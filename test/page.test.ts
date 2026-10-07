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
  href: string;
  dateTime: string;
  children: El[];
  text: string | null;
  textContent: string;
  // 警戒标记：页面一旦通过 innerHTML 渲染内容即为 true（纯文本展示不允许走 innerHTML）
  innerHTMLAssigned: boolean;
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
    href: '',
    dateTime: '',
    children: [],
    text: null as string | null,
    innerHTMLAssigned: false,
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
  // innerHTML 只记录不解析：意见内容若改走 innerHTML 渲染，textContent 断言会失败，
  // innerHTMLAssigned 标记则给出更直接的原因
  Object.defineProperty(node, 'innerHTML', {
    get(): string {
      return '';
    },
    set(this: any, value: unknown): void {
      this.innerHTMLAssigned = true;
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
const NOT_FOUND_TEXT = '没有找到符合关键词的意见。';
const LOAD_FAILED_TEXT = '意见列表加载失败，请稍后刷新重试。';
const NETWORK_ERROR_TEXT = '网络错误，提交未成功，请重试。';
const SUBMIT_FAILED_TEXT = '提交失败，请稍后重试。';

class Harness {
  els: Record<string, El> = {};
  // 页面脚本通过 document.createElement 创建过的全部元素（按创建先后），
  // 用于断言渲染只产生纯文本结构，不为意见内容创建脚本、图片、链接、表单等元素
  created: El[] = [];
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
    register('search-form', 'form');
    register('f-search', 'input');
    register('search-clear', 'button');
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
      createElement: (tag: string): El => {
        const el = makeElement(tag);
        this.created.push(el);
        return el;
      },
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

  // 在搜索框布置文字（不触发事件）并点击“搜索”，返回监听器的返回值
  search(keyword: string): unknown {
    this.els['f-search'].value = keyword;
    const handler = this.els['search-form'].listeners.submit[0];
    return handler({ preventDefault(): void {} });
  }

  // 点击“清空”按钮
  clearSearch(): void {
    this.els['search-clear'].listeners.click[0]({});
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

function findViewLink(article: El): El | undefined {
  return article.children.find((node) => node.tagName === 'A' && node.className === 'view-link');
}

// 首页为某条意见生成的独立查看地址：标识恰为“.”或“..”时改走查询串
// （路径段会被网址路径归一化移除），其余标识走路径段；两者都经 encodeURIComponent。
function expectedViewHref(id: string): string {
  return id === '.' || id === '..'
    ? `/ideas?id=${encodeURIComponent(id)}`
    : `/ideas/${encodeURIComponent(id)}`;
}

// 校验一条已渲染的意见与原记录逐字段对应：标题、详细说明、非空使用场景、提交时间、
// 独立查看入口（链接只由该记录的 id 决定，与标题/说明文字无关）
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
  // 每条意见都有独立查看入口：href 只由 id 经 encodeURIComponent 拼成，可直接分享
  const viewLink = findViewLink(article);
  assert.ok(viewLink, '每条意见都应有查看入口');
  assert.equal(viewLink!.href, expectedViewHref(String(idea.id)));
  assert.equal(viewLink!.textContent, '查看这条意见');
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

// 201 表示服务端接受了请求，但页面只承认「确认返回的完整记录」：
// 响应必须可解析为带 idea 的 JSON 对象，且 idea 自身结构完整（非空字符串 id，
// title、description、scenario、createdAt 全部存在且为字符串）。
// 下面的用例只覆盖「响应可解析、状态为 201、但 idea 结构异常」这一类——
// 响应无法解析与整条 idea 缺失已由上面的用例覆盖。
function malformedSuccessBodies(): Array<{ name: string; body: unknown }> {
  const text = {
    id: 'a',
    title: '返回的标题',
    description: '返回的说明',
    scenario: '返回的场景',
    createdAt: '2026-03-01T00:00:00.000Z',
  };
  const without = (field: string): Record<string, unknown> => {
    const record = { ...text };
    delete record[field];
    return record;
  };
  return [
    // 顶层不是包含 idea 的对象
    { name: '顶层为 null', body: null },
    { name: '顶层为数组', body: [{ idea: text }] },
    { name: '顶层为普通字符串', body: JSON.stringify({ idea: text }) },
    { name: '顶层为数字', body: 1 },
    { name: '顶层没有 idea 字段（其他字段完整）', body: { saved: true, title: text.title } },
    // idea 是空值、数组或普通字符串等不能代表一条意见的内容
    { name: 'idea 为 null', body: { idea: null } },
    { name: 'idea 为 undefined（字段存在但无值）', body: { idea: undefined } },
    { name: 'idea 为数组', body: { idea: [text] } },
    { name: 'idea 为普通字符串', body: { idea: '返回的标题' } },
    { name: 'idea 为数字', body: { idea: 1 } },
    // idea 是对象、也带标题和正文，但标识不合法
    { name: 'id 为空字符串', body: { idea: { ...text, id: '' } } },
    { name: 'id 缺失', body: { idea: without('id') } },
    { name: 'id 为数字', body: { idea: { ...text, id: 1 } } },
    { name: 'id 为 null', body: { idea: { ...text, id: null } } },
    { name: 'id 为数组', body: { idea: { ...text, id: [] } } },
    // 标题、详细说明、使用场景、提交时间缺失或不是字符串
    { name: 'title 缺失', body: { idea: without('title') } },
    { name: 'title 为数字', body: { idea: { ...text, title: 1 } } },
    { name: 'title 为 null', body: { idea: { ...text, title: null } } },
    { name: 'description 缺失', body: { idea: without('description') } },
    { name: 'description 为数字', body: { idea: { ...text, description: 1 } } },
    { name: 'scenario 缺失（与空字符串不同）', body: { idea: without('scenario') } },
    { name: 'scenario 为数字', body: { idea: { ...text, scenario: 0 } } },
    { name: 'scenario 为 null', body: { idea: { ...text, scenario: null } } },
    { name: 'createdAt 缺失', body: { idea: without('createdAt') } },
    { name: 'createdAt 为数字', body: { idea: { ...text, createdAt: 0 } } },
    { name: 'createdAt 为 null', body: { idea: { ...text, createdAt: null } } },
  ];
}

test('201 但响应整体或 idea 结构异常：显示提交失败、保留三个输入框、不插入任何意见，已有记录的数量、顺序与内容保持原样', async (t) => {
  // 已有记录用不同的标题、说明、场景与时间，以便逐条核对失败后没有被改动或重排
  const existing = [
    makeIdea({ id: 'r1', title: '已有意见一', description: '已有说明一', scenario: '已有场景一', createdAt: '2026-01-01T01:01:01.000Z' }),
    makeIdea({ id: 'r2', title: '已有意见二', description: '已有说明二', scenario: '', createdAt: '2026-02-02T02:02:02.000Z' }),
    makeIdea({ id: 'r3', title: '已有意见三', description: '已有说明三', scenario: '已有场景三', createdAt: '2026-03-03T03:03:03.000Z' }),
  ];
  for (const c of malformedSuccessBodies()) {
    await t.test(c.name, async () => {
      const h = new Harness(pageScript);
      h.gets[0].resolve(jsonResponse(200, { ideas: existing }));
      await flush();

      // 表单文字故意与响应里带回的文字不同：不能拿提交时的表单文字补齐缺失字段
      h.setForm({ title: '表单里的标题', description: '表单里的说明', scenario: '表单里的场景' });
      const failed = h.submit();
      assert.equal(h.postsIssued, 1, c.name);
      h.posts[0].resolve(jsonResponse(201, c.body));
      await failed;
      await flush();

      // 显示现有的提交失败提示（不是字段校验错误，也没有成功提示）
      assert.equal(h.els.error.hidden, false, c.name);
      assert.equal(h.els.error.textContent, SUBMIT_FAILED_TEXT, c.name);
      assert.equal(h.els.success.hidden, true, c.name);
      // 三个输入框的内容原样保留，用户可以继续编辑后重试
      assert.equal(h.els['f-title'].value, '表单里的标题', c.name);
      assert.equal(h.els['f-desc'].value, '表单里的说明', c.name);
      assert.equal(h.els['f-scenario'].value, '表单里的场景', c.name);
      // 列表数量不变；逐条核对顺序与全部字段，不允许先插入不完整意见
      const articles = h.articles();
      assert.equal(articles.length, existing.length, c.name);
      existing.forEach((idea, index) => assertArticleMatches(articles[index], idea));
    });
  }
});

test('201 结构异常的失败响应到达后用户可继续编辑，随后收到完整记录：显示成功、把实际返回的意见放到列表最前、清空未继续编辑的表单，失败提示消失', async () => {
  const existing = [
    makeIdea({ id: 'r1', title: '已有意见一', description: '已有说明一', scenario: '已有场景一', createdAt: '2026-01-01T01:01:01.000Z' }),
    makeIdea({ id: 'r2', title: '已有意见二', description: '已有说明二', scenario: '', createdAt: '2026-02-02T02:02:02.000Z' }),
  ];
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: existing }));
  await flush();

  // 第一次提交：201 可解析，但 idea 缺 createdAt
  h.setForm({ title: '第一次的标题', description: '第一次的说明', scenario: '第一次的场景' });
  const firstAttempt = h.submit();
  h.posts[0].resolve(jsonResponse(201, {
    idea: { id: 'bad', title: '第一次的标题', description: '第一次的说明', scenario: '第一次的场景' },
  }));
  await firstAttempt;
  await flush();
  assert.equal(h.els.error.hidden, false);
  assert.equal(h.els.error.textContent, SUBMIT_FAILED_TEXT);
  assert.equal(h.els.success.hidden, true);
  assert.equal(h.articles().length, existing.length);

  // 用户继续编辑当前输入（失败没有打断编辑），随后再次提交
  h.edit('f-title', '重试后的标题');
  h.edit('f-desc', '重试后的说明');
  h.edit('f-scenario', '重试后的场景');
  const secondAttempt = h.submit();
  assert.equal(h.postsIssued, 2);
  // 发起新提交后上一条失败提示先消失
  assert.equal(h.els.error.hidden, true);
  assert.equal(h.els.success.hidden, true);

  // 这次返回结构完整的记录，且字段以实际响应为准（与表单文字刻意不同）
  const saved = makeIdea({
    id: 'a',
    title: '服务确认的标题',
    description: '服务确认的说明',
    scenario: '服务确认的场景',
    createdAt: '2026-04-04T04:04:04.000Z',
  });
  h.posts[1].resolve(jsonResponse(201, { idea: saved }));
  await secondAttempt;
  await flush();

  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.success.textContent, SUCCESS_TEXT);
  assert.equal(h.els.error.hidden, true);
  // 等待期间没有继续编辑：三个输入框清空
  assert.equal(h.els['f-title'].value, '');
  assert.equal(h.els['f-desc'].value, '');
  assert.equal(h.els['f-scenario'].value, '');
  // 实际返回的意见在最前，失败那次没有留下任何记录，已有意见顺序与内容不变
  const articles = h.articles();
  assert.equal(articles.length, existing.length + 1);
  assertArticleMatches(articles[0], saved);
  assertArticleMatches(articles[1], existing[0]);
  assertArticleMatches(articles[2], existing[1]);
});

test('201 结构异常后等待期间未编辑再提交成功：表单清空，失败提示不残留', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  h.setForm({ title: '标题', description: '说明', scenario: '场景' });
  const firstAttempt = h.submit();
  // idea 的 id 不是字符串
  h.posts[0].resolve(jsonResponse(201, { idea: { id: 7, title: '标题', description: '说明', scenario: '场景', createdAt: '2026-04-04T04:04:04.000Z' } }));
  await firstAttempt;
  await flush();
  assert.equal(h.els.error.hidden, false);
  assert.equal(h.els['f-title'].value, '标题');
  assert.equal(h.articles().length, 0);

  // 不改动任何输入，直接再次提交；这次记录完整
  const secondAttempt = h.submit();
  const saved = makeIdea({ id: 'a', title: '标题', description: '说明', scenario: '场景' });
  h.posts[1].resolve(jsonResponse(201, { idea: saved }));
  await secondAttempt;
  await flush();

  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.error.hidden, true);
  assert.equal(h.els['f-title'].value, '');
  assert.equal(h.els['f-desc'].value, '');
  assert.equal(h.els['f-scenario'].value, '');
  assert.equal(h.articles().length, 1);
});

test('提交成功的边界：idea 的使用场景为空字符串与缺少 scenario 字段不同，空字符串记录按成功展示且字段全部来自该记录', async () => {
  const existing = makeIdea({ id: 'r1', title: '已有意见', description: '已有说明', scenario: '已有场景', createdAt: '2026-01-01T00:00:00.000Z' });
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [existing] }));
  await flush();

  // 表单文字与响应不同：展示内容必须来自已确认记录，不能用输入框文字替代
  h.setForm({ title: '表单标题', description: '表单说明', scenario: '表单场景' });
  const submitted = h.submit();
  const saved = makeIdea({
    id: 'a',
    title: '空场景的确认标题',
    description: '空场景的确认说明',
    scenario: '',
    createdAt: '2026-05-05T05:05:05.000Z',
  });
  h.posts[0].resolve(jsonResponse(201, { idea: saved }));
  await submitted;
  await flush();

  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.success.textContent, SUCCESS_TEXT);
  assert.equal(h.els.error.hidden, true);
  assert.equal(h.els['f-title'].value, '');
  assert.equal(h.els['f-desc'].value, '');
  assert.equal(h.els['f-scenario'].value, '');
  const articles = h.articles();
  assert.equal(articles.length, 2);
  // 新记录在最前：标题、说明、提交时间来自响应，空场景不展示“使用场景”段
  assertArticleMatches(articles[0], saved);
  assert.equal(findScenario(articles[0]), undefined);
  assert.equal(articles[0].children.find((n) => n.tagName === 'TIME')!.dateTime, saved.createdAt);
  // 已有记录原样保留、各自字段不串
  assertArticleMatches(articles[1], existing);
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

// 提交提示归属：成功或失败提示只属于最近一次点击提交。用户可以在上一条请求还没返回时
// 再次点击提交，更早请求迟到的任何结果都不能改动当前提示；但旧请求被服务确认保存的意见
// 仍必须进入列表。下列用例精确控制两个 POST 的返回先后与结果类型。

function settleGate(g: Gate, outcome: 'network-error' | 'server-reject' | 'broken-json' | 'missing-idea' | 'malformed-idea'): void {
  if (outcome === 'network-error') {
    g.reject(new TypeError('Failed to fetch'));
  } else if (outcome === 'server-reject') {
    g.resolve(jsonResponse(400, { error: '较早一次提交被拒绝' }));
  } else if (outcome === 'broken-json') {
    g.resolve(brokenJsonResponse(201));
  } else if (outcome === 'malformed-idea') {
    // 可解析的 201：标题、正文、场景都带回来了，但缺少 createdAt，记录结构仍不完整
    g.resolve(jsonResponse(201, {
      idea: { id: 'stale', title: '迟到的标题', description: '迟到的说明', scenario: '' },
    }));
  } else {
    g.resolve(jsonResponse(201, { saved: true }));
  }
}

const STALE_FAILURE_KINDS = [
  { name: '网络错误', outcome: 'network-error' as const },
  { name: '服务拒绝（400）', outcome: 'server-reject' as const },
  { name: '201 但响应无法解析', outcome: 'broken-json' as const },
  { name: '201 但内容不完整（缺 idea）', outcome: 'missing-idea' as const },
  { name: '201 但意见结构异常（idea 缺 createdAt）', outcome: 'malformed-idea' as const },
];

test('后一次提交先确认保存后，较早请求迟到的各类失败都不能把成功提示改成失败', async (t) => {
  for (const c of STALE_FAILURE_KINDS) {
    await t.test(c.name, async () => {
      const h = new Harness(pageScript);
      h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
      await flush();

      h.setForm({ title: '先提交', description: '先提交的说明' });
      const first = h.submit();
      h.setForm({ title: '后提交', description: '后提交的说明' });
      const second = h.submit();
      assert.equal(h.posts.length, 2);

      // 后一次点击先确认保存：成功提示属于它
      h.posts[1].resolve(jsonResponse(201, { idea: makeIdea({ id: 'b', title: '后提交', description: '后提交的说明' }) }));
      await second;
      await flush();
      assert.equal(h.els.success.hidden, false);
      assert.equal(h.els.success.textContent, SUCCESS_TEXT);
      assert.equal(h.els.error.hidden, true);
      assert.deepEqual(h.titles(), ['后提交']);

      // 较早请求随后才失败：成功提示必须原样保留，不出现失败，失败的意见不入列表
      settleGate(h.posts[0], c.outcome);
      await first;
      await flush();
      assert.equal(h.els.success.hidden, false, c.name);
      assert.equal(h.els.success.textContent, SUCCESS_TEXT, c.name);
      assert.equal(h.els.error.hidden, true, c.name);
      assert.deepEqual(h.titles(), ['后提交'], c.name);
    });
  }
});

test('后一次提交先被服务拒绝、较早请求随后才确认保存：保留后一次失败说明，不另显示成功，先提交的意见仍带着自己的字段进入列表', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  const firstIdea = makeIdea({
    id: 'a',
    title: '先提交',
    description: '先提交的说明',
    scenario: '先提交的场景',
    createdAt: '2026-03-01T00:00:00.000Z',
  });
  h.setForm({ title: '先提交', description: '先提交的说明', scenario: '先提交的场景' });
  const first = h.submit();
  // 用 edit 布置第二条（触发 input 事件），模拟等待期间继续编辑后再次提交
  h.edit('f-title', '后提交');
  h.edit('f-desc', '后提交的说明');
  const second = h.submit();
  assert.equal(h.posts.length, 2);

  // 后一次点击先被拒绝：失败提示属于它
  h.posts[1].resolve(jsonResponse(400, { error: '后提交被拒绝' }));
  await second;
  await flush();
  assert.equal(h.els.error.hidden, false);
  assert.equal(h.els.error.textContent, '提交失败：后提交被拒绝');
  assert.equal(h.els.success.hidden, true);
  assert.equal(h.articles().length, 0);

  // 先提交随后才确认保存：失败提示原样保留、成功提示不出现；意见仍入列表，
  // 标题、详细说明、使用场景、时间逐条对应
  h.posts[0].resolve(jsonResponse(201, { idea: firstIdea }));
  await first;
  await flush();
  assert.equal(h.els.error.hidden, false);
  assert.equal(h.els.error.textContent, '提交失败：后提交被拒绝');
  assert.equal(h.els.success.hidden, true);
  const articles = h.articles();
  assert.equal(articles.length, 1);
  assertArticleMatches(articles[0], firstIdea);
  // 等待期间有编辑：迟到的成功受草稿保护，不能清掉当前输入
  assert.equal(h.els['f-title'].value, '后提交');
  assert.equal(h.els['f-desc'].value, '后提交的说明');
});

test('最近一次提交仍在等待时，较早请求确认保存不显示成功提示，但其意见进入列表；最近一次返回后只显示它自己的成功', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  h.setForm({ title: '先提交', description: '先提交的说明' });
  const first = h.submit();
  h.setForm({ title: '后提交', description: '后提交的说明' });
  const second = h.submit();
  assert.equal(h.posts.length, 2);

  // 较早请求先返回成功，但最近一次点击仍在等待：不能显示成功，
  // 以免让人误以为正在提交的第二条也已保存；已保存的第一条仍要出现在列表里
  h.posts[0].resolve(jsonResponse(201, { idea: makeIdea({ id: 'a', title: '先提交', description: '先提交的说明' }) }));
  await first;
  await flush();
  assert.equal(h.els.success.hidden, true);
  assert.equal(h.els.error.hidden, true);
  assert.deepEqual(h.titles(), ['先提交']);

  // 最近一次点击有了结果：只显示它的成功提示，两条意见都在
  h.posts[1].resolve(jsonResponse(201, { idea: makeIdea({ id: 'b', title: '后提交', description: '后提交的说明' }) }));
  await second;
  await flush();
  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.success.textContent, SUCCESS_TEXT);
  assert.equal(h.els.error.hidden, true);
  assert.deepEqual(h.titles(), ['后提交', '先提交']);
});

test('最近一次提交等待中较早请求失败不显示失败；最近一次被拒时显示的是它自己的失败说明', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  h.setForm({ title: '先提交', description: '先提交的说明' });
  const first = h.submit();
  h.setForm({ title: '后提交', description: '后提交的说明' });
  const second = h.submit();

  // 较早请求先网络失败，但最近一次点击仍在等待：不显示任何失败
  h.posts[0].reject(new TypeError('Failed to fetch'));
  await first;
  await flush();
  assert.equal(h.els.error.hidden, true);
  assert.equal(h.els.success.hidden, true);
  assert.equal(h.articles().length, 0);

  // 最近一次点击被服务拒绝：显示的必须是它自己的失败说明
  h.posts[1].resolve(jsonResponse(400, { error: '第二次提交的问题' }));
  await second;
  await flush();
  assert.equal(h.els.error.hidden, false);
  assert.equal(h.els.error.textContent, '提交失败：第二次提交的问题');
  assert.equal(h.els.success.hidden, true);
});

test('最近一次点击被表单校验直接拦下时保留字段错误；较早请求之后成功或失败都不能掩盖它', async (t) => {
  await t.test('较早请求迟到确认保存：字段错误保留、不显示成功，保存的意见仍入列表且草稿不清空', async () => {
    const h = new Harness(pageScript);
    h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
    await flush();

    h.setForm({ title: '先提交标题', description: '先提交说明' });
    const first = h.submit();
    assert.equal(h.postsIssued, 1);

    // 把标题改成空白后再次点击：请求都不会发出，字段错误就是最近一次提交操作的结果
    h.edit('f-title', '   ');
    await h.submit();
    assert.equal(h.postsIssued, 1);
    assert.equal(h.els.error.hidden, false);
    assert.equal(h.els.error.textContent, '标题不能为空。');
    assert.equal(h.els.success.hidden, true);

    // 较早请求随后确认保存：字段错误原样保留、成功不出现，意见仍入列表
    h.posts[0].resolve(jsonResponse(201, { idea: makeIdea({ id: 'a', title: '先提交标题', description: '先提交说明' }) }));
    await first;
    await flush();
    assert.equal(h.els.error.hidden, false);
    assert.equal(h.els.error.textContent, '标题不能为空。');
    assert.equal(h.els.success.hidden, true);
    assert.deepEqual(h.titles(), ['先提交标题']);
    // 点击后有编辑，迟到成功受草稿保护，空白标题与其他输入保留
    assert.equal(h.els['f-title'].value, '   ');
    assert.equal(h.els['f-desc'].value, '先提交说明');
  });

  for (const c of STALE_FAILURE_KINDS) {
    await t.test(`较早请求迟到失败（${c.name}）：字段错误不被网络/服务失败覆盖`, async () => {
      const h = new Harness(pageScript);
      h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
      await flush();

      h.setForm({ title: '先提交标题', description: '先提交说明' });
      const first = h.submit();
      h.edit('f-title', '   ');
      await h.submit();
      assert.equal(h.els.error.textContent, '标题不能为空。');

      settleGate(h.posts[0], c.outcome);
      await first;
      await flush();

      assert.equal(h.els.error.hidden, false, c.name);
      assert.equal(h.els.error.textContent, '标题不能为空。', c.name);
      assert.equal(h.els.success.hidden, true, c.name);
      assert.equal(h.articles().length, 0, c.name);
      assert.equal(h.els['f-title'].value, '   ', c.name);
    });
  }
});

test('发起新的提交后先清除上一条操作的提示：本次结果返回前不显示成功或失败', async (t) => {
  await t.test('上一条成功：再次点击提交后成功提示立即消失', async () => {
    const h = new Harness(pageScript);
    h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
    await flush();

    h.setForm({ title: '第一条', description: '第一条说明' });
    const first = h.submit();
    h.posts[0].resolve(jsonResponse(201, { idea: makeIdea({ id: 'a', title: '第一条' }) }));
    await first;
    await flush();
    assert.equal(h.els.success.hidden, false);

    h.edit('f-title', '第二条');
    h.edit('f-desc', '第二条说明');
    const second = h.submit();
    assert.equal(h.posts.length, 2);
    // 新点击已发起、结果未返回：上一条成功提示先被清除，且没有失败提示
    assert.equal(h.els.success.hidden, true);
    assert.equal(h.els.error.hidden, true);

    h.posts[1].resolve(jsonResponse(201, { idea: makeIdea({ id: 'b', title: '第二条' }) }));
    await second;
    await flush();
    assert.equal(h.els.success.hidden, false);
    assert.equal(h.els.success.textContent, SUCCESS_TEXT);
  });

  await t.test('上一条失败：再次点击提交后失败提示立即消失', async () => {
    const h = new Harness(pageScript);
    h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
    await flush();

    h.setForm({ title: '第一条', description: '第一条说明' });
    const first = h.submit();
    h.posts[0].reject(new TypeError('Failed to fetch'));
    await first;
    await flush();
    assert.equal(h.els.error.hidden, false);

    h.edit('f-title', '第二条');
    const second = h.submit();
    assert.equal(h.posts.length, 2);
    assert.equal(h.els.error.hidden, true);
    assert.equal(h.els.success.hidden, true);

    h.posts[1].resolve(jsonResponse(201, { idea: makeIdea({ id: 'b', title: '第二条' }) }));
    await second;
    await flush();
    assert.equal(h.els.success.hidden, false);
    assert.equal(h.els.error.hidden, true);
  });
});

test('两条提交都成功但返回次序颠倒：只显示最近一次的成功提示，不出现失败，两条意见分别保留且各自字段对应', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  const firstIdea = makeIdea({ id: 'a', title: '先提交', description: '先提交的说明', scenario: '先提交的场景', createdAt: '2026-03-01T00:00:00.000Z' });
  const secondIdea = makeIdea({ id: 'b', title: '后提交', description: '后提交的说明', scenario: '', createdAt: '2026-03-02T00:00:00.000Z' });
  h.setForm({ title: '先提交', description: '先提交的说明', scenario: '先提交的场景' });
  const first = h.submit();
  h.edit('f-title', '后提交');
  h.edit('f-desc', '后提交的说明');
  h.edit('f-scenario', '');
  const second = h.submit();

  // 后一次先返回成功
  h.posts[1].resolve(jsonResponse(201, { idea: secondIdea }));
  await second;
  await flush();
  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.error.hidden, true);
  assert.deepEqual(h.titles(), ['后提交']);

  // 较早一次随后成功：不出现失败/重复提示，两条意见都保留，字段逐条对应
  h.posts[0].resolve(jsonResponse(201, { idea: firstIdea }));
  await first;
  await flush();
  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.success.textContent, SUCCESS_TEXT);
  assert.equal(h.els.error.hidden, true);
  const articles = h.articles();
  assert.equal(articles.length, 2);
  assertArticleMatches(articles.find((a) => a.children.some((n) => n.tagName === 'H3' && n.textContent === '先提交'))!, firstIdea);
  assertArticleMatches(articles.find((a) => a.children.some((n) => n.tagName === 'H3' && n.textContent === '后提交'))!, secondIdea);
  // 第二次点击之后没有再编辑：最近一次成功按草稿保护规则清空表单（与响应先后无关）
  assert.equal(h.els['f-title'].value, '');
  assert.equal(h.els['f-desc'].value, '');
  assert.equal(h.els['f-scenario'].value, '');
});

test('两条提交返回次序颠倒：后提交的乙始终排在前，先提交的甲迟到确认后补入乙后面', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  // 两条记录提交时间相同：排列只按本页发起提交的先后，与时间无关
  const sameTime = '2026-03-01T00:00:00.000Z';
  const ideaA = makeIdea({ id: 'a', title: '甲', description: '甲的说明', scenario: '甲的场景', createdAt: sameTime });
  const ideaB = makeIdea({ id: 'b', title: '乙', description: '乙的说明', scenario: '', createdAt: sameTime });
  h.setForm({ title: '甲', description: '甲的说明', scenario: '甲的场景' });
  const first = h.submit();
  h.setForm({ title: '乙', description: '乙的说明' });
  const second = h.submit();
  assert.equal(h.posts.length, 2);

  // 乙先返回成功：先显示乙
  h.posts[1].resolve(jsonResponse(201, { idea: ideaB }));
  await second;
  await flush();
  assert.deepEqual(h.titles(), ['乙']);

  // 甲随后才返回成功：补入乙后面，不能把乙挤到第二位
  h.posts[0].resolve(jsonResponse(201, { idea: ideaA }));
  await first;
  await flush();
  assert.deepEqual(h.titles(), ['乙', '甲']);
  const articles = h.articles();
  assert.equal(articles.length, 2);
  assertArticleMatches(articles[0], ideaB);
  assertArticleMatches(articles[1], ideaA);
});

test('两条提交按发起次序返回：最终顺序同样是后提交的在前', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  const ideaA = makeIdea({ id: 'a', title: '甲', description: '甲的说明' });
  const ideaB = makeIdea({ id: 'b', title: '乙', description: '乙的说明' });
  h.setForm({ title: '甲', description: '甲的说明' });
  const first = h.submit();
  h.setForm({ title: '乙', description: '乙的说明' });
  const second = h.submit();

  h.posts[0].resolve(jsonResponse(201, { idea: ideaA }));
  await first;
  await flush();
  assert.deepEqual(h.titles(), ['甲']);

  h.posts[1].resolve(jsonResponse(201, { idea: ideaB }));
  await second;
  await flush();
  assert.deepEqual(h.titles(), ['乙', '甲']);
});

test('首次列表未返回时连续提交且返回次序颠倒：按提交先后排列，晚到的列表不覆盖也不重排', async () => {
  const h = new Harness(pageScript);

  const ideaA = makeIdea({ id: 'a', title: '甲', description: '甲的说明' });
  const ideaB = makeIdea({ id: 'b', title: '乙', description: '乙的说明' });
  h.setForm({ title: '甲', description: '甲的说明' });
  const first = h.submit();
  h.setForm({ title: '乙', description: '乙的说明' });
  const second = h.submit();

  // 首次列表仍在加载，乙先确认、甲随后确认
  h.posts[1].resolve(jsonResponse(201, { idea: ideaB }));
  await second;
  await flush();
  h.posts[0].resolve(jsonResponse(201, { idea: ideaA }));
  await first;
  await flush();
  assert.deepEqual(h.titles(), ['乙', '甲']);

  // 首次列表随后到达（含乙的重复拷贝与一条已有意见）：
  // 已保存意见不被覆盖、相对位置不变，已有记录按接口次序补在后面
  const remote = makeIdea({ id: 'r1', title: '已有意见' });
  const staleCopy = makeIdea({ id: 'b', title: '列表里的乙' });
  h.gets[0].resolve(jsonResponse(200, { ideas: [staleCopy, remote] }));
  await flush();
  assert.deepEqual(h.titles(), ['乙', '甲', '已有意见']);
  const articles = h.articles();
  assertArticleMatches(articles[0], ideaB);
  assertArticleMatches(articles[1], ideaA);
  assertArticleMatches(articles[2], remote);
});

test('先提交的甲失败、后提交的乙成功：乙正常展示且位置不受相邻失败影响', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  h.setForm({ title: '甲', description: '甲的说明' });
  const first = h.submit();
  h.setForm({ title: '乙', description: '乙的说明' });
  const second = h.submit();

  // 乙先确认保存
  h.posts[1].resolve(jsonResponse(201, { idea: makeIdea({ id: 'b', title: '乙' }) }));
  await second;
  await flush();
  assert.deepEqual(h.titles(), ['乙']);

  // 甲随后被服务拒绝：不出现占位意见，乙的位置不变
  h.posts[0].resolve(jsonResponse(400, { error: '甲被拒绝' }));
  await first;
  await flush();
  assert.deepEqual(h.titles(), ['乙']);
  assert.equal(h.articles().length, 1);
});

// 字符上限的首页表单回归。与 test/length-limits.test.ts 的接口用例使用同一批边界内容，
// 保证「首页表单」与「直接提交接口」两个入口对中文、表情、换行与首尾空白的接受/拒绝一致。
// 长度按 Unicode 码点计（标题 120、详细说明 5000、使用场景 1000）；
// 这些用例要能发现：表情被算成两个字符（UTF-16 码元）、按传输字节计数、
// 恰好达到上限被错误拒绝，以及前端对超限内容放行了请求。
const TITLE_LIMIT_ERROR = '标题最多 120 个字符。';
const DESC_LIMIT_ERROR = '详细说明最多 5000 个字符。';
const SCENARIO_LIMIT_ERROR = '使用场景最多 1000 个字符。';
const codePointCount = (text: string): number => Array.from(text).length;
const repeatCp = (char: string, times: number): string => char.repeat(times);

test('边界内容：三个字段同时达到各自上限（含中文、表情、换行与首尾空白），确认保存后显示成功、展示实际保存的意见、未继续编辑时三框清空', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  // 标题：去首尾空白后恰好 120 码点（59 中文 + 两个内部空格 + 59 中文），内部空白计入
  const typedTitle = '  ' + repeatCp('中', 59) + '  ' + repeatCp('中', 59) + '\t';
  const savedTitle = typedTitle.trim();
  assert.equal(codePointCount(savedTitle), 120);
  // 详细说明：首尾空白与换行计入长度，恰好 5000 码点
  const description = '  ' + repeatCp('中', 4995) + '\n  ';
  assert.equal(codePointCount(description), 5000);
  // 使用场景：中文与单个 😀 各算一个码点，恰好 1000 码点
  const scenario = repeatCp('中', 700) + repeatCp('😀', 200) + repeatCp('A', 98) + '\n\n';
  assert.equal(codePointCount(scenario), 1000);

  h.setForm({ title: typedTitle, description, scenario });
  const submitted = h.submit();
  // 合法边界必须放行请求；请求体是点击提交时的原文（标题的首尾空白由服务端处理）
  assert.equal(h.postsIssued, 1);
  assert.deepEqual(JSON.parse(h.postBodies[0] as string), {
    title: typedTitle,
    description,
    scenario,
  });

  // 服务确认保存后的记录：标题已去首尾空白、正文与场景原样保留
  const mine = makeIdea({ id: 'a', title: savedTitle, description, scenario });
  h.posts[0].resolve(jsonResponse(201, { idea: mine }));
  await submitted;
  await flush();

  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.success.textContent, SUCCESS_TEXT);
  assert.equal(h.els.error.hidden, true);
  // 等待期间没有继续编辑，三个输入框按现有行为清空
  assert.equal(h.els['f-title'].value, '');
  assert.equal(h.els['f-desc'].value, '');
  assert.equal(h.els['f-scenario'].value, '');
  // 列表展示的是实际保存的意见（标题为去空白后的结果，正文/场景含空白换行）
  const articles = h.articles();
  assert.equal(articles.length, 1);
  assertArticleMatches(articles[0], mine);
});

test('码点计数：表情与多码点文字凑出的恰好上限应通过表单校验（按 UTF-16 码元或字节计都会误判）', async (t) => {
  // 用转义写死组成：旗帜 2 码点、😮‍💨 3 码点、é(e+U+0301 组合重音) 2 码点
  const flag = '🇨🇳';
  const zwjEmoji = '😮‍💨';
  const combining = String.fromCodePoint(0x65, 0x301); // e + 组合重音 = 2 码点
  assert.deepEqual([flag, zwjEmoji, combining].map(codePointCount), [2, 3, 2]);

  const cases = [
    {
      name: '标题 119 中文 + 单个 😀 = 120 码点（😀 占 2 个 UTF-16 码元、4 个字节）',
      values: { title: repeatCp('中', 119) + '😀', description: '说明' },
    },
    {
      name: '详细说明为 5000 个 😀（码元 10000、字节 20000）',
      values: { title: '表情正文标题', description: repeatCp('😀', 5000) },
    },
    {
      name: '标题含旗帜、ZWJ 表情、组合字符，按各自码点累计恰好 120',
      values: { title: flag + zwjEmoji + combining + repeatCp('中', 113), description: '说明' },
    },
    {
      name: '使用场景 997 中文 + 旗帜(2) + 😀(1) = 1000 码点',
      values: { title: '场景标题', description: '说明', scenario: repeatCp('中', 997) + flag + '😀' },
    },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const h = new Harness(pageScript);
      h.setForm(c.values);
      const submitted = h.submit();
      assert.equal(h.postsIssued, 1, c.name);
      assert.equal(h.els.error.hidden, true, c.name);

      // 回包里的记录按原文展示，不被截断
      const saved = makeIdea({
        id: 'a',
        title: c.values.title.trim(),
        description: c.values.description,
        scenario: c.values.scenario ?? '',
      });
      h.posts[0].resolve(jsonResponse(201, { idea: saved }));
      await submitted;
      await flush();
      assert.equal(h.els.success.hidden, false, c.name);
      assert.equal(h.articles().length, 1, c.name);
      assertArticleMatches(h.articles()[0], saved);
    });
  }
});

test('任一超限字段：发出请求前显示对应字段错误，保留全部输入，不增加列表记录，也不出现保存成功提示', async (t) => {
  const cases = [
    {
      name: '标题 121 码点（中文）',
      values: { title: repeatCp('中', 121), description: '有效说明', scenario: '场景' },
      message: TITLE_LIMIT_ERROR,
    },
    {
      name: '标题去首尾空白后 121 码点（首尾空白不占额度）',
      values: { title: '  ' + repeatCp('中', 121) + ' ', description: '有效说明', scenario: '场景' },
      message: TITLE_LIMIT_ERROR,
    },
    {
      name: '标题 120 中文 + 单个 😀 = 121 码点',
      values: { title: repeatCp('中', 120) + '😀', description: '有效说明', scenario: '场景' },
      message: TITLE_LIMIT_ERROR,
    },
    {
      name: '详细说明 5001 码点（中文）',
      values: { title: '有效标题', description: repeatCp('中', 5001), scenario: '场景' },
      message: DESC_LIMIT_ERROR,
    },
    {
      name: '详细说明 5000 中文 + 单个 😀 = 5001 码点',
      values: { title: '有效标题', description: repeatCp('中', 5000) + '😀', scenario: '场景' },
      message: DESC_LIMIT_ERROR,
    },
    {
      name: '使用场景 1001 码点（中文）',
      values: { title: '有效标题', description: '有效说明', scenario: repeatCp('中', 1001) },
      message: SCENARIO_LIMIT_ERROR,
    },
    {
      name: '使用场景 1000 中文 + 单个 😀 = 1001 码点',
      values: { title: '有效标题', description: '有效说明', scenario: repeatCp('中', 1000) + '😀' },
      message: SCENARIO_LIMIT_ERROR,
    },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const h = new Harness(pageScript);
      const existing = makeIdea({ id: 'r1', title: '已有意见' });
      h.gets[0].resolve(jsonResponse(200, { ideas: [existing] }));
      await flush();

      h.setForm(c.values);
      await h.submit();

      // 前端校验必须拦住请求，不能把超限内容发给服务端
      assert.equal(h.postsIssued, 0, c.name);
      assert.equal(h.els.error.hidden, false, c.name);
      assert.equal(h.els.error.textContent, c.message, c.name);
      assert.equal(h.els.success.hidden, true, c.name);
      // 三个输入框内容全部保留，便于用户改短而不是重填
      assert.equal(h.els['f-title'].value, c.values.title, c.name);
      assert.equal(h.els['f-desc'].value, c.values.description, c.name);
      assert.equal(h.els['f-scenario'].value, c.values.scenario ?? '', c.name);
      // 列表不增加任何记录，已有记录保留
      assert.deepEqual(h.titles(), ['已有意见'], c.name);
    });
  }
});

test('首尾空白要区分对待：带首尾空白的合法上限标题可以提交；被空白推到超限的详细说明必须拒绝', async () => {
  // 前者：首尾空白在判定前去trim，内部 120 码点，首尾空白再多也允许，保存的是去空白标题
  const h1 = new Harness(pageScript);
  const paddedTitle = '   ' + repeatCp('中', 120) + '  ';
  assert.equal(codePointCount(paddedTitle.trim()), 120);
  h1.setForm({ title: paddedTitle, description: '说明' });
  const first = h1.submit();
  assert.equal(h1.postsIssued, 1);
  const saved = makeIdea({ id: 'a', title: paddedTitle.trim(), description: '说明' });
  h1.posts[0].resolve(jsonResponse(201, { idea: saved }));
  await first;
  await flush();
  assert.equal(h1.els.error.hidden, true);
  assert.equal(h1.els.success.hidden, false);
  assert.deepEqual(h1.titles(), [paddedTitle.trim()]);

  // 后者：非空白内容只有 4998 码点，但首尾 3 个空白把整条详细说明推到 5001 码点，必须拒绝
  const h2 = new Harness(pageScript);
  const paddedDescription = '  ' + repeatCp('中', 4998) + ' ';
  assert.equal(codePointCount(paddedDescription), 5001);
  assert.ok(codePointCount(paddedDescription.trim()) < 5000, '去掉空白后并未超限，用以证明计数含首尾空白');
  h2.setForm({ title: '有效标题', description: paddedDescription, scenario: '场景' });
  await h2.submit();
  assert.equal(h2.postsIssued, 0);
  assert.equal(h2.els.error.textContent, DESC_LIMIT_ERROR);
  assert.equal(h2.els.success.hidden, true);
  assert.equal(h2.els['f-desc'].value, paddedDescription);
  assert.equal(h2.articles().length, 0);
});

test('使用场景省略为空字符串仍可提交；场景首尾空白计入长度', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  h.setForm({ title: '空场景标题', description: '说明', scenario: '' });
  const submitted = h.submit();
  assert.equal(h.postsIssued, 1);
  assert.deepEqual(JSON.parse(h.postBodies[0] as string), {
    title: '空场景标题',
    description: '说明',
    scenario: '',
  });
  h.posts[0].resolve(jsonResponse(201, { idea: makeIdea({ id: 'a', title: '空场景标题', description: '说明', scenario: '' }) }));
  await submitted;
  await flush();
  assert.equal(h.els.success.hidden, false);

  // 999 中文 + 首尾两个空格 = 1001 码点：场景按原文计数，空白不能豁免
  const h2 = new Harness(pageScript);
  const paddedScenario = ' ' + repeatCp('中', 999) + ' ';
  assert.equal(codePointCount(paddedScenario), 1001);
  h2.setForm({ title: '标题', description: '说明', scenario: paddedScenario });
  await h2.submit();
  assert.equal(h2.postsIssued, 0);
  assert.equal(h2.els.error.textContent, SCENARIO_LIMIT_ERROR);
  assert.equal(h2.els['f-scenario'].value, paddedScenario);
});

test('超限被拦后把字段缩短到允许范围：可以正常提交，之前的错误不继续阻止保存', async (t) => {
  await t.test('标题缩短后提交成功', async () => {
    const h = new Harness(pageScript);
    h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
    await flush();

    h.setForm({ title: repeatCp('中', 121), description: '先超长后改短的说明', scenario: '场景' });
    await h.submit();
    assert.equal(h.postsIssued, 0);
    assert.equal(h.els.error.textContent, TITLE_LIMIT_ERROR);

    // 模拟用户把标题改到恰好上限；其余字段不动
    h.edit('f-title', repeatCp('中', 120));
    const retried = h.submit();
    assert.equal(h.postsIssued, 1, '只有缩短后的这一次真正发出请求');
    assert.equal(h.els.error.hidden, true);
    h.posts[0].resolve(jsonResponse(201, { idea: makeIdea({ id: 'a', title: repeatCp('中', 120), description: '先超长后改短的说明', scenario: '场景' }) }));
    await retried;
    await flush();

    assert.equal(h.els.success.hidden, false);
    assert.equal(h.els.success.textContent, SUCCESS_TEXT);
    assert.equal(h.els.error.hidden, true);
    assert.equal(h.els['f-title'].value, '');
    assert.equal(h.els['f-desc'].value, '');
    assert.equal(h.els['f-scenario'].value, '');
    assert.equal(h.articles().length, 1);
  });

  await t.test('被空白推超限的详细说明删一个首尾空白后提交成功，内容原样保留', async () => {
    const h = new Harness(pageScript);
    const tooLong = '  ' + repeatCp('中', 4998) + ' ';
    assert.equal(codePointCount(tooLong), 5001);
    h.setForm({ title: '标题', description: tooLong });
    await h.submit();
    assert.equal(h.postsIssued, 0);
    assert.equal(h.els.error.textContent, DESC_LIMIT_ERROR);

    const fixed = tooLong.trimStart() + '\n'; // 5000 码点，仍保留首尾空白与换行
    assert.equal(codePointCount(fixed), 5000);
    h.edit('f-desc', fixed);
    const retried = h.submit();
    assert.equal(h.postsIssued, 1);
    h.posts[0].resolve(jsonResponse(201, { idea: makeIdea({ id: 'b', title: '标题', description: fixed }) }));
    await retried;
    await flush();

    assert.equal(h.els.success.hidden, false);
    assert.equal(h.els.error.hidden, true);
    assertArticleMatches(h.articles()[0], makeIdea({ id: 'b', title: '标题', description: fixed }));
  });
});

// 纯文本展示回归：用户会在标题、详细说明、使用场景中粘贴网页片段、代码示例或报错内容。
// 这些文字（含看起来像网页标记的片段、脚本与事件属性、原文已有的 &lt; &amp; 等实体写法、
// 引号与尖括号）必须逐字按普通文字展示：不能被当成网页结构解析（不生成元素、不执行动作、
// 不触发额外请求），不能为避免解析而删改原文符号或整段内容，不能把实体解码成别的字符，
// 也不能再叠加一层转义。覆盖两种展示过程：打开首页加载已有意见、提交成功后新意见直接进入
// 列表；展示内容一律以接口实际返回的记录为准。这些用例要能发现：改用 innerHTML 渲染、
// 按标记解析文本、剥离尖括号内容、解码或重复转义实体、特殊文字串到相邻记录。

// 三个字段都带网页标记样文本；详细说明与使用场景同时含中文、表情、空行与首尾空白
const MARKUP_TITLE = '建议 <b>重点</b> 支持 "深色" 模式 😀';
const MARKUP_DESCRIPTION = [
  '  报错内容原样保留首尾空白  ',
  '',
  '代码片段 <script>alert("x")</script> 与图片样文本 <img src=x onerror="alert(1)">',
  '链接样文本 <a href="https://example.com">示例</a>、表单样文本 <form><input name="q"></form>',
  '实体原文 &lt;div&gt;、&amp;、&quot;引号&quot; 与 "双引号"、<尖括号> 😀',
  '  末行空白也保留  ',
].join('\n');
const MARKUP_SCENARIO = '  场景 <b>加粗</b> &lt;标签&gt; "引号" 😀\n\n含空行  ';

// 以实体写法为主的记录：&lt;、&amp;、引号必须保持字面内容，不解码也不再转义
const ENTITY_TITLE = '实体 &lt;b&gt; 与 &amp; 保持原文';
const ENTITY_DESCRIPTION = '已有写法 &lt;p&gt;段落&lt;/p&gt;、&amp;、&quot; 与 "引号" 逐字保留\n第二行 &lt;div&gt; 😀';
const ENTITY_SCENARIO = '&lt;场景&gt; &amp; "引号"';

// 渲染意见只应产生的元素；意见文字里的脚本、图片、链接、表单、加粗等标记
// 一旦被当成网页结构，就会多出此集合之外的元素
const RENDER_TAGS = new Set(['ARTICLE', 'H3', 'P', 'STRONG', 'SPAN', 'TIME', 'A']);

// 断言整个渲染过程只产生纯文本结构：不创建意见文字里出现的元素、不经过 innerHTML、
// 列表里只有意见记录本身（没有额外插入的表单或记录）
function assertPlainTextOnly(h: Harness): void {
  for (const el of h.created) {
    assert.ok(RENDER_TAGS.has(el.tagName), `不应为意见内容创建 ${el.tagName} 元素`);
    assert.equal(el.innerHTMLAssigned, false, '不应通过 innerHTML 渲染意见内容');
  }
  for (const child of h.els.ideas.children) {
    assert.equal(child.tagName, 'ARTICLE', '列表中不应插入意见记录之外的内容');
  }
}

test('首次列表加载：含网页标记样文本与实体原文的意见逐字按普通文字展示，不解析标记、不影响相邻记录', async () => {
  const h = new Harness(pageScript);
  const plain = makeIdea({ id: 'r1', title: '普通意见', description: '普通说明', scenario: '普通场景' });
  const markup = makeIdea({ id: 'r2', title: MARKUP_TITLE, description: MARKUP_DESCRIPTION, scenario: MARKUP_SCENARIO });
  const entity = makeIdea({ id: 'r3', title: ENTITY_TITLE, description: ENTITY_DESCRIPTION, scenario: '' });
  h.gets[0].resolve(jsonResponse(200, { ideas: [plain, markup, entity] }));
  await flush();

  // 含特殊文字的记录是合法意见：列表正常加载，不显示加载失败提示
  assert.equal(h.els.empty.hidden, true);
  assert.equal(h.els.error.hidden, true);
  // 渲染不触发额外的网络请求（不加载图片、不执行片段中的动作）
  assert.equal(h.getsIssued, 1);
  assert.equal(h.postsIssued, 0);

  // 排列保持接口次序，每条记录的字段各自对应、不串记录
  const articles = h.articles();
  assert.equal(articles.length, 3);
  assertArticleMatches(articles[0], plain);
  assertArticleMatches(articles[1], markup);
  assertArticleMatches(articles[2], entity);
  // 空字符串场景继续不显示“使用场景”段，也不被误报为异常
  assert.equal(findScenario(articles[2]), undefined);

  // “<b>重点</b>”连同尖括号一起读到：不能只剩“重点”，也不能变成加粗元素
  const heading = articles[1].children.find((n) => n.tagName === 'H3')!;
  assert.equal(heading.textContent, MARKUP_TITLE);
  assert.ok(heading.textContent.includes('<b>重点</b>'));
  assert.equal(heading.children.length, 0);

  // 详细说明逐字保留：脚本、事件属性、链接、表单样文本与空行、首尾空白都在
  const desc = articles[1].children.find((n) => n.tagName === 'P' && n.children.length === 0)!;
  assert.equal(desc.textContent, MARKUP_DESCRIPTION);
  assert.ok(desc.textContent.includes('<script>alert("x")</script>'));
  assert.ok(desc.textContent.includes('<img src=x onerror="alert(1)">'));
  assert.ok(desc.textContent.includes('\n\n'));
  assert.equal(desc.children.length, 0);

  // 使用场景同样逐字保留（含首尾空白与空行）
  const scenarioText = findScenario(articles[1])!.children.find((n) => n.tagName === 'SPAN')!;
  assert.equal(scenarioText.textContent, MARKUP_SCENARIO);
  assert.equal(scenarioText.children.length, 0);

  // 实体原文不解码也不再转义：读到的仍是 &lt;、&amp; 本身，而不是 < 或 &amp;lt;
  const entityHeading = articles[2].children.find((n) => n.tagName === 'H3')!;
  assert.equal(entityHeading.textContent, ENTITY_TITLE);
  assert.ok(entityHeading.textContent.includes('&lt;b&gt;'));
  assert.ok(!entityHeading.textContent.includes('<b>'));
  const entityDesc = articles[2].children.find((n) => n.tagName === 'P' && n.children.length === 0)!;
  assert.equal(entityDesc.textContent, ENTITY_DESCRIPTION);

  assertPlainTextOnly(h);
});

test('提交成功后：含网页标记样文本的新意见按接口返回的记录逐字进入列表，表单按现有行为清空', async () => {
  const h = new Harness(pageScript);
  const existing = makeIdea({ id: 'r1', title: '已有意见', description: '已有说明' });
  h.gets[0].resolve(jsonResponse(200, { ideas: [existing] }));
  await flush();

  // 标题带首尾空白：仍遵循现有处理（保存与展示去空白后的结果），不为这些片段另设规则
  const typedTitle = '  ' + MARKUP_TITLE + '  ';
  h.setForm({ title: typedTitle, description: MARKUP_DESCRIPTION, scenario: MARKUP_SCENARIO });
  const submitted = h.submit();
  assert.equal(h.postsIssued, 1);
  // 请求体逐字携带原文：不为避免被当成网页结构而删改符号或整段内容
  assert.deepEqual(JSON.parse(h.postBodies[0] as string), {
    title: typedTitle,
    description: MARKUP_DESCRIPTION,
    scenario: MARKUP_SCENARIO,
  });

  // 接口实际返回的记录：标题已去首尾空白，详细说明与使用场景逐字保留
  const saved = makeIdea({ id: 'a', title: MARKUP_TITLE, description: MARKUP_DESCRIPTION, scenario: MARKUP_SCENARIO });
  h.posts[0].resolve(jsonResponse(201, { idea: saved }));
  await submitted;
  await flush();

  // 这样的内容仍属合法意见：显示现有的成功提示，不出现提交失败
  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.success.textContent, SUCCESS_TEXT);
  assert.equal(h.els.error.hidden, true);
  // 等待期间没有继续编辑，三个输入框按现有行为清空
  assert.equal(h.els['f-title'].value, '');
  assert.equal(h.els['f-desc'].value, '');
  assert.equal(h.els['f-scenario'].value, '');

  // 新意见直接出现在列表最前，展示以接口返回为准；已有记录原样保留
  const articles = h.articles();
  assert.equal(articles.length, 2);
  assertArticleMatches(articles[0], saved);
  assertArticleMatches(articles[1], existing);
  const heading = articles[0].children.find((n) => n.tagName === 'H3')!;
  assert.equal(heading.textContent, MARKUP_TITLE);
  assert.ok(heading.textContent.includes('<b>重点</b>'));
  assert.equal(heading.children.length, 0);
  assertPlainTextOnly(h);
});

test('实体写法、引号与尖括号随提交逐字保存并展示：不解码、不额外转义，各字段对应自己的记录', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  h.setForm({ title: ENTITY_TITLE, description: ENTITY_DESCRIPTION, scenario: ENTITY_SCENARIO });
  const submitted = h.submit();
  assert.equal(h.postsIssued, 1);
  assert.deepEqual(JSON.parse(h.postBodies[0] as string), {
    title: ENTITY_TITLE,
    description: ENTITY_DESCRIPTION,
    scenario: ENTITY_SCENARIO,
  });

  const saved = makeIdea({ id: 'a', title: ENTITY_TITLE, description: ENTITY_DESCRIPTION, scenario: ENTITY_SCENARIO });
  h.posts[0].resolve(jsonResponse(201, { idea: saved }));
  await submitted;
  await flush();

  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.error.hidden, true);
  const articles = h.articles();
  assert.equal(articles.length, 1);
  assertArticleMatches(articles[0], saved);
  // 逐字相等已保证不解码、不再转义；这里再明确钉住关键片段的字面内容
  const heading = articles[0].children.find((n) => n.tagName === 'H3')!;
  assert.ok(heading.textContent.includes('&lt;b&gt;'));
  assert.ok(heading.textContent.includes('&amp;'));
  const scenarioText = findScenario(articles[0])!.children.find((n) => n.tagName === 'SPAN')!;
  assert.equal(scenarioText.textContent, ENTITY_SCENARIO);
  assertPlainTextOnly(h);
});

test('特殊文字意见与普通意见混排：相邻记录与排列不受影响，表单仍可继续填写并正常提交下一条', async () => {
  const h = new Harness(pageScript);
  const plainA = makeIdea({ id: 'r1', title: '普通意见一', description: '普通说明一', scenario: '场景一' });
  const markup = makeIdea({ id: 'r2', title: MARKUP_TITLE, description: MARKUP_DESCRIPTION, scenario: MARKUP_SCENARIO });
  const plainB = makeIdea({ id: 'r3', title: '普通意见二', description: '普通说明二' });
  h.gets[0].resolve(jsonResponse(200, { ideas: [plainA, markup, plainB] }));
  await flush();

  // 特殊文字不影响相邻记录的展示与原有排列
  let articles = h.articles();
  assert.equal(articles.length, 3);
  assert.deepEqual(h.titles(), [plainA.title, markup.title, plainB.title]);
  assertArticleMatches(articles[0], plainA);
  assertArticleMatches(articles[1], markup);
  assertArticleMatches(articles[2], plainB);

  // 用户继续填写并正常提交下一条意见
  h.edit('f-title', '下一条意见');
  h.edit('f-desc', '下一条说明');
  const submitted = h.submit();
  assert.equal(h.postsIssued, 1);
  const next = makeIdea({ id: 'a', title: '下一条意见', description: '下一条说明', scenario: '' });
  h.posts[0].resolve(jsonResponse(201, { idea: next }));
  await submitted;
  await flush();

  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.success.textContent, SUCCESS_TEXT);
  assert.equal(h.els.error.hidden, true);
  // 新意见排最前，其余记录（含特殊文字记录）的次序与内容原样保留
  articles = h.articles();
  assert.equal(articles.length, 4);
  assertArticleMatches(articles[0], next);
  assertArticleMatches(articles[1], plainA);
  assertArticleMatches(articles[2], markup);
  assertArticleMatches(articles[3], plainB);
  assertPlainTextOnly(h);
});

// 关键词搜索回归：搜索只影响首页当前看到的列表——纯文本、大小写不敏感、
// 一段完整关键词（内部空格按原文、标点与正则样文字按普通文字），
// 只在客户端过滤已合并的完整列表，不发请求、不改保存、不碰提交表单草稿。

test('搜索：关键词命中标题、详细说明、使用场景任一字段即显示，英文大小写不影响匹配，首尾空白忽略', async () => {
  const inTitle = makeIdea({ id: 'r1', title: '支持 Apple 深色模式', description: '普通说明', scenario: '' });
  const inDesc = makeIdea({ id: 'r2', title: '普通标题', description: '正文里提到 Apple 一次', scenario: '' });
  const inScenario = makeIdea({ id: 'r3', title: '普通标题', description: '普通说明', scenario: '夜间 apple 使用' });
  const none = makeIdea({ id: 'r4', title: '完全不沾边', description: '另外的内容', scenario: '其他场景' });
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [inTitle, inDesc, inScenario, none] }));
  await flush();
  assert.equal(h.articles().length, 4);

  h.search('  APPLE  '); // 首尾空白应在生效前去掉
  assert.equal(h.getsIssued, 1, '搜索不发起网络请求');
  assert.equal(h.postsIssued, 0);
  // 沿用接口原有顺序，不重排；每条只出现一次
  assert.deepEqual(h.titles(), ['支持 Apple 深色模式', '普通标题', '普通标题']);
  // 命中记录的全部字段仍按原文渲染，字段对应关系不变
  assertArticleMatches(h.articles()[1], inDesc);
  assertArticleMatches(h.articles()[2], inScenario);
});

test('搜索：关键词是一段完整文字，内部空格按原文比较，不拆成多个词', async () => {
  const match = makeIdea({ id: 'r1', title: '深色 模式', description: '说明', scenario: '' });
  const reversed = makeIdea({ id: 'r2', title: '模式 深色', description: '说明', scenario: '' });
  const single = makeIdea({ id: 'r3', title: '深色与模式', description: '说明', scenario: '' });
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [match, reversed, single] }));
  await flush();

  h.search('深色 模式');
  assert.deepEqual(h.titles(), ['深色 模式']);
  assert.equal(h.els.empty.hidden, true);

  // 换一个内部含多个连续空格的关键词，同样按整段比较
  h.search('深色  模式');
  assert.deepEqual(h.titles(), []);
});

test('搜索：标点、尖括号与看起来像正则表达式的文字一律按普通文字查找', async () => {
  const regexLike = makeIdea({
    id: 'r1',
    title: '普通标题',
    description: '希望支持 a.c 与 [abc] 这样的写法，以及 ^start$ 和 x+y*? 等符号',
    scenario: '',
  });
  // 含 "abc" 但不含逐字 "a.c"：若关键词被当成正则，"a.c" 会误命中这条
  const dotTrick = makeIdea({ id: 'r3', title: '字母连写', description: '比如 abc 这样的连写', scenario: '' });
  const markup = makeIdea({
    id: 'r2',
    title: '建议 <b>重点</b> 加粗',
    description: '样例 <img src=x onerror="alert(1)"> 原样显示',
    scenario: '场景 (一) · 分隔',
  });
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [regexLike, dotTrick, markup] }));
  await flush();

  // 正则元字符按普通字符："a.c" 只能逐字命中，不能像正则那样匹配 "abc"
  h.search('a.c');
  assert.deepEqual(h.titles(), ['普通标题']);
  h.search('[abc]');
  assert.deepEqual(h.titles(), ['普通标题']);
  h.search('^start$');
  assert.deepEqual(h.titles(), ['普通标题']);
  h.search('x+y*?');
  assert.deepEqual(h.titles(), ['普通标题']);
  // 改成逐字片段后，"abc" 记录可以正常命中
  h.search('abc');
  assert.deepEqual(h.titles(), ['普通标题', '字母连写']);

  // 尖括号与标点同样按普通文字逐字命中
  h.search('<b>重点</b>');
  assert.deepEqual(h.titles(), ['建议 <b>重点</b> 加粗']);
  h.search('onerror="alert(1)"');
  assert.deepEqual(h.titles(), ['建议 <b>重点</b> 加粗']);
  h.search('(一) ·');
  assert.deepEqual(h.titles(), ['建议 <b>重点</b> 加粗']);
});

test('搜索：命中结果沿用原有排列，同一条只显示一次，内容相同但 id 不同的记录分别保留', async () => {
  const r1 = makeIdea({ id: 'r1', title: '重复关键词', description: '说明一' });
  const r2 = makeIdea({ id: 'r2', title: '别的标题', description: '不含关键词' });
  const r3 = makeIdea({ id: 'r3', title: '重复关键词', description: '说明三' });
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [r1, r2, r3] }));
  await flush();

  h.search('重复关键词');
  const articles = h.articles();
  assert.equal(articles.length, 2);
  assertArticleMatches(articles[0], r1);
  assertArticleMatches(articles[1], r3);
});

test('搜索：关键词为空或只有空白时恢复完整列表并沿用原顺序；清空按钮等价于清空关键词', async () => {
  const ideas = [
    makeIdea({ id: 'r1', title: '苹果意见', description: '说明一' }),
    makeIdea({ id: 'r2', title: '香蕉意见', description: '说明二' }),
    makeIdea({ id: 'r3', title: '橘子意见', description: '说明三' }),
  ];
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas }));
  await flush();

  h.search('苹果');
  assert.deepEqual(h.titles(), ['苹果意见']);
  h.search('   \t\n  ');
  assert.deepEqual(h.titles(), ['苹果意见', '香蕉意见', '橘子意见']);
  assert.equal(h.els.empty.hidden, true);

  h.search('香蕉');
  assert.deepEqual(h.titles(), ['香蕉意见']);
  h.clearSearch();
  assert.equal(h.els['f-search'].value, '');
  assert.deepEqual(h.titles(), ['苹果意见', '香蕉意见', '橘子意见']);
});

test('搜索：首次加载成功且完整列表为空时仍提示“还没有意见记录”，不把它说成没有找到', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  h.search('任意关键词');
  assert.equal(h.articles().length, 0);
  assert.equal(h.els.empty.hidden, false);
  assert.equal(h.els.empty.textContent, EMPTY_TEXT);
  // 用户仍可修改或清空关键词
  h.clearSearch();
  assert.equal(h.els.empty.textContent, EMPTY_TEXT);
});

test('搜索：已有意见但没有匹配结果时显示明确的未找到提示，换词或清空后恢复', async () => {
  const ideas = [
    makeIdea({ id: 'r1', title: '深色模式', description: '说明一' }),
    makeIdea({ id: 'r2', title: '导出数据', description: '说明二' }),
  ];
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas }));
  await flush();

  h.search('完全不存在的关键词');
  assert.equal(h.articles().length, 0);
  assert.equal(h.els.empty.hidden, false);
  assert.equal(h.els.empty.textContent, NOT_FOUND_TEXT);

  // 修改成能命中的关键词后立即恢复展示
  h.search('导出');
  assert.deepEqual(h.titles(), ['导出数据']);
  assert.equal(h.els.empty.hidden, true);

  // 再次无匹配；清空关键词回到完整列表，未找到提示消失
  h.search('xyz');
  assert.equal(h.els.empty.textContent, NOT_FOUND_TEXT);
  h.search('');
  assert.deepEqual(h.titles(), ['深色模式', '导出数据']);
  assert.equal(h.els.empty.hidden, true);
});

test('搜索：首次列表尚未返回时不能提前断言没有匹配；迟到的列表按已生效关键词更新结果', async () => {
  const h = new Harness(pageScript);
  // 列表还在途就先发起搜索
  h.search('深色');
  assert.equal(h.els.empty.hidden, true, '加载中不显示未找到或空列表提示');
  assert.equal(h.articles().length, 0);

  const r1 = makeIdea({ id: 'r1', title: '深色模式', description: '说明一' });
  const r2 = makeIdea({ id: 'r2', title: '导出数据', description: '说明二' });
  const r3 = makeIdea({ id: 'r3', title: '深色主题再一条', description: '说明三' });
  h.gets[0].resolve(jsonResponse(200, { ideas: [r1, r2, r3] }));
  await flush();

  // 迟到的列表直接按已生效关键词展示
  assert.deepEqual(h.titles(), ['深色模式', '深色主题再一条']);
  assert.equal(h.els.empty.hidden, true);
});

test('搜索：首次列表加载失败时继续显示加载失败提示，不能把失败显示成搜索无结果', async () => {
  const h = new Harness(pageScript);
  h.gets[0].reject(new TypeError('Failed to fetch'));
  await flush();

  h.search('深色');
  assert.equal(h.els.empty.hidden, false);
  assert.equal(h.els.empty.textContent, LOAD_FAILED_TEXT);
  assert.equal(h.articles().length, 0);

  // 清空关键词也不能把失败状态洗白成空列表
  h.clearSearch();
  assert.equal(h.els.empty.textContent, LOAD_FAILED_TEXT);
});

test('搜索生效后本页提交的新意见：符合关键词的按原顺序出现，不符合的仍已保存，清空后可见且不报失败', async () => {
  const remote = makeIdea({ id: 'r1', title: '已有深色意见', description: '已有说明' });
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [remote] }));
  await flush();

  h.search('深色');
  assert.deepEqual(h.titles(), ['已有深色意见']);

  // 在搜索生效期间填写并提交一条不符合关键词的新意见
  h.setForm({ title: '完全无关的标题', description: '完全无关的说明' });
  const savedUnrelated = makeIdea({ id: 'a', title: '完全无关的标题', description: '完全无关的说明' });
  const firstSubmit = h.submit();
  assert.equal(h.postsIssued, 1);
  h.posts[0].resolve(jsonResponse(201, { idea: savedUnrelated }));
  await firstSubmit;
  await flush();
  // 服务已确认保存，不能提示失败；只是按当前关键词暂时不可见
  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.success.textContent, SUCCESS_TEXT);
  assert.equal(h.els.error.hidden, true);
  assert.deepEqual(h.titles(), ['已有深色意见']);

  // 再提交一条符合关键词的新意见：按原有规则排在最前
  h.setForm({ title: '新的深色意见', description: '新的说明' });
  const savedMatch = makeIdea({ id: 'b', title: '新的深色意见', description: '新的说明' });
  const secondSubmit = h.submit();
  h.posts[1].resolve(jsonResponse(201, { idea: savedMatch }));
  await secondSubmit;
  await flush();
  assert.deepEqual(h.titles(), ['新的深色意见', '已有深色意见']);

  // 清空搜索后，暂时不可见的已保存意见按原有顺序出现
  h.clearSearch();
  assert.deepEqual(h.titles(), ['新的深色意见', '完全无关的标题', '已有深色意见']);
  assert.equal(h.articles().length, 3);
});

test('搜索：迟到的首次列表与本页新提交同时存在时，去重与过滤都按 id 与已生效关键词进行', async () => {
  const h = new Harness(pageScript);
  // 列表未返回时先搜索、先提交
  h.search('深色');
  h.setForm({ title: '本页提交的深色意见', description: '说明' });
  const mine = makeIdea({ id: 'a', title: '本页提交的深色意见', description: '说明' });
  const submitted = h.submit();
  h.posts[0].resolve(jsonResponse(201, { idea: mine }));
  await submitted;
  assert.deepEqual(h.titles(), ['本页提交的深色意见']);

  // 迟到列表携带同 id 的重复拷贝（文案不同）以及命中、不命中各一条远端记录
  const staleCopy = makeIdea({ id: 'a', title: '列表里的重复拷贝' });
  const hit = makeIdea({ id: 'r1', title: '远端深色意见' });
  const miss = makeIdea({ id: 'r2', title: '远端无关意见' });
  h.gets[0].resolve(jsonResponse(200, { ideas: [staleCopy, hit, miss] }));
  await flush();

  const articles = h.articles();
  assert.equal(articles.length, 2);
  assertArticleMatches(articles[0], mine);
  assertArticleMatches(articles[1], hit);
});

test('搜索：不提交意见、不影响提交表单草稿与字段校验，填写意见与搜索互不干扰', async () => {
  const ideas = [
    makeIdea({ id: 'r1', title: '深色模式', description: '说明一' }),
    makeIdea({ id: 'r2', title: '导出数据', description: '说明二' }),
  ];
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas }));
  await flush();

  // 一边填写意见草稿一边搜索：草稿原样保留，搜索词也保留
  h.edit('f-title', '正在写的标题');
  h.edit('f-desc', '正在写的说明\n第二行');
  h.edit('f-scenario', '正在写的场景');
  h.search('导出');
  assert.deepEqual(h.titles(), ['导出数据']);
  assert.equal(h.els['f-title'].value, '正在写的标题');
  assert.equal(h.els['f-desc'].value, '正在写的说明\n第二行');
  assert.equal(h.els['f-scenario'].value, '正在写的场景');
  assert.equal(h.els['f-search'].value, '导出');
  assert.equal(h.postsIssued, 0);

  // 搜索生效期间字段校验照常：不发请求、显示字段错误、列表仍为过滤结果
  h.setForm({ title: '   ', description: '正在写的说明\n第二行', scenario: '正在写的场景' });
  h.submit();
  assert.equal(h.postsIssued, 0);
  assert.equal(h.els.error.hidden, false);
  assert.equal(h.els.error.textContent, '标题不能为空。');
  assert.deepEqual(h.titles(), ['导出数据']);

  // 提交成功后表单按现有行为清空、成功提示照常显示；关键词仍是“导出”，
  // 新意见不含该关键词，已保存但暂时不可见（不能因此提示失败）
  h.edit('f-title', '深色新意见');
  const saved = makeIdea({ id: 'a', title: '深色新意见', description: '正在写的说明\n第二行', scenario: '正在写的场景' });
  const done = h.submit();
  h.posts[0].resolve(jsonResponse(201, { idea: saved }));
  await done;
  await flush();
  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.success.textContent, SUCCESS_TEXT);
  assert.equal(h.els.error.hidden, true);
  assert.equal(h.els['f-title'].value, '');
  assert.equal(h.els['f-desc'].value, '');
  assert.equal(h.els['f-scenario'].value, '');
  assert.deepEqual(h.titles(), ['导出数据']);

  // 清空搜索后，新保存的意见按原有顺序出现在最前
  h.clearSearch();
  assert.deepEqual(h.titles(), ['深色新意见', '深色模式', '导出数据']);
});

test('搜索：列表中的意见始终展示原文，空白与换行保留，网页标记样内容继续按普通文字显示', async () => {
  const markup = makeIdea({
    id: 'r1',
    title: '建议 <b>深色</b> 模式 😀',
    description: '第一行 <script>alert("深色")</script>\n  第二行保留首尾空白与换行  ',
    scenario: '夜间使用 深色',
  });
  const plain = makeIdea({ id: 'r2', title: '普通意见', description: '普通说明', scenario: '' });
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [markup, plain] }));
  await flush();

  // 用标记内部的普通文字搜索，命中记录仍逐字按原文渲染
  h.search('深色');
  const articles = h.articles();
  assert.equal(articles.length, 1);
  assertArticleMatches(articles[0], markup);
  assertPlainTextOnly(h);

  // 直接用含尖括号与脚本样的整段搜索，同样按普通文字命中
  h.search('<script>alert("深色")</script>');
  assert.equal(h.articles().length, 1);
  assertArticleMatches(h.articles()[0], markup);
  assertPlainTextOnly(h);
});

// 读取兼容回归（首页侧）：已经保存的意见只要记录结构完整，首页首次加载就必须继续按原文显示，
// 不能因为内容不符合「现在」的提交限制（标题去空白后非空且最多 120 码点、详细说明含非空白
// 内容且最多 5000 码点、使用场景最多 1000 码点）而整次加载失败、跳过这些记录，或只显示混排
// 在其中的普通意见。内容校验只约束新提交；结构判定（isCompleteIdea）也不能为此放宽。
const LEGACY_LIMITS = { title: 120, description: 5000, scenario: 1000 };

// 一组按今天的规则已无法新提交、但结构完整的历史记录，中间夹一条普通意见
function legacyRecords(): Array<Record<string, unknown>> {
  return [
    makeIdea({
      id: 'legacy-1',
      title: '  ' + repeatCp('长', LEGACY_LIMITS.title + 1) + ' ',
      description: '标题超限历史正文\n第二行保留换行与中文😀',
      scenario: '标题超限记录的场景',
      createdAt: '2020-01-01T00:00:00.000Z',
    }),
    makeIdea({
      id: 'legacy-2',
      title: '正文超限的历史意见',
      description: repeatCp('描', LEGACY_LIMITS.description) + '😀',
      scenario: '',
      createdAt: '2020-02-02T00:02:00.000Z',
    }),
    makeIdea({
      id: 'legacy-3',
      title: '  场景超限且标题首尾空白保留  ',
      description: '场景超限历史正文',
      scenario: repeatCp('景', LEGACY_LIMITS.scenario + 1),
      createdAt: '2020-03-03T00:03:00.000Z',
    }),
    makeIdea({
      // 混在特殊记录中间的普通意见：不能变成只显示这一条
      id: 'legacy-4',
      title: '混排在其中的普通意见',
      description: '完全符合当前规则的普通正文',
      scenario: '',
      createdAt: '2020-04-04T00:04:00.000Z',
    }),
    makeIdea({
      id: 'legacy-5',
      title: '  \t\n ',
      description: '标题只有空白的历史正文，不能替换成默认标题',
      scenario: '空白标题记录的场景',
      createdAt: '2020-05-05T00:05:00.000Z',
    }),
    makeIdea({
      id: 'legacy-6',
      title: '正文只有空白的历史意见',
      description: '  \n\t  ',
      scenario: '',
      createdAt: '2020-06-06T00:06:00.000Z',
    }),
    makeIdea({
      id: 'legacy-7',
      title: '  建议 <b>重点</b> 支持深色模式 😀  ',
      description: [
        '正文第一行保留换行',
        '脚本样文本 <script>alert("x")</script> 与实体原文 &lt;div&gt; &amp;',
        '',
        '末行含中文、表情与空白  😀  ',
      ].join('\n'),
      scenario: '',
      createdAt: 'not-a-date-but-a-string',
    }),
    makeIdea({
      id: 'legacy-8',
      title: '',
      description: '标题为空字符串的历史正文',
      scenario: '空标题记录的场景',
      createdAt: '2020-08-08T00:08:00.000Z',
    }),
    makeIdea({
      id: 'legacy-9',
      title: '正文为空字符串的历史意见',
      description: '',
      scenario: '空正文记录的场景\n第二行换行保留',
      createdAt: '2020-09-09T00:09:00.000Z',
    }),
  ];
}

test('首次加载：超限或空白的历史记录全部按原文显示，不加载失败、不跳过、不只显示普通意见、不截断、不替换默认文字', async () => {
  const legacy = legacyRecords();
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: legacy }));
  await flush();

  // 不出现“意见列表加载失败”或“还没有意见记录”的提示（empty 节点保持隐藏）
  assert.equal(h.els.empty.hidden, true);
  assert.equal(h.els.error.hidden, true);
  assert.equal(h.getsIssued, 1, '首次加载只发起一次列表请求');
  assert.equal(h.postsIssued, 0);

  // 特殊记录一条都不能少，顺序与接口返回一致
  const articles = h.articles();
  assert.equal(articles.length, legacy.length);
  assert.deepEqual(h.titles(), legacy.map((idea) => idea.title));
  for (const [i, idea] of legacy.entries()) assertArticleMatches(articles[i], idea);

  // 长内容完整保留，不截断到当前上限；首尾空白也在
  const overTitleHeading = articles[0].children.find((n) => n.tagName === 'H3')!;
  assert.equal(codePointCount(overTitleHeading.textContent), LEGACY_LIMITS.title + 1 + 3);
  assert.ok(overTitleHeading.textContent.startsWith('  '));
  assert.ok(overTitleHeading.textContent.endsWith(' '));
  const overDescText = articles[1].children.find((n) => n.tagName === 'P' && n.children.length === 0)!;
  assert.equal(codePointCount(overDescText.textContent), LEGACY_LIMITS.description + 1);
  assert.ok(overDescText.textContent.endsWith('😀'));
  const overScenarioSpan = findScenario(articles[2])!.children.find((n) => n.tagName === 'SPAN')!;
  assert.equal(codePointCount(overScenarioSpan.textContent), LEGACY_LIMITS.scenario + 1);

  // 空白内容按原文渲染，不能被替换成默认文字（空字符串与纯空白各自保留）
  assert.equal(articles[4].children.find((n) => n.tagName === 'H3')!.textContent, '  \t\n ');
  assert.equal(articles[5].children.find((n) => n.tagName === 'P' && n.children.length === 0)!.textContent, '  \n\t  ');
  assert.equal(articles[7].children.find((n) => n.tagName === 'H3')!.textContent, '');
  assert.equal(articles[8].children.find((n) => n.tagName === 'P' && n.children.length === 0)!.textContent, '');

  // scenario 为空字符串的记录一律不渲染“使用场景”段
  for (const index of [1, 3, 5, 6]) assert.equal(findScenario(articles[index]), undefined);
});

test('首次加载：历史标题首尾空白、说明与场景中的换行、中文和表情保留；尖括号与网页标记样文字按普通文字展示', async () => {
  const legacy = legacyRecords();
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: legacy }));
  await flush();

  const markup = h.articles()[6];
  const heading = markup.children.find((n) => n.tagName === 'H3')!;
  // 首尾空白与尖括号逐字保留：不能只剩“重点”，也不能变成加粗元素
  assert.equal(heading.textContent, '  建议 <b>重点</b> 支持深色模式 😀  ');
  assert.ok(heading.textContent.includes('<b>重点</b>'));
  assert.equal(heading.children.length, 0);
  const desc = markup.children.find((n) => n.tagName === 'P' && n.children.length === 0)!;
  assert.ok(desc.textContent.includes('<script>alert("x")</script>'));
  assert.ok(desc.textContent.includes('&lt;div&gt; &amp;'));
  assert.ok(desc.textContent.includes('\n\n'));
  assert.equal(desc.children.length, 0);
  // 不能解析为日期的历史时间字符串也按原文放在 time 上
  const time = markup.children.find((n) => n.tagName === 'TIME')!;
  assert.equal(time.dateTime, 'not-a-date-but-a-string');
  assertPlainTextOnly(h);
});

test('使用场景为空字符串继续省略场景段落；它与缺失场景字段不是同一种情况：缺字段整次加载失败', async () => {
  // 空字符串 scenario：正常记录，加载成功且没有场景段
  const ok = makeIdea({ id: 'r1', title: '空场景历史意见', description: '正文', scenario: '' });
  const h1 = new Harness(pageScript);
  h1.gets[0].resolve(jsonResponse(200, { ideas: [ok] }));
  await flush();
  assert.equal(h1.els.empty.hidden, true);
  assert.equal(h1.articles().length, 1);
  assert.equal(findScenario(h1.articles()[0]), undefined);

  // 缺少 scenario 字段（即使与正常记录、超限记录混排）：整次加载失败，不部分展示
  const withoutScenario = makeIdea({ id: 'r2', title: '缺场景字段', description: '正文' });
  delete (withoutScenario as Record<string, unknown>).scenario;
  const overLimit = makeIdea({
    id: 'r3',
    title: repeatCp('长', LEGACY_LIMITS.title + 1),
    description: '结构完整但标题超限的历史记录',
  });
  const h2 = new Harness(pageScript);
  h2.gets[0].resolve(jsonResponse(200, { ideas: [overLimit, withoutScenario, ok] }));
  await flush();
  assert.equal(h2.els.empty.hidden, false);
  assert.equal(h2.els.empty.textContent, LOAD_FAILED_TEXT);
  assert.equal(h2.articles().length, 0, '不能只展示结构完整的部分');
});

test('读入历史记录后提交符合当前规则的新意见：成功并排最前，旧记录的内容、标识、时间与相对次序保持不变', async () => {
  const legacy = legacyRecords();
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: legacy }));
  await flush();

  h.setForm({ title: '兼容旧内容后的新意见', description: '符合当前规则的新说明', scenario: '新场景' });
  const submitted = h.submit();
  assert.equal(h.postsIssued, 1);
  const mine = makeIdea({ id: 'new-1', title: '兼容旧内容后的新意见', description: '符合当前规则的新说明', scenario: '新场景' });
  h.posts[0].resolve(jsonResponse(201, { idea: mine }));
  await submitted;
  await flush();

  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.success.textContent, SUCCESS_TEXT);
  assert.equal(h.els.error.hidden, true);

  const articles = h.articles();
  assert.equal(articles.length, legacy.length + 1);
  assertArticleMatches(articles[0], mine);
  for (const [i, idea] of legacy.entries()) assertArticleMatches(articles[i + 1], idea);
  assert.deepEqual(h.titles(), [mine.title, ...legacy.map((idea) => idea.title)]);
});

test('新旧内容区别保留：首页表单对超限或空白的新内容仍按当前规则拦截，已加载的历史记录数量、顺序与内容不变', async (t) => {
  const cases = [
    { name: '标题超限', values: { title: repeatCp('中', LEGACY_LIMITS.title + 1), description: '说明', scenario: '场景' }, message: TITLE_LIMIT_ERROR },
    { name: '详细说明超限', values: { title: '标题', description: repeatCp('中', LEGACY_LIMITS.description + 1), scenario: '场景' }, message: DESC_LIMIT_ERROR },
    { name: '使用场景超限', values: { title: '标题', description: '说明', scenario: repeatCp('中', LEGACY_LIMITS.scenario + 1) }, message: SCENARIO_LIMIT_ERROR },
    { name: '标题只有空白', values: { title: '  \t\n ', description: '说明', scenario: '场景' }, message: '标题不能为空。' },
    { name: '标题为空字符串', values: { title: '', description: '说明', scenario: '场景' }, message: '标题不能为空。' },
    { name: '详细说明只有空白', values: { title: '标题', description: '  \n\t  ', scenario: '场景' }, message: '详细说明不能为空。' },
    { name: '详细说明为空字符串', values: { title: '标题', description: '', scenario: '场景' }, message: '详细说明不能为空。' },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const legacy = legacyRecords();
      const h = new Harness(pageScript);
      h.gets[0].resolve(jsonResponse(200, { ideas: legacy }));
      await flush();

      h.setForm(c.values);
      await h.submit();

      // 新内容校验在发出请求前拦截，历史记录不受影响
      assert.equal(h.postsIssued, 0, c.name);
      assert.equal(h.els.error.hidden, false, c.name);
      assert.equal(h.els.error.textContent, c.message, c.name);
      assert.equal(h.els.success.hidden, true, c.name);
      assert.equal(h.articles().length, legacy.length, c.name);
      assert.deepEqual(h.titles(), legacy.map((idea) => idea.title), c.name);
    });
  }
});

test('结构判定不为接受超限旧内容而放宽：结构完整的超限记录与结构损坏记录混排时整次首页加载失败', async (t) => {
  const overLimit = (): Record<string, unknown> =>
    makeIdea({
      title: repeatCp('长', LEGACY_LIMITS.title + 1),
      description: repeatCp('描', LEGACY_LIMITS.description + 1),
      scenario: repeatCp('景', LEGACY_LIMITS.scenario + 1),
    });
  const good = (): Record<string, unknown> => makeIdea({ id: 'r1' });
  const cases = [
    { name: '混入 null', record: null },
    { name: '混入缺 title 的记录', record: (() => { const r = good(); delete r.title; return r; })() },
    { name: '混入缺 scenario 的记录', record: (() => { const r = good(); delete r.scenario; return r; })() },
    { name: '混入 id 为空字符串的记录', record: { ...good(), id: '' } },
    { name: '混入 createdAt 为数字的记录', record: { ...good(), createdAt: 1 } },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const h = new Harness(pageScript);
      // 损坏记录夹在两条内容超限但结构完整的历史记录之间，前面还有一条普通记录
      h.gets[0].resolve(jsonResponse(200, { ideas: [good(), overLimit(), c.record, overLimit()] }));
      await flush();

      assert.equal(h.els.empty.hidden, false, c.name);
      assert.equal(h.els.empty.textContent, LOAD_FAILED_TEXT, c.name);
      assert.equal(h.articles().length, 0, c.name);
    });
  }
});

// 独立查看入口回归（首页内联脚本侧）：每条已保存意见都在列表与搜索结果中带查看链接，
// 链接只由该记录的 id 决定，特殊 id 经 encodeURIComponent 编码，空标题记录同样可打开。
test('查看入口：首次加载的每条意见都带独立链接，按 id 区分，特殊字符 id 正确编码', async () => {
  const specialId = '中文 id 含空格/和?特殊&字符 #';
  const ideas = [
    makeIdea({ id: 'r1', title: '普通意见', description: '说明' }),
    makeIdea({ id: specialId, title: '特殊标识意见', description: '说明' }),
    makeIdea({ id: 'r3', title: '', description: '空标题的历史意见' }),
    makeIdea({ id: 'dup-a', title: '同文', description: '同样的说明' }),
    makeIdea({ id: 'dup-b', title: '同文', description: '同样的说明' }),
  ];
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas }));
  await flush();

  const articles = h.articles();
  assert.equal(articles.length, 5);
  ideas.forEach((idea, index) => assertArticleMatches(articles[index], idea));
  // 同文不同 id：各自入口指向各自记录
  const links = articles.map((a) => findViewLink(a)!.href);
  assert.deepEqual(links, ideas.map((idea) => `/ideas/${encodeURIComponent(idea.id)}`));
  assert.notEqual(links[3], links[4]);
  assert.equal(links[1], `/ideas/${encodeURIComponent(specialId)}`);
  // 链接里不能出现未编码的空格或 / ? & # 等网址特殊字符（斜杠编码成 %2F）
  assert.ok(!/[\s/?&#]/.test(links[1].slice('/ideas/'.length)));
});

test('查看入口：搜索结果中的每条意见同样带入口且仍按 id 指向各自记录', async () => {
  const ideas = [
    makeIdea({ id: 'r1', title: '深色模式一', description: '说明' }),
    makeIdea({ id: 'r2', title: '深色模式二', description: '说明' }),
    makeIdea({ id: 'r3', title: '无关意见', description: '说明' }),
  ];
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas }));
  await flush();

  h.search('深色');
  let visible = h.articles();
  assert.equal(visible.length, 2);
  assert.equal(findViewLink(visible[0])!.href, '/ideas/r1');
  assert.equal(findViewLink(visible[1])!.href, '/ideas/r2');

  // 清空搜索后所有记录（含刚才不可见的一条）的入口都在
  h.clearSearch();
  visible = h.articles();
  assert.equal(visible.length, 3);
  ideas.forEach((idea, index) => assert.equal(findViewLink(visible[index])!.href, `/ideas/${encodeURIComponent(idea.id)}`));
});

test('查看入口：空标题或纯空白标题的历史记录仍有可操作入口，不因标题缺失无法打开', async () => {
  const ideas = [
    makeIdea({ id: 'empty-1', title: '', description: '标题为空字符串' }),
    makeIdea({ id: 'ws-1', title: ' \t\n ', description: '标题只有空白' }),
    makeIdea({ id: 'ok-1', title: '正常标题', description: '说明' }),
  ];
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas }));
  await flush();

  const articles = h.articles();
  assert.equal(articles.length, 3);
  assert.equal(findViewLink(articles[0])!.href, '/ideas/empty-1');
  assert.equal(findViewLink(articles[1])!.href, '/ideas/ws-1');
  assert.equal(findViewLink(articles[2])!.href, '/ideas/ok-1');
  // 入口文字不依赖标题
  for (const article of articles) {
    assert.equal(findViewLink(article)!.textContent, '查看这条意见');
  }
});

test('查看入口：本页新提交确认的意见同样带入口，入口以响应确认的 id 为准', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  h.setForm({ title: '新意见', description: '新说明', scenario: '新场景' });
  const submitted = h.submit();
  const mine = makeIdea({ id: 'just-saved-1', title: '新意见', description: '新说明', scenario: '新场景' });
  h.posts[0].resolve(jsonResponse(201, { idea: mine }));
  await submitted;
  await flush();

  const articles = h.articles();
  assert.equal(articles.length, 1);
  assertArticleMatches(articles[0], mine);
  assert.equal(findViewLink(articles[0])!.href, '/ideas/just-saved-1');
});

// 历史标识为“.”或“..”时不能使用路径段：浏览器发送前会做路径归一化，
// 即使编码成 %2E 也会被当作当前/上一级目录移除，导致链接落到 /ideas/ 或首页。
// 首页因此只对这两个标识改走查询串 /ideas?id=<encoded>；其余标识的链接保持路径形式不变。
test('查看入口：标识为“.”或“..”的历史记录改走查询串链接，其余标识仍走路径形式', async () => {
  const ideas = [
    makeIdea({ id: '.', title: '单点意见', description: '说明' }),
    makeIdea({ id: '..', title: '双点意见', description: '说明' }),
    makeIdea({ id: '%2E', title: '字面百分号二E', description: '说明' }),
    makeIdea({ id: '%2E%2E', title: '字面百分号二E两次', description: '说明' }),
    makeIdea({ id: '...', title: '三个点不受影响', description: '说明' }),
    makeIdea({ id: 'normal-1', title: '普通意见', description: '说明' }),
  ];
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas }));
  await flush();

  const expected = ideas.map((idea) => expectedViewHref(String(idea.id)));
  const links = h.articles().map((a) => findViewLink(a)!.href);
  assert.deepEqual(links, expected);
  // 两个点标识各自独立、互不相同，也不与字面 %2E 记录混用
  assert.equal(links[0], '/ideas?id=.');
  assert.equal(links[1], '/ideas?id=..');
  assert.notEqual(links[0], links[1]);
  assert.equal(links[2], '/ideas/%252E');
  assert.equal(links[3], '/ideas/%252E%252E');
  assert.equal(links[4], '/ideas/...');
  assert.equal(links[5], '/ideas/normal-1');
  // 链接仍是可点击的普通查看入口
  for (const article of h.articles()) {
    assert.equal(findViewLink(article)!.textContent, '查看这条意见');
  }

  // 搜索结果中同样保留查询串入口：过滤后只看点与双点（“三个点不受影响”不含“点意见”）
  h.search('点意见');
  const visible = h.articles();
  assert.equal(visible.length, 2);
  assert.equal(findViewLink(visible[0])!.href, '/ideas?id=.');
  assert.equal(findViewLink(visible[1])!.href, '/ideas?id=..');
});
