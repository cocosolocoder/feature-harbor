import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../testing/server.ts';

// 已有意见数据无法读取时的拒绝结果与数据保护回归。
// 存储文件 ideas.json 出现两类「无法读取」：
//   1. 内容不是合法 JSON（含被截断的数组、混在空白与换行里的残片）；
//   2. 是合法 JSON，但顶层不是意见数组（对象，包括形如 {"ideas": [...]} 的信封，或 null）。
// 此时：
//   - 提交一条字段完全合法的新意见必须返回 500，并以 error 字段说明
//     「无法读取已有意见数据，未保存新意见」；不能返回成功用的 idea，
//     也不能把服务端读盘失败误判成用户填错字段的 400；
//   - 查询列表也必须返回现有的 500 错误，不能返回成功的空列表，
//     让人误以为此前没有提交过意见；
//   - 最关键：请求结束后存储文字与请求前逐字节一致——即使是不完整的 JSON、
//     空白或换行，也不能被重写成 []、被重新排版，或被替换成只含新意见的列表。
// 全部用例只走公开入口（GET/POST /api/ideas），在真实进程上验证。

const DATA_FILE_NAME = 'ideas.json';
const READ_ERROR_MESSAGE = '无法读取已有意见数据，未保存新意见';

// 一条标题、详细说明、使用场景均合法的新意见；字段本身没有任何问题，
// 避免由表单内容错误遮住「存储无法读取」这一需要保障的结果。
const VALID_BODY = {
  title: '存储异常时的新意见',
  description: '这条意见字段全部合法，不应被保存。',
  scenario: '旧数据读不出来时提交',
};

interface CorruptionCase {
  name: string;
  content: string;
}

// 两类存储异常都要覆盖，不能只保障 JSON 解析失败：
// 既能解析、顶层却不是意见数组（对象或 null）的内容同样属于无法读取。
const CORRUPTION_CASES: CorruptionCase[] = [
  {
    name: '内容不是合法 JSON（被截断的数组）',
    content: '[{"id": "broken-1", "title": "恢复用旧意见", "description": "半截记录',
  },
  {
    name: '内容不是合法 JSON（残片混在空白与换行中）',
    content: '\n\t  {"ideas": [\n  \n',
  },
  {
    name: '合法 JSON 但顶层是普通对象而不是意见数组',
    content: '{"oops": true}\n',
  },
  {
    name: '合法 JSON 但顶层是形似列表响应的 {"ideas": [...]} 对象而不是数组',
    content: JSON.stringify({ ideas: [{ id: 'x', title: '藏在对象里的记录' }] }, null, 2) + '\n',
  },
  {
    name: '合法 JSON 但顶层是 null 而不是数组',
    content: 'null\n',
  },
];

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'featureharbor-readfail-'));
}

function dataFile(dir: string): string {
  return join(dir, DATA_FILE_NAME);
}

async function safeStop(server: StartedServer): Promise<void> {
  await Promise.race([
    server.stop(),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);
}

// 直接把存储文件写成给定的「无法读取」内容，再启动服务（服务启动不会改写已有文件）。
async function startWithContent(dir: string, content: string): Promise<StartedServer> {
  writeFileSync(dataFile(dir), content, 'utf8');
  return startServer(dir);
}

async function postValidIdea(server: StartedServer): Promise<{ status: number; data: any }> {
  const res = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(VALID_BODY),
  });
  return { status: res.status, data: await res.json() };
}

async function getIdeas(server: StartedServer): Promise<{ status: number; data: any }> {
  const res = await fetch(`${server.origin}/api/ideas`);
  return { status: res.status, data: await res.json() };
}

for (const c of CORRUPTION_CASES) {
  test(`存储异常「${c.name}」：合法提交返回 500 与现有错误说明，不含 idea，也不是 400`, async () => {
    const dir = freshDir();
    const server = await startWithContent(dir, c.content);
    try {
      const { status, data } = await postValidIdea(server);
      assert.equal(status, 500);
      assert.equal(data.error, READ_ERROR_MESSAGE);
      // 不能带有任何表示保存成功的内容
      assert.equal('idea' in data, false, '响应不应包含 idea 字段');
      assert.equal(data.idea, undefined);
    } finally {
      await safeStop(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`存储异常「${c.name}」：GET 列表同样返回现有的 500 错误，不返回成功的空列表`, async () => {
    const dir = freshDir();
    const server = await startWithContent(dir, c.content);
    try {
      const { status, data } = await getIdeas(server);
      assert.equal(status, 500);
      assert.equal(typeof data.error, 'string');
      assert.ok(data.error.length > 0);
      // 绝不能以 { ideas: [] } 的成功形态让人误以为此前没有意见
      assert.notDeepEqual(data, { ideas: [] });
      assert.equal(Array.isArray(data.ideas), false);
    } finally {
      await safeStop(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`存储异常「${c.name}」：无论提交失败还是查询失败，存储文字与请求前逐字节一致`, async () => {
    const dir = freshDir();
    const server = await startWithContent(dir, c.content);
    try {
      const file = dataFile(dir);
      const beforePost = readFileSync(file, 'utf8');
      assert.equal(beforePost, c.content);

      await postValidIdea(server);
      const afterPost = readFileSync(file, 'utf8');
      assert.equal(
        afterPost,
        c.content,
        '提交被拒后原有存储内容必须逐字节保留：不能被重写为空数组、重新排版或换成只含新意见的列表',
      );

      // 提交失败后留下的内容再次查询失败，仍不得改写
      await getIdeas(server);
      assert.equal(readFileSync(file, 'utf8'), c.content);

      // 先查询失败、再提交失败，顺序反过来同样不得改写
      await getIdeas(server);
      await postValidIdea(server);
      assert.equal(readFileSync(file, 'utf8'), c.content);

      // 不能留下临时文件等写入痕迹
      assert.deepEqual(readdirSync(dir).sort(), [DATA_FILE_NAME]);
    } finally {
      await safeStop(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('只含空白/换行的存储内容同样无法解析：提交与查询都返回 500，空白原样保留不被重写', async () => {
  const dir = freshDir();
  // 纯空白既不是合法 JSON，也不能被当成「没有意见」而初始化或保存成空数组
  const content = '  \n\t \r\n';
  const server = await startWithContent(dir, content);
  try {
    const file = dataFile(dir);

    const posted = await postValidIdea(server);
    assert.equal(posted.status, 500);
    assert.equal(posted.data.error, READ_ERROR_MESSAGE);
    assert.equal('idea' in posted.data, false);
    assert.equal(readFileSync(file, 'utf8'), content);

    const got = await getIdeas(server);
    assert.equal(got.status, 500);
    assert.equal(Array.isArray(got.data.ideas), false);
    assert.equal(readFileSync(file, 'utf8'), content);
    assert.deepEqual(readdirSync(dir).sort(), [DATA_FILE_NAME]);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('存储修复为正常空数组后：查询成功返回空列表，合法提交返回 201 且能读到完整新意见', async () => {
  const dir = freshDir();
  // 先处于无法读取状态并失败一次，确认失败本身不会修复/破坏文件
  const broken = '[{"id": "half"; 截到一半';
  let server = await startWithContent(dir, broken);
  try {
    assert.equal((await postValidIdea(server)).status, 500);
    assert.equal(readFileSync(dataFile(dir), 'utf8'), broken);
  } finally {
    await safeStop(server);
  }

  // 人工把存储修复为正常的空数组（空数组代表没有记录，与损坏内容必须区分开）
  writeFileSync(dataFile(dir), '[]\n', 'utf8');
  server = await startServer(dir);
  try {
    const empty = await getIdeas(server);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data, { ideas: [] });

    const { status, data } = await postValidIdea(server);
    assert.equal(status, 201);
    assert.equal(data.idea.title, VALID_BODY.title);
    assert.equal(data.idea.description, VALID_BODY.description);
    assert.equal(data.idea.scenario, VALID_BODY.scenario);
    assert.equal(typeof data.idea.id, 'string');
    assert.ok(data.idea.id.length > 0);
    assert.ok(!Number.isNaN(Date.parse(data.idea.createdAt)));

    const list = await getIdeas(server);
    assert.equal(list.status, 200);
    assert.equal(list.data.ideas.length, 1);
    assert.deepEqual(list.data.ideas[0], data.idea);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('存储修复为含已有记录的数组后：新提交排在最前，旧记录的内容、标识与时间原样保留', async () => {
  const dir = freshDir();
  const oldIdea = {
    id: 'old-fixed-id',
    title: '已有的旧意见',
    description: '旧意见正文\n第二行原样保留',
    scenario: '旧场景',
    createdAt: '2020-01-01T00:00:00.000Z',
  };
  // 先制造一次合法 JSON 但顶层为对象的读取失败，再修复成正常数组
  let server = await startWithContent(dir, '{"ideas": []}\n');
  try {
    const failed = await getIdeas(server);
    assert.equal(failed.status, 500);
    assert.equal(readFileSync(dataFile(dir), 'utf8'), '{"ideas": []}\n');
  } finally {
    await safeStop(server);
  }

  writeFileSync(dataFile(dir), `${JSON.stringify([oldIdea], null, 2)}\n`, 'utf8');
  server = await startServer(dir);
  try {
    const before = await getIdeas(server);
    assert.equal(before.status, 200);
    assert.deepEqual(before.data.ideas, [oldIdea]);

    const created = await postValidIdea(server);
    assert.equal(created.status, 201);
    const newIdea = created.data.idea;
    assert.notEqual(newIdea.id, oldIdea.id);

    const after = await getIdeas(server);
    assert.equal(after.status, 200);
    assert.equal(after.data.ideas.length, 2);
    // 新意见排在已有列表前面
    assert.deepEqual(after.data.ideas[0], newIdea);
    // 旧记录的内容、标识、时间保持原样，不被重排或改写
    assert.deepEqual(after.data.ideas[1], oldIdea);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
