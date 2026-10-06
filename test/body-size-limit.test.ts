import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { startServer, removeDataDir, type StartedServer } from '../testing/server.ts';

// POST /api/ideas 请求体大小限制（按实际收到的正文累计原始字节：JSON 的括号、引号、
// 字段名与空白都计入；中文、表情按 UTF-8 字节累计）的端到端回归。
// 与字段上限（标题/详细说明/使用场景按 Unicode 码点计算）是两套互相独立的规则。
//
// 本文件必须能发现这个回归：超大请求处理在写出 400 后立即 req.destroy()，
// 客户端（尤其用 Transfer-Encoding: chunked 陆续发送、超限时仍在上传的）
// 只看到连接重置（ECONNRESET），读不到完整、可解析的错误响应。
// 因此这里不用 fetch，而用原始 TCP 连接：把正文一次发完或分多段陆续发，
// 发完后保持连接等结果，再逐字节检查收到的是不是完整的 HTTP 响应。

const MAX_BODY_BYTES = 1_000_000;
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

let server: StartedServer;
let port: number;
let host: string;

before(async () => {
  server = await startServer();
  const url = new URL(server.origin);
  host = url.hostname;
  port = Number(url.port);
});

after(async () => {
  await server.stop();
  removeDataDir(server);
});

interface RawResult {
  status: number;
  headers: Map<string, string>;
  body: Buffer;
  socketError: Node.ErrnoException | null;
}

// 直接走 TCP：head 为请求头原文（必须自带 Content-Length 或 Transfer-Encoding），
// payload 为与声明一致的正文原始字节；可切成 chunkSize 的小段陆续发送并在段间停顿。
// blast=true 时不等待背压、在同一轮里尽快把全部字节交给套接字——这正是大正文客户端的
// 常见发送方式，旧实现在这种发送方式下会在客户端仍有数据在途时 destroy 连接并触发 RST；
// 不等待背压是刻意的：本用例就是要保证这种客户端也能读完整响应。
async function rawPost(
  head: string,
  payload: Buffer,
  options: { chunked?: boolean; chunkSize?: number; slowMs?: number; blast?: boolean } = {},
): Promise<RawResult> {
  const { chunked = false, chunkSize = Infinity, slowMs = 0, blast = false } = options;
  const sock = net.connect(port, host);
  await once(sock, 'connect');

  const writeAll = async (data: Buffer | string): Promise<void> => {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    if (!sock.write(buffer)) await once(sock, 'drain');
  };
  const put = (data: Buffer | string): void => {
    sock.write(Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1'));
  };

  let socketError: Node.ErrnoException | null = null;
  sock.on('error', (error: Node.ErrnoException) => { socketError = error; });

  if (blast) put(head);
  else await writeAll(head);
  const pieces: Buffer[] = [];
  for (let off = 0; off < payload.length; off += chunkSize) {
    pieces.push(payload.subarray(off, Math.min(off + chunkSize, payload.length)));
  }
  for (const piece of pieces) {
    if (blast) {
      if (chunked) put(`${piece.length.toString(16)}\r\n`);
      put(piece);
      if (chunked) put('\r\n');
    } else {
      if (chunked) await writeAll(`${piece.length.toString(16)}\r\n`);
      await writeAll(piece);
      if (chunked) await writeAll('\r\n');
      if (slowMs > 0) await sleep(slowMs);
    }
  }
  if (blast) put(chunked ? '0\r\n\r\n' : Buffer.alloc(0));
  else if (chunked) await writeAll('0\r\n\r\n');

  const received: Buffer[] = [];
  sock.on('data', (chunk: Buffer) => { received.push(chunk); });
  // 硬超时兜底：旧实现在某些发送方式下会 destroy 连接，偶发表现为连接迟迟不关或响应残缺；
  // 无论哪种都必须作为失败暴露出来，不能让整个测试进程一直挂住。
  let timer: NodeJS.Timeout | undefined;
  const closed = once(sock, 'close').then(() => 'closed' as const);
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), 10_000);
  });
  const outcome = await Promise.race([closed, timeout]);
  clearTimeout(timer);
  if (outcome === 'timeout') {
    sock.destroy();
    assert.fail('服务端没有在限定时间内结束响应（旧实现 destroy 连接可能导致客户端无法读到完整结果）');
  }

  const raw = Buffer.concat(received);
  const split = raw.indexOf('\r\n\r\n');
  assert.ok(split >= 0, '必须收到完整的响应头');
  const lines = raw.subarray(0, split).toString('latin1').split('\r\n');
  const status = Number(lines[0].split(' ')[1]);
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':');
    headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return { status, headers, body: raw.subarray(split + 4), socketError };
}

function contentLengthHead(byteLength: number): string {
  return `POST /api/ideas HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${byteLength}\r\nConnection: close\r\n\r\n`;
}
const chunkedHead =
  'POST /api/ideas HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n';

// 解析响应并核对它是完整、可解析的 JSON：状态码、Content-Length 与正文严格对应，
// 连接没有被重置，且调用方给出的断言在解析结果上成立。
function expectJsonResponse(result: RawResult, status: number, check: (data: any) => void): void {
  assert.equal(result.socketError, null, '不能出现连接重置等网络错误，客户端应读到完整响应');
  assert.equal(result.status, status);
  const declaredLength = Number(result.headers.get('content-length'));
  assert.ok(Number.isInteger(declaredLength) && declaredLength > 0, '响应必须带 Content-Length');
  assert.equal(result.body.length, declaredLength, '响应正文必须完整（按 Content-Length 收齐）');
  let data: any;
  assert.doesNotThrow(() => { data = JSON.parse(result.body.toString('utf8')); }, '响应体必须是可解析的 JSON');
  check(data);
}

// 构造字节数恰好为 targetBytes 的 JSON 文本（用单字节 ASCII 填充被忽略的额外字段，
// 使三个受限制字段保持合法且极短），并在测试侧自查字节数。
function exactBytesValidJson(targetBytes: number): Buffer {
  const prefix = '{"title":"边界标题","description":"边界说明","pad":"';
  const suffix = '"}';
  const padLength = targetBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  assert.ok(padLength >= 0);
  const payload = prefix + 'q'.repeat(padLength) + suffix;
  assert.equal(Buffer.byteLength(payload), targetBytes);
  return Buffer.from(payload, 'utf8');
}
function exactBytesInvalidJson(targetBytes: number): Buffer {
  const payload = '{' + 'z'.repeat(targetBytes - 1);
  assert.equal(Buffer.byteLength(payload), targetBytes);
  return Buffer.from(payload, 'latin1');
}

async function listIdeas(): Promise<any[]> {
  const res = await fetch(`${server.origin}/api/ideas`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.ideas));
  return data.ideas;
}
async function createValidIdea(title: string): Promise<any> {
  const res = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, description: `${title} 的详细说明`, scenario: '使用场景' }),
  });
  const data = await res.json();
  return { status: res.status, data };
}

test('准备：先保存一条普通意见，作为拒绝后比对的基准', async () => {
  const { status, data } = await createValidIdea('原有意见');
  assert.equal(status, 201);
  const list = await listIdeas();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, data.idea.id);
});

test('超大请求（预先声明 Content-Length）：一次发完或分段陆续发送，都收到完整的 400 JSON', async (t) => {
  const payload = exactBytesValidJson(MAX_BODY_BYTES + 1);
  const cases = [
    { name: '一次发完', options: {} },
    { name: '不分段、尽快压入套接字（不等背压）', options: { blast: true } },
    { name: '分成小段、尽快压入套接字（超限发生在中途，不等背压）', options: { chunkSize: 200_000, blast: true } },
    { name: '分成小段陆续慢速发送', options: { chunkSize: 64 * 1024, slowMs: 2 } },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const before = await listIdeas();
      const result = await rawPost(contentLengthHead(payload.length), payload, c.options);
      expectJsonResponse(result, 400, (data) => {
        assert.equal(data.error, '请求体过大');
        assert.equal(data.idea, undefined, '拒绝响应不能包含表示保存成功的 idea');
      });
      assert.deepEqual(await listIdeas(), before, '被拒绝的意见不进入列表，已有记录保持原样');
    });
  }
});

test('超大请求（未预先声明长度、chunked 分段传输）：整段或分段发送都收到完整 400，不能变成连接重置', async (t) => {
  const payload = exactBytesValidJson(MAX_BODY_BYTES + 1);
  const cases = [
    { name: '单个 chunk（超限发生在末段）', options: { chunked: true } },
    { name: '多个 chunk 尽快压入套接字（曾稳定触发 ECONNRESET 的情形，不等背压）', options: { chunked: true, chunkSize: 200_000, blast: true } },
    { name: '多个 chunk 慢速陆续发送', options: { chunked: true, chunkSize: 64 * 1024, slowMs: 2 } },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const before = await listIdeas();
      const result = await rawPost(chunkedHead, payload, c.options);
      expectJsonResponse(result, 400, (data) => {
        assert.equal(data.error, '请求体过大');
        assert.equal(data.idea, undefined);
      });
      assert.deepEqual(await listIdeas(), before);
    });
  }
});

test('客户端尽快压入远超上限的正文、超限时仍有大量字节在途：两种传输方式都必须读到完整 400（旧实现必现连接重置）', async (t) => {
  // 只比上限多一个字节时，客户端往往恰好赶在服务端 destroy 前把数据送完，问题不稳定复现；
  // 正文远超上限（这里 3MB）时，超限点之后仍有大量数据在途，旧实现 write 响应后立即
  // req.destroy() 会必现 ECONNRESET。固定用这个确定性情形守住“不能变成网络错误”。
  const payload = exactBytesValidJson(3_000_000);
  const cases = [
    { name: 'Content-Length 声明长度 + 不等待背压尽快压入', head: contentLengthHead(payload.length), options: { chunkSize: 200_000, blast: true } },
    { name: 'chunked + 不等待背压尽快压入', head: chunkedHead, options: { chunked: true, chunkSize: 200_000, blast: true } },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const before = await listIdeas();
      const result = await rawPost(c.head, payload, c.options);
      expectJsonResponse(result, 400, (data) => {
        assert.equal(data.error, '请求体过大');
        assert.equal(data.idea, undefined);
      });
      assert.deepEqual(await listIdeas(), before);
    });
  }
});

test('超大判定优先于 JSON 解析：已超过上限的正文即使不是合法 JSON，错误仍是“请求体过大”', async (t) => {
  const invalid = exactBytesInvalidJson(MAX_BODY_BYTES + 1);
  await t.test('Content-Length 声明长度的非法 JSON 超大正文', async () => {
    const result = await rawPost(contentLengthHead(invalid.length), invalid, { chunkSize: 200_000 });
    expectJsonResponse(result, 400, (data) => {
      assert.equal(data.error, '请求体过大');
      assert.equal(data.idea, undefined);
    });
  });
  await t.test('chunked 传输的非法 JSON 超大正文', async () => {
    const result = await rawPost(chunkedHead, invalid, { chunked: true, chunkSize: 200_000, blast: true });
    expectJsonResponse(result, 400, (data) => {
      assert.equal(data.error, '请求体过大');
      assert.equal(data.idea, undefined);
    });
  });
});

test('大小边界按实际收到的字节累计：恰好 1,000,000 字节继续走现有 JSON 与字段规则，多出一个字节即拒绝', async (t) => {
  await t.test('恰好 1,000,000 字节的合法 JSON（含被忽略的大额外字段）：正常保存并返回 201', async () => {
    const exact = exactBytesValidJson(MAX_BODY_BYTES);
    const result = await rawPost(contentLengthHead(exact.length), exact, { chunkSize: 200_000 });
    expectJsonResponse(result, 201, (data) => {
      assert.ok(data.idea && typeof data.idea === 'object');
      assert.equal(data.idea.title, '边界标题');
      assert.equal(data.idea.description, '边界说明');
      assert.equal(typeof data.idea.id, 'string');
      assert.equal(typeof data.idea.createdAt, 'string');
    });
    // 恰好上限的成功记录进入列表并排在最前
    const list = await listIdeas();
    assert.equal(list[0].title, '边界标题');
    assert.equal(list.length, 2);
  });

  await t.test('恰好 1,000,000 字节但不是合法 JSON：沿用现有的非法 JSON 拒绝，而不是“请求体过大”', async () => {
    const exact = exactBytesInvalidJson(MAX_BODY_BYTES);
    const before = await listIdeas();
    const result = await rawPost(contentLengthHead(exact.length), exact, { chunkSize: 200_000 });
    expectJsonResponse(result, 400, (data) => {
      assert.equal(data.error, '请求体不是有效的 JSON');
      assert.equal(data.idea, undefined);
    });
    assert.deepEqual(await listIdeas(), before);
  });

  await t.test('在恰好上限的合法正文上多出一个字节：拒绝为“请求体过大”，不截断后保存', async () => {
    const over = exactBytesValidJson(MAX_BODY_BYTES + 1);
    const before = await listIdeas();
    const result = await rawPost(contentLengthHead(over.length), over, { chunkSize: 200_000 });
    expectJsonResponse(result, 400, (data) => {
      assert.equal(data.error, '请求体过大');
      assert.equal(data.idea, undefined);
    });
    assert.deepEqual(await listIdeas(), before);
  });

  await t.test('多出一个字节的情形在 chunked 传输下同样确定拒绝', async () => {
    const over = exactBytesValidJson(MAX_BODY_BYTES + 1);
    const result = await rawPost(chunkedHead, over, { chunked: true, chunkSize: 123_457, blast: true });
    expectJsonResponse(result, 400, (data) => {
      assert.equal(data.error, '请求体过大');
    });
  });
});

test('大小以内的非法 JSON 继续使用现有拒绝结果', async () => {
  const payload = Buffer.from('{"title":"只有半截",');
  const before = await listIdeas();
  const result = await rawPost(contentLengthHead(payload.length), payload);
  expectJsonResponse(result, 400, (data) => {
    assert.equal(data.error, '请求体不是有效的 JSON');
    assert.equal(data.idea, undefined);
  });
  assert.deepEqual(await listIdeas(), before);
});

test('超大请求结束后服务继续正常工作：合法意见保存成功，排在原有记录之前，旧记录原样保留', async () => {
  const before = await listIdeas();
  const rejected = exactBytesValidJson(MAX_BODY_BYTES + 1);
  const result = await rawPost(chunkedHead, rejected, { chunked: true, chunkSize: 200_000, blast: true });
  expectJsonResponse(result, 400, (data) => assert.equal(data.error, '请求体过大'));
  assert.deepEqual(await listIdeas(), before);

  const { status, data } = await createValidIdea('新的普通意见');
  assert.equal(status, 201);
  const after = await listIdeas();
  assert.equal(after.length, before.length + 1);
  assert.equal(after[0].id, data.idea.id);
  assert.deepEqual(after.slice(1), before, '原有记录的内容、标识、提交时间与排列保持原样');
});
