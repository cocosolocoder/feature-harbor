import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, removeDataDir, type StartedServer } from '../testing/server.ts';
import {
  LIMITS,
  codePoints,
  boundaryMixed,
  boundaryEmojiLast,
  titleSurroundingWhitespace,
  titleInternalSpace,
  descriptionSurroundingWhitespace,
  descriptionPushedOverByWhitespace,
  scenarioBoundaryMixed,
  fixedAfterRejection,
  overByOneCases,
} from '../testing/limits-fixtures.ts';

// 字符上限（按 Unicode 码点：标题 120、详细说明 5000、使用场景 1000）的接口侧回归。
// 边界载荷与首页表单回归共用 testing/limits-fixtures.ts，两个入口对同一内容
// 必须给出一致的接受/拒绝结果。本文件只走公开的 POST/GET /api/ideas，
// 回归需要能发现：
// - 把 😀 等表情算成两个字符（UTF-16 码元）或按传输字节（UTF-8）计算长度；
// - 恰好达到上限的内容被错误拒绝；
// - 超限一个码点时被截断保存而不是明确 400 拒绝；
// - 标题首尾空白参与长度判断、详细说明/使用场景的首尾空白与换行未原样保留；
// - 失败请求污染了已有意见的内容或排列次序。

let server: StartedServer;

before(async () => {
  server = await startServer();
});

after(async () => {
  await server.stop();
  removeDataDir(server);
});

interface Idea {
  id: string;
  title: string;
  description: string;
  scenario: string;
  createdAt: string;
}

async function postIdea(body: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function listIdeas(): Promise<Idea[]> {
  const res = await fetch(`${server.origin}/api/ideas`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.ideas));
  return data.ideas as Idea[];
}

test('三个字段同时恰好达到上限（ASCII/中文/😀/多码点序列/换行混合）：201 接受且完整保存', async () => {
  const { status, data } = await postIdea(boundaryMixed);
  assert.equal(status, 201, `码点恰好达上限应接受，实际错误：${JSON.stringify(data.error)}`);
  assert.equal(codePoints(data.idea.title), LIMITS.title);
  assert.equal(codePoints(data.idea.description), LIMITS.description);
  assert.equal(codePoints(data.idea.scenario), LIMITS.scenario);
  assert.equal(data.idea.title, boundaryMixed.title);
  assert.equal(data.idea.description, boundaryMixed.description);
  assert.equal(data.idea.scenario, boundaryMixed.scenario);

  // 随后列表中可读到完整内容
  const listed = (await listIdeas()).find((i) => i.id === data.idea.id);
  assert.ok(listed);
  assert.equal(listed!.description, boundaryMixed.description);
  assert.equal(listed!.scenario, boundaryMixed.scenario);
});

test('😀 在三个字段中都只算一个码点：以表情收尾恰好到顶的内容 201 接受', async () => {
  const { status, data } = await postIdea(boundaryEmojiLast);
  assert.equal(status, 201, `😀 按 1 码点计时恰好到顶应接受，实际错误：${JSON.stringify(data.error)}`);
  assert.equal(data.idea.title, boundaryEmojiLast.title);
  assert.equal(data.idea.description, boundaryEmojiLast.description);
  assert.equal(data.idea.scenario, boundaryEmojiLast.scenario);
});

test('标题首尾空白在判断长度前去除：trim 后恰好 120 码点接受，保存时去掉首尾空白', async () => {
  const { status, data } = await postIdea({ title: titleSurroundingWhitespace, description: '说明' });
  assert.equal(status, 201, `trim 后恰好 120 码点的标题应接受，实际错误：${JSON.stringify(data.error)}`);
  assert.equal(data.idea.title, '题'.repeat(LIMITS.title));
  assert.equal(codePoints(data.idea.title), LIMITS.title);
});

test('标题内部空白计入长度：内部一个空格共 120 码点接受，两个空格共 121 码点拒绝', async () => {
  const ok = await postIdea({ title: titleInternalSpace.exact, description: '说明' });
  assert.equal(ok.status, 201);

  const rejected = await postIdea({ title: titleInternalSpace.over, description: '说明' });
  assert.equal(rejected.status, 400);
  assert.match(String(rejected.data.error), /标题/);
});

test('详细说明恰好 5000 码点（含首尾空白与换行）接受，保存后首尾空白与换行原样保留', async () => {
  const description = descriptionSurroundingWhitespace;
  const { status, data } = await postIdea({ title: '正文边界', description });
  assert.equal(status, 201, `恰好 5000 码点（含首尾空白换行）的正文应接受，实际错误：${JSON.stringify(data.error)}`);
  assert.equal(data.idea.description, description);
  assert.ok(data.idea.description.startsWith('  \n'));
  assert.ok(data.idea.description.endsWith('\n  '));
});

test('带首尾空白的合法上限标题接受，而仅被首尾空白推到 5001 码点的详细说明拒绝', async () => {
  const titleRes = await postIdea({ title: titleSurroundingWhitespace, description: '合法标题说明' });
  assert.equal(titleRes.status, 201);
  assert.equal(titleRes.data.idea.title, '题'.repeat(LIMITS.title));

  const descRes = await postIdea({
    title: '被空白推超限',
    description: descriptionPushedOverByWhitespace,
  });
  assert.equal(descRes.status, 400);
  assert.match(String(descRes.data.error), /详细说明/);
});

test('使用场景恰好 1000 码点（含换行/表情/多码点序列）接受并原样保留；省略或空字符串仍可提交', async () => {
  const full = await postIdea({ title: '场景边界', description: '说明', scenario: scenarioBoundaryMixed });
  assert.equal(full.status, 201, `恰好 1000 码点的场景应接受，实际错误：${JSON.stringify(full.data.error)}`);
  assert.equal(full.data.idea.scenario, scenarioBoundaryMixed);

  const omitted = await postIdea({ title: '省略场景', description: '说明' });
  assert.equal(omitted.status, 201);
  assert.equal(omitted.data.idea.scenario, '');

  const empty = await postIdea({ title: '空字符串场景', description: '说明', scenario: '' });
  assert.equal(empty.status, 201);
  assert.equal(empty.data.idea.scenario, '');

  // 全空白的场景也是合法字符串（仅按长度约束），应原样保存
  const blank = ' \n\t ';
  const blankRes = await postIdea({ title: '空白场景', description: '说明', scenario: blank });
  assert.equal(blankRes.status, 201);
  assert.equal(blankRes.data.idea.scenario, blank);
});

test('任一字段只超出一个码点：400 且错误明确指出该字段，拒绝前后列表逐字一致（不截断保存）', async (t) => {
  for (const c of overByOneCases) {
    await t.test(c.name, async () => {
      const before = await listIdeas();
      const { status, data } = await postIdea(c.form);
      assert.equal(status, 400, c.name);
      assert.equal(typeof data.error, 'string');
      assert.match(data.error, c.apiError, c.name);
      // 必须是整条拒绝：不允许新增记录，也不允许截断后保存
      assert.deepEqual(await listIdeas(), before, `${c.name}：拒绝前后列表应逐字一致`);
    });
  }
});

test('超限请求不影响已有意见的内容与次序；把超限字段缩短到允许范围后可正常提交', async () => {
  // 该用例要断言列表的精确内容与次序，使用独立的数据目录，避免与文件内其他用例共享数据
  const dir = mkdtempSync(join(tmpdir(), 'featureharbor-limits-'));
  const isolated = await startServer(dir);
  try {
    const ipost = (body: unknown) =>
      fetch(`${isolated.origin}/api/ideas`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async (res) => ({ status: res.status, data: await res.json() }));
    const ilist = async (): Promise<Idea[]> => {
      const res = await fetch(`${isolated.origin}/api/ideas`);
      const data = await res.json();
      return data.ideas as Idea[];
    };

    // 先保存两条基线意见
    const first = await ipost({ title: '边界基线一', description: '说明一', scenario: '场景一' });
    assert.equal(first.status, 201);
    const second = await ipost({ title: '边界基线二', description: '说明二' });
    assert.equal(second.status, 201);
    const baseline = await ilist();
    const baselineIds = baseline.map((i) => i.id);
    assert.deepEqual(baselineIds, [second.data.idea.id, first.data.idea.id]);

    // 共享夹具中的每个超限用例都必须被拒绝
    for (const c of overByOneCases) {
      const rejected = await ipost(c.form);
      assert.equal(rejected.status, 400, c.name);
    }

    // 失败之后，已有意见的内容与顺序都不变，也没有新增记录
    const afterFailures = await ilist();
    assert.deepEqual(afterFailures, baseline);

    // 把超限字段缩短到允许范围（含中文、表情与换行），同一条意见应能正常提交
    assert.equal(codePoints(fixedAfterRejection.title), LIMITS.title);
    assert.equal(codePoints(fixedAfterRejection.description!), LIMITS.description);
    assert.equal(codePoints(fixedAfterRejection.scenario!), LIMITS.scenario);
    const accepted = await ipost(fixedAfterRejection);
    assert.equal(accepted.status, 201, '缩短到上限后之前的错误不能继续阻止保存');
    assert.equal(accepted.data.idea.title, fixedAfterRejection.title);
    assert.equal(accepted.data.idea.description, fixedAfterRejection.description);
    assert.equal(accepted.data.idea.scenario, fixedAfterRejection.scenario);

    // 新意见排在最前，旧意见内容与次序原样保留
    const finalList = await ilist();
    assert.deepEqual(finalList.map((i) => i.id), [accepted.data.idea.id, ...baselineIds]);
    assert.deepEqual(finalList.slice(1), baseline);
  } finally {
    await isolated.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
