import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../testing/server.ts';

// 已有意见数据含非法 UTF-8 字节时的拒绝结果与数据保护回归。
// 旧实现用 readFileSync(file, 'utf8') 读取存储，坏字节被静默替换成“�”：
// 替换后的文字只要仍能组成完整记录，列表就可能正常返回，随后的提交还会把
// 替换后的旧内容一并写回，改写用户原文。这里从进程外把非法字节直接写进
// ideas.json 的各字段（替换后仍是合法 JSON、记录结构完整，正是旧实现漏网的形态），
// 验证：GET 返回 500（unable to read ideas），合法新提交返回 500
// （无法读取已有意见数据，未保存新意见）且不带 idea，存储逐字节不变、不残留 .tmp。
// 是否失败只由实际编码决定，不看文字里有没有“�”：用户主动写下的“�”以合法
// UTF-8（EF BF BD）存储时仍是普通文字，照常读取。

interface Idea {
  id: string;
  title: string;
  description: string;
  scenario: string;
  createdAt: string;
}

// 三个字段都符合当前要求的新意见：任何拒绝都只能来自已有数据读取失败。
const NEW_IDEA = {
  title: '存储编码异常时的新意见',
  description: '这一条意见的标题、详细说明与使用场景都合法，拒绝结果只能来自无法读取已有数据。',
  scenario: '需要先恢复历史意见数据的场景',
};

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'featureharbor-utf8-storage-'));
}

function ideasFile(server: StartedServer): string {
  return join(server.dataDir, 'ideas.json');
}

// 构造一份 ideas.json 的原始字节：一条结构完整的记录，指定字段的值里嵌入
// 非法字节。非法字节被替换成“�”后整份仍是合法 JSON、记录仍完整——
// 正是旧实现会误当正常数据读出的形态。
function ideasFileWithBadBytes(badBytes: number[], field: keyof Idea): Buffer {
  const idea: Idea = {
    id: 'bad-utf8-1',
    title: '正常标题',
    description: '正常正文',
    scenario: '正常场景',
    createdAt: '2024-01-01T00:00:00.000Z',
  };
  idea[field] = '前缀@@BAD@@后缀';
  const json = Buffer.from(`${JSON.stringify([idea], null, 2)}\n`, 'utf8');
  const marker = Buffer.from('@@BAD@@', 'utf8');
  const at = json.indexOf(marker);
  assert.ok(at >= 0);
  return Buffer.concat([
    json.subarray(0, at),
    Buffer.from(badBytes),
    json.subarray(at + marker.length),
  ]);
}

// 三类非法形态：单独的续字节、缺失后续字节的多字节字符、不符合 UTF-8 规则的编码。
const BAD_BYTE_CASES: Array<{ name: string; bytes: number[] }> = [
  { name: '单独的续字节 0x80', bytes: [0x80] },
  { name: '单独的续字节 0xBF', bytes: [0xbf] },
  { name: '非法字节 0xFF', bytes: [0xff] },
  { name: '缺失后续字节的三字节字符（E4 B8 后不是续字节）', bytes: [0xe4, 0xb8] },
  { name: '缺失后续字节的四字节字符（F0 9F 98 后不是续字节）', bytes: [0xf0, 0x9f, 0x98] },
  { name: '过长编码 C0 AF', bytes: [0xc0, 0xaf] },
  { name: '代理区编码 ED A0 80', bytes: [0xed, 0xa0, 0x80] },
  { name: '超出范围 F5 80 80 80', bytes: [0xf5, 0x80, 0x80, 0x80] },
];

// 非法字节落在哪个字段都应拒绝整份数据：三个文字字段之外，id 与 createdAt 也一样。
const BAD_BYTE_FIELDS: Array<keyof Idea> = ['title', 'description', 'scenario', 'id', 'createdAt'];

async function postNewIdea(
  server: StartedServer,
): Promise<{ status: number; contentType: string | null; data: any }> {
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
  return { status: res.status, contentType: res.headers.get('content-type'), data };
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

test('已有意见数据含非法 UTF-8 时：查询与合法新提交都返回 500，原有存储逐字节保留', async (t) => {
  for (const field of BAD_BYTE_FIELDS) {
    for (const bad of BAD_BYTE_CASES) {
      await t.test(`${field} 字段含${bad.name}`, async () => {
        const dir = freshDir();
        let server: StartedServer | undefined;
        try {
          server = await startServer(dir);
          const file = ideasFile(server);
          const tmpFile = `${file}.tmp`;

          // 服务已正常启动后，在进程之外把非法字节写进已保存记录的字段。
          const content = ideasFileWithBadBytes(bad.bytes, field);
          writeFileSync(file, content);
          const before = readFileSync(file);
          assert.ok(before.equals(content));

          // 提交一条三字段均合法的新意见：必须 500，使用现有 error 说明，
          // 响应不带表示保存成功的 idea，也不能归为新意见输入错误的 400。
          const post1 = await postNewIdea(server);
          assert.equal(post1.status, 500);
          assert.match(post1.contentType ?? '', /application\/json/);
          assert.ok(post1.data && typeof post1.data === 'object');
          assert.equal(post1.data.error, '无法读取已有意见数据，未保存新意见');
          assert.equal(Object.prototype.hasOwnProperty.call(post1.data, 'idea'), false);

          // 被拒绝的提交不能改动原有存储的任何字节，也不留下含新意见的临时副本。
          assert.ok(readFileSync(file).equals(before), '提交被拒绝后存储内容被改动');
          assert.equal(existsSync(tmpFile), false, '拒绝保存后不应留下临时文件');

          // 查询同样是现有的 500：不能返回成功的空列表，也不能只返回正常片段。
          const get1 = await getIdeas(server);
          assert.equal(get1.status, 500);
          assert.deepEqual(get1.data, { error: 'unable to read ideas' });
          assert.ok(readFileSync(file).equals(before), '查询失败后存储内容被改动');

          // 重复失败结果一致：任何一次失败请求都不能触发写入或“自愈”式重写。
          const post2 = await postNewIdea(server);
          assert.equal(post2.status, 500);
          assert.equal(post2.data.error, '无法读取已有意见数据，未保存新意见');
          const get2 = await getIdeas(server);
          assert.equal(get2.status, 500);
          assert.deepEqual(get2.data, { error: 'unable to read ideas' });
          assert.ok(readFileSync(file).equals(before), '再次失败后存储内容被改动');
          assert.equal(existsSync(tmpFile), false);

          // 正常停止并用同一数据目录重启：启动过程也不能改写无法读取的内容。
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
          assert.ok(readFileSync(file).equals(before), '重启后的失败请求改动了存储内容');
          assert.equal(existsSync(tmpFile), false);
        } finally {
          await safeStop(server);
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
});

test('存储中用户主动写下的“�”是普通文字：合法 UTF-8 照常读取，中文、表情、换行原样保留', async () => {
  const dir = freshDir();
  const file = join(dir, 'ideas.json');
  // “�”以合法 UTF-8（EF BF BD）存储时就是普通文字，不能凭这个字符拒绝；
  // 中文、表情、换行与空白继续按原样读取。
  const oldIdea: Idea = {
    id: 'replacement-char-1',
    title: '标题里有用户写下的 � 字符',
    description: '正文第一行 �\n第二行带表情 😀 与中文',
    scenario: '场景里的 � 与空白  ',
    createdAt: '2024-03-04T05:06:07.000Z',
  };
  writeFileSync(file, `${JSON.stringify([oldIdea], null, 2)}\n`, 'utf8');

  let server: StartedServer | undefined;
  try {
    server = await startServer(dir);

    const listed = await getIdeas(server);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.data.ideas, [oldIdea]);

    // 合法提交照常成功：新意见排在最前，含“�”的旧记录逐字段原样保留。
    const posted = await postNewIdea(server);
    assert.equal(posted.status, 201);
    const after = await getIdeas(server);
    assert.equal(after.status, 200);
    assert.equal(after.data.ideas.length, 2);
    assert.deepEqual(after.data.ideas[0], posted.data.idea);
    assert.deepEqual(after.data.ideas[1], oldIdea);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('存储编码正常但结构不完整的记录仍按原有规则拒绝（不受严格解码影响）', async () => {
  const dir = freshDir();
  const file = join(dir, 'ideas.json');
  // 编码完全合法、只是结构不完整（缺少 scenario 字段）：结果与之前一致，
  // 严格 UTF-8 解码不改变已有的结构判定。
  writeFileSync(
    file,
    '[{"id":"broken-1","title":"缺场景字段","description":"正文","createdAt":"2024-01-01T00:00:00.000Z"}]\n',
    'utf8',
  );
  const before = readFileSync(file);

  let server: StartedServer | undefined;
  try {
    server = await startServer(dir);

    const listed = await getIdeas(server);
    assert.equal(listed.status, 500);
    assert.deepEqual(listed.data, { error: 'unable to read ideas' });

    const posted = await postNewIdea(server);
    assert.equal(posted.status, 500);
    assert.equal(posted.data.error, '无法读取已有意见数据，未保存新意见');
    assert.ok(readFileSync(file).equals(before), '失败后存储内容被改动');
    assert.equal(existsSync(`${file}.tmp`), false);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
