import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../testing/server.ts';

// 存储读取异常的回归保障：保护「已有意见数据无法读取时，拒绝保存新意见，并保留原有存储内容」
// 这一现有行为。只走公开入口（GET/POST /api/ideas）并直接检查磁盘上的 ideas.json，
// 在真实进程上验证两类异常：
//   1. 存储内容不是合法 JSON（含被截断、夹着空白与换行的不完整 JSON）；
//   2. 是合法 JSON、但顶层不是意见数组（对象、字符串等）。
// 两类异常都必须：POST 合法意见返回 500 和现有的 error 说明、响应不带 idea、不能算成 400；
// GET 返回现有的 500 错误，不能当成空列表；请求结束后文件内容与请求前逐字节一致
// （不能被重写成 []、被格式化、或被替换成只含新意见的列表），也不能留下 .tmp 临时文件。
// 发起提交的意见本身三个字段都合法，避免由表单内容错误遮住需要保障的结果。

interface Idea {
  id: string;
  title: string;
  description: string;
  scenario: string;
  createdAt: string;
}

// 三个字段都符合当前要求的新意见：任何拒绝都只能来自存储读取异常。
const NEW_IDEA = {
  title: '存储读取异常时的新意见',
  description: '这一条意见的标题、详细说明与使用场景都合法，拒绝结果只能来自无法读取已有数据。',
  scenario: '需要先恢复历史意见数据的场景',
};

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'featureharbor-corrupt-'));
}

function ideasFile(server: StartedServer): string {
  return join(server.dataDir, 'ideas.json');
}

async function postNewIdea(
  server: StartedServer,
): Promise<{ status: number; contentType: string | null; text: string; data: any }> {
  const res = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(NEW_IDEA),
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { status: res.status, contentType: res.headers.get('content-type'), text, data };
}

async function getIdeas(
  server: StartedServer,
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${server.origin}/api/ideas`);
  return { status: res.status, data: await res.json() };
}

// 兜底停止：即使重复调用也不挂住测试（stop 内部另有 SIGKILL 兜底）。
async function safeStop(server: StartedServer | undefined): Promise<void> {
  if (!server) return;
  await Promise.race([
    server.stop(),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);
}

// 两类存储异常的具体内容：既包含无法解析，也包含能解析但顶层不是数组。
// 其中刻意放入不完整 JSON、前导/末尾空白与换行，用来验证这些文字逐字节保留。
const CORRUPT_CASES: Array<{ name: string; content: string }> = [
  {
    name: '存储内容不是合法 JSON（写到一半被截断的数组）',
    content: '[\n  {"id":"old-1","title":"未保存完的意见","description":"文件写到一半',
  },
  {
    name: '不完整 JSON 中夹杂空白、制表符与换行，末尾也不是合法结尾',
    content: '\n\t  [{"id":"old-2","title":"半截意见","description":"没有闭合"\n  \t\n',
  },
  {
    name: '是合法 JSON，但顶层是对象而不是意见数组',
    content: '{\n  "notIdeas": [{ "id": "old-3" }]\n}\n',
  },
  {
    name: '是合法 JSON，但顶层是字符串而不是意见数组',
    content: '"this is not an ideas array"\n',
  },
];

test('已有数据无法读取为意见数组时：提交合法意见与查询列表都返回 500，且原有存储逐字节保留', async (t) => {
  for (const corrupt of CORRUPT_CASES) {
    await t.test(corrupt.name, async () => {
      const dir = freshDir();
      let server: StartedServer | undefined;
      try {
        server = await startServer(dir);
        const file = ideasFile(server);
        const tmpFile = `${file}.tmp`;

        // 服务已正常启动后，在进程之外把存储改成无法读取的内容。
        writeFileSync(file, corrupt.content, 'utf8');
        const before = readFileSync(file);
        assert.equal(before.toString('utf8'), corrupt.content);

        // 提交一条三字段均合法的新意见：必须 500，使用现有 error 说明，
        // 响应不能带表示保存成功的 idea，也不能归为字段填错的 400。
        const post1 = await postNewIdea(server);
        assert.equal(post1.status, 500);
        assert.match(post1.contentType ?? '', /application\/json/);
        assert.ok(post1.data && typeof post1.data === 'object');
        assert.equal(post1.data.error, '无法读取已有意见数据，未保存新意见');
        assert.equal(Object.prototype.hasOwnProperty.call(post1.data, 'idea'), false);

        // 最关键的保护：拒绝保存后原有文字一个字节都不能变，
        // 不能被重写为空数组、换一种格式整理，或替换成只含新意见的列表。
        assert.ok(readFileSync(file).equals(before), '提交被拒绝后存储内容被改动');
        assert.equal(existsSync(tmpFile), false, '拒绝保存后不应留下临时文件');

        // 同样的异常条件下查询也必须是现有的 500 错误，不能返回成功的空列表。
        const get1 = await getIdeas(server);
        assert.equal(get1.status, 500);
        assert.deepEqual(get1.data, { error: 'unable to read ideas' });
        assert.ok(readFileSync(file).equals(before), '查询失败后存储内容被改动');

        // 重复的提交与查询再次失败：任何一次失败请求都不能触发写入或“自愈”式重写。
        const post2 = await postNewIdea(server);
        assert.equal(post2.status, 500);
        assert.equal(post2.data.error, '无法读取已有意见数据，未保存新意见');
        assert.equal(Object.prototype.hasOwnProperty.call(post2.data, 'idea'), false);
        const get2 = await getIdeas(server);
        assert.equal(get2.status, 500);
        assert.deepEqual(get2.data, { error: 'unable to read ideas' });
        assert.ok(readFileSync(file).equals(before), '再次失败后存储内容被改动');
        assert.equal(existsSync(tmpFile), false);

        // 正常停止并用同一数据目录重启：启动过程也不能把无法读取的内容重置为空数组。
        await server.stop();
        server = undefined;
        server = await startServer(dir);
        assert.ok(readFileSync(file).equals(before), '重启后原有存储内容被改动');

        const getAfterRestart = await getIdeas(server);
        assert.equal(getAfterRestart.status, 500);
        assert.deepEqual(getAfterRestart.data, { error: 'unable to read ideas' });

        const postAfterRestart = await postNewIdea(server);
        assert.equal(postAfterRestart.status, 500);
        assert.equal(postAfterRestart.data.error, '无法读取已有意见数据，未保存新意见');
        assert.equal(Object.prototype.hasOwnProperty.call(postAfterRestart.data, 'idea'), false);
        assert.ok(readFileSync(file).equals(before), '重启后的失败请求改动了存储内容');
        assert.equal(existsSync(tmpFile), false);
      } finally {
        await safeStop(server);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

// 顶层能解析为数组、但数组条目结构不完整的异常：
// 空值、数组、非对象，以及对象缺少字段或字段类型不对。任意一条不合格整份列表都算读取失败，
// 即使同列表里其余记录完全正常；scenario 缺失与为空字符串不同，后者是正常记录，不在此列。
// 内容刻意使用非标准缩进，验证读取失败时这些文字同样逐字节保留。
const GOOD_RECORD =
  '{"id":"good-1","title":"正常记录","description":"正常正文","scenario":"正常场景","createdAt":"2024-01-01T00:00:00.000Z"}';
const MALFORMED_RECORD_CASES: Array<{ name: string; badRecord: string }> = [
  { name: '条目为 null', badRecord: 'null' },
  { name: '条目为数组', badRecord: '[]' },
  { name: '条目为字符串', badRecord: '"not-an-object"' },
  { name: '条目为数字', badRecord: '1' },
  { name: '缺少 id', badRecord: '{"title":"无 id","description":"正文","scenario":"","createdAt":"2024-01-01T00:00:00.000Z"}' },
  { name: 'id 为空字符串', badRecord: '{"id":"","title":"空 id","description":"正文","scenario":"","createdAt":"2024-01-01T00:00:00.000Z"}' },
  { name: 'id 为数字', badRecord: '{"id":1,"title":"数字 id","description":"正文","scenario":"","createdAt":"2024-01-01T00:00:00.000Z"}' },
  { name: '缺少 title', badRecord: '{"id":"no-title","description":"正文","scenario":"","createdAt":"2024-01-01T00:00:00.000Z"}' },
  { name: 'title 为数字', badRecord: '{"id":"num-title","title":1,"description":"正文","scenario":"","createdAt":"2024-01-01T00:00:00.000Z"}' },
  { name: '缺少 description', badRecord: '{"id":"no-desc","title":"标题","scenario":"","createdAt":"2024-01-01T00:00:00.000Z"}' },
  { name: 'description 为 null', badRecord: '{"id":"null-desc","title":"标题","description":null,"scenario":"","createdAt":"2024-01-01T00:00:00.000Z"}' },
  { name: '缺少 scenario（与空字符串不同）', badRecord: '{"id":"no-scenario","title":"标题","description":"正文","createdAt":"2024-01-01T00:00:00.000Z"}' },
  { name: 'scenario 为数字', badRecord: '{"id":"num-scenario","title":"标题","description":"正文","scenario":0,"createdAt":"2024-01-01T00:00:00.000Z"}' },
  { name: 'scenario 为 null', badRecord: '{"id":"null-scenario","title":"标题","description":"正文","scenario":null,"createdAt":"2024-01-01T00:00:00.000Z"}' },
  { name: '缺少 createdAt', badRecord: '{"id":"no-time","title":"标题","description":"正文","scenario":""}' },
  { name: 'createdAt 为数字', badRecord: '{"id":"num-time","title":"标题","description":"正文","scenario":"","createdAt":0}' },
];

test('数组条目结构不完整（空值/数组/缺字段/字段类型错误）：查询与合法提交都返回 500，且存储逐字节保留', async (t) => {
  // 既覆盖「只有异常条目」，也覆盖「正常记录与异常记录混排」：
  // 混排时同样必须整份拒绝，不能跳过异常记录或只返回正常部分。
  const layouts: Array<{ label: string; build: (bad: string) => string }> = [
    { label: '仅有异常条目', build: (bad) => `[ ${bad} ]\n` },
    { label: '异常记录前面还有一条正常记录', build: (bad) => `[\n\t${GOOD_RECORD},\n  ${bad}\n]\n` },
  ];
  for (const c of MALFORMED_RECORD_CASES) {
    for (const layout of layouts) {
      await t.test(`${c.name}（${layout.label}）`, async () => {
        const dir = freshDir();
        let server: StartedServer | undefined;
        try {
          server = await startServer(dir);
          const file = ideasFile(server);
          const tmpFile = `${file}.tmp`;
          const content = layout.build(c.badRecord);

          writeFileSync(file, content, 'utf8');
          const before = readFileSync(file);

          // 查询：现有的 500 错误，不能返回成功（更不能只返回其中的正常记录）。
          const get1 = await getIdeas(server);
          assert.equal(get1.status, 500);
          assert.deepEqual(get1.data, { error: 'unable to read ideas' });
          assert.ok(readFileSync(file).equals(before), '查询失败后存储内容被改动');

          // 提交三字段均合法的新意见：同样 500，使用现有 error，响应不带 idea，不算 400。
          const post1 = await postNewIdea(server);
          assert.equal(post1.status, 500);
          assert.equal(post1.data.error, '无法读取已有意见数据，未保存新意见');
          assert.equal(Object.prototype.hasOwnProperty.call(post1.data, 'idea'), false);
          assert.ok(readFileSync(file).equals(before), '提交被拒绝后存储内容被改动');
          assert.equal(existsSync(tmpFile), false, '拒绝保存后不应留下临时文件');

          // 重启后依旧读取失败，启动过程不做格式化或自愈。
          await server.stop();
          server = undefined;
          server = await startServer(dir);
          assert.ok(readFileSync(file).equals(before), '重启后原有存储内容被改动');
          const getAfterRestart = await getIdeas(server);
          assert.equal(getAfterRestart.status, 500);
          assert.deepEqual(getAfterRestart.data, { error: 'unable to read ideas' });
        } finally {
          await safeStop(server);
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
});

test('历史记录的首尾空白、换行与时间字符串原样可读：结构完整即可查询与追加，不套用新提交的内容限制', async () => {
  const dir = freshDir();
  const file = join(dir, 'ideas.json');
  // 手写一条结构完整但「内容不规整」的历史记录：标题首尾空白、正文与场景含换行，
  // 时间字符串也不是标准 ISO 形式。读取时只验结构，这些文字必须原样保留。
  const legacyRecord = {
    id: 'legacy-1',
    title: '  历史标题首尾空白  ',
    description: '历史正文第一行\n第二行\n',
    scenario: '\n历史场景换行\t',
    createdAt: '2024/01/02 03:04:05',
  };
  writeFileSync(file, `[ ${JSON.stringify(legacyRecord)} ]\n`, 'utf8');

  let server: StartedServer | undefined;
  try {
    server = await startServer(dir);

    const listed = await getIdeas(server);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.data.ideas, [legacyRecord]);

    // 合法新意见仍可追加并排最前；旧记录（含空白、换行、时间字符串）原样跟在后面。
    const posted = await postNewIdea(server);
    assert.equal(posted.status, 201);
    const after = await getIdeas(server);
    assert.equal(after.status, 200);
    assert.equal(after.data.ideas.length, 2);
    assert.deepEqual(after.data.ideas[0], posted.data.idea);
    assert.deepEqual(after.data.ideas[1], legacyRecord);
    assert.equal(existsSync(`${file}.tmp`), false);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('正常的空意见数组仍代表没有记录：查询成功返回空列表，合法提交返回 201 且能读到完整新意见', async () => {
  const dir = freshDir();
  let server: StartedServer | undefined;
  try {
    server = await startServer(dir);
    const file = ideasFile(server);

    // 首次启动创建的就是 []\n：空数组（即使带换行）属于没有记录，不是读取异常。
    assert.equal(readFileSync(file, 'utf8'), '[]\n');
    const empty = await getIdeas(server);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data, { ideas: [] });

    // 停止后写入被空白、制表符与换行包裹的空数组：仍是合法的空列表。
    await server.stop();
    server = undefined;
    writeFileSync(file, ' \n\t [ ] \r\n ', 'utf8');
    server = await startServer(dir);

    const whitespaceEmpty = await getIdeas(server);
    assert.equal(whitespaceEmpty.status, 200);
    assert.deepEqual(whitespaceEmpty.data, { ideas: [] });

    // 合法提交仍然成功，返回结构与字段完整，随后可以读到这条新意见。
    const posted = await postNewIdea(server);
    assert.equal(posted.status, 201);
    assert.ok(posted.data && typeof posted.data.idea === 'object');
    const idea = posted.data.idea as Idea;
    assert.equal(typeof idea.id, 'string');
    assert.ok(idea.id.length > 0);
    assert.equal(typeof idea.createdAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(idea.createdAt)));
    assert.equal(idea.title, NEW_IDEA.title);
    assert.equal(idea.description, NEW_IDEA.description);
    assert.equal(idea.scenario, NEW_IDEA.scenario);

    const listed = await getIdeas(server);
    assert.equal(listed.status, 200);
    assert.equal(listed.data.ideas.length, 1);
    assert.deepEqual(listed.data.ideas[0], idea);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('有已有记录时合法提交：新意见排在最前，旧记录的内容、标识与时间保持原样', async () => {
  const dir = freshDir();
  const file = join(dir, 'ideas.json');
  // 启动前直接放入一条标识与时间固定的旧记录（正文/场景带空白、换行与表情），
  // 这样「旧记录原样保留」可以逐字段精确比对，而不依赖先前请求的返回。
  const oldIdea: Idea = {
    id: 'fixed-old-id-0001',
    title: ' 旧意见标题首尾空白也保持原样 ',
    description: '旧意见正文\n第二行\t保留 <b>标记</b> 😀',
    scenario: ' 旧场景空白与换行保留\n第二行 ',
    createdAt: '2024-01-02T03:04:05.678Z',
  };
  writeFileSync(file, `${JSON.stringify([oldIdea], null, 2)}\n`, 'utf8');

  let server: StartedServer | undefined;
  try {
    server = await startServer(dir);

    const before = await getIdeas(server);
    assert.equal(before.status, 200);
    assert.deepEqual(before.data.ideas, [oldIdea]);

    const posted = await postNewIdea(server);
    assert.equal(posted.status, 201);
    const newIdea = posted.data.idea as Idea;
    assert.notEqual(newIdea.id, oldIdea.id);

    const after = await getIdeas(server);
    assert.equal(after.status, 200);
    assert.equal(after.data.ideas.length, 2);
    // 新意见在最前，旧记录整体（含文字、标识、时间）原样跟在后面。
    assert.deepEqual(after.data.ideas[0], newIdea);
    assert.deepEqual(after.data.ideas[1], oldIdea);
    assert.equal(after.data.ideas[1].id, 'fixed-old-id-0001');
    assert.equal(after.data.ideas[1].createdAt, '2024-01-02T03:04:05.678Z');
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
