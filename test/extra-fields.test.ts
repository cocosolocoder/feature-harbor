import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCompleteIdea } from '../idea-fields.ts';
import { startServer, type StartedServer } from '../testing/server.ts';

// 附带信息（常规字段 id/title/description/scenario/createdAt 之外的额外字段）保留的回归保障。
// 意见列表页面只展示常规字段，但已保存记录允许携带其他信息：读取时不能像“整理数据”一样
// 只挑常规字段重组记录、只按白名单重建对象，或把读取结果重新映射一遍，否则未参与页面
// 展示的内容会在查询、追加保存（readIdeas → unshift → saveIdeas 的整表重写）或重启后丢失。
//
// 本文件真实起一份 server.ts，启动前直接把带多层附加信息的历史数据写入 ideas.json，
// 只走公开的 GET/POST /api/ideas，覆盖：
//   - 额外字段可以是文字（首尾空白、换行、中文、表情、网页标记样文本逐字保留），
//     也可以是含数组与对象的多层信息；其中的空字符串、数字零、布尔值 false/null
//     都保留各自类型与存在性，不能变成缺字段或被换成默认内容；数组内容与次序不变；
//   - 额外字段的名称、值与所属意见按 id 对应，不串到其他记录；
//     带附加信息与只含常规字段的意见都保留；标题和详细说明相同但 id 不同的记录
//     仍是独立意见，一条的附加信息不能转移或复制给另一条；
//   - 读取后通过现有提交功能保存一条符合当前规则的新意见：201 返回完整新记录，
//     新意见排在已有意见之前，旧记录（含附带信息、标识、时间、文字与相对次序）不变；
//     SIGTERM 停止后用同一 --data-dir 重启，结论仍一致；
//   - 允许额外信息不放宽完整记录要求：只要有一条意见缺少必需的 scenario 字段，
//     即使它带着丰富附加信息、其他意见都正常，GET 仍返回现有的 500 读取失败，
//     合法新提交也返回现有的 500、不返回已保存的新记录，磁盘内容逐字节保持不变。
// 首页展示范围、搜索范围与新意见字段规则沿用当前功能，本文件不要求把额外字段加到表单或页面。

type IdeaRecord = Record<string, unknown> & {
  id: string;
  title: string;
  description: string;
  scenario: string;
  createdAt: string;
};

const REGULAR_KEYS = ['createdAt', 'description', 'id', 'scenario', 'title'];

// 磁盘数组次序就是接口返回次序（最新在前由写入方 unshift 保证，读取方不重排）。
function seededIdeas(): IdeaRecord[] {
  return [
    {
      id: 'extra-rich-0001',
      // 常规文字同样覆盖首尾空白、换行、中文、表情与标记样文本
      title: '  多层附加信息的意见  ',
      description: '正文第一行\n第二行 <b>加粗</b> 😀',
      scenario: '场景 🌙\n第二行',
      createdAt: '2020-01-01T00:01:00.000Z',
      // 纯文字附加信息：首尾空白、换行、中文、表情、网页标记样文本都要按原文返回
      note: '  附言首行保留首尾空白\n第二行含中文与表情 😀 与标记样文本 <p>段落</p>  ',
      // 数组附加信息：空字符串、0、false、null 与各种文字混排，内容与次序都要保持
      labels: ['', ' 标签 ', 0, false, null, '末尾'],
      // 多层附加信息：对象套对象、对象套数组，深层的空串/0/false/null 同样不能丢类型
      meta: {
        emptyString: '',
        zero: 0,
        no: false,
        nothing: null,
        yes: true,
        nested: {
          alsoEmpty: '',
          alsoZero: 0,
          alsoFalse: false,
          alsoNull: null,
          text: '  多层文字\n换行 保留 ',
          list: [
            { deep: '深一层', count: 0 },
            ['更深', '', 0, false, null, { deepest: true }],
          ],
        },
        sequence: [0, false, null, '', '二', { keep: '次序' }, ['a', 'b']],
      },
    },
    {
      id: 'extra-text-0002',
      title: '只有一条文字附加信息',
      description: '正文',
      scenario: '',
      createdAt: '2020-02-02T00:02:00.000Z',
      remark: '纯文字附加信息，末尾空白保留  ',
    },
    {
      // 只含常规字段：不能因为其他记录带附加信息，就给它凭空补出额外字段
      id: 'regular-only-0003',
      title: '只含常规字段的意见',
      description: '没有任何附加信息',
      scenario: '普通场景',
      createdAt: '2020-03-03T00:03:00.000Z',
    },
    {
      // 与下一条标题、详细说明完全相同，只能靠 id 区分；本条带附加信息
      id: 'dup-with-extra-0004',
      title: '重复标题与正文',
      description: '重复的详细说明\n第二行',
      scenario: '第一条的场景',
      createdAt: '2020-04-04T00:04:00.000Z',
      // rank 的 0、active 的 false、note 的空字符串都必须保留类型与存在性
      source: { owner: 'alice', rank: 0, active: false, note: '' },
    },
    {
      // 同文不同 id 且不带附加信息：上一条的 source 不能转移或复制到这里
      id: 'dup-regular-0005',
      title: '重复标题与正文',
      description: '重复的详细说明\n第二行',
      scenario: '第二条的场景',
      createdAt: '2020-05-05T00:05:00.000Z',
    },
  ];
}

// 一条完全符合当前规则的新意见：任何失败都只能来自被测行为本身。
const NEW_IDEA = {
  title: ' 读取附加信息后提交的新意见 ',
  description: '新意见正文\n第二行 <em>保留</em> 🚀',
  scenario: '新意见场景',
};

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'featureharbor-extra-'));
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

function startWith(dir: string, ideas: unknown[]): Promise<StartedServer> {
  writeFileSync(join(dir, 'ideas.json'), `${JSON.stringify(ideas, null, 2)}\n`, 'utf8');
  return startServer(dir);
}

// 钉住多层附加信息的每个关键类型：空字符串仍是字符串字段、0 不变成 false 或缺字段、
// false/null 保持各自类型，数组内容与次序不变，文字逐字保留。
// 入参是 GET 响应中 id 为 extra-rich-0001 的那条记录——附加信息必须仍属于它。
function assertRichExtrasIntact(record: IdeaRecord): void {
  assert.equal(record.id, 'extra-rich-0001');
  assert.equal(
    record.note,
    '  附言首行保留首尾空白\n第二行含中文与表情 😀 与标记样文本 <p>段落</p>  ',
  );

  const labels = record.labels as unknown[];
  assert.ok(Array.isArray(labels));
  assert.equal(labels.length, 6);
  assert.deepEqual(labels, ['', ' 标签 ', 0, false, null, '末尾']);
  // 逐项再钉一次类型，避免 deepEqual 之外产生歧义
  assert.strictEqual(labels[0], '');
  assert.strictEqual(labels[2], 0);
  assert.strictEqual(labels[3], false);
  assert.strictEqual(labels[4], null);

  const meta = record.meta as Record<string, unknown>;
  assert.equal(typeof meta, 'object');
  assert.ok(meta !== null && !Array.isArray(meta));
  assert.ok(Object.prototype.hasOwnProperty.call(meta, 'emptyString'), '空字符串字段不能变成缺字段');
  assert.strictEqual(meta.emptyString, '');
  assert.strictEqual(meta.zero, 0, '数字零不能变成 false 或缺字段');
  assert.strictEqual(meta.no, false, '布尔 false 不能被换成默认内容');
  assert.strictEqual(meta.nothing, null, 'null 不能变成缺字段或默认内容');
  assert.strictEqual(meta.yes, true);

  const nested = meta.nested as Record<string, unknown>;
  assert.strictEqual(nested.alsoEmpty, '');
  assert.strictEqual(nested.alsoZero, 0);
  assert.strictEqual(nested.alsoFalse, false);
  assert.strictEqual(nested.alsoNull, null);
  assert.strictEqual(nested.text, '  多层文字\n换行 保留 ');
  assert.deepEqual(nested.list, [
    { deep: '深一层', count: 0 },
    ['更深', '', 0, false, null, { deepest: true }],
  ]);

  // 数组中的内容与次序：每一位都按原顺序、原类型返回
  const sequence = meta.sequence as unknown[];
  assert.ok(Array.isArray(sequence));
  assert.equal(sequence.length, 7);
  assert.strictEqual(sequence[0], 0);
  assert.strictEqual(sequence[1], false);
  assert.strictEqual(sequence[2], null);
  assert.strictEqual(sequence[3], '');
  assert.strictEqual(sequence[4], '二');
  assert.deepEqual(sequence[5], { keep: '次序' });
  assert.deepEqual(sequence[6], ['a', 'b']);
}

test('带文字与多层附加信息的历史意见：GET 成功返回完整记录，额外字段的名称、值、类型与所属意见保持对应', async () => {
  const dir = freshDir();
  const seeded = seededIdeas();
  let server: StartedServer | undefined;
  try {
    server = await startWith(dir, seeded);

    const listed = await getIdeas(server);
    assert.equal(listed.status, 200);
    assert.ok(Array.isArray(listed.data.ideas));
    assert.equal(listed.data.ideas.length, seeded.length);
    // 整表深度一致：任何“只挑常规字段重组记录”的整理都会在这里被发现
    assert.deepEqual(listed.data.ideas, seeded);

    const byId = new Map<string, IdeaRecord>(
      (listed.data.ideas as IdeaRecord[]).map((idea) => [idea.id, idea]),
    );

    assertRichExtrasIntact(byId.get('extra-rich-0001')!);

    // 单条文字附加信息逐字保留
    const textOnly = byId.get('extra-text-0002')!;
    assert.strictEqual(textOnly.remark, '纯文字附加信息，末尾空白保留  ');
    assert.strictEqual(textOnly.scenario, '');

    // 只含常规字段的意见不被凭空补出额外字段，带附加信息的意见也不丢常规字段
    const regularOnly = byId.get('regular-only-0003')!;
    assert.deepEqual(Object.keys(regularOnly).sort(), REGULAR_KEYS);

    // 同文不同 id：两条独立意见都在，附加信息各归各、不转移不复制
    const dupWithExtra = byId.get('dup-with-extra-0004')!;
    const dupRegular = byId.get('dup-regular-0005')!;
    assert.equal(dupWithExtra.title, dupRegular.title);
    assert.equal(dupWithExtra.description, dupRegular.description);
    assert.notEqual(dupWithExtra.id, dupRegular.id);
    assert.deepEqual(dupWithExtra.source, { owner: 'alice', rank: 0, active: false, note: '' });
    const source = dupWithExtra.source as Record<string, unknown>;
    assert.strictEqual(source.rank, 0);
    assert.strictEqual(source.active, false);
    assert.strictEqual(source.note, '');
    assert.ok(!('source' in dupRegular), '不能把一条意见的附加信息转移给同文的另一条');
    assert.deepEqual(Object.keys(dupRegular).sort(), REGULAR_KEYS);
    assert.equal(dupWithExtra.scenario, '第一条的场景');
    assert.equal(dupRegular.scenario, '第二条的场景');

    // 附加信息与所属意见的对应关系：额外字段名只出现在自己的记录上
    for (const idea of listed.data.ideas as IdeaRecord[]) {
      if (idea.id !== 'extra-rich-0001') {
        assert.ok(!('meta' in idea), `meta 不应出现在 ${idea.id} 上`);
        assert.ok(!('note' in idea), `note 不应出现在 ${idea.id} 上`);
        assert.ok(!('labels' in idea), `labels 不应出现在 ${idea.id} 上`);
      }
      if (idea.id !== 'extra-text-0002') assert.ok(!('remark' in idea), `remark 不应出现在 ${idea.id} 上`);
      if (idea.id !== 'dup-with-extra-0004') assert.ok(!('source' in idea), `source 不应出现在 ${idea.id} 上`);
    }

    // 再查一次结果稳定一致，读取不能有任何改写副作用
    assert.deepEqual((await getIdeas(server)).data.ideas, seeded);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('读取后提交符合当前规则的新意见：201 返回完整新记录并排最前，旧记录的附带信息、标识、时间、文字与相对次序不变（重启后仍一致）', async () => {
  const dir = freshDir();
  const seeded = seededIdeas();
  let server: StartedServer | undefined;
  try {
    server = await startWith(dir, seeded);

    const posted = await postIdea(server, NEW_IDEA);
    assert.equal(posted.status, 201);
    const newIdea = posted.data.idea as IdeaRecord;
    // 成功结果必须是完整记录：对象、非空 id、四个常规字符串字段
    assert.ok(isCompleteIdea(newIdea));
    assert.ok(newIdea.id.length > 0);
    assert.ok(!Number.isNaN(Date.parse(newIdea.createdAt)));
    // 现有提交规则不变：标题去首尾空白，正文与场景按原文保存
    assert.equal(newIdea.title, '读取附加信息后提交的新意见');
    assert.equal(newIdea.description, '新意见正文\n第二行 <em>保留</em> 🚀');
    assert.equal(newIdea.scenario, '新意见场景');
    // 新意见只含常规字段，不把存储里出现过的附加信息带到新记录上
    assert.deepEqual(Object.keys(newIdea).sort(), REGULAR_KEYS);
    for (const old of seeded) assert.notEqual(newIdea.id, old.id);

    const after = await getIdeas(server);
    assert.equal(after.status, 200);
    assert.equal(after.data.ideas.length, seeded.length + 1);
    assert.deepEqual(after.data.ideas[0], newIdea, '新意见排在已有意见之前');
    assert.deepEqual(after.data.ideas.slice(1), seeded, '旧记录（含附带信息与相对次序）整体原样保留');

    // 追加保存会整表重写：重写后多层附加信息的类型与归属仍要完整
    const byId = new Map<string, IdeaRecord>(
      (after.data.ideas as IdeaRecord[]).map((idea) => [idea.id, idea]),
    );
    assertRichExtrasIntact(byId.get('extra-rich-0001')!);
    assert.deepEqual(byId.get('dup-with-extra-0004')!.source, {
      owner: 'alice', rank: 0, active: false, note: '',
    });
    assert.ok(!('source' in byId.get('dup-regular-0005')!));

    // 正常停止并用同一数据目录重启：附带信息、标识、时间、文字与次序仍不变
    await server.stop();
    server = undefined;
    server = await startServer(dir);
    const afterRestart = await getIdeas(server);
    assert.equal(afterRestart.status, 200);
    assert.equal(afterRestart.data.ideas.length, seeded.length + 1);
    assert.deepEqual(afterRestart.data.ideas[0], newIdea);
    assert.deepEqual(afterRestart.data.ideas.slice(1), seeded);
    const restartedById = new Map<string, IdeaRecord>(
      (afterRestart.data.ideas as IdeaRecord[]).map((idea) => [idea.id, idea]),
    );
    assertRichExtrasIntact(restartedById.get('extra-rich-0001')!);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('允许附加信息不放宽完整记录要求：一条意见缺少 scenario（即使附带信息丰富）时，查询与合法提交仍是现有 500，磁盘逐字节不变', async () => {
  const dir = freshDir();
  const file = join(dir, 'ideas.json');
  const tmpFile = `${file}.tmp`;
  const seeded = seededIdeas();
  // 中间一条缺少必需的 scenario 字段，但带着丰富附加信息；前后记录都正常
  // （前一条带附加信息、后一条只含常规字段），不能只返回正常部分。
  const records: unknown[] = [
    seeded[0],
    {
      id: 'missing-scenario-0006',
      title: '缺少使用场景字段',
      description: '这条记录带着丰富附加信息，但结构不完整',
      createdAt: '2020-06-06T00:06:00.000Z',
      richExtra: {
        note: '丰富附加信息不能弥补必需字段缺失',
        nested: { zero: 0, no: false, empty: '', nothing: null, list: ['a', 0, '', false, null] },
      },
    },
    seeded[2],
  ];
  let server: StartedServer | undefined;
  try {
    server = await startWith(dir, records);
    const before = readFileSync(file);

    const listed = await getIdeas(server);
    assert.equal(listed.status, 500);
    assert.deepEqual(listed.data, { error: 'unable to read ideas' });
    assert.ok(readFileSync(file).equals(before), '查询失败后存储内容被改动');
    assert.equal(existsSync(tmpFile), false, '查询失败后不应留下临时文件');

    // 合法新提交同样因无法读取已有数据而失败：不返回已保存的新记录
    const posted = await postIdea(server, NEW_IDEA);
    assert.equal(posted.status, 500);
    assert.equal(posted.data.error, '无法读取已有意见数据，未保存新意见');
    assert.equal(Object.prototype.hasOwnProperty.call(posted.data, 'idea'), false);
    assert.ok(readFileSync(file).equals(before), '提交失败后存储内容被改动');
    assert.equal(existsSync(tmpFile), false, '提交失败后不应留下临时文件');

    // 再次查询结论不变，原有数据保持原样
    const listedAgain = await getIdeas(server);
    assert.equal(listedAgain.status, 500);
    assert.deepEqual(listedAgain.data, { error: 'unable to read ideas' });
    assert.ok(readFileSync(file).equals(before));
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
