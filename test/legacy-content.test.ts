import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../testing/server.ts';

// 读取兼容的回归保障：保护「已经保存的意见只按结构完整性读取，不重新套用新提交的内容限制」
// 这一现有行为。新意见的提交规则仍由接口与首页的内容校验约束（标题去首尾空白后非空、
// 最多 120 码点；详细说明含非空白内容、最多 5000 码点；使用场景最多 1000 码点），
// 但这些规则只能作用于新提交，读取历史记录时不能再套一遍——否则上限或空白要求一旦变化，
// 旧意见就会在列表接口变成整次加载失败。
//
// 本文件真实起一份 server.ts，启动前直接把「按今天的规则已无法提交、但记录结构完整」的
// 历史数据写入 ideas.json，只走公开的 GET/POST /api/ideas，覆盖：
//   - 标题/详细说明/使用场景超过当前上限、标题或详细说明只有空白的历史记录仍 200 返回，
//     长内容不截断、空白不替换为默认文字，首尾空白、换行、中文、表情与标记样文本逐字保留；
//   - scenario 为空字符串是正常记录（与缺少 scenario 字段不同），同样原样读取；
//   - 读取完成后再提交一条符合当前规则的新意见：201 且排在旧意见之前，
//     旧记录的内容、标识、时间与相对次序保持不变，SIGTERM 重启后仍然如此；
//   - 同样的超限或空白内容作为新意见提交时仍返回 400 字段错误，旧记录不受影响——
//     新旧内容的区别必须保留；
//   - 结构判定不能为了接受超限旧内容而放宽：混入缺字段或字段类型错误的记录时，
//     即使其中夹着结构完整的超限记录，整次读取仍 500 失败，磁盘内容逐字节保留。

interface Idea {
  id: string;
  title: string;
  description: string;
  scenario: string;
  createdAt: string;
}

const TITLE_LIMIT = 120;
const DESCRIPTION_LIMIT = 5000;
const SCENARIO_LIMIT = 1000;
const points = (text: string): number => Array.from(text).length;
const repeatCp = (char: string, times: number): string => char.repeat(times);

// 一组按今天的提交规则已无法新建、但结构完整的历史记录，刻意夹着一条普通意见，
// 用来证明读取时不会跳过内容特殊的记录、也不会只返回混在其中的普通意见。
// 磁盘上的数组次序就是接口返回次序（最新在前由写入方保证，读取方不重排）。
function legacyIdeas(): Idea[] {
  return [
    {
      id: 'legacy-over-title-0001',
      // 标题超过当前上限一个码点，且含首尾空白（历史标题不去空白、不截断）
      title: '  ' + repeatCp('长', TITLE_LIMIT + 1) + ' ',
      description: '标题超限历史记录的正文\n第二行保留换行 与中文😀',
      scenario: '标题超限记录的场景',
      createdAt: '2020-01-01T00:00:00.000Z',
    },
    {
      id: 'legacy-over-desc-0002',
      title: '正文超限的历史意见',
      // 详细说明恰好超过当前上限一个码点：5000 个中文 + 单个 😀
      description: repeatCp('描', DESCRIPTION_LIMIT) + '😀',
      scenario: '正文超限记录的场景 🌙',
      createdAt: '2020-02-02T00:02:00.000Z',
    },
    {
      id: 'legacy-over-scenario-0003',
      title: '  场景超限且标题首尾空白保留  ',
      description: '场景超限历史记录的正文',
      // 使用场景超过当前上限一个码点
      scenario: repeatCp('景', SCENARIO_LIMIT + 1),
      createdAt: '2020-03-03T00:03:00.000Z',
    },
    {
      // 混在特殊记录中间的普通意见：不能变成只显示这一条
      id: 'legacy-normal-0004',
      title: '混排在其中的普通意见',
      description: '完全符合当前规则的普通正文',
      scenario: '',
      createdAt: '2020-04-04T00:04:00.000Z',
    },
    {
      id: 'legacy-blank-title-0005',
      // 标题是空字符串与只有空白的两种边界之一：只有空白（空字符串另由 blank-title-empty 覆盖）
      title: '  \t\n ',
      description: '标题只有空白的历史正文，必须按原文读到，不能替换成默认标题',
      scenario: '空白标题记录的场景',
      createdAt: '2020-05-05T00:05:00.000Z',
    },
    {
      id: 'legacy-blank-desc-0006',
      title: '正文只有空白的历史意见',
      // 详细说明只有空白（含换行）：不能替换成默认正文，也不能判为读取失败
      description: '  \n\t  ',
      scenario: '',
      createdAt: '2020-06-06T00:06:00.000Z',
    },
    {
      id: 'legacy-markup-0007',
      // 标题首尾空白 + 尖括号/标记样文本：按普通文字读取，不解释成网页结构
      title: '  建议 <b>重点</b> 支持深色模式 😀  ',
      description: [
        '正文第一行保留换行',
        '脚本样文本 <script>alert("x")</script> 与实体原文 &lt;div&gt; &amp;',
        '末行含中文、表情与空白  😀  ',
      ].join('\n'),
      // scenario 为空字符串：正常记录，读取时原样保留为空，不能与缺少 scenario 字段混淆
      scenario: '',
      createdAt: 'not-a-date-but-a-string',
    },
    {
      id: 'legacy-empty-title-0008',
      // 标题就是空字符串：结构完整（字段存在且为字符串）即读取成功
      title: '',
      description: '标题为空字符串的历史正文',
      scenario: '空标题记录的场景',
      createdAt: '2020-08-08T00:08:00.000Z',
    },
    {
      id: 'legacy-empty-desc-0009',
      title: '正文为空字符串的历史意见',
      description: '',
      scenario: '空正文记录的场景\n第二行换行保留',
      createdAt: '2020-09-09T00:09:00.000Z',
    },
  ];
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'featureharbor-legacy-'));
}

async function getIdeas(
  server: StartedServer,
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${server.origin}/api/ideas`);
  return { status: res.status, data: await res.json() };
}

async function postIdea(
  server: StartedServer,
  body: unknown,
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function safeStop(server: StartedServer | undefined): Promise<void> {
  if (!server) return;
  await Promise.race([
    server.stop(),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);
}

// 预置结构完整但内容不符合当前提交限制的历史数据后启动服务
async function startWithLegacy(dir: string, ideas: Idea[]): Promise<StartedServer> {
  writeFileSync(join(dir, 'ideas.json'), `${JSON.stringify(ideas, null, 2)}\n`, 'utf8');
  return await startServer(dir);
}

// 一条完全符合当前规则的新意见：任何失败都只能来自被测行为本身
const NEW_IDEA = {
  title: '读取旧意见之后提交的新意见',
  description: '这条意见的标题、详细说明与使用场景都符合当前规则，应照常保存。',
  scenario: '兼容旧内容后的新场景',
};

test('内容超过当前提交限制或只有空白的历史记录：列表接口成功返回且逐字按原文保留，不截断、不替换、不跳过', async () => {
  const dir = freshDir();
  const old = legacyIdeas();
  let server: StartedServer | undefined;
  try {
    server = await startWithLegacy(dir, old);

    const listed = await getIdeas(server);
    assert.equal(listed.status, 200);
    assert.ok(Array.isArray(listed.data.ideas));
    // 特殊记录一条都不能少，也不能只返回混在其中的普通意见
    assert.equal(listed.data.ideas.length, old.length);
    assert.deepEqual(listed.data.ideas, old);

    // 按 id 取记录，钉住关键内容：长内容完整保留（不截断到当前上限），
    // 空白内容不被替换成默认文字，首尾空白与换行、中文、表情逐字保留
    const byId = new Map<string, Idea>(
      (listed.data.ideas as Idea[]).map((idea) => [idea.id, idea]),
    );

    const overTitle = byId.get('legacy-over-title-0001')!;
    assert.equal(points(overTitle.title), TITLE_LIMIT + 1 + 3, '超限标题不能被截断');
    assert.ok(overTitle.title.startsWith('  ') && overTitle.title.endsWith(' '));
    assert.ok(overTitle.title.includes(repeatCp('长', TITLE_LIMIT + 1)));
    assert.equal(overTitle.description, '标题超限历史记录的正文\n第二行保留换行 与中文😀');

    const overDesc = byId.get('legacy-over-desc-0002')!;
    assert.equal(points(overDesc.description), DESCRIPTION_LIMIT + 1, '超限正文不能被截断');
    assert.ok(overDesc.description.endsWith('😀'));
    assert.equal(overDesc.scenario, '正文超限记录的场景 🌙');

    const overScenario = byId.get('legacy-over-scenario-0003')!;
    assert.equal(points(overScenario.scenario), SCENARIO_LIMIT + 1, '超限场景不能被截断');
    assert.equal(overScenario.title, '  场景超限且标题首尾空白保留  ');

    assert.equal(byId.get('legacy-blank-title-0005')!.title, '  \t\n ');
    assert.equal(byId.get('legacy-blank-desc-0006')!.description, '  \n\t  ');
    assert.equal(byId.get('legacy-empty-title-0008')!.title, '');
    assert.equal(byId.get('legacy-empty-desc-0009')!.description, '');

    // 标记样文本连同尖括号逐字返回，时间字符串即使不能解析为日期也按原文读取
    const markup = byId.get('legacy-markup-0007')!;
    assert.equal(markup.title, '  建议 <b>重点</b> 支持深色模式 😀  ');
    assert.ok(markup.description.includes('<script>alert("x")</script>'));
    assert.ok(markup.description.includes('&lt;div&gt; &amp;'));
    assert.equal(markup.scenario, '');
    assert.equal(markup.createdAt, 'not-a-date-but-a-string');

    // 再查一次，结果稳定一致，读取不能有任何改写副作用
    assert.deepEqual((await getIdeas(server)).data.ideas, old);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('读取历史记录后提交符合当前规则的新意见：201 并排最前，旧记录的内容、标识、时间与相对次序不变（重启后仍一致）', async () => {
  const dir = freshDir();
  const old = legacyIdeas();
  let server: StartedServer | undefined;
  try {
    server = await startWithLegacy(dir, old);

    const posted = await postIdea(server, NEW_IDEA);
    assert.equal(posted.status, 201);
    const newIdea = posted.data.idea as Idea;
    assert.equal(typeof newIdea.id, 'string');
    assert.ok(newIdea.id.length > 0);
    assert.equal(newIdea.title, NEW_IDEA.title);
    assert.equal(newIdea.description, NEW_IDEA.description);
    assert.equal(newIdea.scenario, NEW_IDEA.scenario);
    for (const oldId of old.map((idea) => idea.id)) assert.notEqual(newIdea.id, oldId);

    const after = await getIdeas(server);
    assert.equal(after.status, 200);
    assert.equal(after.data.ideas.length, old.length + 1);
    assert.deepEqual(after.data.ideas[0], newIdea, '新意见排在旧意见之前');
    assert.deepEqual(after.data.ideas.slice(1), old, '旧记录整体原样保留');

    // 正常停止并用同一数据目录重启：历史记录的完整内容、标识、时间与相对次序仍不变
    await server.stop();
    server = undefined;
    server = await startServer(dir);
    const afterRestart = await getIdeas(server);
    assert.equal(afterRestart.status, 200);
    assert.equal(afterRestart.data.ideas.length, old.length + 1);
    assert.deepEqual(afterRestart.data.ideas[0], newIdea);
    assert.deepEqual(afterRestart.data.ideas.slice(1), old);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('新旧内容区别保留：超限或空白内容作为新意见提交仍返回 400 字段错误，历史记录数量、次序与内容不变', async (t) => {
  const cases: Array<{ name: string; body: Record<string, unknown>; field: string }> = [
    {
      name: '标题超过 120 码点的新提交被拒',
      field: '标题',
      body: { title: repeatCp('新', TITLE_LIMIT + 1), description: '说明', scenario: '场景' },
    },
    {
      name: '详细说明超过 5000 码点的新提交被拒',
      field: '详细说明',
      body: { title: '新标题', description: repeatCp('新', DESCRIPTION_LIMIT + 1), scenario: '场景' },
    },
    {
      name: '使用场景超过 1000 码点的新提交被拒',
      field: '使用场景',
      body: { title: '新标题', description: '说明', scenario: repeatCp('新', SCENARIO_LIMIT + 1) },
    },
    {
      name: '标题只有空白的新提交被拒',
      field: '标题',
      body: { title: '  \t\n ', description: '说明', scenario: '场景' },
    },
    {
      name: '标题为空字符串的新提交被拒',
      field: '标题',
      body: { title: '', description: '说明', scenario: '场景' },
    },
    {
      name: '详细说明只有空白的新提交被拒',
      field: '详细说明',
      body: { title: '新标题', description: '  \n\t  ', scenario: '场景' },
    },
    {
      name: '详细说明为空字符串的新提交被拒',
      field: '详细说明',
      body: { title: '新标题', description: '', scenario: '场景' },
    },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const dir = freshDir();
      const old = legacyIdeas();
      let server: StartedServer | undefined;
      try {
        server = await startWithLegacy(dir, old);

        const rejected = await postIdea(server, c.body);
        assert.equal(rejected.status, 400, c.name);
        assert.equal(typeof rejected.data.error, 'string');
        assert.ok(rejected.data.error.includes(c.field), `${c.name} 的错误应指明字段，实际：${rejected.data.error}`);
        assert.equal(Object.prototype.hasOwnProperty.call(rejected.data, 'idea'), false);

        // 旧意见不受影响：不能因为拒绝新提交而重排、改写或清空历史记录
        const listed = await getIdeas(server);
        assert.equal(listed.status, 200);
        assert.deepEqual(listed.data.ideas, old, c.name);
      } finally {
        await safeStop(server);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

test('结构判定不因接受超限旧内容而放宽：结构完整的超限记录与结构损坏记录混排时整次读取失败', async (t) => {
  // 两条结构完整但内容超限的历史记录，中间夹结构损坏记录：必须整份列表失败，
  // 不能只返回结构完整的部分，也不能把内容限制和结构判定混为一谈。
  const overLimit = (id: string): Idea => ({
    id,
    title: repeatCp('长', TITLE_LIMIT + 1),
    description: repeatCp('描', DESCRIPTION_LIMIT + 1),
    scenario: repeatCp('景', SCENARIO_LIMIT + 1),
    createdAt: '2020-12-12T00:00:00.000Z',
  });
  const brokenCases: Array<{ name: string; broken: Record<string, unknown> }> = [
    { name: '损坏记录缺少 title 字段', broken: { id: 'broken-1', description: 'x', scenario: '', createdAt: '2020-11-11T00:00:00.000Z' } },
    { name: '损坏记录缺少 scenario 字段（与 scenario 空字符串不同）', broken: { id: 'broken-2', title: '无场景字段', description: 'x', createdAt: '2020-11-11T00:00:00.000Z' } },
    { name: '损坏记录 id 为空字符串', broken: { id: '', title: '空标识', description: 'x', scenario: '', createdAt: '2020-11-11T00:00:00.000Z' } },
    { name: '损坏记录字段类型错误（createdAt 为数字）', broken: { id: 'broken-3', title: '时间非字符串', description: 'x', scenario: '', createdAt: 1700000000000 } },
  ];
  for (const c of brokenCases) {
    await t.test(c.name, async () => {
      const dir = freshDir();
      const file = join(dir, 'ideas.json');
      const tmpFile = `${file}.tmp`;
      const records = [overLimit('legacy-a'), c.broken, overLimit('legacy-b')];
      writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`, 'utf8');

      let server: StartedServer | undefined;
      try {
        server = await startServer(dir);
        const before = readFileSync(file);

        const listed = await getIdeas(server);
        assert.equal(listed.status, 500, c.name);
        assert.deepEqual(listed.data, { error: 'unable to read ideas' }, c.name);
        assert.ok(readFileSync(file).equals(before), '查询失败后存储内容被改动');

        // 合法新提交同样因无法读取历史数据而失败，不能只保存新意见或只返回正常部分
        const posted = await postIdea(server, NEW_IDEA);
        assert.equal(posted.status, 500, c.name);
        assert.equal(posted.data.error, '无法读取已有意见数据，未保存新意见');
        assert.equal(Object.prototype.hasOwnProperty.call(posted.data, 'idea'), false);
        assert.ok(readFileSync(file).equals(before), '提交失败后存储内容被改动');
        assert.equal(existsSync(tmpFile), false, '失败后不应留下临时文件');
      } finally {
        await safeStop(server);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
