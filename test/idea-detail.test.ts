import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, removeDataDir, type StartedServer } from '../testing/server.ts';

// 单条意见独立查看功能的回归：
//   - 接口 GET /api/ideas/<encoded-id> 按标识精确返回同一条已保存意见；
//   - 查看页 /ideas/<encoded-id> 是可直接分享、刷新的地址，打开即见该条意见；
//   - 不存在与加载失败明确区分；历史内容兼容、附加信息不公开；
//   - 首页列表与搜索结果的查看入口在 test/page.test.ts 中随首页沙箱一起回归。

let server: StartedServer;
let detailScript: string;

before(async () => {
  server = await startServer();
  const res = await fetch(`${server.origin}/ideas/page-shell-probe`);
  assert.equal(res.status, 200);
  const html = await res.text();
  const start = html.indexOf('<script>');
  const end = html.lastIndexOf('</script>');
  assert.notEqual(start, -1);
  assert.ok(end > start);
  detailScript = html.slice(start + '<script>'.length, end);
});

after(async () => {
  await server.stop();
  removeDataDir(server);
});

async function postIdea(
  origin: string,
  idea: { title: string; description: string; scenario?: string },
): Promise<Record<string, any>> {
  const res = await fetch(`${origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(idea),
  });
  assert.equal(res.status, 201);
  return (await res.json()).idea;
}

async function seedDataDir(records: unknown[]): Promise<StartedServer> {
  const dir = mkdtempSync(join(tmpdir(), 'featureharbor-detail-'));
  writeFileSync(join(dir, 'ideas.json'), `${JSON.stringify(records, null, 2)}\n`);
  return startServer(dir);
}

// ---------------------------------------------------------------------------
// 接口：GET /api/ideas/<encoded-id>
// ---------------------------------------------------------------------------

test('单条接口：按标识返回那一条已保存意见，字段与列表接口逐字一致', async () => {
  const a = await postIdea(server.origin, { title: '意见甲', description: '说明甲\n第二行', scenario: '场景甲' });
  const b = await postIdea(server.origin, { title: '意见乙', description: '说明乙' });

  const res = await fetch(`${server.origin}/api/ideas/${encodeURIComponent(a.id)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const data = await res.json();
  assert.deepEqual(data.idea, a);
  // 不能串到另一条记录
  assert.notEqual(data.idea.id, b.id);
  assert.equal(data.idea.title, '意见甲');
});

test('单条接口：标题与说明相同但标识不同的两条意见，各自地址只返回各自记录', async () => {
  const payload = { title: '完全相同的标题', description: '完全相同的说明', scenario: '同一场景' };
  const first = await postIdea(server.origin, payload);
  const second = await postIdea(server.origin, payload);
  assert.notEqual(first.id, second.id);

  const r1 = await fetch(`${server.origin}/api/ideas/${encodeURIComponent(first.id)}`).then((r) => r.json());
  const r2 = await fetch(`${server.origin}/api/ideas/${encodeURIComponent(second.id)}`).then((r) => r.json());
  assert.equal(r1.idea.id, first.id);
  assert.equal(r1.idea.createdAt, first.createdAt);
  assert.equal(r2.idea.id, second.id);
  assert.equal(r2.idea.createdAt, second.createdAt);
  assert.notEqual(r1.idea.id, r2.idea.id);
});

test('单条接口：历史标识含中文、空格、斜杠、问号、井号与表情时，按编码地址准确指向原记录', async () => {
  const specialId = '旧 标识/a?b#c😀';
  const otherId = '旧 标识/a'; // 前缀相同的另一条，证明是整段精确匹配而不是前缀匹配
  const srv = await seedDataDir([
    { id: otherId, title: '前缀记录', description: '说明', scenario: '', createdAt: '2020-01-01T00:00:00.000Z' },
    { id: specialId, title: '特殊标识记录', description: '说明', scenario: '', createdAt: '2020-02-02T00:00:00.000Z' },
  ]);
  try {
    const url = `${srv.origin}/api/ideas/${encodeURIComponent(specialId)}`;
    // 编码后的地址含 %2F %3F %23 与多字节 UTF-8 百分号序列
    assert.match(url, /%2F/);
    assert.match(url, /%3F/);
    assert.match(url, /%23/);
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.idea.id, specialId);
    assert.equal(data.idea.title, '特殊标识记录');

    // 另一路径：直接分享/刷新编码链接，结果一致
    const again = await fetch(url);
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), data);
  } finally {
    await srv.stop();
    removeDataDir(srv);
  }
});

test('单条接口：标识中字面百分号按 %25 编码后才能命中；未编码的坏百分号序列按不存在处理', async () => {
  const percentId = '进度 100%';
  const srv = await seedDataDir([
    { id: percentId, title: '百分号标识', description: '说明', scenario: '', createdAt: '2020-01-01T00:00:00.000Z' },
  ]);
  try {
    const ok = await fetch(`${srv.origin}/api/ideas/${encodeURIComponent(percentId)}`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).idea.id, percentId);

    for (const bad of ['100%', '%E4%B8%AD', '%', '%zz']) {
      const res = await fetch(`${srv.origin}/api/ideas/${bad}`);
      assert.equal(res.status, 404, `坏编码 ${bad} 应按不存在处理`);
      assert.deepEqual(await res.json(), { error: 'not found' });
    }
  } finally {
    await srv.stop();
    removeDataDir(srv);
  }
});

test('单条接口：标识只占一个路径段；多出的原始斜杠段是 404，不能返回别的意见', async () => {
  const srv = await seedDataDir([
    { id: 'a/b', title: '含斜杠标识', description: '说明', scenario: '', createdAt: '2020-01-01T00:00:00.000Z' },
    { id: 'a', title: '单段标识', description: '说明', scenario: '', createdAt: '2021-01-01T00:00:00.000Z' },
  ]);
  try {
    const encoded = await fetch(`${srv.origin}/api/ideas/${encodeURIComponent('a/b')}`);
    assert.equal(encoded.status, 200);
    assert.equal((await encoded.json()).idea.title, '含斜杠标识');

    for (const path of ['/api/ideas/a/b', '/api/ideas/a/', '/api/ideas/']) {
      const res = await fetch(`${srv.origin}${path}`);
      assert.equal(res.status, 404, `${path} 应为 404`);
    }
  } finally {
    await srv.stop();
    removeDataDir(srv);
  }
});

test('单条接口：标识不存在返回 404，不返回其他意见，也不暗示产品没有意见', async () => {
  const existing = await postIdea(server.origin, { title: '已存在的意见', description: '说明' });
  const res = await fetch(`${server.origin}/api/ideas/this-id-does-not-exist`);
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.deepEqual(data, { error: 'not found' });
  // 其他意见仍然完好
  const list = await fetch(`${server.origin}/api/ideas`).then((r) => r.json());
  assert.ok(list.ideas.some((idea: any) => idea.id === existing.id));
});

test('单条接口：非 GET 方法返回 405 且 Allow 为 GET', async (t) => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
    await t.test(method, async () => {
      const res = await fetch(`${server.origin}/api/ideas/some-id`, { method });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('allow'), 'GET');
    });
  }
});

test('单条接口：历史内容兼容——超过今天上限或字段空白的完整记录仍按原文返回，不截断', async () => {
  const longTitle = '字'.repeat(121);
  const longDescription = '描'.repeat(5001);
  const longScenario = '景'.repeat(1001);
  const srv = await seedDataDir([
    { id: 'legacy-long', title: longTitle, description: longDescription, scenario: longScenario, createdAt: '2020-01-01T00:00:00.000Z' },
    { id: 'legacy-blank-title', title: '', description: '空标题正文', scenario: '非空场景', createdAt: 'not-a-date' },
    { id: 'legacy-blank-desc', title: '空白正文标题', description: '  \n\t  ', scenario: '', createdAt: '2020-03-03T00:03:00.000Z' },
  ]);
  try {
    const r1 = await fetch(`${srv.origin}/api/ideas/legacy-long`).then((r) => r.json());
    assert.equal(Array.from(r1.idea.title).length, 121);
    assert.equal(Array.from(r1.idea.description).length, 5001);
    assert.equal(Array.from(r1.idea.scenario).length, 1001);
    assert.equal(r1.idea.title, longTitle);
    assert.equal(r1.idea.description, longDescription);

    const r2 = await fetch(`${srv.origin}/api/ideas/legacy-blank-title`).then((r) => r.json());
    assert.equal(r2.idea.title, '');
    assert.equal(r2.idea.createdAt, 'not-a-date');

    const r3 = await fetch(`${srv.origin}/api/ideas/legacy-blank-desc`).then((r) => r.json());
    assert.equal(r3.idea.description, '  \n\t  ');
  } finally {
    await srv.stop();
    removeDataDir(srv);
  }
});

test('单条接口：存储无法读取或内容损坏时返回 500（unable to read ideas），不冒充不存在', async (t) => {
  const cases = [
    { name: '不是合法 JSON', bytes: Buffer.from('  [1, 2, ', 'utf8') },
    { name: '非法 UTF-8 字节', bytes: Buffer.concat([Buffer.from('[{"id":"a","title":"', 'utf8'), Buffer.from([0xe4, 0xb8]), Buffer.from('","description":"d","scenario":"","createdAt":"t"}]', 'utf8')]) },
    { name: '数组中混入结构不完整记录', bytes: Buffer.from(JSON.stringify([{ id: 'a', title: 't', description: 'd', scenario: '' }]), 'utf8') },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const srv = await seedDataDir([
        { id: 'a', title: '原本正常的意见', description: '说明', scenario: '', createdAt: '2020-01-01T00:00:00.000Z' },
      ]);
      try {
        // 服务正常启动后从进程外改坏数据
        writeFileSync(join(srv.dataDir, 'ideas.json'), c.bytes);
        const res = await fetch(`${srv.origin}/api/ideas/a`);
        assert.equal(res.status, 500, c.name);
        assert.deepEqual(await res.json(), { error: 'unable to read ideas' }, c.name);
        // 任意标识都应是加载失败，而不是 404
        const other = await fetch(`${srv.origin}/api/ideas/whatever`);
        assert.equal(other.status, 500, c.name);
      } finally {
        await srv.stop();
        removeDataDir(srv);
      }
    });
  }
});

test('单条接口不改变既有公开接口：列表、提交、首页与健康检查照常', async () => {
  const before = await fetch(`${server.origin}/api/ideas`).then((r) => r.json());
  assert.ok(Array.isArray(before.ideas));
  const mine = await postIdea(server.origin, { title: '兼容性检查', description: '说明' });
  const after = await fetch(`${server.origin}/api/ideas`).then((r) => r.json());
  assert.equal(after.ideas[0].id, mine.id);
  assert.equal((await fetch(`${server.origin}/`)).status, 200);
  assert.equal((await fetch(`${server.origin}/health`)).status, 200);
  assert.equal((await fetch(`${server.origin}/no-such-path`)).status, 404);
});

// ---------------------------------------------------------------------------
// 查看页 HTML 壳：/ideas/<encoded-id>
// ---------------------------------------------------------------------------

test('查看页：直接打开编码后的分享链接返回 HTML 页面壳，含返回首页入口与所需结构', async () => {
  const idea = await postIdea(server.origin, { title: '分享测试', description: '说明' });
  const res = await fetch(`${server.origin}/ideas/${encodeURIComponent(idea.id)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  for (const expected of [
    'id="idea-detail"',
    'id="d-title"',
    'id="d-desc"',
    'id="d-scenario-row"',
    'id="d-scenario"',
    'id="d-time"',
    'id="detail-note"',
    'href="/"',
    "fetch('/api' + path)",
  ]) {
    assert.ok(html.includes(expected), `查看页应包含 ${expected}`);
  }
  // 意见内容不能在服务端拼进 HTML：避免标记样文字被解析，也保证刷新后内容来自接口
  assert.ok(!html.includes('分享测试'), '意见文字不应由服务端拼入页面 HTML');
});

test('查看页：内容不预先出现在 HTML 中，因此常规字段之外的附加信息也不会在页面上公开', async () => {
  const srv = await seedDataDir([
    {
      id: 'with-extra',
      title: '带附加信息的意见',
      description: '正文',
      scenario: '',
      createdAt: '2020-01-01T00:00:00.000Z',
      secret: '内部备注 SECRET-XYZ',
      nested: { token: 'TOKEN-123', list: [1, 2, 3] },
    },
  ]);
  try {
    const html = await fetch(`${srv.origin}/ideas/with-extra`).then((r) => r.text());
    assert.ok(!html.includes('SECRET-XYZ'));
    assert.ok(!html.includes('TOKEN-123'));
    assert.ok(!html.includes('内部备注'));
    assert.ok(!html.includes('带附加信息的意见'), '常规文字也不应在服务端预渲染');
  } finally {
    await srv.stop();
    removeDataDir(srv);
  }
});

test('查看页：多一个原始路径段或空标识是 404；未知标识仍返回页面壳（由脚本提示不存在）', async () => {
  assert.equal((await fetch(`${server.origin}/ideas/a/b`)).status, 404);
  assert.equal((await fetch(`${server.origin}/ideas/`)).status, 404);
  const unknown = await fetch(`${server.origin}/ideas/this-id-does-not-exist`);
  assert.equal(unknown.status, 200);
  assert.match(unknown.headers.get('content-type') ?? '', /text\/html/);
});

test('查看页：非 GET 方法返回 405', async () => {
  const res = await fetch(`${server.origin}/ideas/x`, { method: 'POST' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET');
});

// ---------------------------------------------------------------------------
// 查看页内联脚本：在可控 DOM/fetch 的 vm 沙箱中执行真实页面脚本
// ---------------------------------------------------------------------------

interface DEl {
  tagName: string;
  hidden: boolean;
  dateTime: string;
  text: string | null;
  textContent: string;
  innerHTMLAssigned: boolean;
}

function makeDetailEl(tag: string, hidden = false): DEl {
  const node: any = {
    tagName: tag.toUpperCase(),
    hidden,
    dateTime: '',
    text: null as string | null,
    innerHTMLAssigned: false,
  };
  Object.defineProperty(node, 'textContent', {
    get(this: any): string {
      return this.text !== null ? this.text : '';
    },
    set(this: any, value: unknown): void {
      this.text = String(value);
    },
  });
  Object.defineProperty(node, 'innerHTML', {
    get(): string { return ''; },
    set(): void { node.innerHTMLAssigned = true; },
  });
  return node as DEl;
}

interface Gate {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function gate(): Gate {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function jsonResponse(status: number, body: unknown): any {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

function brokenJsonResponse(status = 200): any {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => { throw new SyntaxError('响应体不是有效 JSON'); },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

class DetailHarness {
  els: Record<string, DEl> = {};
  created: DEl[] = [];
  fetchCalls: Array<{ url: string }> = [];
  pending: Gate;

  constructor(script: string, ideaId: string) {
    const byId = new Map<string, DEl>();
    const register = (id: string, tag: string, hidden = false): DEl => {
      const el = makeDetailEl(tag, hidden);
      byId.set(id, el);
      this.els[id] = el;
      return el;
    };
    register('idea-detail', 'article', true);
    register('d-title', 'h2');
    register('d-desc', 'p');
    register('d-scenario-row', 'p', true);
    register('d-scenario', 'span');
    register('d-time', 'time');
    register('detail-note', 'p', true);

    const g = gate();
    this.pending = g;
    const documentMock = {
      getElementById: (id: string): DEl => byId.get(id)!,
      createElement: (tag: string): DEl => {
        const el = makeDetailEl(tag);
        this.created.push(el);
        return el;
      },
    };
    const fetchMock = (url: unknown): Promise<unknown> => {
      this.fetchCalls.push({ url: String(url) });
      return g.promise;
    };
    const windowMock = { location: { pathname: `/ideas/${ideaId}` } };
    const context = vm.createContext({
      console,
      document: documentMock,
      window: windowMock,
      fetch: fetchMock,
    });
    vm.runInContext(script, context, { filename: 'inline-detail-script.js' });
  }

  get note(): DEl { return this.els['detail-note']; }
  get box(): DEl { return this.els['idea-detail']; }
}

const NOT_FOUND_TEXT = '该意见不存在。';
const DETAIL_LOAD_FAILED_TEXT = '意见加载失败，请稍后刷新重试。';

function makeIdea(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'idea-1',
    title: '意见标题',
    description: '意见的完整详细说明',
    scenario: '',
    createdAt: '2026-05-05T05:05:05.000Z',
    ...partial,
  };
}

test('详情脚本：打开即按地址栏标识请求单条接口，且只请求这一次', () => {
  const h = new DetailHarness(detailScript, encodeURIComponent('id 中文/x?y#z'));
  assert.deepEqual(h.fetchCalls.map((c) => c.url), ['/api/ideas/' + encodeURIComponent('id 中文/x?y#z')]);
});

test('详情脚本：成功返回后展示该条意见的标题、完整说明、非空白使用场景与提交时间', async () => {
  const idea = makeIdea({
    title: '  带首尾空白的标题  ',
    description: '第一行\n第二行 <b>重点</b> &lt;实体&gt;\n末行',
    scenario: '  夜间使用 😀  ',
    createdAt: '2026-05-05T05:05:05.000Z',
  });
  const h = new DetailHarness(detailScript, String(idea.id));
  h.pending.resolve(jsonResponse(200, { idea }));
  await flush();

  assert.equal(h.box.hidden, false);
  assert.equal(h.note.hidden, true);
  assert.equal(h.els['d-title'].textContent, idea.title);
  assert.equal(h.els['d-desc'].textContent, idea.description);
  assert.equal(h.els['d-scenario-row'].hidden, false);
  assert.equal(h.els['d-scenario'].textContent, idea.scenario);
  assert.equal(h.els['d-time'].dateTime, idea.createdAt);
  assert.ok(h.els['d-time'].textContent.length > 0);
});

test('详情脚本：完整长说明不截断；换行、空白、中文、表情逐字保留', async () => {
  const longDescription = '中'.repeat(6000) + '\n末尾 😀\n  空白行  ';
  const idea = makeIdea({ description: longDescription });
  const h = new DetailHarness(detailScript, String(idea.id));
  h.pending.resolve(jsonResponse(200, { idea }));
  await flush();
  assert.equal(Array.from(h.els['d-desc'].textContent).length, Array.from(longDescription).length);
  assert.equal(h.els['d-desc'].textContent, longDescription);
  assert.ok(h.els['d-desc'].textContent.endsWith('  空白行  '));
});

test('详情脚本：使用场景为空字符串或纯空白时不展示场景段；非空白才展示', async (t) => {
  for (const scenario of ['', '   ', '\n\t ']) {
    await t.test(JSON.stringify(scenario), async () => {
      const idea = makeIdea({ scenario });
      const h = new DetailHarness(detailScript, String(idea.id));
      h.pending.resolve(jsonResponse(200, { idea }));
      await flush();
      assert.equal(h.els['d-scenario-row'].hidden, true);
    });
  }
  const idea = makeIdea({ scenario: '\n 有内容 \n' });
  const h = new DetailHarness(detailScript, String(idea.id));
  h.pending.resolve(jsonResponse(200, { idea }));
  await flush();
  assert.equal(h.els['d-scenario-row'].hidden, false);
  assert.equal(h.els['d-scenario'].textContent, '\n 有内容 \n');
});

test('详情脚本：不能解析为日期的历史时间字符串按原文显示', async () => {
  const idea = makeIdea({ createdAt: 'not-a-date-but-a-string' });
  const h = new DetailHarness(detailScript, String(idea.id));
  h.pending.resolve(jsonResponse(200, { idea }));
  await flush();
  assert.equal(h.els['d-time'].dateTime, 'not-a-date-but-a-string');
  assert.equal(h.els['d-time'].textContent, 'not-a-date-but-a-string');
});

test('详情脚本：历史标题为空或纯空白时记录仍可查看，标题区按原文为空，不替换默认文字', async (t) => {
  for (const title of ['', '  \t\n ']) {
    await t.test(JSON.stringify(title), async () => {
      const idea = makeIdea({ title });
      const h = new DetailHarness(detailScript, String(idea.id));
      h.pending.resolve(jsonResponse(200, { idea }));
      await flush();
      assert.equal(h.box.hidden, false, '空白标题的历史记录仍能打开');
      assert.equal(h.els['d-title'].textContent, title);
      assert.equal(h.els['d-desc'].textContent, idea.description);
    });
  }
});

test('详情脚本：网页标记样文字与实体写法按普通文字显示，不创建元素、不走 innerHTML', async () => {
  const idea = makeIdea({
    title: '建议 <b>重点</b> 支持深色模式',
    description: '脚本 <script>alert("x")</script>、图片 <img src=x onerror="alert(1)">、实体 &lt;b&gt; &amp;',
    scenario: '场景 <a href="javascript:alert(1)">链接样文本</a>',
  });
  const h = new DetailHarness(detailScript, String(idea.id));
  h.pending.resolve(jsonResponse(200, { idea }));
  await flush();

  assert.equal(h.els['d-title'].textContent, idea.title);
  assert.equal(h.els['d-desc'].textContent, idea.description);
  assert.equal(h.els['d-scenario'].textContent, idea.scenario);
  assert.ok(h.els['d-title'].textContent.includes('<b>重点</b>'));
  assert.ok(h.els['d-desc'].textContent.includes('&lt;b&gt;'));
  assert.ok(!h.els['d-desc'].textContent.includes('<b>'), '实体不能解码成标记');
  // 详情渲染不应创建任何元素（结构都在静态 HTML 中），也不能走 innerHTML
  assert.deepEqual(h.created, []);
  for (const el of Object.values(h.els)) assert.equal(el.innerHTMLAssigned, false);
});

test('详情脚本：同标题同说明但不同标识时，地址决定展示哪一条，互不串内容', async () => {
  const first = makeIdea({ id: 'x', title: '同文', description: '同文', scenario: '', createdAt: '2020-01-01T00:00:00.000Z' });
  const second = makeIdea({ id: 'y', title: '同文', description: '同文', scenario: '', createdAt: '2020-02-02T00:00:00.000Z' });

  const h1 = new DetailHarness(detailScript, 'x');
  h1.pending.resolve(jsonResponse(200, { idea: first }));
  await flush();
  const h2 = new DetailHarness(detailScript, 'y');
  h2.pending.resolve(jsonResponse(200, { idea: second }));
  await flush();

  assert.deepEqual(h1.fetchCalls.map((c) => c.url), ['/api/ideas/x']);
  assert.deepEqual(h2.fetchCalls.map((c) => c.url), ['/api/ideas/y']);
  assert.equal(h1.els['d-time'].dateTime, first.createdAt);
  assert.equal(h2.els['d-time'].dateTime, second.createdAt);
});

test('详情脚本：404 明确提示该意见不存在，隐藏详情，不展示其他意见', async (t) => {
  await t.test('404 带 JSON 错误体', async () => {
    const h = new DetailHarness(detailScript, 'missing');
    h.pending.resolve(jsonResponse(404, { error: 'not found' }));
    await flush();
    assert.equal(h.note.hidden, false);
    assert.equal(h.note.textContent, NOT_FOUND_TEXT);
    assert.equal(h.box.hidden, true);
  });
  await t.test('404 响应体不是有效 JSON 仍提示不存在（状态码先于响应体判定）', async () => {
    const h = new DetailHarness(detailScript, 'missing');
    h.pending.resolve(brokenJsonResponse(404));
    await flush();
    assert.equal(h.note.textContent, NOT_FOUND_TEXT);
    assert.equal(h.box.hidden, true);
  });
});

test('详情脚本：网络错误、5xx、坏 JSON、200 但结构异常都提示加载失败，不展示半份详情', async (t) => {
  const run = async (name: string, settle: (h: DetailHarness) => Promise<void>): Promise<void> => {
    await t.test(name, async () => {
      const h = new DetailHarness(detailScript, 'idea-1');
      await settle(h);
      await flush();
      assert.equal(h.note.hidden, false, name);
      assert.equal(h.note.textContent, DETAIL_LOAD_FAILED_TEXT, name);
      assert.equal(h.box.hidden, true, name);
    });
  };
  await run('网络错误', async (h) => { h.pending.reject(new TypeError('Failed to fetch')); });
  await run('500 存储读取失败', async (h) => { h.pending.resolve(jsonResponse(500, { error: 'unable to read ideas' })); });
  await run('500 坏 JSON', async (h) => { h.pending.resolve(brokenJsonResponse(500)); });
  await run('200 响应体不是有效 JSON', async (h) => { h.pending.resolve(brokenJsonResponse(200)); });
  await run('200 顶层为 null', async (h) => { h.pending.resolve(jsonResponse(200, null)); });
  await run('200 顶层为数组', async (h) => { h.pending.resolve(jsonResponse(200, [])); });
  await run('200 缺少 idea 字段', async (h) => { h.pending.resolve(jsonResponse(200, {})); });
  const complete = makeIdea();
  const without = (field: string): unknown => {
    const record = { ...complete };
    delete (record as Record<string, unknown>)[field];
    return record;
  };
  await run('idea 缺 id', async (h) => { h.pending.resolve(jsonResponse(200, { idea: without('id') })); });
  await run('idea 缺 title', async (h) => { h.pending.resolve(jsonResponse(200, { idea: without('title') })); });
  await run('idea 缺 scenario', async (h) => { h.pending.resolve(jsonResponse(200, { idea: without('scenario') })); });
  await run('idea 为 null', async (h) => { h.pending.resolve(jsonResponse(200, { idea: null })); });
});

test('详情脚本：不读取也不展示常规字段之外的附加信息', async () => {
  const idea = makeIdea({ secret: 'SECRET-XYZ', nested: { token: 'TOKEN-123' } });
  const h = new DetailHarness(detailScript, String(idea.id));
  h.pending.resolve(jsonResponse(200, { idea }));
  await flush();
  // 只更新标题、说明、时间等常规字段；页面没有任何元素会承载附加信息
  assert.equal(h.box.hidden, false);
  assert.equal(h.els['d-title'].textContent, idea.title);
  assert.equal(h.els['d-desc'].textContent, idea.description);
  for (const el of Object.values(h.els)) {
    assert.ok(!el.textContent.includes('SECRET-XYZ'));
    assert.ok(!el.textContent.includes('TOKEN-123'));
  }
});
