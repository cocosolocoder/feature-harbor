import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PRODUCT: string = 'FeatureHarbor';
const RESOURCE: string = 'ideas';
const PAGE: string = "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>FeatureHarbor · 产品意见与公开路线图</title><style>body{font-family:system-ui,sans-serif;max-width:52rem;margin:3rem auto;padding:0 1rem;line-height:1.7}a{color:#175b9c}</style><main><h1>FeatureHarbor</h1><p>产品意见与公开路线图</p><h2>意见列表</h2><p>还没有意见记录。</p><p><a href=\"/api/ideas\">查看意见列表接口</a> · <a href=\"/health\">服务状态</a></p></main></html>";
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
function respond(res: ServerResponse, status: number, value: unknown, html = false): void {
  const body = html ? String(value) : JSON.stringify(value);
  res.writeHead(status, { 'content-type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body), ...(status === 405 ? { allow: 'GET' } : {}) });
  res.end(body);
}
const server = createServer((req: IncomingMessage, res: ServerResponse): void => {
  let route: string;
  try { route = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { respond(res, 400, { error: 'invalid request path' }); return; }
  if (!['/', '/health', '/api/ideas'].includes(route)) { respond(res, 404, { error: 'not found' }); return; }
  if (req.method !== 'GET') { respond(res, 405, { error: 'method not allowed' }); return; }
  if (route === '/') { respond(res, 200, PAGE, true); return; }
  if (route === '/health') { respond(res, 200, { status: 'ok', product: PRODUCT }); return; }
  try {
    const records: unknown = JSON.parse(readFileSync(dataFile, 'utf8'));
    if (!Array.isArray(records)) throw new Error('Invalid record list');
    respond(res, 200, { [RESOURCE]: records });
  } catch { respond(res, 500, { error: 'unable to read ideas' }); }
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
