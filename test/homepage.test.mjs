import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startApp, launchBrowser, dom, createIdea } from './helpers.mjs';

const EMPTY_TEXT = '还没有意见记录。';
const LOAD_FAILED_TEXT = '意见列表加载失败，请稍后刷新重试。';
const SUCCESS_TEXT = '提交成功，你的意见已保存。';

let browser;
test.before(async () => {
  browser = await launchBrowser();
});
test.after(async () => {
  await browser.close();
});

async function freshPage(app) {
  const page = await dom.open(browser, app.url);
  return page;
}

// 直接读取真实服务里的最新意见（绕过代理）
async function latestStoredIdea(app) {
  const res = await fetch(`${app.directUrl}api/ideas`);
  const data = await res.json();
  return data.ideas[0];
}

test('提交成功后：显示保存成功提示、清空三个输入框、新意见展示在已有记录之前', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  await createIdea(app.directUrl, { title: '已有意见甲', description: '甲的详细说明', scenario: '甲的场景' });
  await createIdea(app.directUrl, { title: '已有意见乙', description: '乙的详细说明' });

  const page = await freshPage(app);
  await dom.waitIdeas(page, 2);

  await dom.fill(page, { title: '新意见丙', description: '丙的详细说明', scenario: '丙的使用场景' });
  await dom.submit(page);

  await dom.waitSuccessVisible(page);
  const status = await dom.status(page);
  assert.equal(status.success.hidden, false);
  assert.equal(status.success.text, SUCCESS_TEXT);
  assert.equal(status.error.hidden, true);
  // 标题、详细说明、使用场景全部清空
  assert.deepEqual(await dom.values(page), { title: '', description: '', scenario: '' });

  const ideas = await dom.ideas(page);
  assert.equal(ideas.length, 3);
  assert.equal(ideas[0].title, '新意见丙');
  assert.equal(ideas[0].description, '丙的详细说明');
  assert.equal(ideas[0].hasScenario, true);
  assert.equal(ideas[0].scenario, '丙的使用场景');
  // 原记录保持接口返回的次序与内容
  assert.equal(ideas[1].title, '已有意见乙');
  assert.equal(ideas[2].title, '已有意见甲');

  // 展示内容与服务端记录一一对应（标题、正文、场景、提交时间）
  const stored = await latestStoredIdea(app);
  assert.equal(stored.title, '新意见丙');
  assert.equal(ideas[0].createdAt, stored.createdAt);
  assert.equal(ideas[1].createdAt, (await (await fetch(`${app.directUrl}api/ideas`)).json()).ideas[1].createdAt);

  assert.deepEqual(page.pageErrors, []);
  await dom.close(page);
});

test('提交时不填使用场景：列表不出现“使用场景”区块；纯空白场景同样不显示', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const page = await freshPage(app);
  await dom.waitEmptyText(page, EMPTY_TEXT);
  await dom.fill(page, { title: '无场景意见', description: '没有使用场景', scenario: '' });
  await dom.submit(page);
  await dom.waitSuccessVisible(page);
  let ideas = await dom.ideas(page);
  assert.equal(ideas.length, 1);
  assert.equal(ideas[0].hasScenario, false);

  await dom.fill(page, { title: '空白场景意见', description: '场景只有空格', scenario: '   ' });
  await dom.submit(page);
  await dom.waitSuccessVisible(page);
  ideas = await dom.ideas(page);
  assert.equal(ideas.length, 2);
  assert.equal(ideas[0].title, '空白场景意见');
  assert.equal(ideas[0].hasScenario, false);
  assert.equal(ideas[1].title, '无场景意见');
  await dom.close(page);
});

test('竞态·提交先返回：首次列表未结束时提交，提交意见立即可见，列表稍后返回后仍在最前且不重复', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  await createIdea(app.directUrl, { title: '历史意见', description: '服务端已有记录' });

  app.config.getIdeas = 'hold';
  const page = await freshPage(app);
  await app.waitForHeldGet();

  // 加载尚未结束时填写并提交
  await dom.fill(page, { title: '抢先返回的意见', description: '先于列表返回', scenario: '竞态场景' });
  await dom.submit(page);
  await dom.waitSuccessVisible(page);

  // 只有刚提交的意见可见；等待加载期间不得提示“还没有意见记录”
  await dom.waitIdeas(page, 1);
  let status = await dom.status(page);
  assert.equal((await dom.ideas(page))[0].title, '抢先返回的意见');
  assert.equal(status.empty.hidden, true);

  // 首次列表此时才返回（真实接口的响应里已包含刚提交的同一条记录）
  app.releaseGet();
  await dom.waitIdeas(page, 2);

  const ideas = await dom.ideas(page);
  assert.equal(ideas.length, 2, '同一条意见不得因两次返回都包含而显示两条');
  assert.equal(ideas[0].title, '抢先返回的意见');
  assert.equal(ideas[1].title, '历史意见');
  status = await dom.status(page);
  assert.equal(status.success.hidden, false, '保存成功提示仍然保留');
  assert.equal(status.empty.hidden, true);
  assert.deepEqual(page.pageErrors, []);
  await dom.close(page);
});

test('竞态·首次列表先返回：列表就绪后再提交，新意见同样插入最前', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  await createIdea(app.directUrl, { title: '历史意见A', description: 'A' });

  app.config.getIdeas = 'hold';
  const page = await freshPage(app);
  await app.waitForHeldGet();
  app.releaseGet();
  await dom.waitIdeas(page, 1);

  await dom.fill(page, { title: '后提交的意见', description: '列表已就绪后提交' });
  await dom.submit(page);
  await dom.waitSuccessVisible(page);
  await dom.waitIdeas(page, 2);

  const ideas = await dom.ideas(page);
  assert.equal(ideas[0].title, '后提交的意见');
  assert.equal(ideas[1].title, '历史意见A');
  await dom.close(page);
});

test('按 id 去重：列表返回同 id 记录只显示一次；标题正文相同但 id 不同的两条分别展示', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  app.config.getIdeas = 'hold';
  const page = await freshPage(app);
  await app.waitForHeldGet();

  await dom.fill(page, { title: '同样的标题', description: '同样的正文', scenario: '提交时的场景' });
  await dom.submit(page);
  await dom.waitSuccessVisible(page);
  const submitted = await latestStoredIdea(app);

  // 首次列表响应：包含同 id 的同一条（只展示一次），外加一条文字相同、id 不同的记录（必须分别展示）
  const sameTextDifferentId = {
    ...submitted,
    id: randomUUID(),
    scenario: '另一个场景',
    createdAt: '2020-01-02T03:04:05.000Z',
  };
  app.releaseGet({ json: { ideas: [submitted, sameTextDifferentId] } });

  await dom.waitIdeas(page, 2);
  const ideas = await dom.ideas(page);
  assert.equal(ideas.length, 2, '不能按文字内容合并，也不能把同 id 显示成两条');
  assert.equal(ideas[0].createdAt, submitted.createdAt, '本页提交的记录在前');
  assert.equal(ideas[0].scenario, '提交时的场景');
  assert.equal(ideas[1].title, '同样的标题');
  assert.equal(ideas[1].description, '同样的正文');
  assert.equal(ideas[1].scenario, '另一个场景');
  assert.equal(ideas[1].createdAt, '2020-01-02T03:04:05.000Z');
  assert.notEqual(ideas[0].createdAt, ideas[1].createdAt);
  assert.deepEqual(page.pageErrors, []);
  await dom.close(page);
});

test('同页先后提交两条：后提交的排最前，原记录次序不变，各条字段仍对应原记录', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  await createIdea(app.directUrl, { title: '历史意见', description: '历史正文' });

  const page = await freshPage(app);
  await dom.waitIdeas(page, 1);

  await dom.fill(page, { title: '第一条提交', description: '第一条正文', scenario: '场景一' });
  await dom.submit(page);
  await dom.waitSuccessVisible(page);
  await dom.waitIdeas(page, 2);

  await dom.fill(page, { title: '第二条提交', description: '第二条正文', scenario: '场景二' });
  await dom.submit(page);
  await dom.waitSuccessVisible(page);
  await dom.waitIdeas(page, 3);

  const ideas = await dom.ideas(page);
  assert.deepEqual(ideas.map((i) => i.title), ['第二条提交', '第一条提交', '历史意见']);
  assert.equal(ideas[0].description, '第二条正文');
  assert.equal(ideas[0].scenario, '场景二');
  assert.equal(ideas[1].description, '第一条正文');
  assert.equal(ideas[1].scenario, '场景一');
  assert.equal(ideas[2].description, '历史正文');

  // 提交时间各自对应：顺序与接口最新排序一致且互不相同
  const stored = (await (await fetch(`${app.directUrl}api/ideas`)).json()).ideas;
  assert.equal(ideas[0].createdAt, stored[0].createdAt);
  assert.equal(ideas[1].createdAt, stored[1].createdAt);
  assert.deepEqual(await dom.values(page), { title: '', description: '', scenario: '' });
  await dom.close(page);
});

test('首次列表等待中：不显示“还没有意见记录”；加载成功且确实为空时才显示', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  app.config.getIdeas = 'hold';
  const page = await freshPage(app);
  await app.waitForHeldGet();

  let status = await dom.status(page);
  assert.equal(status.empty.hidden, true, '加载中不能误报空列表');
  assert.equal(status.success.hidden, true);
  assert.equal(status.error.hidden, true);
  assert.equal((await dom.ideas(page)).length, 0);

  app.releaseGet();
  await dom.waitEmptyText(page, EMPTY_TEXT);
  await dom.close(page);
});

test('首次列表加载失败：显示加载失败提示，不当成没有记录，也不清掉本页已提交意见', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  app.config.getIdeas = 'fail';
  const page = await freshPage(app);
  await dom.waitEmptyText(page, LOAD_FAILED_TEXT);
  let status = await dom.status(page);
  assert.equal(status.success.hidden, true);

  // 加载失败后提交成功：新意见与加载失败提示同时可见
  await dom.fill(page, { title: '失败后提交的意见', description: '列表虽然失败但提交成功' });
  await dom.submit(page);
  await dom.waitSuccessVisible(page);
  await dom.waitIdeas(page, 1);

  status = await dom.status(page);
  assert.equal(status.success.hidden, false, '保存成功提示正常显示');
  assert.equal(status.empty.hidden, false, '加载失败提示不能被成功提交清除');
  assert.equal(status.empty.text, LOAD_FAILED_TEXT);
  assert.equal((await dom.ideas(page))[0].title, '失败后提交的意见');
  assert.deepEqual(await dom.values(page), { title: '', description: '', scenario: '' });
  assert.deepEqual(page.pageErrors, []);
  await dom.close(page);
});

test('提交返回失败状态：保留表单内容，提示提交失败，不显示成功、不插入列表，原记录保留', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  await createIdea(app.directUrl, { title: '原有意见', description: '原有正文' });
  app.config.postIdeas = 'fail';

  const page = await freshPage(app);
  await dom.waitIdeas(page, 1);

  await dom.fill(page, { title: '提交会失败', description: '失败的正文', scenario: '失败的场景' });
  await dom.submit(page);
  await dom.waitErrorVisible(page);

  const status = await dom.status(page);
  assert.equal(status.success.hidden, true);
  assert.match(status.error.text, /提交失败/);
  assert.deepEqual(await dom.values(page),
    { title: '提交会失败', description: '失败的正文', scenario: '失败的场景' }, '表单内容必须保留');
  const ideas = await dom.ideas(page);
  assert.equal(ideas.length, 1);
  assert.equal(ideas[0].title, '原有意见');
  assert.equal(status.empty.hidden, true);

  // 失败后恢复服务再提交成功：之前保留的记录仍在，新意见正常加入
  app.config.postIdeas = 'normal';
  await dom.submit(page);
  await dom.waitSuccessVisible(page);
  await dom.waitIdeas(page, 2);
  assert.equal((await dom.ideas(page))[0].title, '提交会失败');
  assert.equal((await dom.ideas(page))[1].title, '原有意见');
  await dom.close(page);
});

test('提交遇到网络错误：保留表单、提示网络错误、不插入列表', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  app.config.postIdeas = 'destroy';

  const page = await freshPage(app);
  await dom.waitEmptyText(page, EMPTY_TEXT);
  await dom.fill(page, { title: '网络中断的意见', description: '请求没有到达' });
  await dom.submit(page);
  await dom.waitErrorVisible(page);

  const status = await dom.status(page);
  assert.equal(status.success.hidden, true);
  assert.equal(status.error.text, '网络错误，提交未成功，请重试。');
  assert.deepEqual(await dom.values(page),
    { title: '网络中断的意见', description: '请求没有到达', scenario: '' });
  assert.equal((await dom.ideas(page)).length, 0);

  // 服务端确实没有这条记录
  const stored = (await (await fetch(`${app.directUrl}api/ideas`)).json()).ideas;
  assert.equal(stored.length, 0);
  await dom.close(page);
});

test('页面字段校验：标题为空时提示且不发请求，表单内容保留', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const page = await freshPage(app);
  await dom.waitEmptyText(page, EMPTY_TEXT);
  await dom.fill(page, { title: '   ', description: '正文内容', scenario: '场景' });
  await dom.submit(page);
  await dom.waitErrorVisible(page);

  const status = await dom.status(page);
  assert.match(status.error.text, /标题不能为空/);
  assert.equal(status.success.hidden, true);
  assert.equal(app.counts.postIdeas, 0, '校验未通过不应调用提交接口');
  assert.deepEqual(await dom.values(page),
    { title: '   ', description: '正文内容', scenario: '场景' });
  assert.equal((await dom.ideas(page)).length, 0);
  await dom.close(page);
});
