import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PRODUCT: string = 'FeatureHarbor';
const RESOURCE: string = 'ideas';
const MAX_TITLE = 120;
const MAX_DESCRIPTION = 5000;
const MAX_SCENARIO = 1000;
const MAX_BODY_BYTES = 1_000_000;
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
<label for="f-title">标题 <span class="required">*</span>（必填，最多 120 字）</label>
<input id="f-title" name="title" required>
<label for="f-desc">详细说明 <span class="required">*</span>（必填，最多 5000 字）</label>
<textarea id="f-desc" name="description" rows="5" required></textarea>
<label for="f-scenario">使用场景（可选，最多 1000 字）</label>
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
const form = document.getElementById('idea-form');
const titleInput = document.getElementById('f-title');
const descInput = document.getElementById('f-desc');
const scenarioInput = document.getElementById('f-scenario');
const errorBox = document.getElementById('error');
const successBox = document.getElementById('success');
const emptyNote = document.getElementById('empty');
const list = document.getElementById('ideas');
function codePoints(text) { return Array.from(text).length; }
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
let serverIdeas = null;
let loadFailed = false;
const submittedIdeas = [];
const itemNodes = new Map();
function mergeIdeas() {
  const seen = new Set();
  const merged = [];
  for (const idea of submittedIdeas) {
    if (idea && !seen.has(idea.id)) { seen.add(idea.id); merged.push(idea); }
  }
  if (serverIdeas) {
    for (const idea of serverIdeas) {
      if (idea && !seen.has(idea.id)) { seen.add(idea.id); merged.push(idea); }
    }
  }
  return merged;
}
function renderList() {
  const merged = mergeIdeas();
  const nextIds = new Set(merged.map((idea) => idea.id));
  for (const id of [...itemNodes.keys()]) {
    if (!nextIds.has(id)) { itemNodes.get(id).remove(); itemNodes.delete(id); }
  }
  let reference = null;
  for (const idea of merged) {
    let node = itemNodes.get(idea.id);
    if (!node) { node = renderIdea(idea); itemNodes.set(idea.id, node); }
    if (reference) reference.after(node); else list.prepend(node);
    reference = node;
  }
  if (loadFailed) {
    emptyNote.textContent = '意见列表加载失败，请稍后刷新重试。';
    emptyNote.hidden = false;
  } else {
    emptyNote.textContent = '还没有意见记录。';
    emptyNote.hidden = serverIdeas ? merged.length > 0 : true;
  }
}
async function loadIdeas() {
  try {
    const res = await fetch('/api/ideas');
    if (!res.ok) throw new Error('load failed');
    const data = await res.json();
    serverIdeas = Array.isArray(data.ideas) ? data.ideas : [];
    loadFailed = false;
  } catch {
    loadFailed = true;
  }
  renderList();
}
function validate(title, description, scenario) {
  const trimmed = title.trim();
  if (!trimmed) return '标题不能为空。';
  if (codePoints(trimmed) > 120) return '标题最多 120 个字符。';
  if (!description.trim()) return '详细说明不能为空。';
  if (codePoints(description) > 5000) return '详细说明最多 5000 个字符。';
  if (codePoints(scenario) > 1000) return '使用场景最多 1000 个字符。';
  return null;
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  successBox.hidden = true;
  const title = titleInput.value;
  const description = descInput.value;
  const scenario = scenarioInput.value;
  const problem = validate(title, description, scenario);
  if (problem) { showError(problem); return; }
  let res;
  try {
    res = await fetch('/api/ideas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, description, scenario })
    });
  } catch {
    showError('网络错误，提交未成功，请重试。');
    return;
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || !data || !data.idea) {
    showError(data && data.error ? '提交失败：' + data.error : '提交失败，请稍后重试。');
    return;
  }
  form.reset();
  successBox.textContent = '提交成功，你的意见已保存。';
  successBox.hidden = false;
  if (!submittedIdeas.some((idea) => idea.id === data.idea.id)) submittedIdeas.push(data.idea);
  renderList();
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
function codePoints(text: string): number {
  return Array.from(text).length;
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
  const title = (body.title as string).trim();
  const description = body.description as string;
  const scenario = typeof body.scenario === 'string' ? body.scenario : '';
  if (!title) { respond(res, 400, { error: '标题去掉首尾空白后不能为空' }); return; }
  if (codePoints(title) > MAX_TITLE) { respond(res, 400, { error: `标题最多 ${MAX_TITLE} 个字符` }); return; }
  if (!description.trim()) { respond(res, 400, { error: '详细说明必须包含非空白内容' }); return; }
  if (codePoints(description) > MAX_DESCRIPTION) { respond(res, 400, { error: `详细说明最多 ${MAX_DESCRIPTION} 个字符` }); return; }
  if (codePoints(scenario) > MAX_SCENARIO) { respond(res, 400, { error: `使用场景最多 ${MAX_SCENARIO} 个字符` }); return; }
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
