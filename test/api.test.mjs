import test from 'node:test';
import assert from 'node:assert/strict';
import { startBackend, createIdea } from './helpers.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('首页与健康检查可访问，提交入口与字段保留', async (t) => {
  const app = await startBackend();
  t.after(() => { app.stop(); app.cleanup(); });

  const home = await fetch(new URL('/', app.url));
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type') ?? '', /text\/html/);
  const html = await home.text();
  assert.ok(html.includes('FeatureHarbor'), '首页标题存在');
  assert.ok(html.includes('id="idea-form"'), '提交入口保留');
  assert.ok(html.includes('name="title"'), '标题字段保留');
  assert.ok(html.includes('id="f-desc"'), '详细说明字段存在');
  assert.ok(html.includes('id="f-scenario"'), '使用场景字段存在');
  assert.ok(html.includes('loadIdeas'), '首次列表加载逻辑保留');

  const health = await fetch(new URL('health', app.url));
  assert.equal(health.status, 200);
  assert.equal((await health.json()).product, 'FeatureHarbor');
});

test('GET /api/ideas 初始为空列表；提交后按创建时间倒序（最新在前）', async (t) => {
  const app = await startBackend();
  t.after(() => { app.stop(); app.cleanup(); });

  const before = await (await fetch(`${app.url}api/ideas`)).json();
  assert.deepEqual(before, { ideas: [] }, '初始数据目录没有任何记录');

  const first = await createIdea(app.url, { title: '第一条', description: '正文一', scenario: '场景一' });
  await sleep(5);
  const second = await createIdea(app.url, { title: '第二条', description: '正文二' });

  const list = (await (await fetch(`${app.url}api/ideas`)).json()).ideas;
  assert.equal(list.length, 2);
  assert.equal(list[0].id, second.id);
  assert.equal(list[1].id, first.id);
  assert.equal(list[0].title, '第二条');
  assert.equal(list[0].scenario, '');
  assert.equal(list[1].scenario, '场景一');
  assert.ok(list[0].createdAt > list[1].createdAt);
});

test('GET /api/ideas 无法读取数据时返回非 2xx（页面据此进入失败态）', async (t) => {
  const app = await startBackend();
  t.after(() => { app.stop(); app.cleanup(); });
  app.corruptStore();

  const res = await fetch(`${app.url}api/ideas`);
  assert.notEqual(res.status, 200);
});

test('POST /api/ideas 成功返回 201、完整记录（含 id 与 createdAt），标题去首尾空白，且真实落盘', async (t) => {
  const app = await startBackend();
  t.after(() => { app.stop(); app.cleanup(); });

  const res = await fetch(`${app.url}api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '  支持深色模式  ', description: '希望支持深色模式。', scenario: '夜间使用' }),
  });
  const data = await res.json();
  assert.equal(res.status, 201);
  assert.ok(typeof data.idea?.id === 'string' && data.idea.id.length > 0);
  assert.ok(typeof data.idea?.createdAt === 'string' && !Number.isNaN(Date.parse(data.idea.createdAt)));
  assert.equal(data.idea.title, '支持深色模式', '标题去掉首尾空白');
  assert.equal(data.idea.description, '希望支持深色模式。');
  assert.equal(data.idea.scenario, '夜间使用');

  const list = (await (await fetch(`${app.url}api/ideas`)).json()).ideas;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, data.idea.id);
});

test('POST 字段规则：缺字段/类型错误/空白/超长返回 400，不写入任何记录', async (t) => {
  const app = await startBackend();
  t.after(() => { app.stop(); app.cleanup(); });

  const expect400 = async (label, body, init = {}) => {
    const res = await fetch(`${app.url}api/ideas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      ...init,
    });
    assert.equal(res.status, 400, `应拒绝：${label}`);
  };

  await expect400('缺少 title', JSON.stringify({ description: '没有标题' }));
  await expect400('缺少 description', JSON.stringify({ title: '只有标题' }));
  await expect400('title 不是字符串', JSON.stringify({ title: 123, description: 'x' }));
  await expect400('description 为 null', JSON.stringify({ title: 'x', description: null }));
  await expect400('scenario 不是字符串', JSON.stringify({ title: 'x', description: 'y', scenario: 1 }));
  await expect400('标题全空白', JSON.stringify({ title: '   ', description: 'y' }));
  await expect400('正文全空白', JSON.stringify({ title: 'x', description: '   \n\t  ' }));
  await expect400('标题 121 字', JSON.stringify({ title: 'a'.repeat(121), description: 'y' }));
  await expect400('正文 5001 字', JSON.stringify({ title: 'x', description: 'b'.repeat(5001) }));
  await expect400('场景 1001 字', JSON.stringify({ title: 'x', description: 'y', scenario: 'c'.repeat(1001) }));
  await expect400('请求体不是 JSON', '不是 json');
  await expect400('请求体是数组', JSON.stringify([1, 2]));

  assert.deepEqual((await (await fetch(`${app.url}api/ideas`)).json()).ideas, []);
});

test('长度按 Unicode 码点计算：120 个 emoji 标题合法，121 拒绝', async (t) => {
  const app = await startBackend();
  t.after(() => { app.stop(); app.cleanup(); });

  const ok = await fetch(`${app.url}api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '😀'.repeat(120), description: 'y' }),
  });
  assert.equal(ok.status, 201);
  assert.equal(Array.from((await ok.json()).idea.title).length, 120);

  const bad = await fetch(`${app.url}api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '😀'.repeat(121), description: 'y' }),
  });
  assert.equal(bad.status, 400);
});

test('scenario 省略视为空；空字符串同样保留为空', async (t) => {
  const app = await startBackend();
  t.after(() => { app.stop(); app.cleanup(); });

  const a = await createIdea(app.url, { title: 'A', description: 'da' });
  const b = await createIdea(app.url, { title: 'B', description: 'db', scenario: '' });
  assert.equal(a.scenario, '');
  assert.equal(b.scenario, '');
});

test('未知路径 404、已知路径不支持的方法 405（含 Allow 头）', async (t) => {
  const app = await startBackend();
  t.after(() => { app.stop(); app.cleanup(); });

  const notFound = await fetch(`${app.url}nope`);
  assert.equal(notFound.status, 404);

  const putIdea = await fetch(`${app.url}api/ideas`, { method: 'PUT' });
  assert.equal(putIdea.status, 405);
  assert.equal(putIdea.headers.get('allow'), 'GET, POST');

  const deleteHome = await fetch(new URL('/', app.url), { method: 'DELETE' });
  assert.equal(deleteHome.status, 405);
  assert.equal(deleteHome.headers.get('allow'), 'GET');
});

test('数据持久化：提交后用同一数据目录重启记录仍在', async (t) => {
  const app = await startBackend();
  const idea = await createIdea(app.url, { title: '重启后还在', description: '持久化正文' });

  await app.stop();
  const restarted = await startBackend({ dataDir: app.dir });
  t.after(() => { restarted.stop(); restarted.cleanup(); });

  const list = (await (await fetch(`${restarted.url}api/ideas`)).json()).ideas;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, idea.id);
  app.cleanup();
});
