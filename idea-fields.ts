// 产品意见三个字段的唯一规则来源：首页内联脚本与 POST /api/ideas 接口共用。
// 上限、空白处理与码点计数只能在这里定义一次（完整记录的结构判定 isCompleteIdea 同理）：
//   - 接口侧（server.ts）直接调用本模块的函数；
//   - 首页无法使用模块导入，server.ts 把下列同一个函数的源码（Function.prototype.toString）
//     注入内联脚本，因此页面执行的校验与这里逐字相同，不要在页面里再维护第二份。
//
// 规则（长度一律按 Unicode 码点计数，Array.from(text).length）：
//   title       必填，去掉首尾空白后非空，最多 120 个码点；内部空白保留并计入，
//               保存去掉首尾空白后的结果；
//   description 必填，须含非空白内容，最多 5000 个码点；首尾空白与换行计入长度并原样保存；
//   scenario    可省略（省略时按空字符串保存）；填写时为字符串，最多 1000 个码点，
//               按原文计数与保存。
// 恰好达到上限允许提交；超限由调用方拒绝整条意见，不截断。

export const FIELD_LIMITS = {
  title: 120,
  description: 5000,
  scenario: 1000,
} as const;

// 按 Unicode 码点计数：中文、英文字母、单个 😀 各算一个；
// 旗帜、ZWJ 表情、组合字符等由多个码点组成的文字按各自码点累计，
// 不能按 UTF-16 码元（String.length）或传输字节计数。
export function codePointCount(text: string): number {
  return Array.from(text).length;
}

// 内容层面的问题类型。两个入口的提示措辞可以不同，但接受/拒绝的判定共用本结果。
export type ContentErrorCode =
  | 'title-empty'
  | 'title-too-long'
  | 'description-empty'
  | 'description-too-long'
  | 'scenario-too-long';

// 校验三个字符串字段的内容，按首页与接口一致的顺序返回第一个问题；全部通过返回 null。
// 入参必须已经是字符串：字段缺失、请求体不是对象、字段类型错误属于接口的结构校验，
// 由 server.ts 在调用本函数之前处理（首页的输入框值天然是字符串）。
export function checkIdeaContent(
  title: string,
  description: string,
  scenario: string,
): ContentErrorCode | null {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) return 'title-empty';
  if (codePointCount(trimmedTitle) > FIELD_LIMITS.title) return 'title-too-long';
  if (!description.trim()) return 'description-empty';
  if (codePointCount(description) > FIELD_LIMITS.description) return 'description-too-long';
  if (codePointCount(scenario) > FIELD_LIMITS.scenario) return 'scenario-too-long';
  return null;
}

// 一条完整意见记录的结构判定，同样是唯一一份：读取已有数据（readIdeas）、
// 首页加载列表、首页确认提交响应三处共用，不在任何入口另写第二份。
// 完整记录必须是 JSON 对象（不能是空值或数组）：id 为非空字符串，
// title、description、scenario、createdAt 均存在且为字符串（scenario 允许为空字符串，
// 缺少它则不完整；id 不增加格式要求，createdAt 不校验日期有效性）。
// 这里只判断结构完整性，不套用新提交的内容限制：不去除文字空白、不补齐缺失字段、
// 不截断内容；记录含有额外字段时仍视为完整，读取时按原样保留。
export function isCompleteIdea(record: unknown): boolean {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return false;
  const idea = record as Record<string, unknown>;
  if (typeof idea.id !== 'string' || idea.id.length === 0) return false;
  for (const field of ['title', 'description', 'scenario', 'createdAt'] as const) {
    if (typeof idea[field] !== 'string') return false;
  }
  return true;
}

// 校验通过后、保存前的规整：标题去掉首尾空白（内部空白保留），
// 详细说明与使用场景原样保存。
export function normalizeIdea(
  title: string,
  description: string,
  scenario: string,
): { title: string; description: string; scenario: string } {
  return { title: title.trim(), description, scenario };
}

// 注入首页内联脚本的同一份规则源码。函数直接取自上面的定义（Node 运行 TS 时会剥离类型
// 标注），页面因此不会出现第二份上限或计数逻辑；提示文案仍由页面侧自己提供。
export const fieldRulesBrowserScript: string = `// 字段规则与接口共用同一份实现（由 idea-fields.ts 注入，勿在此另写第二份）
const FIELD_LIMITS = ${JSON.stringify({ title: FIELD_LIMITS.title, description: FIELD_LIMITS.description, scenario: FIELD_LIMITS.scenario })};
const codePointCount = ${codePointCount.toString()};
const checkIdeaContent = ${checkIdeaContent.toString()};
`;

// 注入首页内联脚本的同一份完整记录判定源码（与字段规则同理，页面不维护第二份）。
// 首页加载列表与确认提交响应都调用它；接口侧读取已有数据直接调用上面的函数。
export const completeIdeaBrowserScript: string = `// 完整记录判定与接口共用同一份实现（由 idea-fields.ts 注入，勿在此另写第二份）
const isCompleteIdea = ${isCompleteIdea.toString()};
`;
