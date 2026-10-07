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
