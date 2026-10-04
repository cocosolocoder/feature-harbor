import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { startServer, removeDataDir, type StartedServer } from '../testing/server.ts';

// 这些测试不在浏览器里跑，而是启动真实服务、GET / 取出页面里的内联脚本原文，
// 再放入带极简 DOM / 可控 fetch 的 vm 沙箱执行。被测脚本与线上页面逐字一致，
// 同时每个请求的成功、失败、返回先后都可以由测试精确控制。

let server: StartedServer;
let pageScript: string;

before(async () => {
  server = await startServer();
  const res = await fetch(`${server.origin}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  const start = html.indexOf('<script>');
  const end = html.lastIndexOf('</script>');
  assert.notEqual(start, -1);
  assert.ok(end > start);
  pageScript = html.slice(start + '<script>'.length, end);
});

after(async () => {
  await server.stop();
  removeDataDir(server);
});

interface El {
  tagName: string;
  className: string;
  hidden: boolean;
  value: string;
  dateTime: string;
  children: El[];
  text: string | null;
  textContent: string;
  listeners: Record<string, Array<(event: unknown) => unknown>>;
  append(...nodes: El[]): void;
  replaceChildren(...nodes: El[]): void;
  addEventListener(type: string, fn: (event: unknown) => unknown): void;
  reset(): void;
}

function makeElement(tag: string): El {
  const node = {
    tagName: tag.toUpperCase(),
    className: '',
    hidden: false,
    value: '',
    dateTime: '',
    children: [],
    text: null as string | null,
    listeners: {} as Record<string, Array<(event: unknown) => unknown>>,
    append(...nodes: El[]): void {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes: El[]): void {
      this.children = [...nodes];
    },
    addEventListener(type: string, fn: (event: unknown) => unknown): void {
      (this.listeners[type] ??= []).push(fn);
    },
    reset(): void {},
  };
  Object.defineProperty(node, 'textContent', {
    get(this: any): string {
      return this.text !== null ? this.text : this.children.map((c: El) => c.textContent).join('');
    },
    set(this: any, value: unknown): void {
      this.text = String(value);
    },
  });
  return node as El;
}

interface Gate {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function gate(): Gate {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(status: number, body: unknown): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function brokenJsonResponse(status = 201): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('响应体不是有效 JSON');
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let ideaSeq = 0;
function makeIdea(partial: Record<string, unknown> = {}): Record<string, unknown> {
  ideaSeq += 1;
  return {
    id: `id-${ideaSeq}`,
    title: `标题 ${ideaSeq}`,
    description: `详细说明 ${ideaSeq}`,
    scenario: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

const SUCCESS_TEXT = '提交成功，你的意见已保存。';
const EMPTY_TEXT = '还没有意见记录。';
const LOAD_FAILED_TEXT = '意见列表加载失败，请稍后刷新重试。';
const NETWORK_ERROR_TEXT = '网络错误，提交未成功，请重试。';

class Harness {
  els: Record<string, El> = {};
  gets: Gate[] = [];
  getsIssued = 0;
  posts: Gate[] = [];
  postsIssued = 0;
  postBodies: unknown[] = [];

  constructor(script: string) {
    const byId: Map<string, El> = new Map();
    const register = (id: string, tag: string, hidden = false): El => {
      const node = makeElement(tag);
      node.hidden = hidden;
      byId.set(id, node);
      this.els[id] = node;
      return node;
    };
    const form = register('idea-form', 'form');
    const titleInput = register('f-title', 'input');
    const descInput = register('f-desc', 'textarea');
    const scenarioInput = register('f-scenario', 'textarea');
    register('error', 'p', true);
    register('success', 'p', true);
    register('empty', 'p', true);
    register('ideas', 'div');
    form.reset = (): void => {
      titleInput.value = '';
      descInput.value = '';
      scenarioInput.value = '';
    };
    const documentMock = {
      getElementById: (id: string): El => byId.get(id)!,
      createElement: (tag: string): El => makeElement(tag),
    };
    const fetchMock = (url: unknown, init?: { method?: string; body?: unknown }): Promise<unknown> => {
      const method = init?.method ?? 'GET';
      const pending = gate();
      if (method === 'POST') {
        this.posts.push(pending);
        this.postsIssued += 1;
        this.postBodies.push(init?.body);
      } else {
        this.gets.push(pending);
        this.getsIssued += 1;
      }
      return pending.promise;
    };
    const context = vm.createContext({ console, document: documentMock, fetch: fetchMock });
    vm.runInContext(script, context, { filename: 'inline-page-script.js' });
  }

  setForm(values: { title?: string; description?: string; scenario?: string }): void {
    if (values.title !== undefined) this.els['f-title'].value = values.title;
    if (values.description !== undefined) this.els['f-desc'].value = values.description;
    if (values.scenario !== undefined) this.els['f-scenario'].value = values.scenario;
  }

  // 模拟真实用户输入：赋值并触发 input 事件（setForm 不触发事件，只用于布置初始状态）
  edit(id: string, value: string): void {
    const el = this.els[id];
    el.value = value;
    for (const fn of el.listeners.input ?? []) fn({ target: el });
  }

  // 触发表单 submit 监听器，返回监听器（async 函数）的 Promise
  submit(): Promise<unknown> {
    const handler = this.els['idea-form'].listeners.submit[0];
    return handler({ preventDefault(): void {} });
  }

  articles(): El[] {
    return this.els.ideas.children.filter((node) => node.tagName === 'ARTICLE');
  }

  titles(): string[] {
    return this.articles().map((article) => article.children.find((n) => n.tagName === 'H3')!.textContent);
  }
}

function findScenario(article: El): El | undefined {
  return article.children.find(
    (node) =>
      node.tagName === 'P' &&
      node.children.some((child) => child.tagName === 'STRONG' && child.textContent === '使用场景：'),
  );
}

// 校验一条已渲染的意见与原记录逐字段对应：标题、详细说明、非空使用场景、提交时间
function assertArticleMatches(article: El, idea: Record<string, unknown>): void {
  const heading = article.children.find((n) => n.tagName === 'H3')!;
  assert.equal(heading.textContent, idea.title);
  const description = article.children.find((n) => n.tagName === 'P' && n.children.length === 0)!;
  assert.equal(description.textContent, idea.description);
  const scenarioNode = findScenario(article);
  const expectsScenario =
    typeof idea.scenario === 'string' && idea.scenario.trim().length > 0;
  assert.equal(
    Boolean(scenarioNode),
    expectsScenario,
    `使用场景展示与否应与记录一致：${String(idea.scenario)}`,
  );
  if (expectsScenario) {
    const span = scenarioNode!.children.find((n) => n.tagName === 'SPAN')!;
    assert.equal(span.textContent, idea.scenario);
  }
  const time = article.children.find((n) => n.tagName === 'TIME')!;
  assert.equal(time.dateTime, idea.createdAt);
}

test('打开首页即请求首次列表；加载尚未结束时不显示“还没有意见记录”', () => {
  const h = new Harness(pageScript);
  assert.equal(h.gets.length, 1);
  assert.equal(h.els.empty.hidden, true);
  assert.equal(h.articles().length, 0);
});

test('提交成功（首次列表仍在加载）：显示保存成功、清空三个字段、新意见立即出现在列表中', async () => {
  const h = new Harness(pageScript);
  const mine = makeIdea({ id: 'a', title: '我的意见', description: '说明内容', scenario: '夜间使用' });
  h.setForm({ title: '我的意见', description: '说明内容', scenario: '夜间使用' });
  const done = h.submit();
  assert.equal(h.posts.length, 1);
  h.posts[0].resolve(jsonResponse(201, { idea: mine }));
  await done;
  await flush();

  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.success.textContent, SUCCESS_TEXT);
  assert.equal(h.els.error.hidden, true);
  assert.equal(h.els['f-title'].value, '');
  assert.equal(h.els['f-desc'].value, '');
  assert.equal(h.els['f-scenario'].value, '');
  assert.deepEqual(h.titles(), ['我的意见']);
  // 首次列表仍在等待，不能把等待误报成没有记录
  assert.equal(h.els.empty.hidden, true);
});

test('提交先返回、首次列表后返回且列表包含同一条：按 id 只显示一次，新意见在已有记录之前', async () => {
  const h = new Harness(pageScript);
  const mine = makeIdea({ id: 'a', title: '本页提交的标题', description: '本页提交的说明' });
  h.setForm({ title: '本页提交的标题', description: '本页提交的说明' });
  const submitted = h.submit();
  h.posts[0].resolve(jsonResponse(201, { idea: mine }));
  await submitted;

  const r1 = makeIdea({ id: 'r1', title: '已有意见一' });
  const r2 = makeIdea({ id: 'r2', title: '已有意见二' });
  // 晚到的列表也携带 id=a（文案不同，用于证明保留的是提交成功时拿到的那一条）
  const staleCopy = makeIdea({ id: 'a', title: '列表里的重复拷贝' });
  h.gets[0].resolve(jsonResponse(200, { ideas: [staleCopy, r1, r2] }));
  await flush();

  assert.deepEqual(h.titles(), ['本页提交的标题', '已有意见一', '已有意见二']);
});

test('提交先返回、首次列表后返回但不包含该意见：已保存意见不会被晚到的列表覆盖', async () => {
  const h = new Harness(pageScript);
  const mine = makeIdea({ id: 'a', title: '已保存的意见' });
  h.setForm({ title: '已保存的意见', description: '说明' });
  const submitted = h.submit();
  h.posts[0].resolve(jsonResponse(201, { idea: mine }));
  await submitted;

  const r1 = makeIdea({ id: 'r1', title: '服务端已有意见' });
  h.gets[0].resolve(jsonResponse(200, { ideas: [r1] }));
  await flush();

  assert.deepEqual(h.titles(), ['已保存的意见', '服务端已有意见']);
});

test('首次列表先返回、提交后返回：成功意见展示在已有记录之前，已有记录保持接口次序', async () => {
  const h = new Harness(pageScript);
  const r1 = makeIdea({ id: 'r1', title: '已有意见一' });
  const r2 = makeIdea({ id: 'r2', title: '已有意见二' });
  h.gets[0].resolve(jsonResponse(200, { ideas: [r1, r2] }));
  await flush();
  assert.deepEqual(h.titles(), ['已有意见一', '已有意见二']);

  const mine = makeIdea({ id: 'a', title: '新提交的意见' });
  h.setForm({ title: '新提交的意见', description: '说明' });
  const submitted = h.submit();
  h.posts[0].resolve(jsonResponse(201, { idea: mine }));
  await submitted;

  assert.deepEqual(h.titles(), ['新提交的意见', '已有意见一', '已有意见二']);
});

test('标题与正文相同但 id 不同：两条意见分别显示，不按文字内容合并', async () => {
  const h = new Harness(pageScript);
  const first = makeIdea({ id: 'x', title: '支持深色模式', description: '同样的详细说明' });
  h.gets[0].resolve(jsonResponse(200, { ideas: [first] }));
  await flush();

  const second = makeIdea({ id: 'y', title: '支持深色模式', description: '同样的详细说明' });
  h.setForm({ title: '支持深色模式', description: '同样的详细说明' });
  const submitted = h.submit();
  h.posts[0].resolve(jsonResponse(201, { idea: second }));
  await submitted;

  const articles = h.articles();
  assert.equal(articles.length, 2);
  assert.deepEqual(h.titles(), ['支持深色模式', '支持深色模式']);
  assertArticleMatches(articles[0], second);
  assertArticleMatches(articles[1], first);
});

test('同页先后成功提交两条：后提交的排在最前，其余记录保持接口返回次序，字段逐条对应', async () => {
  const h = new Harness(pageScript);
  const r1 = makeIdea({ id: 'r1', title: '记录一', description: '说明一', scenario: '', createdAt: '2026-02-01T01:01:01.000Z' });
  const r2 = makeIdea({ id: 'r2', title: '记录二', description: '说明二', scenario: '   ', createdAt: '2026-02-02T02:02:02.000Z' });
  const r3 = makeIdea({ id: 'r3', title: '记录三', description: '说明三', scenario: '夜间使用', createdAt: '2026-02-03T03:03:03.000Z' });
  h.gets[0].resolve(jsonResponse(200, { ideas: [r1, r2, r3] }));
  await flush();

  const firstSubmitted = makeIdea({ id: 'b', title: '先提交', description: '先提交的说明', scenario: '先提交的场景', createdAt: '2026-03-01T00:00:00.000Z' });
  const secondSubmitted = makeIdea({ id: 'a', title: '后提交', description: '后提交的说明', scenario: '', createdAt: '2026-03-02T00:00:00.000Z' });

  h.setForm({ title: '先提交', description: '先提交的说明', scenario: '先提交的场景' });
  const firstPost = h.submit();
  h.setForm({ title: '后提交', description: '后提交的说明', scenario: '' });
  const secondPost = h.submit();
  assert.equal(h.posts.length, 2);
  h.posts[0].resolve(jsonResponse(201, { idea: firstSubmitted }));
  await firstPost;
  h.posts[1].resolve(jsonResponse(201, { idea: secondSubmitted }));
  await secondPost;
  await flush();

  const expected = [secondSubmitted, firstSubmitted, r1, r2, r3];
  assert.deepEqual(h.titles(), ['后提交', '先提交', '记录一', '记录二', '记录三']);
  const articles = h.articles();
  assert.equal(articles.length, expected.length);
  expected.forEach((idea, index) => assertArticleMatches(articles[index], idea));
});

test('首次列表加载成功且确实没有意见时才显示空列表提示；提交成功后该提示消失', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();
  assert.equal(h.els.empty.hidden, false);
  assert.equal(h.els.empty.textContent, EMPTY_TEXT);

  const mine = makeIdea({ id: 'a', title: '第一条意见' });
  h.setForm({ title: '第一条意见', description: '说明' });
  const submitted = h.submit();
  h.posts[0].resolve(jsonResponse(201, { idea: mine }));
  await submitted;

  assert.equal(h.els.empty.hidden, true);
  assert.deepEqual(h.titles(), ['第一条意见']);
});

test('首次列表加载失败（网络错误）：显示加载失败提示，不能当成没有记录', async () => {
  const h = new Harness(pageScript);
  h.gets[0].reject(new TypeError('Failed to fetch'));
  await flush();

  assert.equal(h.els.empty.hidden, false);
  assert.equal(h.els.empty.textContent, LOAD_FAILED_TEXT);
  assert.equal(h.articles().length, 0);
  assert.equal(h.els.success.hidden, true);
  assert.equal(h.els.error.hidden, true);
});

test('首次列表返回 500：视为加载失败而不是空列表', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(500, { error: 'unable to read ideas' }));
  await flush();

  assert.equal(h.els.empty.hidden, false);
  assert.equal(h.els.empty.textContent, LOAD_FAILED_TEXT);
});

test('首次列表响应体不是有效 JSON：视为加载失败而不是空列表', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(brokenJsonResponse(200));
  await flush();

  assert.equal(h.els.empty.hidden, false);
  assert.equal(h.els.empty.textContent, LOAD_FAILED_TEXT);
});

test('顶层结构异常（空值、数组、其他类型或 ideas 缺失/不是数组）：一律视为加载失败', async (t) => {
  const validIdea = makeIdea({ id: 'r1' });
  const cases = [
    { name: '顶层为 null', body: null },
    { name: '顶层为数组', body: [{ ideas: [] }] },
    { name: '顶层为字符串', body: 'oops' },
    { name: '顶层为数字', body: 42 },
    { name: '缺少 ideas 字段', body: {} },
    { name: 'ideas 为 null', body: { ideas: null } },
    { name: 'ideas 为对象', body: { ideas: {} } },
    { name: 'ideas 为字符串', body: { ideas: JSON.stringify([validIdea]) } },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const h = new Harness(pageScript);
      h.gets[0].resolve(jsonResponse(200, c.body));
      await flush();

      assert.equal(h.els.empty.hidden, false, c.name);
      assert.equal(h.els.empty.textContent, LOAD_FAILED_TEXT, c.name);
      assert.equal(h.articles().length, 0, c.name);
    });
  }
});

test('数组中混入异常记录（空值、数组、非对象、缺字段、字段类型不符、空 id）：整次加载失败', async (t) => {
  const good = (): Record<string, unknown> => makeIdea({ id: 'r1' });
  const cases = [
    { name: '混入 null', record: null },
    { name: '混入数组', record: [] },
    { name: '混入字符串', record: 'r1' },
    { name: '混入数字', record: 1 },
    { name: '缺少 id', record: (() => { const r = good(); delete r.id; return r; })() },
    { name: 'id 为空字符串', record: { ...good(), id: '' } },
    { name: 'id 为数字', record: { ...good(), id: 1 } },
    { name: '缺少 title', record: (() => { const r = good(); delete r.title; return r; })() },
    { name: 'title 为数字', record: { ...good(), title: 1 } },
    { name: '缺少 description', record: (() => { const r = good(); delete r.description; return r; })() },
    { name: 'description 为 null', record: { ...good(), description: null } },
    { name: '缺少 scenario', record: (() => { const r = good(); delete r.scenario; return r; })() },
    { name: 'scenario 为数字', record: { ...good(), scenario: 0 } },
    { name: '缺少 createdAt', record: (() => { const r = good(); delete r.createdAt; return r; })() },
    { name: 'createdAt 为数字', record: { ...good(), createdAt: 0 } },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const h = new Harness(pageScript);
      h.gets[0].resolve(jsonResponse(200, { ideas: [good(), c.record] }));
      await flush();

      assert.equal(h.els.empty.hidden, false, c.name);
      assert.equal(h.els.empty.textContent, LOAD_FAILED_TEXT, c.name);
      // 即使异常记录前有正常意见，也不能只展示其中一部分
      assert.equal(h.articles().length, 0, c.name);
    });
  }
});

test('scenario 为空字符串是正常记录：空场景响应按成功处理，不显示加载失败提示', async () => {
  const h = new Harness(pageScript);
  const idea = makeIdea({ id: 'r1', title: '空场景意见', scenario: '' });
  h.gets[0].resolve(jsonResponse(200, { ideas: [idea] }));
  await flush();

  assert.equal(h.els.empty.hidden, true);
  assert.deepEqual(h.titles(), ['空场景意见']);
});

test('提交先确认保存、随后列表响应含异常记录：已保存意见与成功提示保留，同时显示加载失败，且不部分展示远端记录', async () => {
  const h = new Harness(pageScript);
  const mine = makeIdea({ id: 'a', title: '已保存的意见' });
  h.setForm({ title: '已保存的意见', description: '说明' });
  const submitted = h.submit();
  h.posts[0].resolve(jsonResponse(201, { idea: mine }));
  await submitted;

  // 异常记录前有一条正常远端记录，也不能把它当作完整列表的一部分展示
  const remote = makeIdea({ id: 'r1', title: '远端已有意见' });
  h.gets[0].resolve(jsonResponse(200, { ideas: [remote, null] }));
  await flush();

  assert.deepEqual(h.titles(), ['已保存的意见']);
  assert.equal(h.els.empty.hidden, false);
  assert.equal(h.els.empty.textContent, LOAD_FAILED_TEXT);
  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.success.textContent, SUCCESS_TEXT);
});

test('列表响应异常时正在填写的草稿三个字段不受影响', async () => {
  const h = new Harness(pageScript);
  const mine = makeIdea({ id: 'a', title: '上一条意见' });
  h.setForm({ title: '上一条意见', description: '上一条说明' });
  const submitted = h.submit();
  h.posts[0].resolve(jsonResponse(201, { idea: mine }));
  await submitted;

  // 列表返回前正在填写下一条
  h.edit('f-title', '正在写的标题');
  h.edit('f-desc', '正在写的说明');
  h.edit('f-scenario', '正在写的场景');
  h.gets[0].resolve(jsonResponse(200, { ideas: null }));
  await flush();

  assert.equal(h.els['f-title'].value, '正在写的标题');
  assert.equal(h.els['f-desc'].value, '正在写的说明');
  assert.equal(h.els['f-scenario'].value, '正在写的场景');
  assert.equal(h.els.empty.textContent, LOAD_FAILED_TEXT);
});

test('首次列表加载失败后提交成功：新意见与加载失败提示同时可见，成功提示不掩盖加载问题', async () => {
  const h = new Harness(pageScript);
  h.gets[0].reject(new TypeError('Failed to fetch'));
  await flush();

  const mine = makeIdea({ id: 'a', title: '失败后提交的意见' });
  h.setForm({ title: '失败后提交的意见', description: '说明' });
  const submitted = h.submit();
  h.posts[0].resolve(jsonResponse(201, { idea: mine }));
  await submitted;
  await flush();

  assert.deepEqual(h.titles(), ['失败后提交的意见']);
  assert.equal(h.els.empty.hidden, false);
  assert.equal(h.els.empty.textContent, LOAD_FAILED_TEXT);
  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.success.textContent, SUCCESS_TEXT);
});

test('提交成功后首次列表才失败：不清除已提交意见，同时显示加载失败提示', async () => {
  const h = new Harness(pageScript);
  const mine = makeIdea({ id: 'a', title: '已保存的意见' });
  h.setForm({ title: '已保存的意见', description: '说明' });
  const submitted = h.submit();
  h.posts[0].resolve(jsonResponse(201, { idea: mine }));
  await submitted;
  assert.deepEqual(h.titles(), ['已保存的意见']);

  h.gets[0].reject(new TypeError('Failed to fetch'));
  await flush();

  assert.deepEqual(h.titles(), ['已保存的意见']);
  assert.equal(h.els.empty.hidden, false);
  assert.equal(h.els.empty.textContent, LOAD_FAILED_TEXT);
});

test('提交网络失败：保留表单内容、提示提交失败、不显示成功、不插入列表，已有记录保留', async () => {
  const h = new Harness(pageScript);
  const r1 = makeIdea({ id: 'r1', title: '已有意见' });
  h.gets[0].resolve(jsonResponse(200, { ideas: [r1] }));
  await flush();

  h.setForm({ title: '未提交成功的标题', description: '未提交成功的说明', scenario: '保留的场景' });
  const failed = h.submit();
  h.posts[0].reject(new TypeError('Failed to fetch'));
  await failed;
  await flush();

  assert.equal(h.els.error.hidden, false);
  assert.equal(h.els.error.textContent, NETWORK_ERROR_TEXT);
  assert.equal(h.els.success.hidden, true);
  assert.equal(h.els['f-title'].value, '未提交成功的标题');
  assert.equal(h.els['f-desc'].value, '未提交成功的说明');
  assert.equal(h.els['f-scenario'].value, '保留的场景');
  assert.deepEqual(h.titles(), ['已有意见']);
});

test('提交返回错误状态或非法响应：展示失败信息、保留表单、列表不变', async (t) => {
  const cases = [
    {
      name: '400 携带服务端错误信息',
      response: jsonResponse(400, { error: '标题去掉首尾空白后不能为空' }),
      message: '提交失败：标题去掉首尾空白后不能为空',
    },
    {
      name: '500 携带服务端错误信息',
      response: jsonResponse(500, { error: '保存意见失败，请稍后重试' }),
      message: '提交失败：保存意见失败，请稍后重试',
    },
    {
      name: '201 但响应体不是有效 JSON',
      response: brokenJsonResponse(201),
      message: '提交失败，请稍后重试。',
    },
    {
      name: '201 但缺少 idea 字段',
      response: jsonResponse(201, { saved: true }),
      message: '提交失败，请稍后重试。',
    },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const h = new Harness(pageScript);
      const r1 = makeIdea({ id: 'r1', title: '已有意见' });
      h.gets[0].resolve(jsonResponse(200, { ideas: [r1] }));
      await flush();

      h.setForm({ title: '被拒绝的标题', description: '被拒绝的说明', scenario: '场景' });
      const failed = h.submit();
      h.posts[0].resolve(c.response);
      await failed;
      await flush();

      assert.equal(h.els.error.hidden, false);
      assert.equal(h.els.error.textContent, c.message);
      assert.equal(h.els.success.hidden, true);
      assert.equal(h.els['f-title'].value, '被拒绝的标题');
      assert.equal(h.els['f-desc'].value, '被拒绝的说明');
      assert.equal(h.els['f-scenario'].value, '场景');
      assert.deepEqual(h.titles(), ['已有意见']);
    });
  }
});

test('成功状态但响应结构或意见字段异常：一律提示失败、保留表单、列表与已有记录不变', async (t) => {
  const valid = (): Record<string, unknown> => makeIdea({ id: 'a' });
  const without = (field: string): Record<string, unknown> => {
    const record = valid();
    delete record[field];
    return record;
  };
  const cases = [
    { name: '顶层为 null', body: null },
    { name: '顶层为数组', body: [] },
    { name: '顶层为字符串', body: 'oops' },
    { name: '顶层为数字', body: 42 },
    { name: '缺少 idea 字段', body: { saved: true } },
    { name: 'idea 为空对象', body: { idea: {} } },
    { name: 'idea 为 null', body: { idea: null } },
    { name: 'idea 为数组', body: { idea: [] } },
    { name: 'idea 为字符串', body: { idea: 'a' } },
    { name: 'idea 为数字', body: { idea: 1 } },
    { name: 'idea 缺少 id', body: { idea: without('id') } },
    { name: 'idea 的 id 为空字符串', body: { idea: { ...valid(), id: '' } } },
    { name: 'idea 的 id 为数字', body: { idea: { ...valid(), id: 1 } } },
    { name: 'idea 缺少 title', body: { idea: without('title') } },
    { name: 'idea 的 title 为数字', body: { idea: { ...valid(), title: 1 } } },
    { name: 'idea 缺少 description', body: { idea: without('description') } },
    { name: 'idea 的 description 为 null', body: { idea: { ...valid(), description: null } } },
    { name: 'idea 缺少 scenario', body: { idea: without('scenario') } },
    { name: 'idea 的 scenario 为数字', body: { idea: { ...valid(), scenario: 0 } } },
    { name: 'idea 缺少 createdAt', body: { idea: without('createdAt') } },
    { name: 'idea 的 createdAt 为数字', body: { idea: { ...valid(), createdAt: 0 } } },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const h = new Harness(pageScript);
      const r1 = makeIdea({ id: 'r1', title: '已有意见一' });
      const r2 = makeIdea({ id: 'r2', title: '已有意见二' });
      h.gets[0].resolve(jsonResponse(200, { ideas: [r1, r2] }));
      await flush();

      h.setForm({ title: '被误判的标题', description: '被误判的说明', scenario: '场景' });
      const failed = h.submit();
      h.posts[0].resolve(jsonResponse(201, c.body));
      await failed;
      await flush();

      assert.equal(h.els.error.hidden, false, c.name);
      assert.equal(h.els.error.textContent, '提交失败，请稍后重试。', c.name);
      assert.equal(h.els.success.hidden, true, c.name);
      // 三个字段原样保留，异常记录不能造成草稿丢失
      assert.equal(h.els['f-title'].value, '被误判的标题', c.name);
      assert.equal(h.els['f-desc'].value, '被误判的说明', c.name);
      assert.equal(h.els['f-scenario'].value, '场景', c.name);
      // 异常记录不得进入列表，已有意见内容与次序保持原样
      assert.deepEqual(h.titles(), ['已有意见一', '已有意见二'], c.name);
    });
  }
});

test('成功状态但响应体不是有效 JSON：提示失败、保留表单、不插入列表', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();
  assert.equal(h.els.empty.hidden, false);

  h.setForm({ title: '标题', description: '说明' });
  const failed = h.submit();
  h.posts[0].resolve(brokenJsonResponse(201));
  await failed;
  await flush();

  assert.equal(h.els.error.hidden, false);
  assert.equal(h.els.error.textContent, '提交失败，请稍后重试。');
  assert.equal(h.els.success.hidden, true);
  assert.equal(h.els['f-title'].value, '标题');
  assert.equal(h.els['f-desc'].value, '说明');
  assert.equal(h.articles().length, 0);
  // 空列表提示不被异常提交改变
  assert.equal(h.els.empty.hidden, false);
  assert.equal(h.els.empty.textContent, EMPTY_TEXT);
});

test('提交返回异常期间继续编辑：失败后保留此刻完整草稿（未改动字段、空白、换行），不恢复提交时内容', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  h.setForm({ title: '第一条标题', description: '第一条说明', scenario: '第一条场景' });
  const failed = h.submit();

  // 等待期间继续写下一条：改标题与场景（含空白换行），详细说明保持不动
  h.edit('f-title', '第二条\n 标题  ');
  h.edit('f-scenario', '新场景\n\n含换行');

  h.posts[0].resolve(jsonResponse(201, { idea: {} }));
  await failed;
  await flush();

  assert.equal(h.els.error.hidden, false);
  assert.equal(h.els.error.textContent, '提交失败，请稍后重试。');
  assert.equal(h.els.success.hidden, true);
  // 保留的是失败到达此刻的草稿，而不是点击提交时的快照
  assert.equal(h.els['f-title'].value, '第二条\n 标题  ');
  assert.equal(h.els['f-desc'].value, '第一条说明');
  assert.equal(h.els['f-scenario'].value, '新场景\n\n含换行');
  assert.equal(h.articles().length, 0);
});

test('首次列表加载失败后提交返回异常：加载失败提示与提交失败提示同时保留，互不清除', async () => {
  const h = new Harness(pageScript);
  h.gets[0].reject(new TypeError('Failed to fetch'));
  await flush();

  h.setForm({ title: '标题', description: '说明' });
  const failed = h.submit();
  h.posts[0].resolve(jsonResponse(201, { idea: [] }));
  await failed;
  await flush();

  assert.equal(h.els.empty.hidden, false);
  assert.equal(h.els.empty.textContent, LOAD_FAILED_TEXT);
  assert.equal(h.els.error.hidden, false);
  assert.equal(h.els.error.textContent, '提交失败，请稍后重试。');
  assert.equal(h.els.success.hidden, true);
  assert.equal(h.els['f-title'].value, '标题');
  assert.equal(h.els['f-desc'].value, '说明');
  assert.equal(h.articles().length, 0);
});

test('异常响应处理后再次提交合法意见：正常显示成功、清空表单并插入列表，不受前次异常影响', async () => {
  const h = new Harness(pageScript);
  const r1 = makeIdea({ id: 'r1', title: '已有意见' });
  h.gets[0].resolve(jsonResponse(200, { ideas: [r1] }));
  await flush();

  h.setForm({ title: '重试标题', description: '重试说明' });
  const firstAttempt = h.submit();
  h.posts[0].resolve(jsonResponse(201, { idea: {} }));
  await firstAttempt;
  assert.equal(h.els.error.hidden, false);
  assert.equal(h.articles().length, 1);

  // 草稿仍在，可以直接再次提交
  const mine = makeIdea({ id: 'a', title: '重试标题', description: '重试说明' });
  const secondAttempt = h.submit();
  h.posts[1].resolve(jsonResponse(201, { idea: mine }));
  await secondAttempt;
  await flush();

  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.success.textContent, SUCCESS_TEXT);
  assert.equal(h.els.error.hidden, true);
  assert.equal(h.els['f-title'].value, '');
  assert.equal(h.els['f-desc'].value, '');
  assert.equal(h.els['f-scenario'].value, '');
  assert.deepEqual(h.titles(), ['重试标题', '已有意见']);
});

test('成功响应中 scenario 为空字符串仍属合法：正常保存成功，不因没有使用场景拒绝', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  const mine = makeIdea({ id: 'a', title: '空场景意见', description: '说明', scenario: '' });
  h.setForm({ title: '空场景意见', description: '说明' });
  const done = h.submit();
  h.posts[0].resolve(jsonResponse(201, { idea: mine }));
  await done;
  await flush();

  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.success.textContent, SUCCESS_TEXT);
  assert.equal(h.els.error.hidden, true);
  assert.equal(h.els['f-title'].value, '');
  const articles = h.articles();
  assert.equal(articles.length, 1);
  assertArticleMatches(articles[0], mine);
});

test('成功响应含其他附加字段不影响判断：意见照常保存并展示', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  const mine = { ...makeIdea({ id: 'a', title: '附加字段意见' }), extra: 'whatever', nested: { x: 1 } };
  h.setForm({ title: '附加字段意见', description: '说明' });
  const done = h.submit();
  h.posts[0].resolve(jsonResponse(201, { idea: mine, ok: true }));
  await done;
  await flush();

  assert.equal(h.els.success.hidden, false);
  assert.deepEqual(h.titles(), ['附加字段意见']);
});

test('提交失败后再次提交成功：失败提示清除、表单清空、新意见与已有意见同时展示', async () => {
  const h = new Harness(pageScript);
  const r1 = makeIdea({ id: 'r1', title: '已有意见' });
  h.gets[0].resolve(jsonResponse(200, { ideas: [r1] }));
  await flush();

  h.setForm({ title: '重试标题', description: '重试说明' });
  const firstAttempt = h.submit();
  h.posts[0].reject(new TypeError('Failed to fetch'));
  await firstAttempt;
  assert.equal(h.els.error.hidden, false);

  const mine = makeIdea({ id: 'a', title: '重试标题' });
  const secondAttempt = h.submit();
  h.posts[1].resolve(jsonResponse(201, { idea: mine }));
  await secondAttempt;
  await flush();

  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.success.textContent, SUCCESS_TEXT);
  assert.equal(h.els.error.hidden, true);
  assert.equal(h.els['f-title'].value, '');
  assert.equal(h.els['f-desc'].value, '');
  assert.deepEqual(h.titles(), ['重试标题', '已有意见']);
});

test('前端字段校验失败：不发送提交请求、显示对应错误、保留表单内容', async () => {
  const h = new Harness(pageScript);

  h.setForm({ title: '   ', description: '有效说明' });
  await h.submit();
  assert.equal(h.postsIssued, 0);
  assert.equal(h.els.error.hidden, false);
  assert.equal(h.els.error.textContent, '标题不能为空。');
  assert.equal(h.els['f-title'].value, '   ');
  assert.equal(h.els['f-desc'].value, '有效说明');

  h.setForm({ title: '有效标题', description: '   ' });
  await h.submit();
  assert.equal(h.postsIssued, 0);
  assert.equal(h.els.error.textContent, '详细说明不能为空。');
  assert.equal(h.els['f-desc'].value, '   ');
});

test('整个过程只发起一次首次列表请求，提交动作不会触发重新拉取列表', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();
  h.setForm({ title: '标题', description: '说明' });
  const submitted = h.submit();
  h.posts[0].resolve(jsonResponse(201, { idea: makeIdea({ id: 'a' }) }));
  await submitted;
  await flush();
  assert.equal(h.getsIssued, 1);
});

test('等待提交返回期间继续编辑：成功后完整保留草稿（含未改动字段、空白与换行），已保存意见仍入列表', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  h.setForm({ title: '第一条标题', description: '第一条说明', scenario: '第一条场景' });
  const submitted = h.submit();
  assert.equal(h.posts.length, 1);

  // 等待期间开始写下一条：改动标题与场景，详细说明保持不动
  h.edit('f-title', '第二条\n 标题  ');
  h.edit('f-scenario', '新场景\n\n含换行');

  const mine = makeIdea({ id: 'a', title: '第一条标题', description: '第一条说明', scenario: '第一条场景' });
  h.posts[0].resolve(jsonResponse(201, { idea: mine }));
  await submitted;
  await flush();

  // 发送的仍是点击提交时的快照，等待期间的新输入不能混入
  assert.deepEqual(JSON.parse(h.postBodies[0] as string), {
    title: '第一条标题',
    description: '第一条说明',
    scenario: '第一条场景',
  });
  // 三个输入框完整保留此刻内容，包括未改动的详细说明
  assert.equal(h.els['f-title'].value, '第二条\n 标题  ');
  assert.equal(h.els['f-desc'].value, '第一条说明');
  assert.equal(h.els['f-scenario'].value, '新场景\n\n含换行');
  // 仍提示上一条已保存，并按服务端返回的记录展示
  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.success.textContent, SUCCESS_TEXT);
  const articles = h.articles();
  assert.equal(articles.length, 1);
  assertArticleMatches(articles[0], mine);
});

test('等待期间修改后又改回原文：仍属继续编辑，成功响应保留当前草稿', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  h.setForm({ title: '原标题', description: '原说明', scenario: '原场景' });
  const submitted = h.submit();
  h.edit('f-title', '临时改动');
  h.edit('f-title', '原标题');

  h.posts[0].resolve(jsonResponse(201, { idea: makeIdea({ id: 'a', title: '原标题' }) }));
  await submitted;
  await flush();

  assert.equal(h.els['f-title'].value, '原标题');
  assert.equal(h.els['f-desc'].value, '原说明');
  assert.equal(h.els['f-scenario'].value, '原场景');
  assert.equal(h.els.success.hidden, false);
});

test('等待期间清空某个字段：成功响应不清表单，保留清空后的状态', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  h.setForm({ title: '标题', description: '说明', scenario: '场景' });
  const submitted = h.submit();
  h.edit('f-scenario', '');

  h.posts[0].resolve(jsonResponse(201, { idea: makeIdea({ id: 'a' }) }));
  await submitted;
  await flush();

  assert.equal(h.els['f-title'].value, '标题');
  assert.equal(h.els['f-desc'].value, '说明');
  assert.equal(h.els['f-scenario'].value, '');
  assert.equal(h.els.success.hidden, false);
});

test('等待期间保留的草稿可以直接再次提交：按原有规则校验并保存，不被当成已保存内容', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  h.setForm({ title: '第一条', description: '第一条说明' });
  const first = h.submit();
  h.edit('f-title', '第二条草稿');
  h.edit('f-desc', '第二条说明');
  h.posts[0].resolve(jsonResponse(201, { idea: makeIdea({ id: 'a', title: '第一条' }) }));
  await first;
  await flush();
  // 草稿未被自动提交
  assert.equal(h.postsIssued, 1);
  assert.deepEqual(h.titles(), ['第一条']);

  const secondIdea = makeIdea({ id: 'b', title: '第二条草稿', description: '第二条说明' });
  const second = h.submit();
  assert.equal(h.postsIssued, 2);
  assert.deepEqual(JSON.parse(h.postBodies[1] as string), {
    title: '第二条草稿',
    description: '第二条说明',
    scenario: '',
  });
  h.posts[1].resolve(jsonResponse(201, { idea: secondIdea }));
  await second;
  await flush();

  // 第二次提交后未再编辑，表单清空；两条意见各自出现在列表里
  assert.equal(h.els['f-title'].value, '');
  assert.equal(h.els['f-desc'].value, '');
  assert.deepEqual(h.titles(), ['第二条草稿', '第一条']);
});

test('两条提交同时在途：较早请求后返回也不能清除后一次提交之后输入的内容，两条意见都入列表', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  h.setForm({ title: '先提交', description: '先提交的说明' });
  const first = h.submit();
  h.setForm({ title: '后提交', description: '后提交的说明' });
  const second = h.submit();
  assert.equal(h.posts.length, 2);

  // 后一次提交之后继续输入新草稿
  h.edit('f-title', '正在写的第三条');

  // 较早的请求后返回成功
  h.posts[0].resolve(jsonResponse(201, { idea: makeIdea({ id: 'a', title: '先提交' }) }));
  await first;
  await flush();
  assert.equal(h.els['f-title'].value, '正在写的第三条');
  assert.equal(h.els['f-desc'].value, '后提交的说明');
  assert.deepEqual(h.titles(), ['先提交']);

  h.posts[1].resolve(jsonResponse(201, { idea: makeIdea({ id: 'b', title: '后提交' }) }));
  await second;
  await flush();
  assert.equal(h.els['f-title'].value, '正在写的第三条');
  assert.equal(h.els['f-desc'].value, '后提交的说明');
  assert.deepEqual(h.titles(), ['后提交', '先提交']);
});

test('两条提交在途且期间未编辑：先返回的成功清空表单，后返回的成功各自把意见放入列表', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  h.setForm({ title: '同文意见', description: '同样的说明' });
  const first = h.submit();
  const second = h.submit();
  assert.equal(h.posts.length, 2);

  h.posts[0].resolve(jsonResponse(201, { idea: makeIdea({ id: 'a', title: '同文意见', description: '同样的说明' }) }));
  await first;
  await flush();
  assert.equal(h.els['f-title'].value, '');

  h.posts[1].resolve(jsonResponse(201, { idea: makeIdea({ id: 'b', title: '同文意见', description: '同样的说明' }) }));
  await second;
  await flush();

  // 标题、正文相同但 id 不同，两条记录分别显示，不合并
  const articles = h.articles();
  assert.equal(articles.length, 2);
  assert.deepEqual(h.titles(), ['同文意见', '同文意见']);
});
