import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, removeDataDir, type StartedServer } from '../testing/server.ts';

// 单条意见独立查看的端到端回归：真实起一份 server.ts，只走公开入口
// （GET /ideas/:id、首页 /、GET/POST /api/ideas），覆盖：
//   - 每条已保存意见都有可分享的独立链接：直接打开或刷新都展示同一条记录，
//     内容只来自磁盘上该 id 的已保存内容，不依赖首页、搜索或表单草稿；
//   - 查看页展示标题、完整详细说明（长内容不截断）、非空白使用场景与提交时间，
//     并提供返回首页入口；标题/说明相同但 id 不同的记录各自打开各自的页面；
//   - 历史标识可能含中文、空格或网址特殊字符，链接经 encodeURIComponent 后仍准确指向原记录；
//   - 历史内容兼容：超限、空白标题/说明、换行、中文、表情、网页标记样文本与实体写法按原文展示，
//     标记不解析成页面元素；常规字段之外的附加信息不在查看页公开；
//   - 链接指向不存在的 id：明确提示该意见不存在（404）并可返回首页，不展示其他意见；
//   - 已有数据无法读取或损坏：明确提示加载失败（500），不冒充不存在，也不展示半份详情；
//   - 查看不新增或改写意见；首页提交、列表接口与 404/405 行为保持兼容。

interface Idea {
  id: string;
  title: string;
  description: string;
  scenario: string;
  createdAt: string;
  [extra: string]: unknown;
}

const repeatCp = (char: string, times: number): string => char.repeat(times);

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'featureharbor-view-'));
}

function seedIdeas(dir: string, ideas: unknown[]): void {
  writeFileSync(join(dir, 'ideas.json'), JSON.stringify(ideas, null, 2) + '\n');
}

async function startWith(dir: string): Promise<StartedServer> {
  return startServer(dir);
}

async function fetchView(server: StartedServer, id: string, init?: RequestInit): Promise<Response> {
  return fetch(`${server.origin}/ideas/${encodeURIComponent(id)}`, init);
}

async function fetchViewRaw(server: StartedServer, rawIdSegment: string, init?: RequestInit): Promise<Response> {
  return fetch(`${server.origin}/ideas/${rawIdSegment}`, init);
}

// 标识为“.”或“..”时首页改用查询串形式（/ideas?id=<encoded>），避免网址路径归一化
async function fetchViewQuery(server: StartedServer, id: string, init?: RequestInit): Promise<Response> {
  return fetch(`${server.origin}/ideas?id=${encodeURIComponent(id)}`, init);
}

// 直接把未经编码的原始查询串拼到地址后，用于观察浏览器实际会发出的请求形态
async function fetchViewQueryRaw(server: StartedServer, rawQuery: string, init?: RequestInit): Promise<Response> {
  return fetch(`${server.origin}/ideas?${rawQuery}`, init);
}

// 与 server.ts 一致的 HTML 转义：服务端把意见文字转义后嵌进页面，
// 断言源码中出现的是转义形态，标记样文本因此不可能被解析成元素。
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function assertBackHome(html: string): void {
  assert.ok(html.includes('<a class="back" href="/">'), '查看页必须提供返回首页入口');
}

test('现有意见的查看链接：200 返回只含该条意见的页面，字段完整、可重复打开结果一致', async () => {
  const dir = freshDir();
  const ideas: Idea[] = [
    {
      id: 'idea-0001',
      title: '支持深色模式',
      description: '希望界面支持深色模式。\n第二行说明，含中文与表情 😀',
      scenario: '夜间使用',
      createdAt: '2026-01-02T03:04:05.000Z',
    },
    {
      id: 'idea-0002',
      title: '另一条意见',
      description: '另一条的说明',
      scenario: '',
      createdAt: '2026-01-03T03:04:05.000Z',
    },
  ];
  seedIdeas(dir, ideas);
  const server = await startWith(dir);
  try {
    const res = await fetchView(server, 'idea-0001');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(res.headers.get('content-type') ?? '', /charset=utf-8/);
    const html = await res.text();

    // 只展示这一条：它自己的字段都在，别的意见内容不出现
    assert.ok(html.includes(escapeHtml('支持深色模式')));
    assert.ok(html.includes(escapeHtml(ideas[0].description)));
    assert.ok(html.includes('使用场景：'));
    assert.ok(html.includes(escapeHtml('夜间使用')));
    assert.ok(html.includes(escapeHtml('2026-01-02T03:04:05.000Z')));
    assert.ok(html.includes('意见标识：idea-0001'));
    assert.ok(!html.includes('另一条意见'));
    assert.ok(!html.includes('另一条的说明'));
    assertBackHome(html);

    // 直接打开与刷新等价：再次 GET 返回逐字相同的页面
    const again = await fetchView(server, 'idea-0001');
    assert.equal(again.status, 200);
    assert.equal(await again.text(), html);

    // 另一条记录有自己的页面；scenario 为空字符串时不显示使用场景段
    const res2 = await fetchView(server, 'idea-0002');
    const html2 = await res2.text();
    assert.equal(res2.status, 200);
    assert.ok(html2.includes('另一条意见'));
    assert.ok(!html2.includes('使用场景：'));
    assert.ok(html2.includes('意见标识：idea-0002'));
    assert.ok(!html2.includes('支持深色模式'));
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('通过公开接口提交的新意见立即可经查看链接打开，且查看不改写任何已保存内容', async () => {
  const dir = freshDir();
  const server = await startWith(dir);
  try {
    const payload = { title: '新提交的意见', description: '新提交的完整说明', scenario: '分享给同事看' };
    const postRes = await fetch(`${server.origin}/api/ideas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(postRes.status, 201);
    const saved = (await postRes.json()).idea as Idea;

    const fileBefore = readFileSync(join(dir, 'ideas.json'));
    const res = await fetchView(server, saved.id);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes(escapeHtml(payload.title)));
    assert.ok(html.includes(escapeHtml(payload.description)));
    assert.ok(html.includes(escapeHtml(payload.scenario)));
    assert.ok(html.includes(escapeHtml(saved.createdAt)));
    assert.ok(html.includes(`意见标识：${escapeHtml(saved.id)}`));
    assertBackHome(html);
    // 查看是只读操作：磁盘逐字节不变
    assert.deepEqual(readFileSync(join(dir, 'ideas.json')), fileBefore);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('标题与说明相同但 id 不同的两条意见：各自链接打开各自记录', async () => {
  const dir = freshDir();
  const ideas: Idea[] = [
    { id: 'alpha', title: '同文意见', description: '完全相同的详细说明', scenario: '', createdAt: '2020-01-01T00:00:00.000Z' },
    { id: 'beta', title: '同文意见', description: '完全相同的详细说明', scenario: '', createdAt: '2021-02-02T00:00:00.000Z' },
  ];
  seedIdeas(dir, ideas);
  const server = await startWith(dir);
  try {
    for (const idea of ideas) {
      const res = await fetchView(server, idea.id);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes(`意见标识：${idea.id}`));
      assert.ok(html.includes(escapeHtml(idea.createdAt)));
      assert.ok(!html.includes(`意见标识：${idea.id === 'alpha' ? 'beta' : 'alpha'}`));
    }
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('历史标识含中文、空格与网址特殊字符：编码后的分享链接仍准确指向原记录', async () => {
  const specialIds = [
    '中文标识',
    'id with spaces',
    'slash/inside',
    'q?mark',
    'hash#frag',
    'amp&ersand',
    'percent%sign',
    'angle<>brackets"quote\'',
    'emoji-😀-id',
  ];
  const ideas: Idea[] = specialIds.map((id, index) => ({
    id,
    title: `特殊标识第 ${index + 1} 条`,
    description: `说明 ${index + 1}`,
    scenario: '',
    createdAt: `2022-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
  }));
  const dir = freshDir();
  seedIdeas(dir, ideas);
  const server = await startWith(dir);
  try {
    for (const idea of ideas) {
      // 链接必须先经 encodeURIComponent：空格、/、?、#、&、%、<>、表情全部编码，
      // 不能让路径段或查询/片段语义破坏标识
      const encoded = encodeURIComponent(idea.id);
      assert.notEqual(encoded, idea.id);
      const res = await fetch(`${server.origin}/ideas/${encoded}`);
      assert.equal(res.status, 200, `id=${idea.id}`);
      const html = await res.text();
      assert.ok(html.includes(`意见标识：${escapeHtml(idea.id)}`), `id=${idea.id}`);
      assert.ok(html.includes(escapeHtml(idea.title)), `id=${idea.id}`);
    }
    // 字面斜杠虽把路径拆成两段，但剥掉统一前缀后还原出的标识与存储逐字一致，
    // 同样准确指向这一条（不会误命中或丢失）；关键是分享用的编码链接必须可用
    const literalSlash = await fetchViewRaw(server, 'slash/inside');
    assert.equal(literalSlash.status, 200);
    const literalSlashHtml = await literalSlash.text();
    assert.ok(literalSlashHtml.includes('意见标识：slash/inside'));
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('历史标识为“.”或“..”：查询串形式的分享链接各自准确指向自己的记录，可直接打开与刷新', async () => {
  const dir = freshDir();
  // 同标题同说明、标识仅差在“.”“..”，另放字面文字“%2E”“%2E%2E”，证明四类互不相混
  const ideas: Idea[] = [
    { id: '..', title: '同文意见', description: '完全相同的详细说明', scenario: '上级点的场景', createdAt: '2020-02-02T00:00:00.000Z' },
    { id: '.', title: '同文意见', description: '完全相同的详细说明', scenario: '', createdAt: '2020-01-01T00:00:00.000Z' },
    { id: '%2E', title: '文字百分号二E', description: '标识逐字是 %2E', scenario: '', createdAt: '2020-03-03T00:00:00.000Z' },
    { id: '%2E%2E', title: '文字百分号二E两次', description: '标识逐字是 %2E%2E', scenario: '', createdAt: '2020-04-04T00:00:00.000Z' },
  ];
  seedIdeas(dir, ideas);
  const server = await startWith(dir);
  try {
    // 首页为“.”“..”生成的链接形态：标识放在查询串，且仍是 encodeURIComponent 后的原文
    for (const id of ['.', '..']) {
      const res = await fetchViewQuery(server, id);
      assert.equal(res.status, 200, `id=${id}`);
      const html = await res.text();
      // 用 </p> 锚定标识块，避免“..”包含“.”前缀造成子串歧义
      assert.ok(html.includes(`意见标识：${id}</p>`), `id=${id}`);
      assert.ok(html.includes(escapeHtml('同文意见')));
      // 页面只属于自己这一条：另一个点标识不能出现
      assert.ok(!html.includes(`意见标识：${id === '.' ? '..' : '.'}</p>`));
      assert.ok(!html.includes('文字百分号二E'));
      assertBackHome(html);
      // 直接打开与刷新等价：再次 GET 返回逐字相同的页面
      const again = await fetchViewQuery(server, id);
      assert.equal(again.status, 200);
      assert.equal(await again.text(), html);
    }
    // “.”记录 scenario 为空时不显示场景段；“..”记录的场景正常显示
    const dotHtml = await (await fetchViewQuery(server, '.')).text();
    assert.ok(!dotHtml.includes('使用场景：'));
    const dotDotHtml = await (await fetchViewQuery(server, '..')).text();
    assert.ok(dotDotHtml.includes(escapeHtml('上级点的场景')));

    // 未编码的点（浏览器从 /ideas?id=. 直接发出的形态）与编码成 %2E 的查询值
    // 解码后是同一标识，展示结果必须一致
    const rawDot = await fetchViewQueryRaw(server, 'id=.');
    assert.equal(rawDot.status, 200);
    const rawDotHtml = await rawDot.text();
    assert.ok(rawDotHtml.includes('意见标识：.'));
    const encodedDot = await fetchViewQueryRaw(server, 'id=%2E');
    assert.equal(encodedDot.status, 200);
    assert.equal(await encodedDot.text(), rawDotHtml);
    const encodedDotDot = await fetchViewQueryRaw(server, 'id=%2E%2E');
    assert.equal(encodedDotDot.status, 200);
    assert.ok((await encodedDotDot.text()).includes('意见标识：..'));

    // 文字“%2E”“%2E%2E”仍是不同标识，继续走路径形式并显示各自的记录，
    // 不能因为点标识改用查询串而与“.”“..”混成一条
    const literalOne = await fetchView(server, '%2E');
    assert.equal(literalOne.status, 200);
    const literalOneHtml = await literalOne.text();
    assert.ok(literalOneHtml.includes('意见标识：%2E'));
    assert.ok(literalOneHtml.includes('文字百分号二E'));
    assert.ok(!literalOneHtml.includes('意见标识：.'));
    const literalTwo = await fetchView(server, '%2E%2E');
    assert.equal(literalTwo.status, 200);
    const literalTwoHtml = await literalTwo.text();
    assert.ok(literalTwoHtml.includes('意见标识：%2E%2E'));
    assert.ok(!literalTwoHtml.includes('意见标识：..'));

    // 查询串指向不存在的标识：404 明确提示不存在，不展示其他意见
    const missing = await fetchViewQuery(server, 'no-such-id');
    assert.equal(missing.status, 404);
    const missingHtml = await missing.text();
    assert.ok(missingHtml.includes('该意见不存在'));
    assert.ok(!missingHtml.includes('意见标识：.'));
    assertBackHome(missingHtml);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('历史标识为“.”“..”且历史标题为空白：查询串入口仍能打开，并可辨认当前是哪条', async () => {
  const dir = freshDir();
  const ideas: Idea[] = [
    { id: '.', title: '  \t\n ', description: '单点的空白标题正文', scenario: '单点场景', createdAt: '2020-01-01T00:01:00.000Z' },
    { id: '..', title: '', description: '双点的空标题正文', scenario: '', createdAt: '2020-02-02T00:02:00.000Z' },
  ];
  seedIdeas(dir, ideas);
  const server = await startWith(dir);
  try {
    for (const idea of ideas) {
      const res = await fetchViewQuery(server, idea.id);
      assert.equal(res.status, 200, `id=${idea.id}`);
      const html = await res.text();
      assert.ok(html.includes(`意见标识：${idea.id}`));
      assert.ok(html.includes(escapeHtml(idea.description)));
      assertBackHome(html);
    }
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('点标识查看入口的边界：无 id 查询仍为 JSON 404；畸形编码 404 页面；非 GET 405；存储损坏 500', async () => {
  const dir = freshDir();
  seedIdeas(dir, [
    { id: '.', title: '单点标题 AAA', description: '单点正文 BBB', scenario: '', createdAt: '2020-01-01T00:00:00.000Z' },
  ]);
  const server = await startWith(dir);
  const file = join(dir, 'ideas.json');
  try {
    // /ideas 不带 id、带空 id 或带其他参数，都与 /ideas/ 一样属于未知路径（JSON 404）
    for (const path of ['/ideas', '/ideas?', '/ideas?id=', '/ideas?other=.', '/ideas?id']) {
      const res = await fetch(`${server.origin}${path}`);
      assert.equal(res.status, 404, path);
      const data = await res.json();
      assert.equal(data.error, 'not found', path);
    }

    // 查询串里畸形的百分号编码按“该意见不存在”处理，不能导致 500
    for (const query of ['id=%zz', 'id=%', 'id=%E4%B8%AD']) {
      const res = await fetchViewQueryRaw(server, query);
      assert.equal(res.status, 404, query);
      const html = await res.text();
      assert.ok(html.includes('该意见不存在'), query);
    }

    // 查看页（含查询形式）只支持 GET
    const del = await fetchViewQuery(server, '.', { method: 'DELETE' });
    assert.equal(del.status, 405);
    assert.match(del.headers.get('allow') ?? '', /GET/);

    // 存储损坏时查询形式同样报 500，不能把读取失败冒充成“意见不存在”
    writeFileSync(file, Buffer.from('not-json', 'utf8'));
    const broken = await fetchViewQuery(server, '.');
    assert.equal(broken.status, 500);
    const brokenHtml = await broken.text();
    assert.ok(brokenHtml.includes('加载失败'));
    assert.ok(!brokenHtml.includes('该意见不存在'));
    assert.ok(!brokenHtml.includes('单点标题 AAA'));
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('历史标题为空或只有空白：查看页仍能打开并辨认出当前是哪条意见', async () => {
  const dir = freshDir();
  const ideas: Idea[] = [
    { id: 'empty-title', title: '', description: '标题为空字符串的正文', scenario: '空标题的场景', createdAt: '2020-03-03T00:03:00.000Z' },
    { id: 'blank-title', title: '  \t\n ', description: '标题只有空白的正文', scenario: '', createdAt: '2020-04-04T00:04:00.000Z' },
  ];
  seedIdeas(dir, ideas);
  const server = await startWith(dir);
  try {
    for (const idea of ideas) {
      const res = await fetchView(server, idea.id);
      assert.equal(res.status, 200, `id=${idea.id}`);
      const html = await res.text();
      // 标题文字（包括空白）按原文展示；记录仍可由意见标识辨认
      assert.ok(html.includes(`意见标识：${idea.id}`));
      assert.ok(html.includes(escapeHtml(idea.description)));
      assertBackHome(html);
    }
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('历史兼容：超过今天提交上限的标题/说明/场景在查看页按原文完整展示，不截断、不拒绝', async () => {
  const dir = freshDir();
  const longTitle = '  ' + repeatCp('长', 121) + ' ';
  const longDescription = repeatCp('描', 5000) + '😀';
  const longScenario = repeatCp('景', 1001);
  const ideas: Idea[] = [
    { id: 'legacy-long', title: longTitle, description: longDescription, scenario: longScenario, createdAt: '2019-01-01T00:00:00.000Z' },
    { id: 'legacy-empty-desc', title: '空正文历史', description: '', scenario: '有场景', createdAt: '2019-02-02T00:00:00.000Z' },
  ];
  seedIdeas(dir, ideas);
  const server = await startWith(dir);
  try {
    const res = await fetchView(server, 'legacy-long');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes(escapeHtml(longTitle)), '超限标题完整保留');
    assert.ok(html.includes(escapeHtml(longDescription)), '5001 码点说明完整保留');
    assert.ok(html.includes(escapeHtml(longScenario)), '超限场景完整保留');
    assert.ok(html.includes(escapeHtml('2019-01-01T00:00:00.000Z')));

    // 空白说明也按原文（空）展示，不替换默认文字
    const res2 = await fetchView(server, 'legacy-empty-desc');
    assert.equal(res2.status, 200);
    const html2 = await res2.text();
    assert.ok(html2.includes('意见标识：legacy-empty-desc'));
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('换行、空白、中文与表情逐字保留；网页标记样文本与实体写法按普通文字显示，不解析成元素', async () => {
  const dir = freshDir();
  const markupTitle = '建议 <b>重点</b> 支持深色模式 😀';
  const markupDescription = [
    '  首行保留首尾空白  ',
    '',
    '脚本样文本 <script>alert("x")</script> 与图片 <img src=x onerror="alert(1)">',
    '实体原文 &lt;div&gt;、&amp;、&quot;引号&quot;',
    '  末行  😀  ',
  ].join('\n');
  const markupScenario = '  场景 <b>加粗</b> &lt;标签&gt;\n\n含空行  ';
  const ideas: Idea[] = [
    { id: 'markup-1', title: markupTitle, description: markupDescription, scenario: markupScenario, createdAt: 'not-a-date-but-a-string' },
  ];
  seedIdeas(dir, ideas);
  const server = await startWith(dir);
  try {
    const res = await fetchView(server, 'markup-1');
    assert.equal(res.status, 200);
    const html = await res.text();

    // 转义后的原文逐字出现（空白与换行原样保留在 pre 块中）
    assert.ok(html.includes(escapeHtml(markupTitle)));
    assert.ok(html.includes(escapeHtml(markupDescription)));
    assert.ok(html.includes(escapeHtml(markupScenario)));
    // 不能解析为日期的提交时间按原文展示
    assert.ok(html.includes(escapeHtml('not-a-date-but-a-string')));

    // 标记不能变成真实元素或属性：页面源码中不允许出现意见文字里的原始标签
    assert.ok(!/<script/i.test(html), '意见文字中的脚本不能成为页面元素');
    assert.ok(!/<img/i.test(html), '意见文字中的图片不能成为页面元素');
    // onerror 字样只能以转义后的普通文字存在（尖括号与引号已转义，不构成属性）
    assert.ok(html.includes(escapeHtml('<img src=x onerror="alert(1)">')));
    assert.ok(!html.includes('<b>重点</b>'));
    // 尖括号以转义形态存在
    assert.ok(html.includes('&lt;b&gt;重点&lt;/b&gt;'));
    // 用户写下的实体原文不解码也不再叠加成别的东西：&lt; 在源码中是 &amp;lt;
    assert.ok(html.includes('&amp;lt;div&amp;gt;'));
    assert.ok(html.includes('&amp;amp;'));
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('常规字段之外的附加信息（含多层对象）不在查看页面公开', async () => {
  const dir = freshDir();
  const ideas: Idea[] = [
    {
      id: 'with-secret',
      title: '带附加信息的意见',
      description: '正文',
      scenario: '',
      createdAt: '2020-01-01T00:00:00.000Z',
      internalNote: '这是内部备注 SECRET-TOKEN-123',
      meta: { owner: 'someone', flags: [1, 2, 3], nested: { hidden: 'HIDDEN-VALUE' } },
    },
  ];
  seedIdeas(dir, ideas);
  const server = await startWith(dir);
  try {
    const res = await fetchView(server, 'with-secret');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('带附加信息的意见'));
    assert.ok(!html.includes('SECRET-TOKEN-123'));
    assert.ok(!html.includes('internalNote'));
    assert.ok(!html.includes('HIDDEN-VALUE'));
    assert.ok(!html.includes('someone'));
    assert.ok(!html.includes('flags'));
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('链接指向不存在的意见：404 明确提示该意见不存在、可返回首页，不展示任何其他意见', async () => {
  const dir = freshDir();
  const ideas: Idea[] = [
    { id: 'exists-1', title: '唯一真实存在的意见标题 XYZ', description: '唯一真实存在的正文', scenario: '', createdAt: '2020-01-01T00:00:00.000Z' },
    { id: 'dup-a', title: '同文意见', description: '同文说明', scenario: '', createdAt: '2020-01-01T00:00:00.000Z' },
    { id: 'dup-b', title: '同文意见', description: '同文说明', scenario: '', createdAt: '2020-01-01T00:00:00.000Z' },
  ];
  seedIdeas(dir, ideas);
  const server = await startWith(dir);
  try {
    const res = await fetchView(server, 'does-not-exist');
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('该意见不存在'));
    assertBackHome(html);
    // 不能显示其他意见，也不能把它说成整个产品没有意见
    assert.ok(!html.includes('唯一真实存在的意见标题 XYZ'));
    assert.ok(!html.includes('唯一真实存在的正文'));
    assert.ok(!html.includes('还没有意见记录'));

    // 同文不同 id：缺的那一条不能被另一条顶替
    const missingTwin = await fetchView(server, 'dup-c');
    assert.equal(missingTwin.status, 404);
    const twinHtml = await missingTwin.text();
    assert.ok(twinHtml.includes('该意见不存在'));
    assert.ok(!twinHtml.includes('意见标识：dup-a'));
    assert.ok(!twinHtml.includes('意见标识：dup-b'));

    // 空数据目录下同样是“不存在”，而不是“加载失败”
    const emptyDir = freshDir();
    const emptyServer = await startWith(emptyDir);
    try {
      const emptyRes = await fetchView(emptyServer, 'anything');
      assert.equal(emptyRes.status, 404);
      const emptyHtml = await emptyRes.text();
      assert.ok(emptyHtml.includes('该意见不存在'));
      assert.ok(!emptyHtml.includes('加载失败'));
    } finally {
      await emptyServer.stop();
      rmSync(emptyDir, { recursive: true, force: true });
    }
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('已有数据无法读取或内容损坏：查看页明确提示加载失败（500），不冒充不存在、不展示半份详情', async (t) => {
  const dir = freshDir();
  seedIdeas(dir, [
    { id: 'good-1', title: '正常意见标题 AAA', description: '正常意见正文 BBB', scenario: '', createdAt: '2020-01-01T00:00:00.000Z' },
  ]);
  const server = await startWith(dir);
  const file = join(dir, 'ideas.json');

  const corruptCases = [
    {
      name: 'JSON 被截断',
      bytes: Buffer.from('[\n  {"id":"good-1","title":"正常意见标题 AAA"', 'utf8'),
    },
    {
      name: '顶层不是数组',
      bytes: Buffer.from('{"ideas":[]}', 'utf8'),
    },
    {
      name: '混入结构不完整记录',
      bytes: Buffer.from(JSON.stringify([
        { id: 'good-1', title: '正常意见标题 AAA', description: '正常意见正文 BBB', scenario: '', createdAt: '2020-01-01T00:00:00.000Z' },
        { id: 'bad-1', title: '缺字段的损坏记录' },
      ]), 'utf8'),
    },
    {
      name: '非法 UTF-8 字节',
      bytes: Buffer.concat([
        Buffer.from('[{"id":"good-1","title":"', 'utf8'),
        Buffer.from([0xe4, 0xb8]), // 缺少后续字节的多字节字符
        Buffer.from('","description":"正常意见正文 BBB","scenario":"","createdAt":"2020-01-01T00:00:00.000Z"}]', 'utf8'),
      ]),
    },
  ];

  try {
    for (const c of corruptCases) {
      await t.test(c.name, async () => {
        writeFileSync(file, c.bytes);
        const res = await fetchView(server, 'good-1');
        assert.equal(res.status, 500, c.name);
        assert.match(res.headers.get('content-type') ?? '', /text\/html/);
        const html = await res.text();
        assert.ok(html.includes('加载失败'), c.name);
        assert.ok(!html.includes('该意见不存在'), '读取失败不能被说成不存在');
        // 不展示半份详情：损坏文件里的任何文字都不能出现在页面上
        assert.ok(!html.includes('正常意见标题 AAA'), c.name);
        assert.ok(!html.includes('正常意见正文 BBB'), c.name);
        assert.ok(!html.includes('意见标识：good-1'), c.name);
        assertBackHome(html);
      });
    }

    // 数据恢复后同一链接重新可用
    seedIdeas(dir, [
      { id: 'good-1', title: '正常意见标题 AAA', description: '正常意见正文 BBB', scenario: '', createdAt: '2020-01-01T00:00:00.000Z' },
    ]);
    const recovered = await fetchView(server, 'good-1');
    assert.equal(recovered.status, 200);
    const recoveredHtml = await recovered.text();
    assert.ok(recoveredHtml.includes('正常意见标题 AAA'));
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('查看相关路由：畸形百分号编码按不存在处理；/ideas/ 与未知路径仍为 404；非 GET 方法 405', async () => {
  const dir = freshDir();
  seedIdeas(dir, [
    { id: 'x', title: '标题', description: '正文', scenario: '', createdAt: '2020-01-01T00:00:00.000Z' },
  ]);
  const server = await startWith(dir);
  try {
    // decodeURIComponent 会抛错的路径段：不能导致 500，按找不到该意见处理
    for (const segment of ['%zz', '%E4%B8%AD', '%']) {
      const res = await fetchViewRaw(server, segment);
      assert.equal(res.status, 404, segment);
      const html = await res.text();
      assert.ok(html.includes('该意见不存在'), segment);
    }

    // 没有标识段的路径不属于查看页，保持原有的 JSON 404
    for (const path of ['/ideas/', '/ideas']) {
      const res = await fetch(`${server.origin}${path}`);
      assert.equal(res.status, 404, path);
      const data = await res.json();
      assert.equal(data.error, 'not found');
    }

    // 完全无关路径仍是 JSON 404
    const unknown = await fetch(`${server.origin}/nope`);
    assert.equal(unknown.status, 404);

    // 查看页只支持 GET
    const del = await fetchView(server, 'x', { method: 'DELETE' });
    assert.equal(del.status, 405);
    assert.match(del.headers.get('allow') ?? '', /GET/);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('查看功能不改变现有接口与首页：列表返回、提交、首页表单与首页初始状态保持兼容', async () => {
  const dir = freshDir();
  const server = await startWith(dir);
  try {
    // 首页仍是原来的表单 + 列表页面（不是查看页）
    const home = await fetch(`${server.origin}/`);
    assert.equal(home.status, 200);
    const homeHtml = await home.text();
    assert.ok(homeHtml.includes('<form id="idea-form"'));
    assert.ok(homeHtml.includes('id="ideas"'));
    assert.ok(homeHtml.includes('还没有意见记录。'));
    assert.match(homeHtml, /<p id="empty"[^>]*hidden/);

    // 提交与列表接口行为不变
    const postRes = await fetch(`${server.origin}/api/ideas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '兼容检查', description: '兼容检查正文', scenario: '场景' }),
    });
    assert.equal(postRes.status, 201);
    const listRes = await fetch(`${server.origin}/api/ideas`);
    const list = await listRes.json();
    assert.equal(list.ideas.length, 1);
    assert.equal(list.ideas[0].title, '兼容检查');
  } finally {
    await server.stop();
    removeDataDir(server);
  }
});

// 孤立 Unicode 代理码元标识的端到端回归 ------------------------------------------------
// 合法 JSON 字符串可含未配对的高/低代理码元（如 "旧意见\uD800"）：文件是合法 UTF-8、
// 记录结构完整，必须作为已有意见读取。这类标识无法用 encodeURIComponent（抛 URIError），
// 首页改用兼容编码（每个孤立码元编成“%75”加四位大写十六进制，形如 uXXXX 转义）生成
// /ideas/<兼容编码> 链接；这里直接以公开链接形态请求，覆盖直接打开、刷新、精确匹配、
// 同文不同代理项相互独立、损坏与不存在的区分，以及读操作不改写存储。
const HIGH_UNIT = String.fromCharCode(0xd800);
const LOW_UNIT = String.fromCharCode(0xdc00);

// 与 server.ts 的 encodeCompatViewId 逐字同规则，用于在测试里构造分享链接
function encodeCompatViewId(id: string): string {
  let out = '';
  for (let i = 0; i < id.length; i++) {
    const unit = id.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = id.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += encodeURIComponent(id[i] + id[i + 1]);
        i += 1;
        continue;
      }
      out += '%75' + unit.toString(16).toUpperCase().padStart(4, '0');
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      out += '%75' + unit.toString(16).toUpperCase().padStart(4, '0');
      continue;
    }
    out += encodeURIComponent(id[i]);
  }
  return out;
}
function compatUrl(server: StartedServer, id: string): string {
  return `${server.origin}/ideas/${encodeCompatViewId(id)}`;
}

test('孤立代理码元标识：列表接口原样返回标识，兼容分享链接直接打开与刷新展示同一条且不依赖首页', async () => {
  const dir = freshDir();
  const highId = `旧意见${HIGH_UNIT}`;
  const ideas: Idea[] = [
    { id: 'normal-1', title: '普通意见', description: '普通正文', scenario: '', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: highId, title: '未配对高代理意见', description: `高代理正文${HIGH_UNIT}结尾`, scenario: '高代理场景', createdAt: '2026-02-02T00:00:00.000Z' },
  ];
  seedIdeas(dir, ideas);
  const server = await startWith(dir);
  try {
    // 列表接口返回的原始标识保持不变：JSON 以 \ud800 转义承载，解析后仍是同一孤立码元
    const listRes = await fetch(`${server.origin}/api/ideas`);
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.equal(list.ideas.length, 2);
    assert.equal(list.ideas[1].id, highId);
    assert.equal(list.ideas[1].id.charCodeAt(list.ideas[1].id.length - 1), 0xd800);

    // 直接打开兼容链接（不经过首页）：200 且只展示这一条
    const url = compatUrl(server, highId);
    assert.equal(url, `${server.origin}/ideas/%E6%97%A7%E6%84%8F%E8%A7%81%75D800`);
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('未配对高代理意见'));
    // 正文中的孤立码元同样以字面 \uD800 文本显示（而非替代符号），六字逐字出现在源码里
    assert.ok(html.includes('高代理正文\\uD800结尾'), '正文中的孤立码元同样以可辨文字显示');
    assert.ok(html.includes(escapeHtml('高代理场景')));
    assert.ok(html.includes('意见标识：旧意见\\uD800'), '高代理码元以字面 \\uD800 显示，可与低代理区分');
    assert.ok(!html.includes('意见标识：normal-1'), '不展示其他意见');
    assertBackHome(html);

    // 刷新（再次直接打开）逐字一致
    const again = await fetch(url);
    assert.equal(again.status, 200);
    assert.equal(await again.text(), html);

    // 另一条普通意见仍走已公开的普通路径地址
    const normal = await fetchView(server, 'normal-1');
    assert.equal(normal.status, 200);
    assert.ok((await normal.text()).includes('意见标识：normal-1'));
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('孤立代理码元标识：标题说明相同、标识仅差在高/低代理码元的两条记录各自独立、页面可区分', async () => {
  const dir = freshDir();
  const highId = `同文${HIGH_UNIT}`;
  const lowId = `同文${LOW_UNIT}`;
  const ideas: Idea[] = [
    { id: highId, title: '完全相同的标题', description: '完全相同的说明', scenario: '', createdAt: '2020-01-01T00:00:00.000Z' },
    { id: lowId, title: '完全相同的标题', description: '完全相同的说明', scenario: '', createdAt: '2020-02-02T00:00:00.000Z' },
  ];
  seedIdeas(dir, ideas);
  const server = await startWith(dir);
  try {
    const highRes = await fetch(compatUrl(server, highId));
    assert.equal(highRes.status, 200);
    const highHtml = await highRes.text();
    assert.ok(highHtml.includes('意见标识：同文\\uD800</p>'));
    assert.ok(!highHtml.includes('意见标识：同文\\uDC00'));

    const lowRes = await fetch(compatUrl(server, lowId));
    assert.equal(lowRes.status, 200);
    const lowHtml = await lowRes.text();
    assert.ok(lowHtml.includes('意见标识：同文\\uDC00</p>'));
    assert.ok(!lowHtml.includes('意见标识：同文\\uD800</p>'));

    // 两页不同（提交时间与标识不同），不能都显示成相同的替代符号
    assert.notEqual(highHtml, lowHtml);
    assert.ok(!highHtml.includes('�'));
    assert.ok(!lowHtml.includes('�'));
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('孤立代理码元标识：查看是只读操作，磁盘逐字节不变；普通与点标识的既有地址不受影响', async () => {
  const dir = freshDir();
  const highId = `只读${HIGH_UNIT}`;
  seedIdeas(dir, [
    { id: '.', title: '单点意见', description: '单点正文', scenario: '', createdAt: '2020-03-03T00:00:00.000Z' },
    { id: highId, title: '只读高代理', description: '正文', scenario: '', createdAt: '2020-04-04T00:00:00.000Z' },
  ]);
  const server = await startWith(dir);
  const file = join(dir, 'ideas.json');
  try {
    const before = readFileSync(file);
    await fetch(compatUrl(server, highId));
    await fetchViewQuery(server, '.');
    assert.deepEqual(readFileSync(file), before, '查看前后 ideas.json 逐字节一致');
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('孤立代理码元标识：普通标识不被误判，字面“\\uD800”与“%75D800”仍走普通路径并指向原记录', async () => {
  const dir = freshDir();
  const literalEscape = '\\uD800'; // 六个普通 ASCII 字：反斜杠 u D 8 0 0
  const literalPercent = '%75D800'; // 七个普通 ASCII 字
  const emojiId = 'emoji-😀-id';
  seedIdeas(dir, [
    { id: literalEscape, title: '字面转义文字', description: '标识逐字是反斜杠uD800', scenario: '', createdAt: '2020-05-05T00:00:00.000Z' },
    { id: literalPercent, title: '字面百分号七字', description: '标识逐字是百分号75D800', scenario: '', createdAt: '2020-06-06T00:00:00.000Z' },
    { id: emojiId, title: '完整表情标识', description: '表情正文', scenario: '', createdAt: '2020-07-07T00:00:00.000Z' },
  ]);
  const server = await startWith(dir);
  try {
    const esc = await fetchView(server, literalEscape);
    assert.equal(esc.status, 200);
    const escHtml = await esc.text();
    assert.ok(escHtml.includes('意见标识：\\uD800'));
    assert.ok(escHtml.includes('字面转义文字'));

    const pct = await fetchView(server, literalPercent);
    assert.equal(pct.status, 200);
    const pctHtml = await pct.text();
    assert.ok(pctHtml.includes('意见标识：%75D800'));

    const emoji = await fetchView(server, emojiId);
    assert.equal(emoji.status, 200);
    assert.ok((await emoji.text()).includes('意见标识：emoji-😀-id'));

    // 真实的孤立高代理兼容链接不能被上面任何普通标识顶替
    const surrogate = await fetch(`${server.origin}/ideas/%E4%B8%AD%75D800`);
    assert.equal(surrogate.status, 404);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('孤立代理码元标识：兼容链接损坏或标识无法还原时 404；能还原但无记录也 404；存储不可读时 500', async () => {
  const dir = freshDir();
  const highId = `中${HIGH_UNIT}`;
  seedIdeas(dir, [
    { id: highId, title: '存在的高代理意见', description: '正文', scenario: '', createdAt: '2020-08-08T00:00:00.000Z' },
  ]);
  const server = await startWith(dir);
  const file = join(dir, 'ideas.json');
  try {
    // 兼容转义之外混入畸形百分号编码：整条标识无法可靠还原，按不存在处理（不猜测、不 500）
    for (const segment of ['x%75D800%zz', '%75D800%E4%B8', '%zz%75D800']) {
      const res = await fetchViewRaw(server, segment);
      assert.equal(res.status, 404, segment);
      const html = await res.text();
      assert.ok(html.includes('该意见不存在'), segment);
      assertBackHome(html);
    }

    // 能正常还原成某个标识、但没有对应记录：同样 404。
    // 其中两种易混淆形态也要走“正常解码再精确匹配”：
    // %75DBFF 是合法的兼容转义（代理区末端 U+DBFF）；%75d800 是小写、不构成兼容转义，
    // 按普通百分号编码还原成字面文字“ud800”——二者都不是存储中的那条“中\uD800”。
    for (const segment of ['%75D800%E4%B8%AD', '%75DBFF', '%75d800', '%75D7FF']) {
      const res = await fetchViewRaw(server, segment);
      assert.equal(res.status, 404, segment);
      assert.ok((await res.text()).includes('该意见不存在'), segment);
    }

    // 能正常还原成孤立码元标识、但没有对应记录：同样 404
    const lowMissing = await fetch(`${server.origin}/ideas/${encodeCompatViewId(`中${LOW_UNIT}`)}`);
    assert.equal(lowMissing.status, 404);
    assert.ok((await lowMissing.text()).includes('该意见不存在'));

    // 存储确实无法读取时仍是 500 加载失败，不把合法孤立代理标识当成数据错误
    const bytesBefore = readFileSync(file);
    writeFileSync(file, Buffer.from('not-json', 'utf8'));
    const broken = await fetch(compatUrl(server, highId));
    assert.equal(broken.status, 500);
    const brokenHtml = await broken.text();
    assert.ok(brokenHtml.includes('加载失败'));
    assert.ok(!brokenHtml.includes('该意见不存在'));
    assert.ok(!brokenHtml.includes('存在的高代理意见'));

    // 数据恢复后同一兼容链接重新可用
    writeFileSync(file, bytesBefore);
    const recovered = await fetch(compatUrl(server, highId));
    assert.equal(recovered.status, 200);
    assert.ok((await recovered.text()).includes('存在的高代理意见'));
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
