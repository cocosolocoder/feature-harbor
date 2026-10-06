import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, removeDataDir, type StartedServer } from '../testing/server.ts';

// 真实起一份 server.ts 的端到端冒烟测试：保护接口契约、字段规则与首页入口，
// 前端竞态行为的回归覆盖见 page.test.ts。

let server: StartedServer;

before(async () => {
  server = await startServer();
});

after(async () => {
  await server.stop();
  removeDataDir(server);
});

test('GET /health 返回服务状态和产品名称', async () => {
  const res = await fetch(`${server.origin}/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const data = await res.json();
  assert.deepEqual(data, { status: 'ok', product: 'FeatureHarbor' });
});

test('GET / 返回首页：含提交表单、三个字段、空列表提示与内联脚本入口', async () => {
  const res = await fetch(`${server.origin}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  for (const expected of [
    '<form id="idea-form"',
    'id="f-title"',
    'id="f-desc"',
    'id="f-scenario"',
    'id="search-form"',
    'id="f-search"',
    'id="ideas"',
    '还没有意见记录。',
    "fetch('/api/ideas')",
  ]) {
    assert.ok(html.includes(expected), `首页应包含 ${expected}`);
  }
});

test('首次列表脚本运行前，空列表提示在初始 HTML 中即为 hidden（加载等待不能被误报为空）', async () => {
  const res = await fetch(`${server.origin}/`);
  const html = await res.text();
  assert.match(html, /<p id="empty"[^>]*hidden/);
});

test('空数据目录下 GET /api/ideas 返回空列表', async () => {
  const res = await fetch(`${server.origin}/api/ideas`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, { ideas: [] });
});

test('POST 合法意见返回 201 且带 id/createdAt，随后列表可见且排在最前', async () => {
  const payload = { title: '支持深色模式', description: '希望界面支持深色模式。', scenario: '夜间使用' };
  const res = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.ok(data.idea && typeof data.idea.id === 'string' && data.idea.id.length > 0);
  assert.equal(typeof data.idea.createdAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(data.idea.createdAt)));
  assert.equal(data.idea.title, payload.title);
  assert.equal(data.idea.description, payload.description);
  assert.equal(data.idea.scenario, payload.scenario);

  const listRes = await fetch(`${server.origin}/api/ideas`);
  const list = await listRes.json();
  assert.equal(list.ideas[0].id, data.idea.id);
});

test('POST 省略可选 scenario 时按空字符串保存', async () => {
  const res = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '没有场景', description: '只有说明。' }),
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.idea.scenario, '');
});

test('字段规则：空白标题、空白说明、超长标题、类型错误均返回 400 且不入库', async (t) => {
  const longTitle = '字'.repeat(121);
  const cases: Array<{ name: string; body: unknown }> = [
    { name: '标题为空白', body: { title: '   ', description: '说明' } },
    { name: '缺少标题', body: { description: '说明' } },
    { name: '说明为空白', body: { title: '标题', description: '   ' } },
    { name: '标题超长', body: { title: longTitle, description: '说明' } },
    { name: '标题不是字符串', body: { title: 1, description: '说明' } },
    { name: 'scenario 不是字符串', body: { title: '标题', description: '说明', scenario: 2 } },
    { name: '请求体不是 JSON 对象（数组）', body: [{ title: '标题', description: '说明' }] },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const res = await fetch(`${server.origin}/api/ideas`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(c.body),
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(typeof data.error, 'string');
    });
  }
});

test('非法 JSON 请求体返回 400', async () => {
  const res = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
});

test('同标题同正文的两次提交生成不同 id，列表中分别保留', async () => {
  const payload = { title: '重复标题', description: '重复说明' };
  const first = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => r.json());
  const second = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => r.json());
  assert.notEqual(first.idea.id, second.idea.id);

  const list = await fetch(`${server.origin}/api/ideas`).then((r) => r.json());
  const matches = list.ideas.filter(
    (idea: any) => idea.title === '重复标题' && idea.description === '重复说明',
  );
  assert.equal(matches.length, 2);
});

test('未知路径 404；已知路径不支持的方法 405', async () => {
  const notFound = await fetch(`${server.origin}/nope`);
  assert.equal(notFound.status, 404);

  const deleteIdea = await fetch(`${server.origin}/api/ideas`, { method: 'DELETE' });
  assert.equal(deleteIdea.status, 405);
  assert.match(deleteIdea.headers.get('allow') ?? '', /GET/);
  assert.match(deleteIdea.headers.get('allow') ?? '', /POST/);

  const postHealth = await fetch(`${server.origin}/health`, { method: 'POST' });
  assert.equal(postHealth.status, 405);
});
