import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../testing/server.ts';

// 意见列表页面只展示常规字段（id、title、description、scenario、createdAt），
// 但已保存记录允许携带其他信息。本文件为这些「不参与页面展示的附带信息」提供
// 自动化回归保障：后续整理意见数据（读取、追加保存、重启持久化）时不能丢掉、
// 改写或转移它们。记录的结构完整性仍只按常规字段判定（isCompleteIdea），
// 允许额外信息不放宽任何完整记录要求。
//
// 真实起一份 server.ts，启动前直接把携带额外信息的记录写入 ideas.json
// （额外信息无法经当前提交功能产生），只走公开的 GET/POST /api/ideas，覆盖：
//   - GET 成功返回完整记录：额外字段的名称、值与所属意见一一对应；额外内容可以是
//     文字，也可以是含数组与对象的多层信息；空字符串、数字零、布尔值、空值保留
//     各自类型，不能变成缺少字段或被换成默认内容；数组内容与次序不变；文字中的
//     首尾空白、换行、中文、表情与网页标记样文本逐字返回；
//   - 带附加信息的意见与只含常规字段的意见混排时两者都保留；标题和详细说明相同、
//     标识不同的记录仍是独立意见，附加信息不能从一条转移到另一条；
//   - 通过现有提交功能保存一条符合当前规则的新意见：201 并返回完整的新记录；
//     新意见排在已有意见之前，旧记录的附带信息完整，原有标识、时间、文字与
//     相对次序不变；SIGTERM 重启后仍然一致；
//   - 只要已有列表中有一条缺少必需的 scenario 字段，即使它带着丰富附加信息、
//     其他意见都正常，GET 仍返回现有的 500（unable to read ideas），合法新提交
//     也返回现有的 500（无法读取已有意见数据，未保存新意见）、不返回新记录，
//     存储字节逐字保持且不残留 .tmp。

type ExtraRecord = Record<string, unknown>;

// 一组携带额外信息的历史记录。磁盘上的数组次序就是接口返回次序
// （最新在前由写入方保证，读取方不重排）。
function seededIdeas(): ExtraRecord[] {
  return [
    {
      id: 'extra-rich-0001',
      // 常规字段本身也带首尾空白、换行、中文、表情与标记样文本
      title: '  附带多层信息的意见 😀  ',
      description: '正文首行\n第二行 保留换行与<b>标记样文本</b> &amp; 中文',
      scenario: '场景含 前后空白与表情 🌙\n第二行',
      createdAt: '2024-01-02T03:04:05.678Z',
      // 额外信息：文字 + 多层数组/对象。空串、0、true、false、null 都必须保留
      // 各自的类型与字段位置，不能变成缺少字段或被换成默认内容。
      extra: {
        note: '  额外文字的首尾空白、换行\n与中文😀<i>网页标记</i>&nbsp;  ',
        empty: '',
        zero: 0,
        yes: true,
        no: false,
        nothing: null,
        // 数组中的内容与次序保持不变，包括其中的空串、0、false、null
        list: [
          '首项 ',
          '',
          0,
          false,
          null,
          ['嵌套', '数组', 0, { deep: { value: null, keep: '' } }],
        ],
        nested: { a: { b: [1, 2, { c: '末尾 ' }] }, flag: false, n: 0 },
      },
      // 额外字段名本身允许中文；顶层额外字段直接为 null 也按原样保留
      '附带字段-中文名': ['数组', '次序', '保持', { z: 0, blank: '' }],
      tags: null,
    },
    {
      // 与第一条标题、详细说明（连同使用场景）相同但 id 不同的独立记录：
      // 携带的是自己的附加信息，不能被合并，也不能把另一条的附加信息转移过来。
      id: 'extra-duplicate-text-0002',
      title: '  附带多层信息的意见 😀  ',
      description: '正文首行\n第二行 保留换行与<b>标记样文本</b> &amp; 中文',
      scenario: '场景含 前后空白与表情 🌙\n第二行',
      createdAt: '2024-02-03T04:05:06.789Z',
      extra: { belongsTo: 'extra-duplicate-text-0002', rank: 7, marker: '这条专属的额外内容' },
    },
    {
      // 只含常规字段的意见：与带附加信息的记录混排，两者都保留
      id: 'plain-only-0003',
      title: '只有常规字段的意见',
      description: '普通正文，没有任何额外字段',
      scenario: '普通场景',
      createdAt: '2024-03-04T05:06:07.890Z',
    },
  ];
}

// 一条完全符合当前规则的新意见：不含额外字段，任何失败都只能来自被测行为本身。
const NEW_IDEA = {
  title: '读取带附加信息的旧意见之后提交的新意见',
  description: '标题、详细说明与使用场景都符合当前规则，应照常保存并返回完整记录。',
  scenario: '新意见的使用场景',
};

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'featureharbor-extra-'));
}

async function startWithSeed(dir: string, ideas: unknown[]): Promise<StartedServer> {
  writeFileSync(join(dir, 'ideas.json'), `${JSON.stringify(ideas, null, 2)}\n`, 'utf8');
  return await startServer(dir);
}

async function getIdeas(server: StartedServer): Promise<{ status: number; data: any }> {
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

test('携带额外信息的历史记录：列表成功返回完整记录，额外字段的名称、值、类型、次序与所属意见一一对应', async () => {
  const dir = freshDir();
  const old = seededIdeas();
  let server: StartedServer | undefined;
  try {
    server = await startWithSeed(dir, old);

    const listed = await getIdeas(server);
    assert.equal(listed.status, 200);
    assert.ok(Array.isArray(listed.data.ideas));
    assert.equal(listed.data.ideas.length, old.length);
    // 深严格相等一次性钉住：额外字段名称与值对应、空串/0/false/null 的类型、
    // 数组内容与次序、多层嵌套结构，以及全部文字逐字不变。
    assert.deepStrictEqual(listed.data.ideas, old);

    const byId = new Map<string, ExtraRecord>(
      (listed.data.ideas as ExtraRecord[]).map((idea) => [idea.id as string, idea]),
    );

    const rich = byId.get('extra-rich-0001')!;
    const extra = rich.extra as ExtraRecord;
    // 这些键必须实际存在：0、''、false、null 不能因为是“假值”就变成缺少字段
    for (const key of ['note', 'empty', 'zero', 'yes', 'no', 'nothing', 'list', 'nested']) {
      assert.ok(Object.hasOwn(extra, key), `额外字段 ${key} 不应丢失`);
    }
    assert.equal(extra.empty, '');
    assert.equal(extra.zero, 0);
    assert.equal(extra.yes, true);
    assert.equal(extra.no, false);
    assert.equal(extra.nothing, null);
    // 数组中的内容与次序保持不变（独立钉住，防止整体比较被误改后失焦）
    assert.deepStrictEqual(extra.list, [
      '首项 ',
      '',
      0,
      false,
      null,
      ['嵌套', '数组', 0, { deep: { value: null, keep: '' } }],
    ]);
    assert.deepStrictEqual(extra.nested, { a: { b: [1, 2, { c: '末尾 ' }] }, flag: false, n: 0 });
    // 额外文字：首尾空白、换行、中文、表情与网页标记样文本按原文返回
    const note = extra.note as string;
    assert.ok(note.startsWith('  ') && note.endsWith('  '));
    assert.ok(note.includes('\n'));
    assert.ok(note.includes('中文😀'));
    assert.ok(note.includes('<i>网页标记</i>'));
    assert.ok(note.includes('&nbsp;'));
    // 顶层额外字段：中文名称保留，值为 null 的字段既不丢失也不换成默认内容
    assert.ok(Object.hasOwn(rich, '附带字段-中文名'));
    assert.deepStrictEqual(rich['附带字段-中文名'], ['数组', '次序', '保持', { z: 0, blank: '' }]);
    assert.ok(Object.hasOwn(rich, 'tags'));
    assert.equal(rich.tags, null);

    // 标题/详细说明相同、标识不同的两条仍是独立记录，各自的附加信息不串、不转移
    const duplicate = byId.get('extra-duplicate-text-0002')!;
    assert.notEqual(rich, duplicate);
    const duplicateExtra = duplicate.extra as ExtraRecord;
    assert.equal(duplicateExtra.belongsTo, 'extra-duplicate-text-0002');
    assert.equal(duplicateExtra.marker, '这条专属的额外内容');
    assert.equal(duplicateExtra.rank, 7);
    // 不能把第一条的附加字段转移到同文不同 id 的这条
    for (const keyOnlyOnRich of ['note', 'empty', 'zero', 'yes', 'no', 'nothing', 'list', 'nested']) {
      assert.equal(Object.hasOwn(duplicateExtra, keyOnlyOnRich), false);
    }
    assert.equal(Object.hasOwn(duplicate, '附带字段-中文名'), false);
    assert.equal(Object.hasOwn(duplicate, 'tags'), false);
    // 与第一条连使用场景也相同的情况下，记录仍彼此独立（同文不同 id 不合并）
    assert.equal(duplicate.title, rich.title);
    assert.equal(duplicate.description, rich.description);
    assert.equal(duplicate.scenario, rich.scenario);
    assert.notEqual(duplicate.id, rich.id);

    // 只含常规字段的意见原样保留，不被补出额外字段
    const plain = byId.get('plain-only-0003')!;
    assert.deepEqual(Object.keys(plain).sort(), ['createdAt', 'description', 'id', 'scenario', 'title']);

    // 再查一次，结果稳定一致，读取不能有任何改写副作用
    assert.deepStrictEqual((await getIdeas(server)).data.ideas, old);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('读取带附加信息的旧意见后提交合法新意见：201 返回完整新记录并排最前，旧记录附带信息、标识、时间、文字与次序不变（重启后仍一致）', async () => {
  const dir = freshDir();
  const old = seededIdeas();
  let server: StartedServer | undefined;
  try {
    server = await startWithSeed(dir, old);

    const posted = await postIdea(server, NEW_IDEA);
    assert.equal(posted.status, 201);
    const newIdea = posted.data.idea as ExtraRecord;
    assert.equal(typeof newIdea.id, 'string');
    assert.ok((newIdea.id as string).length > 0);
    assert.equal(typeof newIdea.createdAt, 'string');
    assert.equal(newIdea.title, NEW_IDEA.title);
    assert.equal(newIdea.description, NEW_IDEA.description);
    assert.equal(newIdea.scenario, NEW_IDEA.scenario);
    // 当前提交功能不产生额外字段：完整的新记录只含常规字段
    assert.deepEqual(Object.keys(newIdea).sort(), ['createdAt', 'description', 'id', 'scenario', 'title']);
    for (const oldIdea of old) assert.notEqual(newIdea.id, oldIdea.id);

    const after = await getIdeas(server);
    assert.equal(after.status, 200);
    assert.equal(after.data.ideas.length, old.length + 1);
    assert.deepStrictEqual(after.data.ideas[0], newIdea, '新意见排在已有意见之前');
    assert.deepStrictEqual(after.data.ideas.slice(1), old, '旧记录（含附带信息）整体原样保留');

    // 旧记录的附带信息按所属意见逐条仍可读到
    const oldById = new Map<string, ExtraRecord>(
      (after.data.ideas.slice(1) as ExtraRecord[]).map((idea) => [idea.id as string, idea]),
    );
    const richExtra = oldById.get('extra-rich-0001')!.extra as ExtraRecord;
    assert.equal(richExtra.zero, 0);
    assert.equal(richExtra.empty, '');
    assert.equal(richExtra.no, false);
    assert.equal(richExtra.nothing, null);
    assert.deepStrictEqual(richExtra.list, [
      '首项 ', '', 0, false, null, ['嵌套', '数组', 0, { deep: { value: null, keep: '' } }],
    ]);
    assert.equal(
      (oldById.get('extra-duplicate-text-0002')!.extra as ExtraRecord).marker,
      '这条专属的额外内容',
    );

    // 正常停止并用同一数据目录重启：追加保存没有丢掉未参与页面展示的内容
    await server.stop();
    server = undefined;
    server = await startServer(dir);
    const afterRestart = await getIdeas(server);
    assert.equal(afterRestart.status, 200);
    assert.equal(afterRestart.data.ideas.length, old.length + 1);
    assert.deepStrictEqual(afterRestart.data.ideas[0], newIdea);
    assert.deepStrictEqual(afterRestart.data.ideas.slice(1), old);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('允许额外信息不放宽完整记录要求：一条缺少 scenario 的记录（即使附带信息丰富、其他意见正常）仍整份 500，合法新提交同样 500 且存储不变', async (t) => {
  // 缺 scenario 的损坏记录本身带着丰富附加信息：附加信息不能替代必需字段，
  // 也不能让整份数据变成“部分可读”。
  const broken = (id: string): ExtraRecord => ({
    id,
    title: '缺少使用场景字段的意见',
    description: '虽然带着丰富附加信息，仍是结构不完整记录',
    createdAt: '2024-05-06T07:08:09.000Z',
    extra: {
      rich: true,
      zero: 0,
      empty: '',
      no: false,
      nothing: null,
      list: [1, '', false, { a: ['x', null] }],
      note: ' 附加信息\n含换行与表情😈 ',
    },
  });
  const normalWithExtra: ExtraRecord = {
    id: 'normal-with-extra',
    title: '结构完整且带附加信息的正常意见',
    description: '正常正文',
    scenario: '正常场景',
    createdAt: '2024-06-07T08:09:10.000Z',
    extra: { marker: '我是正常记录', rank: 2 },
  };
  const plainNormal: ExtraRecord = {
    id: 'normal-plain',
    title: '只有常规字段的正常意见',
    description: '正常正文',
    scenario: '',
    createdAt: '2024-07-08T09:10:11.000Z',
  };

  const cases: Array<{ name: string; records: unknown[] }> = [
    { name: '缺 scenario 的记录排在首位', records: [broken('broken-first'), normalWithExtra, plainNormal] },
    { name: '缺 scenario 的记录夹在正常记录中间', records: [normalWithExtra, broken('broken-middle'), plainNormal] },
  ];

  for (const c of cases) {
    await t.test(c.name, async () => {
      const dir = freshDir();
      const file = join(dir, 'ideas.json');
      const tmpFile = `${file}.tmp`;
      writeFileSync(file, `${JSON.stringify(c.records, null, 2)}\n`, 'utf8');

      let server: StartedServer | undefined;
      try {
        server = await startServer(dir);
        const before = readFileSync(file);

        const listed = await getIdeas(server);
        assert.equal(listed.status, 500, c.name);
        assert.deepEqual(listed.data, { error: 'unable to read ideas' }, c.name);
        assert.ok(readFileSync(file).equals(before), '查询失败后存储内容被改动');

        // 合法新意见也无法保存：失败来自已有数据读取，不是新意见输入错误，
        // 不返回已保存的新记录，原有数据逐字节保持。
        const posted = await postIdea(server, NEW_IDEA);
        assert.equal(posted.status, 500, c.name);
        assert.equal(posted.data.error, '无法读取已有意见数据，未保存新意见');
        assert.equal(Object.prototype.hasOwnProperty.call(posted.data, 'idea'), false);
        assert.ok(readFileSync(file).equals(before), '提交被拒后存储内容被改动');
        assert.equal(existsSync(tmpFile), false, '失败后不应留下临时文件');

        // 再查仍是同样的读取失败，不能悄悄变成空列表或部分列表
        const listedAgain = await getIdeas(server);
        assert.equal(listedAgain.status, 500, c.name);
        assert.deepEqual(listedAgain.data, { error: 'unable to read ideas' }, c.name);
      } finally {
        await safeStop(server);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
