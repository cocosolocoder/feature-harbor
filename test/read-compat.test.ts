import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../testing/server.ts';

// 读取旧意见的兼容性回归：保护「已经保存的意见，只要记录结构完整，就继续按原文读取，
// 不重新套用现在的提交限制」这一现有行为，防止新提交校验（标题/说明/场景分别最多
// 120/5000/1000 个 Unicode 码点；标题和说明必须含非空白内容）被误用到读取路径。
// 测试在服务启动前把固定旧记录写入临时数据目录，再真实起 server.ts，只走公开入口
// （GET/POST /api/ideas），这样「旧记录原样返回」可以逐字段精确比对，不依赖先前请求。

interface Idea {
  id: string;
  title: string;
  description: string;
  scenario: string;
  createdAt: string;
}

// 当前对新提交的内容要求（与 idea-fields.ts 的 FIELD_LIMITS 一致）：
// 这些要求继续约束 POST，但读取旧记录时不能重新套用。
const LIMITS = { title: 120, description: 5000, scenario: 1000 } as const;
const points = (text: string): number => Array.from(text).length;

// 恰好 n 个码点的字符串，并自查按码点累计
function cp(char: string, n: number): string {
  const text = char.repeat(n);
  assert.equal(points(text), n);
  return text;
}

// 一条三字段都符合当前规则的正常旧记录
function normalIdea(overrides: Partial<Idea> = {}): Idea {
  return {
    id: 'normal-1',
    title: '普通意见',
    description: '这是一条各字段都在当前限制内的普通意见。',
    scenario: '日常使用',
    createdAt: '2024-02-03T04:05:06.000Z',
    ...overrides,
  };
}

// 结构完整但内容不符合「现在的提交限制」的历史记录：
//   - 标题/说明/场景分别超过当前上限（每个都只多一个码点，保证不是别的原因）；
//   - 标题为空字符串、标题只有空白（含制表符、换行与全角空格）；
//   - 详细说明为空字符串、详细说明只有空白和换行；
//   - 使用场景为空字符串（正常边界，与缺字段不同）；
// 同时保留历史标题的首尾空白、说明与场景中的换行、中文与表情；
// 含尖括号或网页标记样文字按普通文字保留；时间字符串固定、即使不能解析也按原文。
const legacyIdeas: Idea[] = [
  {
    id: 'over-title',
    title: cp('中', LIMITS.title + 1),
    description: '标题超限的旧意见说明',
    scenario: '',
    createdAt: '2024-01-01T00:00:01.000Z',
  },
  {
    id: 'over-desc',
    title: '详细说明超限旧意见',
    description: cp('😀', LIMITS.description + 1),
    scenario: '',
    createdAt: '2024-01-01T00:00:02.000Z',
  },
  {
    id: 'over-scenario',
    title: '使用场景超限旧意见',
    description: '场景超限的旧意见说明',
    scenario: cp('中', LIMITS.scenario + 1),
    createdAt: '2024-01-01T00:00:03.000Z',
  },
  {
    id: 'title-empty',
    title: '',
    description: '标题为空字符串的旧意见说明',
    scenario: '真实使用场景',
    createdAt: '2024-01-01T00:00:04.000Z',
  },
  {
    id: 'title-blank',
    title: ' \t\n 　',
    description: '标题只有空白的旧意见说明',
    scenario: '',
    createdAt: '2024-01-01T00:00:05.000Z',
  },
  {
    id: 'desc-empty',
    title: '说明为空字符串的旧意见',
    description: '',
    scenario: '',
    createdAt: '2024-01-01T00:00:06.000Z',
  },
  {
    id: 'desc-blank',
    title: '说明只有空白的旧意见',
    description: '  \n\t　 \n',
    scenario: '  场景首尾空白与换行保留\n第二行 ',
    createdAt: '2024-01-01T00:00:07.000Z',
  },
  {
    id: 'special-chars',
    // 历史标题的首尾空白必须保留；标题里的尖括号与标记样文字按普通文字
    title: '  旧标题 <b>加粗</b> 与 <img src=x onerror="alert(1)"> 😀  ',
    description:
      '旧说明第一行\n第二行\t与中文、表情 😮‍💨 及实体原文 &lt;b&gt; &amp;\n' +
      '网页标记样文字 <script>alert("x")</script> 与 <a href="https://example.com">链接</a>',
    scenario: '  旧场景\n第二行 <p>段落</p> 🇨🇳 ',
    createdAt: 'not-a-date-but-string',
  },
  {
    id: 'scenario-empty',
    title: '场景为空字符串的旧意见',
    description: '空场景与缺字段不是同一种情况，结构上完整即按原文读取',
    scenario: '',
    createdAt: '2024-01-01T00:00:09.000Z',
  },
  normalIdea({ id: 'normal-1', createdAt: '2024-01-01T00:00:10.000Z' }),
];

// 一条符合当前规则的新意见
const NEW_IDEA = {
  title: '符合当前规则的新意见',
  description: '标题、详细说明与使用场景都符合当前提交限制的新意见。',
  scenario: '迁移历史数据之后的场景',
};

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'featureharbor-readcompat-'));
}

async function safeStop(server: StartedServer | undefined): Promise<void> {
  if (!server) return;
  await Promise.race([
    server.stop(),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);
}

async function getIdeas(origin: string): Promise<{ status: number; data: any }> {
  const res = await fetch(`${origin}/api/ideas`);
  return { status: res.status, data: await res.json() };
}

async function postIdea(origin: string, body: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

test('读取旧意见：三个字段分别超当前上限、标题/说明空白的记录仍由列表接口成功原样返回，不截断、不替换、不跳过', async () => {
  const dir = freshDir();
  const file = join(dir, 'ideas.json');
  writeFileSync(file, `${JSON.stringify(legacyIdeas, null, 2)}\n`, 'utf8');

  let server: StartedServer | undefined;
  try {
    server = await startServer(dir);

    const listed = await getIdeas(server.origin);
    assert.equal(listed.status, 200);
    assert.ok(Array.isArray(listed.data.ideas));
    // 特殊记录一条都不能少，混排在其中的普通意见也不能成为唯一显示的记录
    assert.equal(listed.data.ideas.length, legacyIdeas.length);
    assert.deepEqual(listed.data.ideas, legacyIdeas);

    // 逐条钉住关键性质，避免 deepEqual 之外的预期被悄悄放宽
    const byId = new Map<string, Idea>(
      (listed.data.ideas as Idea[]).map((idea) => [idea.id, idea]),
    );
    assert.equal(points(byId.get('over-title')!.title), LIMITS.title + 1);
    assert.equal(points(byId.get('over-desc')!.description), LIMITS.description + 1);
    assert.equal(points(byId.get('over-scenario')!.scenario), LIMITS.scenario + 1);
    assert.equal(byId.get('title-empty')!.title, '');
    assert.equal(byId.get('title-blank')!.title, ' \t\n 　');
    assert.equal(byId.get('desc-empty')!.description, '');
    assert.equal(byId.get('desc-blank')!.description, '  \n\t　 \n');
    // 长内容完整保留，不能截到当前上限；空白内容不能被替换成默认文字
    assert.equal(byId.get('over-desc')!.description, cp('😀', LIMITS.description + 1));
    assert.equal(byId.get('over-scenario')!.scenario, cp('中', LIMITS.scenario + 1));
    // 历史标题首尾空白、说明/场景换行、中文、表情与标记样文字逐字保留
    const special = byId.get('special-chars')!;
    assert.ok(special.title.startsWith('  旧标题'));
    assert.ok(special.title.endsWith('😀  '));
    assert.ok(special.description.includes('\n'));
    assert.ok(special.description.includes('&lt;b&gt;'));
    assert.ok(special.description.includes('<script>alert("x")</script>'));
    assert.equal(special.scenario, '  旧场景\n第二行 <p>段落</p> 🇨🇳 ');
    assert.equal(special.createdAt, 'not-a-date-but-string');
    // scenario 为空字符串是正常记录
    assert.equal(byId.get('scenario-empty')!.scenario, '');
    // 相对次序与写入时一致
    assert.deepEqual(
      (listed.data.ideas as Idea[]).map((idea) => idea.id),
      legacyIdeas.map((idea) => idea.id),
    );
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('读取旧意见：长内容不被截断到当前上限——重启前后都按磁盘原文返回，只读请求不触发任何重写', async () => {
  const dir = freshDir();
  const file = join(dir, 'ideas.json');
  const oldIdeas: Idea[] = [
    {
      id: 'long-title',
      title: '前后缀 ' + cp('中', LIMITS.title) + ' 😀',
      description: '说明',
      scenario: '',
      createdAt: '2024-03-01T00:00:00.000Z',
    },
    {
      id: 'long-desc',
      title: '长正文',
      description: '\n' + cp('A', LIMITS.description) + 'X',
      scenario: '',
      createdAt: '2024-03-01T00:00:01.000Z',
    },
    {
      id: 'long-scenario',
      title: '长场景',
      description: '说明',
      scenario: cp('😀', LIMITS.scenario) + '中',
      createdAt: '2024-03-01T00:00:02.000Z',
    },
  ];
  const rawBefore = `${JSON.stringify(oldIdeas, null, 2)}\n`;
  writeFileSync(file, rawBefore, 'utf8');

  let server: StartedServer | undefined;
  try {
    server = await startServer(dir);
    const first = await getIdeas(server.origin);
    assert.equal(first.status, 200);
    assert.deepEqual(first.data.ideas, oldIdeas);
    // 只读请求不能因为内容超限而重写磁盘（截断、整理或替换）
    assert.equal(readFileSync(file, 'utf8'), rawBefore);
    assert.equal(existsSync(`${file}.tmp`), false);

    await server.stop();
    server = undefined;
    server = await startServer(dir);
    const second = await getIdeas(server.origin);
    assert.equal(second.status, 200);
    assert.deepEqual(second.data.ideas, oldIdeas);
    assert.equal(readFileSync(file, 'utf8'), rawBefore);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('读完旧意见后提交符合当前规则的新意见：201 并排最前，旧记录的完整内容、标识、时间与相对次序不变', async () => {
  const dir = freshDir();
  const file = join(dir, 'ideas.json');
  writeFileSync(file, `${JSON.stringify(legacyIdeas, null, 2)}\n`, 'utf8');

  let server: StartedServer | undefined;
  try {
    server = await startServer(dir);
    const before = await getIdeas(server.origin);
    assert.equal(before.status, 200);
    assert.deepEqual(before.data.ideas, legacyIdeas);

    const posted = await postIdea(server.origin, NEW_IDEA);
    assert.equal(posted.status, 201);
    const newIdea = posted.data.idea as Idea;
    assert.equal(typeof newIdea.id, 'string');
    assert.ok(newIdea.id.length > 0);
    assert.equal(newIdea.title, NEW_IDEA.title);
    assert.equal(newIdea.description, NEW_IDEA.description);
    assert.equal(newIdea.scenario, NEW_IDEA.scenario);
    for (const old of legacyIdeas) {
      assert.notEqual(newIdea.id, old.id);
    }

    const after = await getIdeas(server.origin);
    assert.equal(after.status, 200);
    assert.equal(after.data.ideas.length, legacyIdeas.length + 1);
    assert.deepEqual(after.data.ideas[0], newIdea);
    // 旧记录整体（含超限/空白内容、标识、时间）原样跟在后面，相对次序不变
    assert.deepEqual(after.data.ideas.slice(1), legacyIdeas);

    // 正常停止并用同一数据目录重启：新意见仍在最前，旧记录仍逐字段一致
    await server.stop();
    server = undefined;
    server = await startServer(dir);
    const restarted = await getIdeas(server.origin);
    assert.equal(restarted.status, 200);
    assert.equal(restarted.data.ideas.length, legacyIdeas.length + 1);
    assert.deepEqual(restarted.data.ideas[0], newIdea);
    assert.deepEqual(restarted.data.ideas.slice(1), legacyIdeas);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('读取旧意见：结构判定不放宽——混入缺字段或字段类型错误的记录时整次读取失败，不只返回正常部分', async (t) => {
  const ok = (): Idea => normalIdea({ id: 'ok-1' });
  const without = (field: keyof Idea): unknown => {
    const record: Record<string, unknown> = { ...ok() };
    delete record[field];
    return record;
  };
  const cases: Array<{ name: string; records: unknown[] }> = [
    { name: '记录为 null', records: [ok(), null] },
    { name: '记录为数组', records: [ok(), []] },
    { name: '缺少 id', records: [ok(), without('id')] },
    { name: 'id 为空字符串', records: [ok(), { ...ok(), id: '' }] },
    { name: 'id 为数字', records: [ok(), { ...ok(), id: 1 }] },
    { name: '缺少 title', records: [ok(), without('title')] },
    { name: 'title 为数字', records: [ok(), { ...ok(), title: 121 }] },
    { name: '缺少 description', records: [ok(), without('description')] },
    { name: 'description 为 null', records: [ok(), { ...ok(), description: null }] },
    { name: '缺少 scenario（与空字符串不同）', records: [ok(), without('scenario')] },
    { name: 'scenario 为数字', records: [ok(), { ...ok(), scenario: 1001 }] },
    { name: '缺少 createdAt', records: [ok(), without('createdAt')] },
    { name: 'createdAt 为数字', records: [ok(), { ...ok(), createdAt: 1704067200000 }] },
    {
      name: '结构异常记录排在首位，其后才是含超限内容但结构完整的旧意见',
      records: [{ id: 'broken-first' }, ...legacyIdeas],
    },
  ];

  for (const c of cases) {
    await t.test(c.name, async () => {
      const dir = freshDir();
      const file = join(dir, 'ideas.json');
      writeFileSync(file, `${JSON.stringify(c.records, null, 2)}\n`, 'utf8');
      const rawBefore = readFileSync(file);

      let server: StartedServer | undefined;
      try {
        server = await startServer(dir);

        // 任意一条结构异常都让整份列表读取失败：不能为了接受超限旧内容而只返回正常部分
        const listed = await getIdeas(server.origin);
        assert.equal(listed.status, 500);
        assert.deepEqual(listed.data, { error: 'unable to read ideas' });

        // 同条件下连保存新意见也必须拒绝，且错误归类为无法读取而不是字段错误 400
        const posted = await postIdea(server.origin, NEW_IDEA);
        assert.equal(posted.status, 500);
        assert.equal(posted.data.error, '无法读取已有意见数据，未保存新意见');
        assert.equal(Object.prototype.hasOwnProperty.call(posted.data, 'idea'), false);

        // 失败请求不能触发对磁盘的重写或留下临时文件
        assert.ok(readFileSync(file).equals(rawBefore));
        assert.equal(existsSync(`${file}.tmp`), false);
      } finally {
        await safeStop(server);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

test('新旧有别：超限或空白的标题、说明作为新意见提交时仍被 400 拒绝，旧记录读取不受影响', async (t) => {
  const cases: Array<{ name: string; body: Record<string, unknown>; field: string }> = [
    {
      name: '新提交标题超限被拒',
      field: '标题',
      body: { title: cp('中', LIMITS.title + 1), description: '说明', scenario: '场景' },
    },
    {
      name: '新提交详细说明超限被拒',
      field: '详细说明',
      body: { title: '标题', description: cp('中', LIMITS.description + 1), scenario: '场景' },
    },
    {
      name: '新提交使用场景超限被拒',
      field: '使用场景',
      body: { title: '标题', description: '说明', scenario: cp('中', LIMITS.scenario + 1) },
    },
    {
      name: '新提交标题为空字符串被拒',
      field: '标题',
      body: { title: '', description: '说明', scenario: '场景' },
    },
    {
      name: '新提交标题只有空白被拒',
      field: '标题',
      body: { title: '  \t　\n ', description: '说明', scenario: '场景' },
    },
    {
      name: '新提交详细说明为空字符串被拒',
      field: '详细说明',
      body: { title: '标题', description: '', scenario: '场景' },
    },
    {
      name: '新提交详细说明只有空白被拒',
      field: '详细说明',
      body: { title: '标题', description: ' \n　\t ', scenario: '场景' },
    },
  ];

  for (const c of cases) {
    await t.test(c.name, async () => {
      const dir = freshDir();
      const file = join(dir, 'ideas.json');
      writeFileSync(file, `${JSON.stringify(legacyIdeas, null, 2)}\n`, 'utf8');

      let server: StartedServer | undefined;
      try {
        server = await startServer(dir);
        const before = await getIdeas(server.origin);
        assert.equal(before.status, 200);
        assert.deepEqual(before.data.ideas, legacyIdeas);

        // 新意见仍按当前规则拒绝：400 与明确字段错误，不带保存成功的 idea
        const rejected = await postIdea(server.origin, c.body);
        assert.equal(rejected.status, 400, c.name);
        assert.equal(typeof rejected.data.error, 'string');
        assert.ok(
          rejected.data.error.includes(c.field),
          `${c.name} 的错误应指明字段，实际：${rejected.data.error}`,
        );
        assert.equal(Object.prototype.hasOwnProperty.call(rejected.data, 'idea'), false);

        // 旧记录的读取完全不受影响：数量、次序与逐字段内容不变
        const after = await getIdeas(server.origin);
        assert.equal(after.status, 200);
        assert.equal(after.data.ideas.length, legacyIdeas.length);
        assert.deepEqual(after.data.ideas, legacyIdeas);

        // 被拒内容没有混进磁盘
        const persisted: Idea[] = JSON.parse(readFileSync(file, 'utf8'));
        assert.deepEqual(persisted, legacyIdeas);
      } finally {
        await safeStop(server);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
