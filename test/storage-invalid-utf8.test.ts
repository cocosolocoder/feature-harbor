import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../testing/server.ts';

// 已有意见数据含非法 UTF-8 字节时的端到端回归。
// 旧实现用 readFileSync(file, 'utf8') 读存储，它内部的 Buffer.toString('utf8') 会把
// 非法字节静默替换成“�”：只要替换后的文字仍能组成结构完整的记录，GET /api/ideas 就
// 正常返回；此后提交新意见还会把替换后的旧内容一并写回，原始字节就此被改写。
// 修复后读取已有数据必须按保存内容的实际字节编码严格判断，而不是看文字里有没有“�”。
// 本测试在服务启动后从进程外向 ideas.json 写入非法字节（fetch 无法表达这些字节），
// 通过公开入口验证：
//   - GET /api/ideas 返回 500、error 为“unable to read ideas”，不返回成功空列表，
//     也不只返回混排其中的正常意见；
//   - POST 一条字段、编码、格式均合法的新意见同样返回 500、error 为
//     “无法读取已有意见数据，未保存新意见”，响应不带 idea，不是 400；
//   - 查询与被拒绝的提交都不得改动原有存储的任何字节，不加入新意见，不残留 .tmp；
//     同一目录重启后结论一致；
//   - 非法形态覆盖：单独续字节、缺少后续字节的多字节字符、过长编码、代理区编码、
//     超范围编码；位置覆盖 title/description/scenario/id/createdAt 等已保存字段，
//     且这些坏字节都特意放在 JSON 字符串内部——替换成“�”后恰好仍是合法 JSON、
//     记录结构也完整，这正是旧实现误读误写的形态；
//   - 用户主动写下的合法“�”（EF BF BD）是普通文字：中文、表情、换行、空白照常读取，
//     提交新意见后旧记录逐字保留。

interface Idea {
  id: string;
  title: string;
  description: string;
  scenario: string;
  createdAt: string;
}

// 三个字段都符合当前要求的新意见：任何 500 都只能来自已有数据读取失败。
const NEW_IDEA = {
  title: '存储编码损坏时的新意见',
  description: '这一条意见的标题、详细说明与使用场景都合法，拒绝结果只能来自无法读取已有数据。',
  scenario: '需要先恢复历史意见原始字节的场景',
};

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'featureharbor-badutf8-'));
}

function ideasFile(server: StartedServer): string {
  return join(server.dataDir, 'ideas.json');
}

async function postNewIdea(
  server: StartedServer,
  body?: string,
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ?? JSON.stringify(NEW_IDEA),
  });
  let data: any;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  return { status: res.status, data };
}

async function getIdeas(server: StartedServer): Promise<{ status: number; data: any }> {
  const res = await fetch(`${server.origin}/api/ideas`);
  return { status: res.status, data: await res.json() };
}

async function safeStop(server: StartedServer | undefined): Promise<void> {
  if (!server) return;
  await Promise.race([
    server.stop(),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);
}

// 构造一条结构完整的记录，并把给定非法字节序列插进指定字段的字符串内容开头之后。
// 所有 JSON 结构字节都保持完整：坏字节若被替换成“�”，整份仍是可解析的 JSON 数组、
// 记录字段也齐全——用来证明修复针对的是字节编码本身，而非结构解析失败。
function storageWithBadBytes(
  field: keyof Idea,
  badBytes: number[],
  extra: { mixValid?: boolean } = {},
): Buffer {
  const records: Array<Record<string, string>> = [
    {
      id: 'broken-1',
      title: '损坏记录的标题前缀标题后缀',
      description: '损坏记录的正文前缀正文后缀',
      scenario: '损坏记录的场景前缀场景后缀',
      createdAt: '2024-01-03T04:05:06.789Z',
    },
  ];
  if (extra.mixValid) {
    records.unshift({
      id: 'valid-1',
      title: '排在前面的正常意见',
      description: '它的内容完全合法，也不能被单独返回',
      scenario: '',
      createdAt: '2024-01-02T03:04:05.678Z',
    });
  }
  const json = JSON.stringify(records);
  const marker = Buffer.from(`"${field}":"`, 'ascii');
  const at = json.indexOf(marker);
  assert.notEqual(at, -1);
  const insertAt = at + marker.length;
  return Buffer.concat([
    Buffer.from(json.substring(0, insertAt), 'utf8'),
    Buffer.from(badBytes),
    Buffer.from(json.substring(insertAt), 'utf8'),
    Buffer.from('\n', 'ascii'),
  ]);
}

const CORRUPT_CASES: Array<{ name: string; build: () => Buffer }> = [
  { name: 'title 中混入单独的续字节 0x80', build: () => storageWithBadBytes('title', [0x80]) },
  { name: 'title 中混入单独的续字节 0xBF', build: () => storageWithBadBytes('title', [0xBF]) },
  { name: 'description 中混入 0xFF', build: () => storageWithBadBytes('description', [0xff]) },
  { name: 'scenario 中缺少后续字节的三字节字符（E4 B8）', build: () => storageWithBadBytes('scenario', [0xe4, 0xb8]) },
  { name: 'title 中缺少后续字节的四字节字符（F0）', build: () => storageWithBadBytes('title', [0xf0]) },
  { name: 'description 中只发三个字节的四字节字符（F0 9F 98）', build: () => storageWithBadBytes('description', [0xf0, 0x9f, 0x98]) },
  { name: 'scenario 中出现过长编码（C0 AF）', build: () => storageWithBadBytes('scenario', [0xc0, 0xaf]) },
  { name: 'title 中出现 UTF-16 代理区编码（ED A0 80）', build: () => storageWithBadBytes('title', [0xed, 0xa0, 0x80]) },
  { name: 'description 中出现超出 Unicode 范围的编码（F5 80 80 80）', build: () => storageWithBadBytes('description', [0xf5, 0x80, 0x80, 0x80]) },
  { name: '坏字节位于 id 字段仍属于整份数据读取失败', build: () => storageWithBadBytes('id', [0x80]) },
  { name: '坏字节位于 createdAt 字段仍属于整份数据读取失败', build: () => storageWithBadBytes('createdAt', [0xe4, 0xb8]) },
  {
    name: '正常意见排在前面、坏字节在另一条记录的字段中：整份列表失败，不只返回正常意见',
    build: () => storageWithBadBytes('description', [0xff], { mixValid: true }),
  },
];

test('已有意见数据含非法 UTF-8：查询与合法提交都返回 500，原有存储逐字节保留', async (t) => {
  for (const corrupt of CORRUPT_CASES) {
    await t.test(corrupt.name, async () => {
      const dir = freshDir();
      let server: StartedServer | undefined;
      try {
        server = await startServer(dir);
        const file = ideasFile(server);
        const tmpFile = `${file}.tmp`;

        const content = corrupt.build();
        writeFileSync(file, content);
        const before = readFileSync(file);
        assert.ok(before.equals(content));

        // 查询：500 与现有 error，不返回空列表，也不只返回其中的正常意见。
        const get1 = await getIdeas(server);
        assert.equal(get1.status, 500);
        assert.deepEqual(get1.data, { error: 'unable to read ideas' });
        assert.ok(readFileSync(file).equals(before), '查询失败后存储字节被改动');

        // 合法新意见：失败来自已有数据读取，是 500 而不是把新意见当成输入错误的 400；
        // 响应不含 idea，不能显示保存成功。
        const post1 = await postNewIdea(server);
        assert.equal(post1.status, 500);
        assert.ok(post1.data && typeof post1.data === 'object');
        assert.equal(post1.data.error, '无法读取已有意见数据，未保存新意见');
        assert.equal(Object.prototype.hasOwnProperty.call(post1.data, 'idea'), false);
        assert.ok(readFileSync(file).equals(before), '被拒绝的提交改写了原有存储');
        assert.equal(existsSync(tmpFile), false, '被拒绝的提交留下了含新意见的临时副本');

        // 重复请求同样失败，任何一次都不能触发写入或“自愈”式重写。
        const get2 = await getIdeas(server);
        assert.equal(get2.status, 500);
        assert.deepEqual(get2.data, { error: 'unable to read ideas' });
        const post2 = await postNewIdea(server);
        assert.equal(post2.status, 500);
        assert.equal(post2.data.error, '无法读取已有意见数据，未保存新意见');
        assert.equal(Object.prototype.hasOwnProperty.call(post2.data, 'idea'), false);
        assert.ok(readFileSync(file).equals(before), '再次失败后存储字节被改动');
        assert.equal(existsSync(tmpFile), false);

        // 同一数据目录重启：启动过程也不能把损坏内容重置或格式化，读取仍失败。
        await server.stop();
        server = undefined;
        assert.ok(readFileSync(file).equals(before), '停止服务改动了存储字节');
        server = await startServer(dir);
        assert.ok(readFileSync(file).equals(before), '重启过程改动了存储字节');
        const getAfterRestart = await getIdeas(server);
        assert.equal(getAfterRestart.status, 500);
        assert.deepEqual(getAfterRestart.data, { error: 'unable to read ideas' });
        const postAfterRestart = await postNewIdea(server);
        assert.equal(postAfterRestart.status, 500);
        assert.equal(postAfterRestart.data.error, '无法读取已有意见数据，未保存新意见');
        assert.equal(Object.prototype.hasOwnProperty.call(postAfterRestart.data, 'idea'), false);
        assert.ok(readFileSync(file).equals(before), '重启后的失败请求改动了存储字节');
        assert.equal(existsSync(tmpFile), false);
      } finally {
        await safeStop(server);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

test('已有数据编码损坏时：新意见自身的请求正文错误仍按现有 400 处理，且不触碰存储', async () => {
  const dir = freshDir();
  let server: StartedServer | undefined;
  try {
    server = await startServer(dir);
    const file = ideasFile(server);
    const content = storageWithBadBytes('title', [0xff]);
    writeFileSync(file, content);
    const before = readFileSync(file);

    // 读取已有数据发生在请求体结构与字段校验之后：新意见本身不合法时维持现有的 400，
    // 字段规则与请求正文的错误处理不因本次修复改变；无论结果如何都不写入。
    const badField = await postNewIdea(server, JSON.stringify({ title: '   ', description: '正文', scenario: '' }));
    assert.equal(badField.status, 400);
    const badJson = await postNewIdea(server, '{不是合法 JSON');
    assert.equal(badJson.status, 400);
    assert.ok(readFileSync(file).equals(before), '400 请求改动了损坏的存储');
    assert.equal(existsSync(`${file}.tmp`), false);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('合法 UTF-8 中用户主动写下的“�”（EF BF BD）是普通文字：读取与追加保存照常，旧内容逐字保留', async () => {
  const dir = freshDir();
  const file = join(dir, 'ideas.json');
  // 直接按字节构造：标题含合法的 EF BF BD，正文含中文、换行、空白与表情。
  const oldBytes = Buffer.concat([
    Buffer.from('[\n  {\n    "id": "legacy-fffd",\n    "title": "用户写的', 'utf8'),
    Buffer.from([0xef, 0xbf, 0xbd]),
    Buffer.from(' 也算标题",\n    "description": "第一行中文\\n第二行 空白与表情 😀\\n",\n', 'utf8'),
    Buffer.from('    "scenario": " 场景 里的替换符 ', 'utf8'),
    Buffer.from([0xef, 0xbf, 0xbd]),
    Buffer.from(' ",\n    "createdAt": "2024-01-04T05:06:07.890Z"\n  }\n]\n', 'utf8'),
  ]);

  let server: StartedServer | undefined;
  try {
    server = await startServer(dir);
    // startServer 会先放入初始 []\n，启动后用历史内容整体替换。
    writeFileSync(file, oldBytes);

    const listed = await getIdeas(server);
    assert.equal(listed.status, 200);
    assert.equal(listed.data.ideas.length, 1);
    const old = listed.data.ideas[0] as Idea;
    assert.equal(old.id, 'legacy-fffd');
    assert.equal(old.title, '用户写的� 也算标题');
    assert.equal(old.description, '第一行中文\n第二行 空白与表情 😀\n');
    assert.equal(old.scenario, ' 场景 里的替换符 � ');
    assert.equal(old.createdAt, '2024-01-04T05:06:07.890Z');

    const posted = await postNewIdea(server);
    assert.equal(posted.status, 201);
    assert.ok(posted.data.idea && posted.data.idea.id);

    // 追加保存后：新意见在最前，旧记录逐字保留，原始字节中的 EF BF BD 未被改动，
    // 也没有把旧记录重写成别的编码形态。
    const after = await getIdeas(server);
    assert.equal(after.status, 200);
    assert.equal(after.data.ideas.length, 2);
    assert.deepEqual(after.data.ideas[1], old);
    const onDisk = readFileSync(file).toString('utf8');
    assert.ok(onDisk.includes('用户写的� 也算标题'));
    // 磁盘上的 JSON 里字符串内的换行以转义序列 \n 两个字节保存。
    assert.ok(onDisk.includes('第一行中文\\n第二行 空白与表情 😀\\n'));
    assert.ok(onDisk.includes('场景 里的替换符 �'));
    assert.equal(existsSync(`${file}.tmp`), false);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('合法空列表与正常意见的读取、提交保持现状', async () => {
  const dir = freshDir();
  let server: StartedServer | undefined;
  try {
    server = await startServer(dir);
    const file = ideasFile(server);

    const empty = await getIdeas(server);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data, { ideas: [] });

    const posted = await postNewIdea(server);
    assert.equal(posted.status, 201);
    const idea = posted.data.idea as Idea;
    assert.equal(idea.title, NEW_IDEA.title);
    assert.equal(idea.description, NEW_IDEA.description);
    assert.equal(idea.scenario, NEW_IDEA.scenario);

    const listed = await getIdeas(server);
    assert.equal(listed.status, 200);
    assert.equal(listed.data.ideas.length, 1);
    assert.deepEqual(listed.data.ideas[0], idea);
    assert.equal(existsSync(`${file}.tmp`), false);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
