import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, removeDataDir, type StartedServer } from '../testing/server.ts';

// 请求体整份字节上限（1,000,000 字节）的端到端回归：真实起一份 server.ts，
// 只访问公开的 POST/GET /api/ideas。这里保护的是「整份请求体大小限制」，
// 与 idea-fields.ts 里标题/详细说明/使用场景按 Unicode 码点计算的字符上限是两回事，
// 两种限制不能混为一谈：
//   - 大小按实际传输的 UTF-8 字节数累计：JSON 的字段名、括号、引号、字段外空白都计入，
//     中文（3 字节）、表情（4 字节）不能按一个字符当作一个字节；
//   - 整份 JSON 合法且正文恰好 1,000,000 字节：201 且完整保存，随后可读到原样的新意见；
//     只多一个字节：400、error 为“请求体过大”、响应不带 idea；
//   - 明确 Content-Length 与不预告总长度的 Transfer-Encoding: chunked 走同一条判定，
//     chunked 的超限可能发生在中途，也可能直到最后一段才发生——不能因为单段较小、
//     或前面的字节已经像一份完整意见就接受整次提交；
//   - 超限后客户端继续把正文发完并保持连接等待，必须收到完整、可解析的 400，
//     不能只看到连接断开；正文同时有 JSON 格式问题时仍报告“请求体过大”，
//     未超限的非法 JSON 继续返回现有的格式错误；
//   - 被拒绝的请求不入库：原有意见的数量、顺序、id、createdAt 与文字逐字不变，
//     不新增截断记录，也不保存已经收到的前缀，磁盘上不残留 .tmp。

const MAX_BODY_BYTES = 1_000_000;

interface Idea {
  id: string;
  title: string;
  description: string;
  scenario: string;
  createdAt: string;
}

// 三个字段都符合现有规则的固定内容：含中文、表情、ZWJ 表情与空白换行，
// 用来验证跨 TCP 段/分块边界拆字后保存仍逐字完整。
const FIELDS = {
  title: '字节边界标题 边界',
  description: '说明含中文：边界测试。\n第二行保留换行与空格  😀',
  scenario: '使用场景：中文字与表情 😮‍💨🌙 尾',
};
const points = (text: string): number => Array.from(text).length;
assert.ok(points(FIELDS.title) <= 120);
assert.ok(points(FIELDS.description) <= 5000);
assert.ok(points(FIELDS.scenario) <= 1000);

let server: StartedServer;

before(async () => {
  server = await startServer();
});

after(async () => {
  await server.stop();
  removeDataDir(server);
});

async function listIdeas(): Promise<Idea[]> {
  const res = await fetch(`${server.origin}/api/ideas`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.ideas));
  return data.ideas as Idea[];
}

function ideasFile(): string {
  return join(server.dataDir, 'ideas.json');
}

function readDisk(): Buffer {
  return readFileSync(ideasFile());
}

// 直接走原始 TCP：fetch/undici 不提供 Transfer-Encoding: chunked 的分段控制，
// 也无法刻意把一个多字节字符的 UTF-8 字节拆到相邻两次写入。
interface RawResponse {
  status: number;
  headers: Record<string, string>;
  rawBody: Buffer;
  text: string;
  json: any;
}

interface RawOptions {
  // 原始正文的字节序列（不含 chunked 帧头）；按数组元素逐次写入
  pieces: Buffer[];
  chunked?: boolean;
  // 每次写入之间的间隔：模拟慢速客户端，验证服务不会在正文发完前提前响应或断开
  delayMs?: number;
}

function rawPost({ pieces, chunked = false, delayMs = 2 }: RawOptions): Promise<RawResponse> {
  const port = Number(new URL(server.origin).port);
  const totalBytes = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const headLines = [
    'POST /api/ideas HTTP/1.1',
    'Host: 127.0.0.1',
    'Content-Type: application/json',
    'Connection: close',
    chunked
      ? 'Transfer-Encoding: chunked'
      : `Content-Length: ${totalBytes}`,
  ];
  return new Promise<RawResponse>((resolve, reject) => {
    const sock: Socket = connect(port, '127.0.0.1');
    let received = Buffer.alloc(0);
    let sendingDone = false;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(error);
    };
    sock.on('error', (error) => fail(error));
    sock.on('data', (chunk) => {
      // 超限请求必须先排空正文再回复：正文没发完就收到任何字节，
      // 说明服务提前响应（或实现退回到读完即断的旧行为）
      if (!sendingDone) fail(new Error('服务在请求体发送完成前就返回了数据'));
      received = Buffer.concat([received, chunk]);
    });
    sock.on('end', () => {
      if (settled) return;
      const split = received.indexOf('\r\n\r\n');
      if (split === -1) {
        fail(new Error('连接在收到完整响应前结束（只看到连接断开）'));
        return;
      }
      const headerText = received.subarray(0, split).toString('latin1');
      const rawBody = received.subarray(split + 4);
      const lines = headerText.split('\r\n');
      const status = Number((lines[0].match(/HTTP\/1\.1 (\d+)/) ?? [])[1]);
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const at = line.indexOf(':');
        if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
      }
      // 响应必须按声明的长度完整到达，不能被截断
      const declared = Number(headers['content-length']);
      if (Number.isFinite(declared)) {
        assert.equal(rawBody.length, declared, '响应正文应与 content-length 等长');
      }
      const text = rawBody.toString('utf8');
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      settled = true;
      resolve({ status, headers, rawBody, text, json });
    });
    sock.on('connect', async () => {
      try {
        await write(sock, headLines.join('\r\n') + '\r\n\r\n');
        for (let i = 0; i < pieces.length; i++) {
          // 间隔只放在段与段之间：最后一段发出后服务端即可判定请求结束，
          // 不能在测试侧再人为拖延，否则会把正常回复误判成“正文没发完就响应”
          if (i > 0 && delayMs > 0) await sleep(delayMs);
          const piece = pieces[i];
          if (chunked) await write(sock, Buffer.from(`${piece.length.toString(16)}\r\n`, 'ascii'));
          await write(sock, piece);
          if (chunked) await write(sock, Buffer.from('\r\n', 'ascii'));
        }
        if (chunked) await write(sock, Buffer.from('0\r\n\r\n', 'ascii'));
        sendingDone = true;
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function write(sock: Socket, data: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    sock.write(data, (error) => (error ? reject(error) : resolve()));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 在给定字节偏移处把正文切成多段（偏移允许落在一个多字节字符的 UTF-8 序列内部）
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

// 构造 {三个合法字段, padding:<填充>} 的整份 JSON，使其 UTF-8 字节数恰好为 target。
// multibyte 为 true 时填充主要用 3 字节的“中”：整份 JSON 的字符数远低于 target，
// 若实现误按字符计数就不会超限——用于区分“按字节”与“按字符”两种判定。
function paddedBody(target: number, multibyte = false): Buffer {
  const base = Buffer.byteLength(JSON.stringify({ ...FIELDS, padding: '' }), 'utf8');
  const need = target - base;
  assert.ok(need >= 0, `目标字节数 ${target} 小于基础 JSON 的 ${base} 字节`);
  let padding: string;
  if (!multibyte) {
    padding = 'x'.repeat(need);
  } else {
    const full = Math.floor(need / 3);
    const rest = need - full * 3;
    padding = '中'.repeat(full) + 'x'.repeat(rest);
  }
  const body = Buffer.from(JSON.stringify({ ...FIELDS, padding }), 'utf8');
  assert.equal(body.length, target);
  // 自带 sanity：这确实是一份合法 JSON，且三个意见字段仍符合码点上限
  const parsed = JSON.parse(body.toString('utf8'));
  assert.equal(points(parsed.title), points(FIELDS.title));
  return body;
}

// 非法 JSON 正文，精确凑到 target 字节（整份大小判定与 JSON 解析的优先级边界用）
function malformedBody(target: number): Buffer {
  const head = Buffer.from('{not json', 'utf8');
  const body = Buffer.concat([head, Buffer.from(' '.repeat(Math.max(0, target - head.length)), 'ascii')]);
  assert.equal(body.length, target);
  return body;
}

// 合法 JSON，但在最后一个字段与结束括号之间插入 target 所需的字段外空白：
// 字段外的空白也计入整份请求体大小
function whitespaceBody(target: number): Buffer {
  const core = JSON.stringify(FIELDS);
  const head = core.slice(0, -1);
  const needed = target - Buffer.byteLength(head, 'utf8') - 1;
  assert.ok(needed >= 0);
  const body = Buffer.from(head + ' '.repeat(needed) + '}', 'utf8');
  assert.equal(body.length, target);
  JSON.parse(body.toString('utf8')); // 自身保证合法
  return body;
}

// 先种入几条原有意见：含首尾/内部空白、换行、中文、表情，以及同标题但不同 id 的两条。
// 所有拒绝用例都要证明这些记录逐字不变。
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
    const res = await fetch(`${server.origin}/api/ideas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(seed),
    });
    assert.equal(res.status, 201);
  }
  baseline = await listIdeas();
  assert.equal(baseline.length, 3);
  baselineDisk = readDisk();
});

test('整份 JSON 恰好 1000000 字节、明确 Content-Length：201 完整保存；中文/表情/ZWJ 的 UTF-8 字节拆在相邻 TCP 写入中也不损坏', async () => {
  const body = paddedBody(MAX_BODY_BYTES);
  // 偏移落在：标题“边”的第 1/3 个字节后、说明“😀”的第 2/4 个字节后、
  // 场景“😮”的第 3/4 个字节后、ZWJ(U+200D) 的第 1/3 个字节后、“💨”的第 2/4 个字节后
  const indexOf = (s: string): number => body.indexOf(Buffer.from(s, 'utf8'));
  const face = indexOf('😮');
  const zwj = body.indexOf(Buffer.from([0xe2, 0x80, 0x8d]), face);
  const cuts = [
    indexOf('边') + 1,
    indexOf('😀') + 2,
    face + 3,
    zwj + 1,
    indexOf('💨') + 2,
    123457,
  ];
  const res = await rawPost({ pieces: cutAt(body, cuts), chunked: false, delayMs: 1 });
  assert.equal(res.status, 201);
  assert.ok(res.json && typeof res.json.idea === 'object' && res.json.idea);
  const saved = res.json.idea as Idea;
  assert.equal(typeof saved.id, 'string');
  assert.ok(saved.id.length > 0);
  assert.equal(typeof saved.createdAt, 'string');
  assert.equal(saved.title, FIELDS.title);
  assert.equal(saved.description, FIELDS.description);
  assert.equal(saved.scenario, FIELDS.scenario);
  assert.ok(!saved.title.includes('�') && !saved.description.includes('�') && !saved.scenario.includes('�'));

  const list = await listIdeas();
  assert.equal(list.length, baseline.length + 1);
  assert.deepEqual(list[0], saved, '随后查询应读到原样保存的新意见并排最前');
  assert.ok(list[0].description.includes('😀'));
  assert.ok(list[0].scenario.includes('😮‍💨🌙'));
  assert.deepEqual(list.slice(1), baseline, '原有意见的顺序与内容不变');
  baseline = list;
  baselineDisk = readDisk();
});

test('整份 JSON 恰好 1000000 字节、chunked 且不预告总长度：201；多字节字符与 3 字节填充中文被拆到相邻段仍原样保存', async () => {
  const body = paddedBody(MAX_BODY_BYTES, true);
  const indexOf = (s: string): number => body.indexOf(Buffer.from(s, 'utf8'));
  const face = indexOf('😮');
  const zwj = body.indexOf(Buffer.from([0xe2, 0x80, 0x8d]), face);
  // 既有固定字段里的多字节拆字，也有任意位置落在填充中文 UTF-8 序列中间的切分
  const cuts = [
    indexOf('边') + 2,
    indexOf('😀') + 1,
    face + 2,
    zwj + 2,
    indexOf('💨') + 1,
    333334,
    765432,
  ];
  const res = await rawPost({ pieces: cutAt(body, cuts), chunked: true, delayMs: 1 });
  assert.equal(res.status, 201);
  const saved = res.json.idea as Idea;
  assert.equal(saved.title, FIELDS.title);
  assert.equal(saved.description, FIELDS.description);
  assert.equal(saved.scenario, FIELDS.scenario);

  const list = await listIdeas();
  assert.equal(list.length, baseline.length + 1);
  assert.deepEqual(list[0], saved);
  assert.deepEqual(list.slice(1), baseline);
  baseline = list;
  baselineDisk = readDisk();
});

test('999999 字节的合法 JSON 同样接受：边界不是四舍五入而是严格大于', async () => {
  const body = paddedBody(MAX_BODY_BYTES - 1);
  const res = await rawPost({ pieces: cutAt(body, [250000, 500000, 750000]) });
  assert.equal(res.status, 201);
  const list = await listIdeas();
  assert.equal(list.length, baseline.length + 1);
  assert.deepEqual(list[0], res.json.idea as Idea);
  assert.deepEqual(list.slice(1), baseline);
  baseline = list;
  baselineDisk = readDisk();
});

test('大小边界处的格式判定：恰好 1000000 字节的非法 JSON 报现有 JSON 错误，不误报“请求体过大”', async () => {
  const body = malformedBody(MAX_BODY_BYTES);
  const res = await rawPost({ pieces: cutAt(body, [400000, 800000]) });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, '请求体不是有效的 JSON');
  assert.ok(!('idea' in (res.json ?? {})));
  assert.deepEqual(await listIdeas(), baseline);
});

test('未超限的非法 JSON（远小于上限）继续返回现有的格式错误', async () => {
  const res = await rawPost({ pieces: [Buffer.from('{bad json', 'utf8')] });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, '请求体不是有效的 JSON');
  assert.deepEqual(await listIdeas(), baseline);
});

test('超过一个字节（Content-Length 明确声明 1000001）：400“请求体过大”，慢速发完正文并等待仍收到完整可解析响应', async () => {
  // 正文本身是合法 JSON，拒绝只能来自整份大小
  const body = paddedBody(MAX_BODY_BYTES + 1);
  const pieces = cutAt(body, [100000, 300000, 600000, 900000]);
  const res = await rawPost({ pieces, chunked: false, delayMs: 5 });
  assert.equal(res.status, 400);
  assert.match(res.headers['content-type'] ?? '', /application\/json/);
  assert.deepEqual(res.json, { error: '请求体过大' });
  assert.ok(!('idea' in res.json), '响应不能带表示保存成功的 idea');

  const list = await listIdeas();
  assert.deepEqual(list, baseline);
  assert.deepEqual(readDisk(), baselineDisk, '不能保存已收到的前缀或截断记录');
  assert.ok(!existsSync(`${ideasFile()}.tmp`), '不能残留 .tmp 临时文件');
});

test('整份 1000001 字节但字符数远少于 1000000（3 字节中文填充）：仍按字节拒绝，证明不是按字符计数', async () => {
  const body = paddedBody(MAX_BODY_BYTES + 1, true);
  assert.ok(body.toString('utf8').length < MAX_BODY_BYTES, '该正文的 JS 字符数应低于 100 万');
  const res = await rawPost({ pieces: cutAt(body, [333333, 666666]), chunked: false });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: '请求体过大' });
  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readDisk(), baselineDisk);
});

test('字段名、引号、括号外的字段外空白也计入字节：合法 JSON 仅靠空白超过一个字节仍拒绝', async () => {
  const body = whitespaceBody(MAX_BODY_BYTES + 1);
  // 对照：去掉一个空白字节即为合法且未超限的请求（下一条用例前先确认对照体本身可被接受）
  const within = whitespaceBody(MAX_BODY_BYTES);
  const ok = await rawPost({ pieces: cutAt(within, [500000]) });
  assert.equal(ok.status, 201);
  const listAfterOk = await listIdeas();
  baseline = listAfterOk;
  baselineDisk = readDisk();

  const res = await rawPost({ pieces: cutAt(body, [500000]), chunked: true });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: '请求体过大' });
  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readDisk(), baselineDisk);
});

test('chunked 超限发生在中途：单段都只有十几万字、超限后还有一整段，仍拒绝整次提交', async () => {
  // 正文同时不是合法 JSON：超限理由不能被格式错误覆盖。
  // 整份做成 1200000 字节、每段 180000：累计在第 6 段中途越过 1000000，
  // 越过之后还剩一整段约 12 万字节——若实现只在最后才比较大小就会漏掉这种中途超限
  const body = malformedBody(1_200_000);
  const pieces: Buffer[] = [];
  const step = 180000;
  for (let offset = 0; offset < body.length; offset += step) {
    pieces.push(body.subarray(offset, Math.min(offset + step, body.length)));
  }
  assert.equal(pieces.length, 7);
  assert.ok(pieces.slice(0, 5).reduce((s, p) => s + p.length, 0) < MAX_BODY_BYTES);
  const res = await rawPost({ pieces, chunked: true, delayMs: 2 });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: '请求体过大' });
  assert.ok(res.rawBody.length > 0, '应收到完整响应体而不是连接断开');
  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readDisk(), baselineDisk);
});

test('chunked 超限直到最后一段才发生：前面的字节本身已是一份完整合法意见，也不能提前接受', async () => {
  const prefix = Buffer.from(JSON.stringify(FIELDS), 'utf8');
  JSON.parse(prefix.toString('utf8')); // 前缀自身就是一份完整、合法、字段合规的意见
  const restLength = MAX_BODY_BYTES + 1 - prefix.length;
  const rest = Buffer.concat([
    Buffer.from(' '.repeat(restLength - 1), 'ascii'),
    Buffer.from('x', 'ascii'),
  ]);
  assert.equal(prefix.length + rest.length, MAX_BODY_BYTES + 1);
  // 每段都不大（100000 字节），越过上限发生在最后一段
  const tailPieces: Buffer[] = [];
  for (let offset = 0; offset < rest.length; offset += 100000) {
    tailPieces.push(rest.subarray(offset, Math.min(offset + 100000, rest.length)));
  }
  const res = await rawPost({ pieces: [prefix, ...tailPieces], chunked: true, delayMs: 2 });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: '请求体过大' });

  const list = await listIdeas();
  assert.deepEqual(list, baseline, '前缀那份“完整意见”绝不能被单独保存');
  assert.deepEqual(readDisk(), baselineDisk);
});

test('chunked 每段都很小（4096 字节）也不能放过：累计超限照样拒绝', async () => {
  const body = paddedBody(MAX_BODY_BYTES + 1);
  const pieces: Buffer[] = [];
  for (let offset = 0; offset < body.length; offset += 4096) {
    pieces.push(body.subarray(offset, Math.min(offset + 4096, body.length)));
  }
  assert.ok(pieces.every((piece) => piece.length <= 4096));
  const res = await rawPost({ pieces, chunked: true });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: '请求体过大' });
  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readDisk(), baselineDisk);
});

test('超限 + JSON 格式错误（Content-Length 声明 1000001）：仍报告“请求体过大”，不被格式错误覆盖', async () => {
  const body = malformedBody(MAX_BODY_BYTES + 1);
  const res = await rawPost({ pieces: cutAt(body, [200000, 400000, 600000, 800000]), chunked: false, delayMs: 3 });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: '请求体过大' });
  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readDisk(), baselineDisk);
});

test('字符上限与字节上限互不混淆：字段按码点超限（正文仅几百字节）报字段错误，不是“请求体过大”', async () => {
  const payload = {
    title: '中'.repeat(121), // 121 个码点、363 字节：触发标题字符上限
    description: '说明',
  };
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  assert.ok(raw.length < 1000);
  const res = await rawPost({ pieces: [raw] });
  assert.equal(res.status, 400);
  assert.match(String(res.json.error), /标题/);
  assert.ok(!String(res.json.error).includes('请求体过大'));
  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readDisk(), baselineDisk);
});

test('全部拒绝尝试后：原有意见的数量、顺序、id、createdAt 与文字逐字保留', async () => {
  const list = await listIdeas();
  assert.deepEqual(list, baseline);
  assert.deepEqual(readDisk(), baselineDisk);
  assert.ok(!existsSync(`${ideasFile()}.tmp`));

  // 原有内容中的空白、换行、中文、表情原样保留
  const first = list[list.length - 1]; // 最早种入的“原有意见 甲”
  assert.equal(first.title, '原有意见 甲');
  assert.equal(first.description, '第一行\n第二行 含中文 与 😀\n  保留首尾空格  ');
  assert.equal(first.scenario, '场景甲 🌙');

  // 同标题但标识不同的两条仍分别保留，id 与提交时间没有重新生成
  const sameTitle = list.filter((idea) => idea.title === '同标题不同标识');
  assert.equal(sameTitle.length, 2);
  assert.notEqual(sameTitle[0].id, sameTitle[1].id);
  for (const idea of sameTitle) {
    assert.ok(baseline.some((old) => old.id === idea.id && old.createdAt === idea.createdAt));
  }
});
