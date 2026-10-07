import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, removeDataDir, type StartedServer } from '../testing/server.ts';

// POST /api/ideas 必须在「整次请求的正文接收完整」之后才解析内容并保存。
// 这里保护的是请求中途断开时的行为（server.ts 读取请求流的 for await 中断分支）：
//   - 发送方明确声明 Content-Length 却只发其中一部分就断开（直接 RST 或优雅 FIN 都覆盖）：
//     即使已收到的前缀本身恰好是一份可解析的 JSON、三个意见字段也已完整，
//     也不能因为文字看起来完整就提前保存；
//   - 分块传输时已经发完全部意见文字、但没发请求结束标记（0\r\n\r\n）就断开，
//     同样属于未完成提交，不能入库；
//   - 断开后：不新增记录、不保存已收到的前缀、磁盘上不残留 .tmp，
//     已有意见的数量、顺序、id、createdAt 与三个文字字段（含空白、换行、中文、表情）逐字不变；
//   - 没有任何意见时发生中断：列表仍正常返回空数组，不能变成读取失败；
//   - 服务继续接受其他正常请求：在途的半截请求不阻塞其他连接的 GET 与合法 POST；
//     中断之后完整送达的合法意见仍返回现有的 201 并排最前；完整送达但非法仍按现有规则 400。
// 连接已经断开，客户端是否读到某种错误响应不做规定——关键结果是没有保存、不影响服务继续使用。

interface Idea {
  id: string;
  title: string;
  description: string;
  scenario: string;
  createdAt: string;
}

// 被中断的那条意见：自身满足当前标题、详细说明、使用场景规则，整份请求也远小于
// 已有的 1000000 字节上限——因此完整发送时必须能保存，中断时拒绝只能来自“请求未完成”。
const INTERRUPTED = {
  title: '  中断意见的标题  ',
  description: '这条意见文字完整且合法：含中文与表情 😀，保留换行\n第二行与  内部空格  。',
  scenario: '使用场景：夜间 🌙\n场景换行也保留',
};
const interruptedBody: Buffer = Buffer.from(JSON.stringify(INTERRUPTED), 'utf8');
assert.ok(Array.from(INTERRUPTED.title.trim()).length <= 120);
assert.ok(Array.from(INTERRUPTED.description).length <= 5000);
assert.ok(Array.from(INTERRUPTED.scenario).length <= 1000);
assert.ok(interruptedBody.length < 1_000_000, '被中断的请求总大小应低于已有的请求体上限');
JSON.parse(interruptedBody.toString('utf8')); // 前缀自身是一份完整、可解析的 JSON

let server: StartedServer;

before(async () => {
  server = await startServer();
});

after(async () => {
  await server.stop();
  removeDataDir(server);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function write(sock: Socket, data: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    sock.write(data, (error) => (error ? reject(error) : resolve()));
  });
}

function ideasFile(): string {
  return join(server.dataDir, 'ideas.json');
}

function readDisk(): Buffer {
  return readFileSync(ideasFile());
}

async function listIdeas(): Promise<Idea[]> {
  const res = await fetch(`${server.origin}/api/ideas`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(typeof data === 'object' && data !== null && Array.isArray(data.ideas));
  return data.ideas as Idea[];
}

async function postJson(payload: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let json: any;
  try { json = await res.json(); } catch { json = undefined; }
  return { status: res.status, json };
}

function contentLengthHead(declaredLength: number): string {
  return [
    'POST /api/ideas HTTP/1.1',
    'Host: 127.0.0.1',
    'Content-Type: application/json',
    `Content-Length: ${declaredLength}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
}

function chunkedHead(): string {
  return [
    'POST /api/ideas HTTP/1.1',
    'Host: 127.0.0.1',
    'Content-Type: application/json',
    'Transfer-Encoding: chunked',
    'Connection: close',
    '',
    '',
  ].join('\r\n');
}

// 在给定字节偏移处把正文切成多段（各段均不含 chunked 帧头）。
function cutAt(body: Buffer, offsets: number[]): Buffer[] {
  const sorted = [...new Set(offsets)].filter((o) => o > 0 && o < body.length).sort((a, b) => a - b);
  const pieces: Buffer[] = [];
  let prev = 0;
  for (const offset of sorted) {
    pieces.push(body.subarray(prev, offset));
    prev = offset;
  }
  pieces.push(body.subarray(prev));
  return pieces;
}

interface DisconnectOptions {
  head: string;
  // 要发送的正文片段；chunked 时每个元素各自作为一个数据块（自动加帧头帧尾）
  pieces: Buffer[];
  chunked?: boolean;
  // 'rst' 模拟连接直接丢失（socket.reset），'fin' 模拟优雅半关（只发 FIN、不再写）
  how: 'rst' | 'fin';
  pieceDelayMs?: number;
  // 已发部分发完后、断开前的等待：确保服务已经收到这些在途字节并在等待剩余正文
  settleMs?: number;
}

// 发送一条「正文尚未完成」的请求然后断开连接，返回断开前服务端回出的原始字节
// （直接 RST 时通常为空；优雅 FIN 时可能收到服务端的普通 400——规格不要求具体错误响应）。
function sendThenDisconnect(options: DisconnectOptions): Promise<Buffer> {
  const port = Number(new URL(server.origin).port);
  const { head, pieces, chunked = false, how, pieceDelayMs = 15, settleMs = 60 } = options;
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(port, '127.0.0.1');
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(received);
    };
    // 断开由测试主动触发，本地连接随后可能报 ECONNRESET/EPIPE：这是预期现象，
    // 不能让 error 事件冒泡成未处理异常。
    sock.on('error', () => {});
    sock.on('data', (chunk) => { received = Buffer.concat([received, chunk]); });
    sock.on('close', finish);
    const timer = setTimeout(finish, 400).unref();
    sock.on('connect', async () => {
      try {
        await write(sock, head);
        for (const piece of pieces) {
          if (chunked) await write(sock, Buffer.from(`${piece.length.toString(16)}\r\n`, 'ascii'));
          await write(sock, piece);
          if (chunked) await write(sock, Buffer.from('\r\n', 'ascii'));
          if (pieceDelayMs > 0) await sleep(pieceDelayMs);
        }
        // 关键：此刻正文尚未发完——Content-Length 未补足，或 chunked 未发结束帧。
        await sleep(settleMs);
        if (how === 'rst') {
          const resettable = sock as Socket & { reset?: () => void };
          if (typeof resettable.reset === 'function') resettable.reset();
          else sock.destroy();
        } else {
          sock.end();
        }
      } catch (error) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  });
}

// 断开连接时不约束服务端回不回错误，但绝不能回 201（保存成功只可能发生在完整接收之后）。
function assertNotSavedResponse(received: Buffer, label: string): void {
  const split = received.indexOf('\r\n\r\n');
  if (split === -1) return; // 连接已断、没有完整响应：规格允许
  const statusLine = received.subarray(0, split).toString('latin1').split('\r\n')[0];
  const match = statusLine.match(/HTTP\/1\.\d (\d{3})/);
  if (match) {
    assert.notEqual(Number(match[1]), 201, `${label}：请求未完成，绝不能返回 201 保存成功`);
  }
}

// 每次中断尝试之后都必须成立的存储不变量。
async function assertStorageUnchanged(baselineList: Idea[], baselineDisk: Buffer): Promise<void> {
  assert.deepEqual(await listIdeas(), baselineList, '中断的意见不能进入已保存列表');
  assert.deepEqual(readDisk(), baselineDisk, '正式保存内容不能被中断清空、重写或混入收到的前缀');
  assert.ok(!existsSync(`${ideasFile()}.tmp`), '不能残留本次提交的临时保存内容');
}

// 先用空存储覆盖「没有任何意见时发生中断」：列表仍应正常返回空数组。
test('没有任何意见时请求中途断开：列表仍正常返回空数组，磁盘保持初始空文件，不残留临时内容', async () => {
  // Content-Length 明确声明更长正文，只发完整 JSON 前缀后直接 RST
  const byReset = await sendThenDisconnect({
    head: contentLengthHead(interruptedBody.length + 20),
    pieces: [interruptedBody],
    how: 'rst',
  });
  assertNotSavedResponse(byReset, '空存储 + Content-Length 短发后 RST');

  // chunked 发完整意见文字但不发结束帧，优雅 FIN
  const byFin = await sendThenDisconnect({
    head: chunkedHead(),
    pieces: [interruptedBody],
    chunked: true,
    how: 'fin',
  });
  assertNotSavedResponse(byFin, '空存储 + chunked 无结束帧后 FIN');

  await sleep(50);
  const res = await fetch(`${server.origin}/api/ideas`);
  assert.equal(res.status, 200, '中断后查询不能变成读取失败');
  assert.deepEqual(await res.json(), { ideas: [] }, '没有意见时仍返回空数组');
  assert.equal(readDisk().toString('utf8'), '[]\n');
  assert.ok(!existsSync(`${ideasFile()}.tmp`));
});

// 种入带空白/换行/中文/表情的原有意见，以及同标题但不同 id 的两条；
// 之后所有中断尝试都要证明这些记录逐字不变。
let baseline: Idea[];
let baselineDisk: Buffer;

test('准备：种入带空白/换行/中文/表情的原有意见，以及同标题不同 id 的两条', async () => {
  const seeds = [
    {
      title: '  原有意见 甲 ',
      description: '第一行\n第二行 含中文 与 😀\n  保留首尾空格  ',
      scenario: '场景甲 🌙',
    },
    { title: '同标题不同标识', description: '第一条同标题', scenario: '' },
    { title: '同标题不同标识', description: '第二条同标题', scenario: '' },
  ];
  for (const seed of seeds) {
    const res = await postJson(seed);
    assert.equal(res.status, 201);
  }
  baseline = await listIdeas();
  assert.equal(baseline.length, 3);
  baselineDisk = readDisk();
});

test('Content-Length 明确声明更长正文，已发前缀恰为完整可解析 JSON（三字段完整）后直接 RST：不保存', async () => {
  const received = await sendThenDisconnect({
    head: contentLengthHead(interruptedBody.length + 20),
    pieces: [interruptedBody],
    how: 'rst',
  });
  assertNotSavedResponse(received, '完整 JSON 前缀后 RST');
  await assertStorageUnchanged(baseline, baselineDisk);
});

test('同上但以优雅 FIN 断开：不因为前缀文字看起来完整就提前保存', async () => {
  const received = await sendThenDisconnect({
    head: contentLengthHead(interruptedBody.length + 20),
    pieces: [interruptedBody],
    how: 'fin',
  });
  assertNotSavedResponse(received, '完整 JSON 前缀后 FIN');
  await assertStorageUnchanged(baseline, baselineDisk);
});

test('Content-Length 声明完整长度但只发半截 JSON（断在字符串中间）后 RST：不保存、不回 500', async () => {
  const cuts = cutAt(interruptedBody, [
    Math.floor(interruptedBody.length * 0.3),
    Math.floor(interruptedBody.length * 0.7),
  ]);
  // 只发前两段，最后一段不发
  const received = await sendThenDisconnect({
    head: contentLengthHead(interruptedBody.length),
    pieces: cuts.slice(0, -1),
    how: 'rst',
  });
  assertNotSavedResponse(received, '半截 JSON 后 RST');
  await assertStorageUnchanged(baseline, baselineDisk);
});

test('Content-Length 短发以 FIN 结束（已发部分是半截 JSON）：同样不保存，服务不崩', async () => {
  const received = await sendThenDisconnect({
    head: contentLengthHead(interruptedBody.length),
    pieces: [interruptedBody.subarray(0, Math.floor(interruptedBody.length / 2))],
    how: 'fin',
  });
  assertNotSavedResponse(received, '半截 JSON 后 FIN');
  await assertStorageUnchanged(baseline, baselineDisk);
});

test('chunked：完整意见文字已作为数据块发出、但不发请求结束标记就 RST：属于未完成提交，不保存', async () => {
  const received = await sendThenDisconnect({
    head: chunkedHead(),
    pieces: [interruptedBody],
    chunked: true,
    how: 'rst',
  });
  assertNotSavedResponse(received, 'chunked 无结束帧后 RST');
  await assertStorageUnchanged(baseline, baselineDisk);
});

test('chunked：完整意见块后不发结束标记而以 FIN 断开：仍不保存', async () => {
  const received = await sendThenDisconnect({
    head: chunkedHead(),
    pieces: [interruptedBody],
    chunked: true,
    how: 'fin',
  });
  assertNotSavedResponse(received, 'chunked 无结束帧后 FIN');
  await assertStorageUnchanged(baseline, baselineDisk);
});

test('chunked 分多块：第一块已是完整可解析意见、后面又到了一块片段，仍无结束帧就 RST：不保存', async () => {
  const received = await sendThenDisconnect({
    head: chunkedHead(),
    // 第二块是任意续发片段：即使第一个块的字节单独解析就是一份完整意见，
    // 请求没有结束标记就仍是未完成提交，不能把第一个块当成整次提交保存
    pieces: [interruptedBody, Buffer.from('后续片段还在到达', 'utf8')],
    chunked: true,
    how: 'rst',
  });
  assertNotSavedResponse(received, '完整前缀块 + 续发块后 RST');
  await assertStorageUnchanged(baseline, baselineDisk);
});

test('在途的未完成请求不阻塞其他连接：中断进行期间 GET 正常、合法 POST 仍 201；断开后不污染', async () => {
  const port = Number(new URL(server.origin).port);
  const sock: Socket = connect(port, '127.0.0.1');
  sock.on('error', () => {});
  await new Promise<void>((resolve) => sock.once('connect', () => resolve()));
  try {
    // 声明完整长度，但只发前三分之二，然后保持连接不发完
    const cuts = cutAt(interruptedBody, [
      Math.floor(interruptedBody.length * 0.3),
      Math.floor(interruptedBody.length * 0.7),
    ]);
    await write(sock, contentLengthHead(interruptedBody.length));
    await write(sock, cuts[0]);
    await sleep(30);
    await write(sock, cuts[1]);
    await sleep(30);

    // 半截请求仍在途：其他连接的查询必须照常
    const getting = await listIdeas();
    assert.deepEqual(getting, baseline, '在途的半截请求不能影响其他连接查询');

    // 其他连接完整提交一条合法意见：仍返回现有的 201 与完整保存结果
    const concurrentPayload = {
      title: '并发期间完整送达的意见',
      description: '另一条请求未完成时，本请求在独立连接上完整发送',
      scenario: '并发场景 😀',
    };
    const saved = await postJson(concurrentPayload);
    assert.equal(saved.status, 201);
    assert.ok(saved.json && typeof saved.json.idea === 'object' && saved.json.idea !== null);
    const concurrentIdea = saved.json.idea as Idea;
    assert.equal(typeof concurrentIdea.id, 'string');
    assert.ok(concurrentIdea.id.length > 0);
    assert.equal(typeof concurrentIdea.createdAt, 'string');
    assert.equal(concurrentIdea.title, concurrentPayload.title);
    assert.equal(concurrentIdea.description, concurrentPayload.description);
    assert.equal(concurrentIdea.scenario, concurrentPayload.scenario);

    // 在途请求再拖一会儿后直接断开
    await sleep(30);
    const resettable = sock as Socket & { reset?: () => void };
    if (typeof resettable.reset === 'function') resettable.reset();
    else sock.destroy();
  } finally {
    await new Promise<void>((resolve) => sock.once('close', () => resolve()));
  }

  await sleep(80);
  const list = await listIdeas();
  // 并发期间完整保存的那一条在，半截请求的内容不在
  assert.equal(list.length, baseline.length + 1);
  assert.equal(list[0].title, '并发期间完整送达的意见');
  assert.equal(
    list.filter((idea) => idea.title === INTERRUPTED.title.trim()).length,
    0,
    '在途半截请求即使已发出大部分字节，断开后也不能留下记录',
  );
  // 再查一次，顺序稳定
  const fresh = await listIdeas();
  assert.deepEqual(fresh, list);
  assert.deepEqual(fresh.slice(1), baseline, '原有记录的内容与相对顺序不变');
  assert.ok(!existsSync(`${ideasFile()}.tmp`));
  baseline = fresh;
  baselineDisk = readDisk();
});

test('中断之后完整重发同一内容：返回现有 201 与完整保存结果，新意见排最前，旧记录原样', async () => {
  const saved = await postJson(INTERRUPTED);
  assert.equal(saved.status, 201);
  const idea = saved.json.idea as Idea;
  assert.ok(idea && typeof idea === 'object');
  assert.equal(typeof idea.id, 'string');
  assert.ok(idea.id.length > 0);
  assert.equal(typeof idea.createdAt, 'string');
  assert.equal(idea.title, INTERRUPTED.title.trim(), '标题按现有规则去掉首尾空白');
  assert.equal(idea.description, INTERRUPTED.description, '详细说明原样保存，含换行与表情');
  assert.equal(idea.scenario, INTERRUPTED.scenario, '使用场景原样保存，含换行与表情');

  const list = await listIdeas();
  assert.equal(list.length, baseline.length + 1);
  assert.deepEqual(list[0], idea, '完整保存结果与随后查询读到的记录一致');
  assert.deepEqual(list.slice(1), baseline, '原有记录保持原来的内容与相对顺序');
  // 之前的中断尝试没有留下任何副本：这份标题在整个列表中只出现一次
  assert.equal(
    list.filter((item) => item.title === INTERRUPTED.title.trim()).length,
    1,
    '中断尝试不能留下半条或前缀副本',
  );
  assert.ok(!existsSync(`${ideasFile()}.tmp`));
  baseline = list;
  baselineDisk = readDisk();
});

test('完整送达但内容不合法：仍按现有规则拒绝（400、现有措辞、不带 idea），不入库', async () => {
  const blankTitle = await postJson({ title: '   ', description: '非空的详细说明' });
  assert.equal(blankTitle.status, 400);
  assert.equal(blankTitle.json.error, '标题去掉首尾空白后不能为空');
  assert.ok(!('idea' in (blankTitle.json ?? {})));

  const missingDescription = await postJson({ title: '只有标题' });
  assert.equal(missingDescription.status, 400);
  assert.ok(!('idea' in (missingDescription.json ?? {})));

  const wrongType = await postJson({ title: '合法标题', description: '合法说明', scenario: 123 });
  assert.equal(wrongType.status, 400);
  assert.match(String(wrongType.json.error), /scenario/);
  assert.ok(!('idea' in (wrongType.json ?? {})));

  await assertStorageUnchanged(baseline, baselineDisk);
});

test('全部中断尝试之后：原有意见的数量、顺序、标识、提交时间与三个文字字段逐字保持', async () => {
  const list = await listIdeas();
  assert.deepEqual(list, baseline);
  assert.deepEqual(readDisk(), baselineDisk);
  assert.ok(!existsSync(`${ideasFile()}.tmp`));

  // 最早种入的“原有意见 甲”排在最后，空白、换行、中文、表情逐字保留
  const oldest = list[list.length - 1];
  assert.equal(oldest.title, '原有意见 甲');
  assert.equal(oldest.description, '第一行\n第二行 含中文 与 😀\n  保留首尾空格  ');
  assert.equal(oldest.scenario, '场景甲 🌙');

  // 同标题但不同 id 的两条仍是独立记录：标识与提交时间没有重新生成
  const sameTitle = list.filter((idea) => idea.title === '同标题不同标识');
  assert.equal(sameTitle.length, 2);
  assert.notEqual(sameTitle[0].id, sameTitle[1].id);
  for (const idea of sameTitle) {
    assert.ok(baseline.some((old) => old.id === idea.id && old.createdAt === idea.createdAt));
  }

  // 合法完整提交的中断意见只存在正式保存的那一条
  const interrupted = list.filter((idea) => idea.title === INTERRUPTED.title.trim());
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].description, INTERRUPTED.description);
  assert.equal(interrupted[0].scenario, INTERRUPTED.scenario);
});
