import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  FIELD_LIMITS,
  checkIdeaContent,
  isCompleteIdea,
  normalizeIdea,
  fieldRulesBrowserScript,
  type ContentErrorCode,
} from './idea-fields.ts';

const PRODUCT: string = 'FeatureHarbor';
const RESOURCE: string = 'ideas';
const MAX_BODY_BYTES = 1_000_000;
// 严格 UTF-8 解码器：fatal 模式遇到非法字节直接抛错，而不是像 Buffer.toString('utf8')
// 那样把坏字节静默替换成“�”。请求正文与磁盘上的已有意见都先在完整的字节缓冲上通过它，
// 才允许进入 JSON 解析；分段送达在缓冲拼接后判断，合法多字节字符被拆到相邻段不算损坏。
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
// 接口侧把共用的内容判定结果映射成原有的错误说明；首页另有自己的措辞。
const CONTENT_ERROR_MESSAGES: Record<ContentErrorCode, string> = {
  'title-empty': '标题去掉首尾空白后不能为空',
  'title-too-long': `标题最多 ${FIELD_LIMITS.title} 个字符`,
  'description-empty': '详细说明必须包含非空白内容',
  'description-too-long': `详细说明最多 ${FIELD_LIMITS.description} 个字符`,
  'scenario-too-long': `使用场景最多 ${FIELD_LIMITS.scenario} 个字符`,
};
// 首页与单条意见查看页共用的样式。
const PAGE_STYLE: string = `
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
#search-form{margin:1rem 0}
#search-form input{max-width:20rem;margin-right:.5rem}
#search-form button{margin-top:.25rem;margin-right:.5rem}
.view-link{margin-top:.5rem}
#detail-note{color:#b00020}
.back{margin-top:2rem}
`;
const PAGE: string = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FeatureHarbor · 产品意见与公开路线图</title><style>${PAGE_STYLE}</style><main><h1>FeatureHarbor</h1><p>产品意见与公开路线图</p>
<h2>提交产品意见</h2>
<form id="idea-form" novalidate>
<label for="f-title">标题 <span class="required">*</span>（必填，最多 ${FIELD_LIMITS.title} 字）</label>
<input id="f-title" name="title" required>
<label for="f-desc">详细说明 <span class="required">*</span>（必填，最多 ${FIELD_LIMITS.description} 字）</label>
<textarea id="f-desc" name="description" rows="5" required></textarea>
<label for="f-scenario">使用场景（可选，最多 ${FIELD_LIMITS.scenario} 字）</label>
<textarea id="f-scenario" name="scenario" rows="3"></textarea>
<button type="submit">提交意见</button>
<p id="error" role="alert" hidden></p>
<p id="success" role="status" hidden></p>
</form>
<h2>意见列表</h2>
<form id="search-form" role="search" novalidate>
<label for="f-search">关键词搜索</label>
<input id="f-search" name="q" type="search" placeholder="搜索标题、详细说明或使用场景" autocomplete="off">
<button type="submit">搜索</button>
<button id="search-clear" type="button">清空</button>
</form>
<p id="empty" hidden>还没有意见记录。</p>
<div id="ideas"></div>
<p><a href="/api/ideas">查看意见列表接口</a> · <a href="/health">服务状态</a></p>
</main><script>
${fieldRulesBrowserScript}
const form = document.getElementById('idea-form');
const titleInput = document.getElementById('f-title');
const descInput = document.getElementById('f-desc');
const scenarioInput = document.getElementById('f-scenario');
const errorBox = document.getElementById('error');
const successBox = document.getElementById('success');
const emptyNote = document.getElementById('empty');
const list = document.getElementById('ideas');
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('f-search');
const searchClear = document.getElementById('search-clear');
const EMPTY_TEXT = '还没有意见记录。';
const NOT_FOUND_TEXT = '没有找到符合关键词的意见。';
const LOAD_FAILED_TEXT = '意见列表加载失败，请稍后刷新重试。';
// 首次列表请求的状态：loading（进行中）/ ready（成功）/ failed（失败）
let listState = 'loading';
// 已生效的搜索关键词：去掉首尾空白后的完整一段文字，空字符串表示不搜索。
// 只影响当前页面的可见结果，不发起请求、不改变已保存记录与接口返回。
let activeKeyword = '';
// 纯文字的大小写不敏感包含判断：关键词内部空格按原文参与比较，
// 不拆词；标点、尖括号与看起来像正则表达式的文字都按普通文字查找，
// 因此直接用 includes，不能走正则。
function ideaMatches(idea, keyword) {
  const needle = keyword.toLowerCase();
  return idea.title.toLowerCase().includes(needle)
    || idea.description.toLowerCase().includes(needle)
    || idea.scenario.toLowerCase().includes(needle);
}
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
  // 每条已保存意见都有独立查看入口（首页列表与搜索结果共用同一个 renderIdea，
  // 因此搜索过滤后可见的每条记录同样带入口）。链接以标识区分记录：同标题同说明、
  // 不同 id 的两条意见各自指向自己的页面；历史标识可能含中文、空格或网址保留字符，
  // 必须逐段 encodeURIComponent 后拼接（空格、/ ? # 等都变成百分号序列），
  // 直接分享或刷新该地址才能准确找回原记录。
  // 入口不使用标题文字（历史标题可能为空白），空标题记录仍可打开。
  const viewLine = document.createElement('p');
  viewLine.className = 'view-link';
  const viewLink = document.createElement('a');
  viewLink.href = '/ideas/' + encodeURIComponent(idea.id);
  viewLink.textContent = '查看这条意见';
  viewLine.append(viewLink);
  item.append(viewLine);
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
  // 搜索只过滤当前页面的可见结果：沿用合并后的原有顺序，逐条判断、不去重不重排，
  // 同一条意见最多出现一次；匹配的意见仍按原文渲染（保留空白与换行），不删改内容。
  const visible = activeKeyword
    ? ordered.filter((idea) => ideaMatches(idea, activeKeyword))
    : ordered;
  list.replaceChildren(...visible.map(renderIdea));
  if (listState === 'failed') {
    // 加载失败优先显示现有的失败提示，不能把失败显示成搜索无结果
    emptyNote.textContent = LOAD_FAILED_TEXT;
    emptyNote.hidden = false;
  } else if (listState !== 'ready') {
    // 首次列表仍在加载，不能把等待误报成没有记录或没有匹配结果
    emptyNote.hidden = true;
  } else if (activeKeyword) {
    // 搜索已生效：完整列表是否为空决定提示措辞，已有意见但无匹配时明确提示未找到
    emptyNote.textContent = ordered.length === 0 ? EMPTY_TEXT : NOT_FOUND_TEXT;
    emptyNote.hidden = visible.length > 0;
  } else {
    emptyNote.textContent = EMPTY_TEXT;
    emptyNote.hidden = ordered.length > 0;
  }
}
// 一条意见记录是否完整，直接使用 idea-fields.ts 注入的同一份 isCompleteIdea：
// 与服务读取已有数据的判定逐字相同，列表加载与提交确认都调用它，不在页面另写第二份。
async function loadIdeas() {
  try {
    const res = await fetch('/api/ideas');
    if (!res.ok) throw new Error('load failed');
    const data = await res.json();
    // 列表响应必须是带 ideas 数组的 JSON 对象，且数组中每条记录都完整；
    // 顶层结构异常或任意一条记录不完整都属于整次加载失败，
    // 即使异常记录前面有正常意见，也不能只展示其中一部分
    if (typeof data !== 'object' || data === null || Array.isArray(data) || !Array.isArray(data.ideas)) {
      throw new Error('invalid ideas response');
    }
    if (!data.ideas.every(isCompleteIdea)) throw new Error('invalid idea record');
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
// 字段内容判定与接口共用同一份实现（FIELD_LIMITS、codePointCount、checkIdeaContent
// 由 idea-fields.ts 注入）；这里只把共用判定结果映射成本页原有的提示措辞与顺序。
function validate(title, description, scenario) {
  switch (checkIdeaContent(title, description, scenario)) {
    case 'title-empty': return '标题不能为空。';
    case 'title-too-long': return '标题最多 ' + FIELD_LIMITS.title + ' 个字符。';
    case 'description-empty': return '详细说明不能为空。';
    case 'description-too-long': return '详细说明最多 ' + FIELD_LIMITS.description + ' 个字符。';
    case 'scenario-too-long': return '使用场景最多 ' + FIELD_LIMITS.scenario + ' 个字符。';
    default: return null;
  }
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
  const problem = validate(title, description, scenario);
  // 被表单直接拦下的一次点击同样是用户最近的提交操作，字段错误即本次点击的结果；
  // 之后更早请求的返回不能掩盖它
  if (problem) { showError(problem); return; }
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
  // 成功状态的响应同样必须记录完整：顶层是含 idea 的 JSON 对象，
  // 且 idea 本身通过 isCompleteIdea 校验（对象、非空 id、各字段均为字符串）。
  // 空对象、数组或缺字段的记录不能当作保存成功：不显示成功提示、
  // 不清空草稿、不并入列表，也不用表单内容补齐响应缺失的信息
  const saved = typeof data === 'object' && data !== null && !Array.isArray(data) && isCompleteIdea(data.idea);
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
// 搜索只在本页过滤已合并的完整列表：提交搜索表单不发起任何请求、不提交意见，
// 也不清空或改写提交意见表单里的草稿；关键词去掉首尾空白后为空时恢复完整列表。
// 已生效后，迟到的首次列表与本页新确认保存的意见都会在 renderList 中继续按它过滤。
function applySearch() {
  activeKeyword = searchInput.value.trim();
  renderList();
}
searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  applySearch();
});
searchClear.addEventListener('click', () => {
  searchInput.value = '';
  activeKeyword = '';
  renderList();
});
loadIdeas();
</script></html>`;
// 单条意见查看页：内容不在服务端拼进 HTML（意见文字含尖括号、实体写法等，
// 只允许作为普通文本显示），页面脚本打开后按地址栏里的意见标识直接请求
// GET /api/ideas/<encoded-id>，与是否访问过首页、是否搜索、是否提交过完全无关；
// 刷新或直接把地址分享给别人，看到的都是存储中同一条已保存意见。
// 展示字段与首页列表同源（都取自接口返回的已保存记录），不从表单草稿或搜索词拼详情，
// 记录携带的常规字段之外的附加信息不在本页公开。
const DETAIL_PAGE: string = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>意见详情 · FeatureHarbor</title><style>${PAGE_STYLE}</style><main>
<p><a href="/">&larr; 返回首页</a></p>
<h1>意见详情</h1>
<p id="detail-note" role="alert" hidden></p>
<article id="idea-detail" class="idea" hidden>
<h2 id="d-title"></h2>
<p id="d-desc" class="pre"></p>
<p id="d-scenario-row" hidden><strong>使用场景：</strong><span id="d-scenario" class="pre"></span></p>
<p>提交时间：<time id="d-time"></time></p>
</article>
<p class="back"><a href="/">&larr; 返回首页</a></p>
</main><script>
${fieldRulesBrowserScript}
const detailBox = document.getElementById('idea-detail');
const titleEl = document.getElementById('d-title');
const descEl = document.getElementById('d-desc');
const scenarioRow = document.getElementById('d-scenario-row');
const scenarioEl = document.getElementById('d-scenario');
const timeEl = document.getElementById('d-time');
const noteEl = document.getElementById('detail-note');
const NOT_FOUND_TEXT = '该意见不存在。';
const LOAD_FAILED_TEXT = '意见加载失败，请稍后刷新重试。';
function showNote(message) {
  noteEl.textContent = message;
  noteEl.hidden = false;
  detailBox.hidden = true;
}
function showIdea(idea) {
  // 全部走 textContent：标题、说明与场景里的网页标记样文本、实体写法都按普通文字逐字显示，
  // 不解析成页面元素，换行与空白由 pre 样式保留，长说明不截断。
  titleEl.textContent = idea.title;
  descEl.textContent = idea.description;
  if (typeof idea.scenario === 'string' && idea.scenario.trim().length > 0) {
    scenarioEl.textContent = idea.scenario;
    scenarioRow.hidden = false;
  } else {
    scenarioRow.hidden = true;
  }
  timeEl.dateTime = idea.createdAt;
  const parsed = new Date(idea.createdAt);
  timeEl.textContent = isNaN(parsed.getTime()) ? String(idea.createdAt) : parsed.toLocaleString();
  noteEl.hidden = true;
  detailBox.hidden = false;
}
async function loadDetail() {
  // 标识来自当前地址的路径段，原样拼到接口地址：浏览器会保留其百分号编码，
  // 服务端按解码后的标识精确匹配，中文、空格与 / ? # 等特殊字符都能准确指向原记录。
  // 不参考搜索关键词、表单草稿或任何首页状态。
  const path = window.location.pathname;
  let res;
  try {
    res = await fetch('/api' + path);
  } catch {
    showNote(LOAD_FAILED_TEXT);
    return;
  }
  if (res.status === 404) {
    // 明确是“这条意见不存在”：不能展示其他意见，也不能说成整个产品没有意见
    showNote(NOT_FOUND_TEXT);
    return;
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    // 存储无法读取、内容损坏、获取失败等：明确提示加载失败，不冒充不存在，也不展示半份详情
    showNote(LOAD_FAILED_TEXT);
    return;
  }
  // 与首页列表同一套结构判定（isCompleteIdea 由 idea-fields.ts 注入）：
  // 结构不完整的响应不能展示半份详情；常规字段之外的内容不读取、不公开。
  const idea = typeof data === 'object' && data !== null && !Array.isArray(data) ? data.idea : null;
  if (!isCompleteIdea(idea)) {
    showNote(LOAD_FAILED_TEXT);
    return;
  }
  showIdea(idea);
}
loadDetail();
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
// 已有意见的结构完整性直接使用 idea-fields.ts 的 isCompleteIdea，
// 与首页列表加载、提交结果确认共用同一份判定。
function readIdeas(): unknown[] {
  // 先拿到原始字节并用 fatal TextDecoder 严格解码，再交给 JSON.parse：
  // readFileSync(path, 'utf8') 内部走 Buffer.toString('utf8')，会把非法 UTF-8 字节
  // 静默替换成“�”。替换后的文字若仍能组成完整记录，列表就会正常返回；此后提交新意见
  // 还会把替换后的旧内容一并保存，原始字节就此被改写。因此这里绝不能按“文字里有没有
  // �”判断（用户主动写下的“�”是以合法 UTF-8 EF BF BD 编码的普通文字，必须照常读取），
  // 而要由保存内容的实际字节编码决定：单独的续字节、缺少后续字节的多字节字符、不符合
  // UTF-8 规则的编码，无论出现在标题、详细说明、使用场景还是其他位置，都让整份数据
  // 读取失败——不替换、不忽略、不只读取其中的正常片段。
  const raw = readFileSync(dataFile);
  let text: string;
  try {
    text = UTF8_DECODER.decode(raw);
  } catch {
    throw new Error('Invalid UTF-8 in ideas storage');
  }
  const records: unknown = JSON.parse(text);
  if (!Array.isArray(records)) throw new Error('Invalid record list');
  // 任意一条记录不完整，整份列表都视为读取失败：
  // 不跳过异常记录，也不只返回正常部分。只检查结构，不套用新提交的内容限制：
  // 标题首尾空白、正文与场景换行、任意时间字符串都按原样保留，不补字段或改写文字。
  if (!records.every(isCompleteIdea)) throw new Error('Invalid idea record');
  return records;
}
function saveIdeas(records: unknown[]): void {
  const tempFile = `${dataFile}.tmp`;
  writeFileSync(tempFile, `${JSON.stringify(records, null, 2)}\n`);
  try {
    renameSync(tempFile, dataFile);
  } catch (error) {
    // 临时内容已写入但替换正式文件失败：尽量删除本次写出的临时普通文件，
    // 不让未保存成功的内容留下可被误认成已保存数据的副本。
    // 清理只针对普通文件——临时路径若是目录等本就不是本次写出的形态，一律不动；
    // 清理本身失败（如权限限制）只放弃清理，不掩盖原有的保存失败。
    try {
      if (lstatSync(tempFile).isFile()) unlinkSync(tempFile);
    } catch {
      // 忽略清理异常：保存失败的结果不变
    }
    throw error;
  }
}
async function handleCreateIdea(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 请求大小上限按实际收到的字节累计：JSON 的括号、引号、字段名与空白都计入，
  // 中文、表情按 UTF-8 编码后的字节数计入；这与字段按 Unicode 码点的上限是两回事。
  const declaredLength = Number(req.headers['content-length']);
  let tooLarge = Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES;
  const chunks: Buffer[] = [];
  let size = 0;
  // 超限后不能写出 400 就立即 req.destroy()：客户端可能还在发送，强断会让它只看到
  // 连接断开，读不到完整错误。这里继续把请求体读完（排空，天然带背压），
  // 等请求正常结束后再回复，客户端只要发完并保持连接等待，就能收到完整可解析的 400。
  // 超限后的字节不再缓存：绝不能拿已收到的前缀去解析，更不能截断后尝试保存。
  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (tooLarge) continue;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        continue;
      }
      chunks.push(chunk);
    }
  } catch {
    // 客户端中途断开或请求流出错：响应已无处可写，安静结束，不能变成 500。
    req.destroy();
    return;
  }
  // 无论是否预先声明长度（Content-Length）还是分段传输（Transfer-Encoding: chunked）、
  // 超出发生在中途还是末段，都按同一条规则拒绝；即使正文同时不是合法 UTF-8 或合法 JSON，
  // 理由也仍是“请求体过大”，不能被后续的 UTF-8/JSON 解析替换成别的错误。
  // 恰好达到上限（size === MAX_BODY_BYTES）不在这里拒绝，继续按 JSON 与字段规则判断。
  if (tooLarge) {
    respond(res, 400, { error: '请求体过大' });
    return;
  }
  // 先按 UTF-8 严格解码整份正文，再解析 JSON：非法字节（单独的续字节、缺少后续
  // 字节的多字节字符、不符合 UTF-8 规则的编码）无论在标题、说明、场景还是正文其他
  // 位置，都让整次提交失败，不能把坏字节替换成“�”、删字节或只解析正常片段。
  // 用户主动输入的“�”本身以合法 UTF-8（EF BF BD）编码，解码结果就是普通文字，照常进入后续判定。
  const rawBody = Buffer.concat(chunks);
  let bodyText: string;
  try {
    bodyText = UTF8_DECODER.decode(rawBody);
  } catch {
    respond(res, 400, { error: '请求体不是有效的 UTF-8' });
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
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
  const rawTitle = body.title as string;
  const rawDescription = body.description as string;
  const scenario = typeof body.scenario === 'string' ? body.scenario : '';
  // 内容规则（空白与上限）与首页共用同一份判定，这里只保留接口原有的错误措辞。
  const problem = checkIdeaContent(rawTitle, rawDescription, scenario);
  if (problem) {
    respond(res, 400, { error: CONTENT_ERROR_MESSAGES[problem] });
    return;
  }
  const { title, description } = normalizeIdea(rawTitle, rawDescription, scenario);
  const idea = {
    id: randomUUID(),
    title,
    description,
    scenario,
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
// 按意见标识读取单条已保存意见（GET /api/ideas/<encoded-id>）。
// 路径里的标识段是 encodeURIComponent 的结果：WHATWG URL 的 pathname 保留百分号编码，
// 这里对“/api/ideas/”之后的整段原文解码一次，因此历史标识中的中文、空格以及
// /、?、# 等在网址中有特殊含义的字符（编码后为 %2F、%3F、%23）都作为标识的一部分，
// 不会被当成路径分隔符或查询；编码损坏无法解码时，按“不存在”处理。
// 只按 id 精确匹配：标题与说明相同但 id 不同的两条意见互不干扰；不套用新提交限制。
function handleGetIdea(res: ServerResponse, route: string): void {
  const encodedId = route.slice('/api/ideas/'.length);
  // 标识在地址中只占一个路径段：原始斜杠意味着多出的路径段，不是合法的查看链接。
  // 标识本身含“/”时分享链接使用的是 %2F，因此这里拒绝原始斜杠不会误伤合法记录。
  if (encodedId.length === 0 || encodedId.includes('/')) {
    respond(res, 404, { error: 'not found' });
    return;
  }
  let id: string;
  try {
    id = decodeURIComponent(encodedId);
  } catch {
    respond(res, 404, { error: 'not found' });
    return;
  }
  let records: unknown[];
  try {
    records = readIdeas();
  } catch {
    // 已有数据无法读取或内容损坏：明确是加载失败，不能冒充“该意见不存在”
    respond(res, 500, { error: 'unable to read ideas' });
    return;
  }
  const found = records.find((record) => (record as Record<string, unknown>).id === id);
  if (found === undefined) {
    // 标识不存在：只返回 404，不能改返回其他意见，也不能说整个产品没有意见
    respond(res, 404, { error: 'not found' });
    return;
  }
  respond(res, 200, { idea: found });
}
const server = createServer((req: IncomingMessage, res: ServerResponse): void => {
  let route: string;
  try { route = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { respond(res, 400, { error: 'invalid request path' }); return; }
  // 单条意见接口：/api/ideas/<encoded-id>
  if (route.startsWith('/api/ideas/')) {
    if (req.method !== 'GET') { respond(res, 405, { error: 'method not allowed' }, { allow: 'GET' }); return; }
    handleGetIdea(res, route);
    return;
  }
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
  // 单条意见查看页：/ideas/<encoded-id>。HTML 只是页面壳，记录由页面脚本按
  // 地址栏标识请求上面的接口；直接打开或刷新分享链接都能看到同一条记录。
  // 标识只占一个路径段（encodeURIComponent 不会产生原始斜杠）；
  // 百分号编码本身是否对应真实记录由脚本请求接口后区分“不存在/加载失败”。
  if (route.startsWith('/ideas/')) {
    const encodedId = route.slice('/ideas/'.length);
    if (encodedId.length === 0 || encodedId.includes('/')) { respond(res, 404, { error: 'not found' }); return; }
    if (req.method !== 'GET') { respond(res, 405, { error: 'method not allowed' }, { allow: 'GET' }); return; }
    respond(res, 200, DETAIL_PAGE, { html: true });
    return;
  }
  if (!['/', '/health'].includes(route)) { respond(res, 404, { error: 'not found' }); return; }
  if (req.method !== 'GET') { respond(res, 405, { error: 'method not allowed' }); return; }
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
