// 字符上限回归共享夹具：接口测试（真实服务 POST /api/ideas）与首页表单测试
// （vm 沙箱中执行线上内联脚本）使用完全相同的边界内容，
// 从两个入口提交同一载荷必须得到一致的接受/拒绝结果。
//
// 长度一律按 Unicode 码点计算：标题 120、详细说明 5000、使用场景 1000。
// 中文、英文字母与单个 😀 各算一个码点；国旗序列由两个码点组成，按码点累计为 2。

export const LIMITS = { title: 120, description: 5000, scenario: 1000 } as const;

export const codePoints = (text: string): number => Array.from(text).length;

// 1 个码点：UTF-16 占 2 个码元、UTF-8 占 4 个字节。
// 按码元或字节计长的实现会把它算成 2 或 4。
export const EMOJI = '😀';
// 2 个码点（区域指示符对）：UTF-16 占 4 个码元、UTF-8 占 8 个字节。
export const MULTI_CP = '🇨🇳';

export interface IdeaForm {
  title: string;
  description: string;
  scenario?: string;
}

// 三个字段同时恰好达到各自上限，且每个字段都混入 ASCII、中文、表情与多码点序列；
// description 还包含换行。码元/字节计数的实现会在这里错误拒绝。
export const boundaryMixed: IdeaForm = {
  title: 'a'.repeat(60) + '中'.repeat(59) + EMOJI, // 60 + 59 + 1 = 120
  description: 'a'.repeat(2496) + '\n' + '中'.repeat(2500) + EMOJI + MULTI_CP, // 2496 + 1 + 2500 + 1 + 2 = 5000
  scenario: 's'.repeat(490) + '中'.repeat(507) + EMOJI + MULTI_CP, // 490 + 507 + 1 + 2 = 1000
};

// 😀 只算一个码点：三个字段都以“上限减一个普通字符 + 😀”恰好到顶。
export const boundaryEmojiLast: IdeaForm = {
  title: '题'.repeat(LIMITS.title - 1) + EMOJI,
  description: 'a'.repeat(LIMITS.description - 1) + EMOJI,
  scenario: '景'.repeat(LIMITS.scenario - 1) + EMOJI,
};

// 标题首尾带空白：按 trim 后的码点恰好 120，按原文计长（或按字节/码元）都会超过。
// 保存时首尾空白应被去掉，请求体中仍应是原文。
export const titleSurroundingWhitespace =
  '  \t ' + '题'.repeat(LIMITS.title) + ' \n ';

// 标题内部空白：trim 不会缩短它，内部空格按码点累计。
export const titleInternalSpace = {
  exact: 'a'.repeat(118) + ' ' + 'b', // 120
  over: 'a'.repeat(118) + '  ' + 'b', // 121
};

// 详细说明恰好 5000 码点，其中 6 个是首尾空白与换行：长度按原文算，保存后原样保留。
export const descriptionSurroundingWhitespace =
  '  \n' + '中'.repeat(LIMITS.description - 6) + '\n  ';

// 非空白内容只有 4999 码点，但首尾各一个空白把原文推到 5001：
// 规则按原文（含首尾空白）计长，两个入口都必须拒绝；先 trim 再判长的实现会错误放行。
export const descriptionPushedOverByWhitespace =
  ' ' + '说'.repeat(LIMITS.description - 1) + ' ';

// 使用场景恰好 1000 码点，含换行、表情与多码点序列。
export const scenarioBoundaryMixed =
  '景'.repeat(996) + '\n' + EMOJI + MULTI_CP; // 996 + 1 + 1 + 2 = 1000

// 超限被拒后，缩短到允许范围的同一条意见（含中文、表情与换行）。
export const fixedAfterRejection: IdeaForm = {
  title: '题'.repeat(LIMITS.title - 1) + EMOJI, // 120
  description: '\n' + '说'.repeat(LIMITS.description - 2) + EMOJI, // 1 + 4998 + 1 = 5000
  scenario: '景'.repeat(LIMITS.scenario - 1) + EMOJI, // 1000
};

export type LimitField = 'title' | 'description' | 'scenario';

export interface OverCase {
  name: string;
  field: LimitField;
  form: IdeaForm;
  // 服务端错误信息（无句号）与前端错误提示（有句号）都必须明确指出对应字段
  apiError: RegExp;
  pageError: string;
}

const VALID_TITLE = '有效标题';
const VALID_DESCRIPTION = '有效说明';
const VALID_SCENARIO = '有效场景';

// 任一字段只多出一个码点即拒绝，覆盖中文、表情（1 码点）与多码点序列累计。
export const overByOneCases: OverCase[] = [
  {
    name: '标题超 1 个码点（中文）',
    field: 'title',
    form: { title: '题'.repeat(LIMITS.title + 1), description: VALID_DESCRIPTION, scenario: VALID_SCENARIO },
    apiError: /标题/,
    pageError: '标题最多 120 个字符。',
  },
  {
    name: '标题超 1 个码点（😀 只算一个码点）',
    field: 'title',
    form: { title: '题'.repeat(LIMITS.title) + EMOJI, description: VALID_DESCRIPTION, scenario: VALID_SCENARIO },
    apiError: /标题/,
    pageError: '标题最多 120 个字符。',
  },
  {
    name: '详细说明超 1 个码点（含换行、表情与多码点序列）',
    field: 'description',
    form: { title: VALID_TITLE, description: 'a'.repeat(4997) + '\n' + EMOJI + MULTI_CP, scenario: VALID_SCENARIO },
    apiError: /详细说明/,
    pageError: '详细说明最多 5000 个字符。',
  },
  {
    name: '使用场景超 1 个码点（表情）',
    field: 'scenario',
    form: { title: VALID_TITLE, description: VALID_DESCRIPTION, scenario: '景'.repeat(LIMITS.scenario) + EMOJI },
    apiError: /使用场景|scenario/,
    pageError: '使用场景最多 1000 个字符。',
  },
  {
    name: '使用场景超 1 个码点（多码点序列按码点累计为 2）',
    field: 'scenario',
    form: { title: VALID_TITLE, description: VALID_DESCRIPTION, scenario: '景'.repeat(LIMITS.scenario - 1) + MULTI_CP },
    apiError: /使用场景|scenario/,
    pageError: '使用场景最多 1000 个字符。',
  },
  {
    name: '详细说明仅被首尾空白推到超限',
    field: 'description',
    form: { title: VALID_TITLE, description: descriptionPushedOverByWhitespace, scenario: VALID_SCENARIO },
    apiError: /详细说明/,
    pageError: '详细说明最多 5000 个字符。',
  },
];

// 防御性自检：夹具自身的码点计数必须符合注释中的声明。
export function assertFixtureCounts(): void {
  assertEqual(codePoints(EMOJI), 1);
  assertEqual(codePoints(MULTI_CP), 2);
  assertEqual(codePoints(boundaryMixed.title), LIMITS.title);
  assertEqual(codePoints(boundaryMixed.description!), LIMITS.description);
  assertEqual(codePoints(boundaryMixed.scenario!), LIMITS.scenario);
  assertEqual(codePoints(boundaryEmojiLast.title), LIMITS.title);
  assertEqual(codePoints(boundaryEmojiLast.description!), LIMITS.description);
  assertEqual(codePoints(boundaryEmojiLast.scenario!), LIMITS.scenario);
  assertEqual(codePoints(titleSurroundingWhitespace.trim()), LIMITS.title);
  assertEqual(codePoints(titleInternalSpace.exact.trim()), LIMITS.title);
  assertEqual(codePoints(titleInternalSpace.over.trim()), LIMITS.title + 1);
  assertEqual(codePoints(descriptionSurroundingWhitespace), LIMITS.description);
  assertEqual(codePoints(descriptionPushedOverByWhitespace), LIMITS.description + 1);
  assertEqual(codePoints(scenarioBoundaryMixed), LIMITS.scenario);
  assertEqual(codePoints(fixedAfterRejection.title), LIMITS.title);
  assertEqual(codePoints(fixedAfterRejection.description!), LIMITS.description);
  assertEqual(codePoints(fixedAfterRejection.scenario!), LIMITS.scenario);
  for (const c of overByOneCases) {
    assertEqual(codePoints(c.form[c.field]!), LIMITS[c.field] + 1, c.name);
  }
}

function assertEqual(actual: number, expected: number, label = ''): void {
  if (actual !== expected) {
    throw new Error(`夹具计数错误${label ? `（${label}）` : ''}：${actual} !== ${expected}`);
  }
}

assertFixtureCounts();
