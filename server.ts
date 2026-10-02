import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PRODUCT: string = 'FeatureHarbor';
const RESOURCE: string = 'ideas';
const PAGE: string = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FeatureHarbor · 产品意见与公开路线图</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; max-width: 52rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.7; }
h1 { margin-bottom: 0.25rem; }
.subtitle { color: #666; margin-top: 0; }
form { border: 1px solid #ccc; border-radius: 8px; padding: 1rem 1.25rem; margin: 1.5rem 0; }
form h2 { margin-top: 0; }
label { display: block; font-weight: 600; margin-top: 0.75rem; }
.required::after { content: " *"; color: #c00; }
input, textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 0.4rem 0.5rem; }
textarea { min-height: 6rem; resize: vertical; }
.hint { font-weight: 400; color: #888; font-size: 0.85rem; }
button { margin-top: 1rem; font: inherit; padding: 0.45rem 1.2rem; cursor: pointer; }
#form-error { color: #b00; margin: 0.75rem 0 0; white-space: pre-wrap; }
.idea { border-top: 1px solid #ddd; padding: 1rem 0; }
.idea h3 { margin: 0 0 0.25rem; }
.idea p { margin: 0.25rem 0; }
.idea .description, .idea .scenario { white-space: pre-wrap; }
.idea .scenario strong { font-weight: 600; }
.idea .meta { color: #888; font-size: 0.85rem; }
#empty { color: #888; }
a { color: #175b9c; }
</style>
</head>
<body>
<main>
<h1>FeatureHarbor</h1>
<p class="subtitle">产品意见与公开路线图</p>

<form id="idea-form" novalidate>
  <h2>提交产品意见</h2>
  <label for="title" class="required">标题</label>
  <input id="title" name="title" required placeholder="一句话概括你的意见">
  <label for="description" class="required">详细说明</label>
  <textarea id="description" name="description" required placeholder="详细描述你的意见或建议"></textarea>
  <label for="scenario">使用场景 <span class="hint">（可选，可不填）</span></label>
  <textarea id="scenario" name="scenario" placeholder="描述你在什么场景下使用（可选）"></textarea>
  <p id="form-error" role="alert"></p>
  <button type="submit">提交意见</button>
</form>

<h2>意见列表</h2>
<p id="empty">还没有意见记录，来提交第一条吧。</p>
<div id="ideas"></div>

<p><a href="/api/ideas">查看意见列表接口</a> · <a href="/health">服务状态</a></p>
</main>
<script>
function renderIdeas(ideas) {
  var list = document.getElementById('ideas');
  var empty = document.getElementById('empty');
  list.innerHTML = '';
  if (!ideas.length) { empty.style.display = ''; return; }
  empty.style.display = 'none';
  ideas.forEach(function (idea) {
    var article = document.createElement('article');
    article.className = 'idea';

    var title = document.createElement('h3');
    title.textContent = idea.title;
    article.appendChild(title);

    var desc = document.createElement('p');
    desc.className = 'description';
    desc.textContent = idea.description;
    article.appendChild(desc);

    if (idea.scenario !== '') {
      var sc = document.createElement('p');
      sc.className = 'scenario';
      var label = document.createElement('strong');
      label.textContent = '使用场景';
      sc.appendChild(label);
      sc.appendChild(document.createTextNode('\\n' + idea.scenario));
      article.appendChild(sc);
    }

    var meta = document.createElement('p');
    meta.className = 'meta';
    var time = new Date(idea.createdAt);
    meta.textContent = '提交时间：' + (isNaN(time.getTime()) ? idea.createdAt : time.toLocaleString());
    article.appendChild(meta);

    list.appendChild(article);
  });
}

function loadIdeas() {
  var empty = document.getElementById('empty');
  fetch('/api/ideas').then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }).then(function (data) {
    renderIdeas(data.ideas || []);
  }).catch(function () {
    empty.style.display = '';
    empty.textContent = '意见列表加载失败，请稍后重试。';
  });
}

var form = document.getElementById('idea-form');
var errorEl = document.getElementById('form-error');
form.addEventListener('submit', function (event) {
  event.preventDefault();
  errorEl.textContent = '';
  var payload = {
    title: document.getElementById('title').value,
    description: document.getElementById('description').value,
    scenario: document.getElementById('scenario').value
  };
  fetch('/api/ideas', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      return { status: res.status, data: data };
    });
  }).then(function (result) {
    if (result.status === 201) {
      form.reset();
      loadIdeas();
    } else {
      errorEl.textContent = (result.data && result.data.error) || '提交失败，请稍后重试。';
    }
  }).catch(function () {
    errorEl.textContent = '提交失败，请检查网络后重试。';
  });
});

loadIdeas();
</script>
</body>
</html>`;
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

interface IdeaRecord {
  id: string;
  title: string;
  description: string;
  scenario: string;
  createdAt: string;
}

function respond(res: ServerResponse, status: number, value: unknown, html = false, allow?: string): void {
  const body = html ? String(value) : JSON.stringify(value);
  res.writeHead(status, {
    'content-type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...(allow ? { allow } : {})
  });
  res.end(body);
}

function codePointLength(value: string): number {
  return [...value].length;
}

function validateIdea(input: unknown): { error?: string; idea?: { title: string; description: string; scenario: string } } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { error: '请求体必须是 JSON 对象' };
  }
  const fields = input as Record<string, unknown>;
  const { title, description, scenario } = fields;
  if (typeof title !== 'string') {
    return { error: 'title 为必填项，且必须是字符串' };
  }
  const trimmedTitle = title.trim();
  if (codePointLength(trimmedTitle) === 0) {
    return { error: '标题去掉首尾空白后不能为空' };
  }
  if (codePointLength(trimmedTitle) > 120) {
    return { error: `标题不能超过 120 个字符（当前 ${codePointLength(trimmedTitle)} 个字符）` };
  }
  if (typeof description !== 'string') {
    return { error: 'description 为必填项，且必须是字符串' };
  }
  if (codePointLength(description) > 5000) {
    return { error: `详细说明不能超过 5000 个字符（当前 ${codePointLength(description)} 个字符）` };
  }
  if (description.trim().length === 0) {
    return { error: '详细说明必须包含非空白内容' };
  }
  if (scenario !== undefined) {
    if (typeof scenario !== 'string') {
      return { error: 'scenario 必须是字符串' };
    }
    if (codePointLength(scenario) > 1000) {
      return { error: `使用场景不能超过 1000 个字符（当前 ${codePointLength(scenario)} 个字符）` };
    }
  }
  return { idea: { title: trimmedTitle, description, scenario: scenario ?? '' } };
}

function loadRecords(): { records?: unknown[]; error?: string } {
  let raw: string;
  try {
    raw = readFileSync(dataFile, 'utf8');
  } catch {
    return { error: '无法读取意见数据' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: '无法读取意见数据' };
  }
  if (!Array.isArray(parsed)) {
    return { error: '无法读取意见数据' };
  }
  return { records: parsed };
}

function saveRecords(records: unknown[]): boolean {
  try {
    const tmpFile = `${dataFile}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(records, null, 2) + '\n');
    renameSync(tmpFile, dataFile);
    return true;
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const limit = 1_000_000;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  let route: string;
  try { route = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { respond(res, 400, { error: 'invalid request path' }); return; }
  if (!['/', '/health', '/api/ideas'].includes(route)) { respond(res, 404, { error: 'not found' }); return; }
  const method: string = req.method ?? 'GET';
  const allowed: string = route === '/api/ideas' ? 'GET, POST' : 'GET';
  if (method !== 'GET' && !(route === '/api/ideas' && method === 'POST')) {
    respond(res, 405, { error: 'method not allowed' }, false, allowed);
    return;
  }
  if (route === '/') { respond(res, 200, PAGE, true); return; }
  if (route === '/health') { respond(res, 200, { status: 'ok', product: PRODUCT }); return; }

  if (method === 'GET') {
    const loaded = loadRecords();
    if (loaded.error) { respond(res, 500, { error: loaded.error }); return; }
    respond(res, 200, { [RESOURCE]: loaded.records });
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch {
    respond(res, 413, { error: '请求体过大' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    respond(res, 400, { error: '请求体不是有效的 JSON' });
    return;
  }
  const validation = validateIdea(parsed);
  if (validation.error) {
    respond(res, 400, { error: validation.error });
    return;
  }
  const loaded = loadRecords();
  if (loaded.error) { respond(res, 500, { error: loaded.error }); return; }
  const record: IdeaRecord = {
    id: randomUUID(),
    title: validation.idea?.title ?? '',
    description: validation.idea?.description ?? '',
    scenario: validation.idea?.scenario ?? '',
    createdAt: new Date().toISOString()
  };
  const records: unknown[] = [record, ...(loaded.records ?? [])];
  if (!saveRecords(records)) {
    respond(res, 500, { error: '意见保存失败，请稍后重试' });
    return;
  }
  respond(res, 201, { idea: record });
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
