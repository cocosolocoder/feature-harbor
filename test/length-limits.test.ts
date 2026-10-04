import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, removeDataDir, type StartedServer } from '../testing/server.ts';

// 字段长度上限的接口端到端回归：真实起一份 server.ts，只走公开的
// POST/GET /api/ideas。长度规则（与首页表单共用同一套判定）：
//   长度按 Unicode 码点累计（Array.from(text).length），标题最多 120、
//   详细说明最多 5000、使用场景最多 1000；中文、英文字母、单个 😀 各算一个码点，
//   由多个码点组成的文字（旗帜 🇨🇳、ZWJ 表情 😮‍💨、组合字符 é）按各自码点累计。
// 标题按去掉首尾空白后的长度判定并保存去空白结果，内部空白仍计入；
// 详细说明只要求含非空白内容，长度含原文首尾空白与换行并原样保存；
// 使用场景按原文计算与保留，省略或空字符串都可提交。
// 本文件要能发现这些回归：把表情算成两个字符（UTF-16 码元）、按传输字节算长度、
// 把恰好达到上限的内容错误拒绝、以及把超限内容截断后保存。

interface Idea {
  id: string;
  title: string;
  description: string;
  scenario: string;
  createdAt: string;
}

let server: StartedServer;

before(async () => {
  server = await startServer();
});

after(async () => {
  await server.stop();
  removeDataDir(server);
});

async function createIdea(body: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function listIdeas(): Promise<Idea[]> {
  const res = await fetch(`${server.origin}/api/ideas`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.ideas));
  return data.ideas as Idea[];
}

const points = (text: string): number => Array.from(text).length;

// 构造恰好 n 个码点的字符串，并自查不是按 UTF-16 码元或字节凑数
function cp(char: string, n: number): string {
  const text = char.repeat(n);
  assert.equal(points(text), n);
  assert.ok(char.length !== 1 || text.length === n);
  return text;
}

// 长度上限的基准用例：三个字段分别恰好达到自己的上限，其他字段均合法，应返回 201
const LIMITS = {
  title: 120,
  description: 5000,
  scenario: 1000,
} as const;

test('三个字段分别恰好达到上限：返回 201，记录按现有规则原样保存并出现在列表最前', async (t) => {
  await t.test('标题恰好 120 码点（中文）：通过，标题首尾空白在判定与保存时去除', async () => {
    const title = '  ' + cp('中', LIMITS.title) + ' ';
    const description = '标题上限的说明\n第二行 😀';
    const scenario = '场景 🌙';
    assert.equal(points(title.trim()), LIMITS.title);

    const { status, data } = await createIdea({ title, description, scenario });
    assert.equal(status, 201);
    assert.equal(data.idea.title, title.trim());
    assert.equal(data.idea.description, description);
    assert.equal(data.idea.scenario, scenario);

    const list = await listIdeas();
    assert.equal(list[0].id, data.idea.id);
    assert.deepEqual(list[0], data.idea);
  });

  await t.test('详细说明恰好 5000 码点：通过，首尾空白与换行计入长度并原样保留', async () => {
    // 首尾各两个空白 + 中间换行 + 4995 个中文码点，合计 5000 码点
    const description = '  ' + cp('中', 4995) + '\n  ';
    assert.equal(points(description), LIMITS.description);
    const title = '正文上限标题';

    const { status, data } = await createIdea({ title, description });
    assert.equal(status, 201);
    assert.equal(data.idea.title, title);
    assert.equal(data.idea.description, description);
    assert.equal(data.idea.scenario, '');

    const list = await listIdeas();
    assert.equal(list[0].description, description);
  });

  await t.test('使用场景恰好 1000 码点（含中文、表情、换行）：通过并原样保留', async () => {
    // 中文与单个 😀 各算一个码点
    const scenario = cp('中', 700) + cp('😀', 200) + cp('A', 98) + '\n\n';
    assert.equal(points(scenario), LIMITS.scenario);
    const description = '场景上限的说明';

    const { status, data } = await createIdea({ title: '场景上限标题', description, scenario });
    assert.equal(status, 201);
    assert.equal(data.idea.scenario, scenario);

    const list = await listIdeas();
    assert.equal(list[0].scenario, scenario);
  });
});

test('长度按码点而非 UTF-16 码元或传输字节：表情与多码点文字的边界内容应被接受', async (t) => {
  await t.test('标题 119 个中文 + 单个 😀 = 120 码点（😀 占 2 个 UTF-16 码元、4 个字节）：通过', async () => {
    const title = cp('中', LIMITS.title - 1) + '😀';
    assert.equal(points(title), LIMITS.title);
    assert.ok(title.length > LIMITS.title, '该串 UTF-16 码元数大于 120，可区分码元计数回归');
    assert.ok(Buffer.byteLength(title) > LIMITS.title, '传输字节数大于 120，可区分字节计数回归');

    const { status, data } = await createIdea({ title, description: '表情边界说明' });
    assert.equal(status, 201);
    assert.equal(data.idea.title, title);
  });

  await t.test('详细说明用 😀 凑满 5000 码点（按码元或字节计都会超限）：通过且不截断', async () => {
    const description = cp('😀', LIMITS.description);
    assert.equal(points(description), LIMITS.description);
    assert.ok(description.length === LIMITS.description * 2);
    assert.ok(Buffer.byteLength(description) === LIMITS.description * 4);

    const { status, data } = await createIdea({ title: '表情正文标题', description });
    assert.equal(status, 201);
    assert.equal(data.idea.description, description);
    assert.equal(points(data.idea.description), LIMITS.description);
  });

  await t.test('多码点文字按各自码点累计：含旗帜、ZWJ 表情、组合字符的标题与场景按码点判定', async () => {
    // 用转义写死码点组成，避免源码字面量被规范化成单码点：
    // 旗帜 🇨🇳 = 2 个地域指示符码点；😮‍💨 = 脸 + ZWJ + 云 共 3 码点；
    // é 的分解形式 = e + U+0301 组合重音 共 2 码点。合计 7，再补 113 个中文共 120 码点
    const flag = '\u{1F1E8}\u{1F1F3}';
    const zwjEmoji = '\u{1F62E}‍💨';
    const combining = 'é';
    assert.deepEqual([flag, zwjEmoji, combining].map(points), [2, 3, 2]);
    const title = flag + zwjEmoji + combining + cp('中', 113);
    assert.equal(points(title), 120);
    // 场景：997 个中文 + 旗帜（2 码点）+ 😀（1 码点）= 1000 码点
    const scenario = cp('中', 997) + flag + '😀';
    assert.equal(points(scenario), LIMITS.scenario);

    const { status, data } = await createIdea({ title, description: '多码点文字说明', scenario });
    assert.equal(status, 201);
    assert.equal(data.idea.title, title);
    assert.equal(data.idea.scenario, scenario);
  });
});

test('任一字段只多出一个码点：返回 400 和明确错误，拒绝该条且不截断保存', async (t) => {
  // 每个正文先在测试侧按码点自查“恰好只多一个”，防止用例本身写错长度
  const descOverOne = ' ' + cp('中', 4998) + '\n ';
  assert.equal(points(descOverOne), LIMITS.description + 1);
  const cases: Array<{ name: string; body: Record<string, unknown>; field: string }> = [
    {
      name: '标题 121 码点（中文）',
      field: '标题',
      body: { title: cp('中', LIMITS.title + 1), description: '说明' },
    },
    {
      name: '标题去空白后 121 码点（首尾空白不能帮忙占用额度）',
      field: '标题',
      body: { title: '  ' + cp('中', LIMITS.title + 1) + ' ', description: '说明' },
    },
    {
      name: '详细说明 5001 码点（中文，首尾空白与换行都计入）',
      field: '详细说明',
      body: { title: '标题一', description: descOverOne },
    },
    {
      name: '使用场景 1001 码点',
      field: '使用场景',
      body: { title: '标题二', description: '说明二', scenario: cp('中', LIMITS.scenario + 1) },
    },
    {
      name: '标题以单个 😀 超出（120 中文 + 😀 = 121 码点；按码元/字节会更早超限）',
      field: '标题',
      body: { title: cp('中', LIMITS.title) + '😀', description: '说明' },
    },
    {
      name: '详细说明以单个 😀 超出（5000 中文 + 😀 = 5001 码点）',
      field: '详细说明',
      body: { title: '标题三', description: cp('中', LIMITS.description) + '😀' },
    },
    {
      name: '使用场景以单个 😀 超出（1000 中文 + 😀 = 1001 码点）',
      field: '使用场景',
      body: { title: '标题四', description: '说明四', scenario: cp('中', LIMITS.scenario) + '😀' },
    },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const before = await listIdeas();
      const { status, data } = await createIdea(c.body);
      assert.equal(status, 400, c.name);
      assert.equal(typeof data.error, 'string');
      assert.ok(data.error.includes(c.field), `${c.name} 的错误应指明字段，实际：${data.error}`);

      // 不能截断后保存：列表数量、内容与次序完全不变
      const after = await listIdeas();
      assert.deepEqual(after, before, c.name);
    });
  }
});

test('首尾空白规则：带首尾空白的合法上限标题可提交；被空白推到超限的详细说明必须拒绝', async () => {
  // 标题：首尾空白在判定与保存前去除，内部空白计入长度。
  // 118 个中文 + 两个内部空格 = 去空白后 120 码点，首尾空白再多也不占用额度
  const title = '   ' + cp('中', 59) + '  ' + cp('中', 59) + '\t';
  assert.equal(points(title.trim()), LIMITS.title);
  const ok = await createIdea({ title, description: '标题空白边界说明' });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.idea.title, title.trim());
  assert.ok(ok.data.idea.title.includes('  '), '标题内部空白应保留');

  // 详细说明：首尾空白与换行计入长度。中间 4998 个中文非空白内容 + 首尾 3 个空白 = 5001 码点，
  // 非空白内容本身远未超限，但整条仍必须拒绝（不能先 trim 再计数）
  const description = '  ' + cp('中', 4998) + ' ';
  assert.equal(points(description), LIMITS.description + 1);
  const before = await listIdeas();
  const rejected = await createIdea({ title: '正文空白边界标题', description });
  assert.equal(rejected.status, 400);
  assert.ok(String(rejected.data.error).includes('详细说明'));
  assert.deepEqual(await listIdeas(), before);

  // 同一非空白内容去掉一个首尾空白后为 5000 码点，应能提交且原样保留
  const fixed = description.trimStart() + '\n'; // 5000 码点，仍带首尾空白/换行
  assert.equal(points(fixed), LIMITS.description);
  const accepted = await createIdea({ title: '正文空白边界标题', description: fixed });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.data.idea.description, fixed);
});

test('使用场景省略或为空字符串仍可提交；空白计入场景长度', async () => {
  for (const scenario of [undefined, '']) {
    const { status, data } = await createIdea({ title: `空场景 ${String(scenario)}`, description: '说明', scenario });
    assert.equal(status, 201);
    assert.equal(data.idea.scenario, '');
  }

  // 999 个中文 + 两个首尾空格 = 1001 码点：场景按原文计数，空白不能豁免
  const scenario = ' ' + cp('中', LIMITS.scenario - 1) + ' ';
  assert.equal(points(scenario), LIMITS.scenario + 1);
  const before = await listIdeas();
  const rejected = await createIdea({ title: '场景空白标题', description: '说明', scenario });
  assert.equal(rejected.status, 400);
  assert.ok(String(rejected.data.error).includes('使用场景'));
  assert.deepEqual(await listIdeas(), before);
});

test('超限被拒后把该字段缩短到允许范围：同一意见可正常提交，之前的 400 不继续阻止保存', async () => {
  const before = await listIdeas();

  const tooLong = { title: cp('中', LIMITS.title + 1), description: '先超长后改短的说明' };
  const first = await createIdea(tooLong);
  assert.equal(first.status, 400);
  assert.deepEqual(await listIdeas(), before);

  // 仅把标题缩短到恰好上限，其余内容不变
  const fixed = { ...tooLong, title: cp('中', LIMITS.title) };
  const second = await createIdea(fixed);
  assert.equal(second.status, 201);
  assert.equal(second.data.idea.title, fixed.title);

  const after = await listIdeas();
  assert.equal(after.length, before.length + 1);
  assert.equal(after[0].id, second.data.idea.id);
  assert.deepEqual(after.slice(1), before);
});
