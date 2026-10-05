import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const PRODUCT: string = 'FeatureHarbor';
const RESOURCE: string = 'ideas';
const MAX_BODY_BYTES = 1_000_000;
// 字段校验规则的唯一来源：标题、详细说明、使用场景三项的上限、空白处理与拒绝原因。
// 服务端提交接口通过 vm 编译这段源码执行（不依赖页面是否被请求过），首页内联脚本
// 则把它逐字嵌入，两个入口共用同一份判定，同一批合法文字的接受/拒绝结果必然一致。
// 上限、页面说明与两侧提示均从这里取数，不再各自维护。
const FIELD_RULES_SOURCE: string = `
const IDEA_FIELD_RULES = {
  title: { label: '标题', max: 120, trim: true,
    emptyCode: 'title-empty', limitCode: 'title-too-long' },
  description: { label: '详细说明', max: 5000, trim: false,
    emptyCode: 'description-empty', limitCode: 'description-too-long' },
  scenario: { label: '使用场景', max: 1000, trim: false,
    emptyCode: null, limitCode: 'scenario-too-long' },
};
// 长度一律按 Unicode 码点计算：中文、英文字母、单个 😀 各算一个码点；
// 旗帜、ZWJ 表情、组合字符等由多个码点组成的文字按各自码点累计，不能当成一个字符
function ideaCodePoints(text) { return Array.from(text).length; }
// 校验已确认都是字符串的三个字段（使用场景缺省传 ''）。
// 标题先去首尾空白再判空、计长，保存去空白结果，内部空白保留并计入；
// 详细说明与使用场景按原文计长（首尾空白与换行都计入），详细说明还须含非空白内容。
// 返回首个不合要求字段的问题代码（字段顺序：标题、详细说明、使用场景），全部合法返回 null。
function validateIdeaFields(title, description, scenario) {
  for (const [name, value] of [['title', title], ['description', description], ['scenario', scenario]]) {
    const rule = IDEA_FIELD_RULES[name];
    const effective = rule.trim ? value.trim() : value;
    if (rule.emptyCode !== null && !effective.trim()) return rule.emptyCode;
    if (ideaCodePoints(effective) > rule.max) return rule.limitCode;
  }
  return null;
}
// 校验通过后的规范化结果：标题保存去掉首尾空白后的内容，其余原样保存
function normalizeIdeaFields(title, description, scenario) {
  return { title: title.trim(), description, scenario };
}
`;
interface FieldRulesApi {
  IDEA_FIELD_RULES: Record<string, { label: string; max: number; trim: boolean; emptyCode: string | null; limitCode: string }>;
  ideaCodePoints(text: string): number;
  validateIdeaFields(title: string, description: string, scenario: string): string | null;
  normalizeIdeaFields(title: string, description: string, scenario: string): { title: string; description: string; scenario: string };
}
const fieldRulesContext = vm.createContext({});
vm.runInContext(FIELD_RULES_SOURCE, fieldRulesContext, { filename: 'field-rules.shared.js' });
// 顶层 const 绑定在上下文的词法作用域中，不作为上下文对象的属性暴露，
// 在同一上下文里再求值标识符即可取到
const fieldRules: FieldRulesApi = {
  IDEA_FIELD_RULES: vm.runInContext('IDEA_FIELD_RULES', fieldRulesContext),
  ideaCodePoints: vm.runInContext('ideaCodePoints', fieldRulesContext),
  validateIdeaFields: vm.runInContext('validateIdeaFields', fieldRulesContext),
  normalizeIdeaFields: vm.runInContext('normalizeIdeaFields', fieldRulesContext),
};
// 接口侧的问题代码 → 400 错误说明（接口原有措辞）
const API_FIELD_ERRORS: Record<string, string> = {
  'title-empty': '标题去掉首尾空白后不能为空',
  'title-too-long': `标题最多 ${fieldRules.IDEA_FIELD_RULES.title.max} 个字符`,
  'description-empty': '详细说明必须包含非空白内容',
  'description-too-long': `详细说明最多 ${fieldRules.IDEA_FIELD_RULES.description.max} 个字符`,
  'scenario-too-long': `使用场景最多 ${fieldRules.IDEA_FIELD_RULES.scenario.max} 个字符`,
};
const PAGE: string = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FeatureHarbor · 产品意见与公开路线图</title><style>
body{font-family:system-ui,sans-serif;max-width:52rem;margin:3rem auto;padding:0 1rem;line-height:1.7}
a{color:#175b9c}
label{display:block;font-weight:600;margin-top:1rem}
input,textarea{width:100%;box-sizing:border-box;padding:.4rem;font:inherit}
textarea{resize:vertical}
.required{color:#b00020}
button{margin-top:1rem;padding:.5rem 1.2rem;font:inherit}
#error{color:#b00020;margin-top:.75rem}
#success{color:#1a7f37;margin-top:.75rem}
.idea{border-top:1px solid #ddd;padding:1rem 0}
.idea h3{margin:0 0 .5rem}
.pre{white-space:pre-wrap}
time{color:#666;font-size:.9rem}
</style><main><h1>FeatureHarbor</h1><p>产品意见与公开路线图</p>
<h2>提交产品意见</h2>
<form id="idea-form" novalidate>
<label for="f-title">标题 <span class="required">*</span>（必填，最多 ${fieldRules.IDEA_FIELD_RULES.title.max} 字）</label>
<input id="f-title" name="title" required>
<label for="f-desc">详细说明 <span class="required">*</span>（必填，最多 ${fieldRules.IDEA_FIELD_RULES.description.max} 字）</label>
<textarea id="f-desc" name="description" rows="5" required></textarea>
<label for="f-scenario">使用场景（可选，最多 ${fieldRules.IDEA_FIELD_RULES.scenario.max} 字）</label>
<textarea id="f-scenario" name="scenario" rows="3"></textarea>
<button type="submit">提交意见</button>
<p id="error" role="alert" hidden></p>
<p id="success" role="status" hidden></p>
</form>
<h2>意见列表</h2>
<p id="empty" hidden>还没有意见记录。</p>
<div id="ideas"></div>
<p><a href="/api/ideas">查看意见列表接口</a> · <a href="/health">服务状态</a></p>
</main><script>
${FIELD_RULES_SOURCE}
const form = document.getElementById('idea-form');
const titleInput = document.getElementById('f-title');
const descInput = document.getElementById('f-desc');
const scenarioInput = document.getElementById('f-scenario');
const errorBox = document.getElementById('error');
const successBox = document.getElementById('success');
const emptyNote = document.getElementById('empty');
const list = document.getElementById('ideas');
const EMPTY_TEXT = '还没有意见记录。';
const LOAD_FAILED_TEXT = '意见列表加载失败，请稍后刷新重试。';
// 首页侧的问题代码 → 字段错误提示（页面原有措辞，可与接口不同；上限取自同一份字段规则）
const FIELD_ERROR_TEXT = {
  'title-empty': '标题不能为空。',
  'title-too-long': '标题最多 ' + IDEA_FIELD_RULES.title.max + ' 个字符。',
  'description-empty': '详细说明不能为空。',
  'description-too-long': '详细说明最多 ' + IDEA_FIELD_RULES.description.max + ' 个字符。',
  'scenario-too-long': '使用场景最多 ' + IDEA_FIELD_RULES.scenario.max + ' 个字符。',
};
// 首次列表请求的状态：loading（进行中）/ ready（成功）/ failed（失败）
let listState = 'loading';
function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  successBox.hidden = true;
}
function renderIdea(idea) {
  const item = document.createElement('article');
  item.className = 'idea';
  const heading = document.createElement('h3');
  heading.textContent = idea.title;
  const desc = document.createElement('p');
  desc.className = 'pre';
  desc.textContent = idea.description;
  item.append(heading, desc);
  if (typeof idea.scenario === 'string' && idea.scenario.trim().length > 0) {
    const scenario = document.createElement('p');
    const label = document.createElement('strong');
    label.textContent = '使用场景：';
    const text = document.createElement('span');
    text.className = 'pre';
    text.textContent = idea.scenario;
    scenario.append(label, text);
    item.append(scenario);
  }
  const time = document.createElement('time');
  time.dateTime = idea.createdAt;
  const parsed = new Date(idea.createdAt);
  time.textContent = isNaN(parsed.getTime()) ? String(idea.createdAt) : parsed.toLocaleString();
  item.append(time);
  return item;
}
let remoteIdeas = [];
// 本页已确认保存的意见，按本页发起提交的先后排列：后提交的在前。
// 每条记录带上点击提交时的序号，响应返回的先后不影响排列位置
const submittedIdeas = [];
function renderList() {
  // 以服务端标识 id 去重后合并：本页提交成功的意见在前，其后补入首次响应中的其他记录
  const seen = new Set();
  const ordered = [];
  for (const entry of submittedIdeas) {
    const idea = entry.idea;
    if (!seen.has(idea.id)) { seen.add(idea.id); ordered.push(idea); }
  }
  for (const idea of remoteIdeas) {
    if (!seen.has(idea.id)) { seen.add(idea.id); ordered.push(idea); }
  }
  list.replaceChildren(...ordered.map(renderIdea));
  if (listState === 'failed') {
    emptyNote.textContent = LOAD_FAILED_TEXT;
    emptyNote.hidden = false;
  } else if (listState === 'ready') {
    emptyNote.textContent = EMPTY_TEXT;
    emptyNote.hidden = ordered.length > 0;
  } else {
    // 首次列表仍在加载，不能把等待误报成没有记录
    emptyNote.hidden = true;
  }
}
// 一条有效意见必须是 JSON 对象：id 为非空字符串，
// title、description、scenario、createdAt 均为字符串（scenario 允许为空字符串）
function isValidIdea(idea) {
  if (typeof idea !== 'object' || idea === null || Array.isArray(idea)) return false;
  if (typeof idea.id !== 'string' || idea.id.length === 0) return false;
  for (const field of ['title', 'description', 'scenario', 'createdAt']) {
    if (typeof idea[field] !== 'string') return false;
  }
  return true;
}
async function loadIdeas() {
  try {
    const res = await fetch('/api/ideas');
    if (!res.ok) throw new Error('load failed');
    const data = await res.json();
    // 列表响应必须是带 ideas 数组的 JSON 对象，且数组中每条记录都合法；
    // 顶层结构异常或任意一条记录异常都属于整次加载失败，
    // 即使异常记录前面有正常意见，也不能只展示其中一部分
    if (typeof data !== 'object' || data === null || Array.isArray(data) || !Array.isArray(data.ideas)) {
      throw new Error('invalid ideas response');
    }
    if (!data.ideas.every(isValidIdea)) throw new Error('invalid idea record');
    remoteIdeas = data.ideas;
    listState = 'ready';
  } catch {
    listState = 'failed';
  }
  renderList();
}
// 任一字段每次发生编辑都递增；提交时记下当前版本，成功响应到达时若版本未变，
// 说明等待期间没有继续编辑，才清空表单，否则保留正在写的草稿
let editVersion = 0;
for (const field of [titleInput, descInput, scenarioInput]) {
  field.addEventListener('input', () => { editVersion += 1; });
}
// 每次点击提交都递增：成功或失败提示只属于最近一次点击。
// 更早发出的请求即使更晚返回，也只能在服务确认保存时更新列表，不能改动当前提示。
let latestSubmitSeq = 0;
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitSeq = ++latestSubmitSeq;
  // 用户发起新的提交后，上一条操作的提示先清除；在本次点击有结果前，
  // 更早请求迟到返回也不能重新显示成功或失败，也不能让人误以为正在提交的意见已保存
  errorBox.hidden = true;
  successBox.hidden = true;
  const title = titleInput.value;
  const description = descInput.value;
  const scenario = scenarioInput.value;
  const submittedVersion = editVersion;
  // 发送请求前先按与提交接口相同的字段规则检查；提示措辞是页面自己的
  const problem = validateIdeaFields(title, description, scenario);
  // 被表单直接拦下的一次点击同样是用户最近的提交操作，字段错误即本次点击的结果；
  // 之后更早请求的返回不能掩盖它
  if (problem) { showError(FIELD_ERROR_TEXT[problem]); return; }
  let res;
  try {
    res = await fetch('/api/ideas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, description, scenario })
    });
  } catch {
    if (submitSeq === latestSubmitSeq) showError('网络错误，提交未成功，请重试。');
    return;
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    if (submitSeq === latestSubmitSeq) {
      showError(data && data.error ? '提交失败：' + data.error : '提交失败，请稍后重试。');
    }
    return;
  }
  // 成功状态的响应同样必须结构完整：顶层是含 idea 的 JSON 对象，
  // 且 idea 本身通过 isValidIdea 校验（对象、非空 id、各字段均为字符串）。
  // 空对象、数组或缺字段的记录不能当作保存成功：不显示成功提示、
  // 不清空草稿、不并入列表，也不用表单内容补齐响应缺失的信息
  const saved = typeof data === 'object' && data !== null && !Array.isArray(data) && isValidIdea(data.idea);
  if (!saved) {
    if (submitSeq === latestSubmitSeq) showError('提交失败，请稍后重试。');
    return;
  }
  const idea = data.idea;
  // 是否清空表单只取决于等待期间有没有继续编辑（包括改回原文、清空字段也算编辑），
  // 与响应返回先后无关：过期请求确认保存时也不能清掉用户正在写的草稿
  if (editVersion === submittedVersion) form.reset();
  // 只要服务确认保存，意见就进入列表，即使这条请求已不是最近一次点击：
  // 不能为了避免提示干扰而丢弃真实保存结果。
  // 位置按本页发起提交的先后确定（后提交的在前），与响应返回先后无关：
  // 先提交的意见迟到确认时补到后提交的意见之后，不能把它挤到更靠后的位置
  const entry = { seq: submitSeq, idea };
  let insertAt = submittedIdeas.findIndex((e) => e.seq < submitSeq);
  if (insertAt === -1) insertAt = submittedIdeas.length;
  submittedIdeas.splice(insertAt, 0, entry);
  renderList();
  // 成功提示只属于最近一次点击：更早的请求迟到返回时，不能在最新一次的失败提示
  // 或新一次提交的等待旁边再显示成功
  if (submitSeq === latestSubmitSeq) {
    successBox.textContent = '提交成功，你的意见已保存。';
    successBox.hidden = false;
  }
});
loadIdeas();
</script></html>`;
const args: string[] = process.argv.slice(2);
const help: string = `FeatureHarbor - 产品意见与公开路线图
Usage: node server.ts serve [--host ADDRESS] [--port PORT] [--data-dir DIRECTORY]
       node server.ts --help
Defaults: --host 127.0.0.1 --port 8080 --data-dir data
Port 0 selects an available port.
`;
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  process.stdout.write(help);
  process.exit(args.length === 0 ? 2 : 0);
}
if (args.shift() !== 'serve') { console.error('Expected serve or --help'); process.exit(2); }
let host: string = '127.0.0.1';
let port: number = 8080;
let dataDir: string = 'data';
while (args.length) {
  const flag = args.shift();
  const value = args.shift();
  if (!value || !['--host', '--port', '--data-dir'].includes(flag ?? '')) {
    console.error('Each option must be --host, --port or --data-dir followed by a value'); process.exit(2);
  }
  if (flag === '--host') host = value;
  else if (flag === '--port') {
    if (!/^\d+$/.test(value) || Number(value) > 65535) { console.error('Port must be between 0 and 65535'); process.exit(2); }
    port = Number(value);
  } else dataDir = value;
}
mkdirSync(dataDir, { recursive: true });
const dataFile = join(dataDir, 'ideas.json');
try { writeFileSync(dataFile, '[]\n', { flag: 'wx' }); } catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
}
function respond(res: ServerResponse, status: number, value: unknown, options: { html?: boolean; allow?: string } = {}): void {
  const body = options.html ? String(value) : JSON.stringify(value);
  res.writeHead(status, { 'content-type': options.html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body), ...(status === 405 ? { allow: options.allow ?? 'GET' } : {}) });
  res.end(body);
}
function readIdeas(): unknown[] {
  const records: unknown = JSON.parse(readFileSync(dataFile, 'utf8'));
  if (!Array.isArray(records)) throw new Error('Invalid record list');
  return records;
}
function saveIdeas(records: unknown[]): void {
  const tempFile = `${dataFile}.tmp`;
  writeFileSync(tempFile, `${JSON.stringify(records, null, 2)}\n`);
  renameSync(tempFile, dataFile);
}
async function handleCreateIdea(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      respond(res, 400, { error: '请求体过大' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    respond(res, 400, { error: '请求体不是有效的 JSON' });
    return;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    respond(res, 400, { error: '请求体必须是 JSON 对象' });
    return;
  }
  const body = payload as Record<string, unknown>;
  for (const field of ['title', 'description'] as const) {
    if (body[field] === undefined) { respond(res, 400, { error: `缺少必填字段 ${field}` }); return; }
    if (typeof body[field] !== 'string') { respond(res, 400, { error: `字段 ${field} 必须是字符串` }); return; }
  }
  if (body.scenario !== undefined && typeof body.scenario !== 'string') {
    respond(res, 400, { error: '字段 scenario 必须是字符串' });
    return;
  }
  // 内容规则（空白处理、码点上限）与首页表单共用同一份字段规则
  const title = body.title as string;
  const description = body.description as string;
  const scenario = typeof body.scenario === 'string' ? body.scenario : '';
  const problem = fieldRules.validateIdeaFields(title, description, scenario);
  if (problem !== null) { respond(res, 400, { error: API_FIELD_ERRORS[problem] }); return; }
  const idea = {
    id: randomUUID(),
    ...fieldRules.normalizeIdeaFields(title, description, scenario),
    createdAt: new Date().toISOString(),
  };
  let records: unknown[];
  try {
    records = readIdeas();
  } catch {
    respond(res, 500, { error: '无法读取已有意见数据，未保存新意见' });
    return;
  }
  records.unshift(idea);
  try {
    saveIdeas(records);
  } catch {
    respond(res, 500, { error: '保存意见失败，请稍后重试' });
    return;
  }
  respond(res, 201, { idea });
}
const server = createServer((req: IncomingMessage, res: ServerResponse): void => {
  let route: string;
  try { route = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { respond(res, 400, { error: 'invalid request path' }); return; }
  if (!['/', '/health', '/api/ideas'].includes(route)) { respond(res, 404, { error: 'not found' }); return; }
  if (route === '/api/ideas') {
    if (req.method === 'POST') {
      handleCreateIdea(req, res).catch(() => {
        if (!res.headersSent) respond(res, 500, { error: '提交意见失败，请稍后重试' });
      });
      return;
    }
    if (req.method !== 'GET') { respond(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST' }); return; }
    try {
      respond(res, 200, { [RESOURCE]: readIdeas() });
    } catch { respond(res, 500, { error: 'unable to read ideas' }); }
    return;
  }
  if (req.method !== 'GET') { respond(res, 405, { error: 'method not allowed' }, { allow: 'GET' }); return; }
  if (route === '/') { respond(res, 200, PAGE, { html: true }); return; }
  respond(res, 200, { status: 'ok', product: PRODUCT });
});
server.once('error', (error: Error): void => { console.error(error.message); process.exitCode = 1; });
server.listen(port, host, (): void => {
  const address = server.address();
  if (address && typeof address !== 'string') {
    const displayedHost = address.address.includes(':') ? `[${address.address}]` : address.address;
    console.log(`${PRODUCT} listening on http://${displayedHost}:${address.port}`);
  }
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, (): void => { server.close(() => { process.exitCode = 0; }); server.closeIdleConnections(); });
}
