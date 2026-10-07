import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, removeDataDir, type StartedServer } from '../testing/server.ts';

// POST /api/ideas 请求体编码（UTF-8）的端到端回归：真实起一份 server.ts，
// 只访问公开的 POST/GET /api/ideas。这里保护的是「提交入口只接受能完整按 UTF-8
// 解码的请求正文」——不能靠替换（坏字节变成“�”）、删去坏字节或只保存正常片段完成提交：
//   - 完整送达、未超 1000000 字节上限但含非法 UTF-8 的正文一律 400，
//     error 为“请求体不是有效的 UTF-8”，响应不带 idea，也不新增意见；
//     非法字节出现在标题、详细说明、使用场景还是正文其他位置（字段外）都按整次提交失败；
//   - 关键回归：坏字节被替换成“�”后若仍是合法 JSON、字段也通过校验，旧行为会误判 201
//     保存被改写的原文；现在必须拒绝；
//   - 非法形态覆盖：单独出现的续字节、缺少后续字节的多字节字符、overlong 编码、
//     UTF-16 代理区编码、FE/FF 等永不合法的字节；
//   - 合法字符在传输中被拆到相邻 TCP 段/分块（中文、表情的 UTF-8 字节分开到达）
//     不是编码损坏：整份正文完整且编码有效时，预先声明 Content-Length 与
//     Transfer-Encoding: chunked 结果相同，都返回 201 并逐字保存；
//   - 用户原本输入、以合法 UTF-8（EF BF BD）编码的“�”(U+FFFD) 是正常文字：
//     不拒绝、不替换，标题/说明/场景仍按原有空白处理与码点上限判断；
//   - 错误先后关系保持：正文超过 1000000 字节（即使同时含非法编码）仍报“请求体过大”；
//     未超限、编码有效但 JSON 格式错误仍报现有 JSON 错误；字段缺失或内容不合要求仍报字段错误。
// 用原始 TCP 而不是 fetch：要刻意把一个多字节字符的 UTF-8 字节拆到相邻两次写入，
// 也要精确控制正文里的非法字节，fetch 的 body 编码会把字符串重新按 UTF-8 编码。

const MAX_BODY_BYTES = 1_000_000;
const FFFD = Buffer.from([0xef, 0xbf, 0xbd]); // “�” U+FFFD 的合法 UTF-8 编码

interface Idea {
  id: string;
  title: string;
  description: string;
  scenario: string;
  createdAt: string;
}

let server: StartedServer;

before(async () => {
  server = await startServer();
});

after(async () => {
  await server.stop();
  removeDataDir(server);
});

function ideasFile(): string {
  return join(server.dataDir, 'ideas.json');
}

async function listIdeas(): Promise<Idea[]> {
  const res = await fetch(`${server.origin}/api/ideas`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.ideas));
  return data.ideas as Idea[];
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

interface RawResponse {
  status: number;
  rawBody: Buffer;
  json: any;
}

interface RawOptions {
  // 原始正文的字节序列（不含 chunked 帧头）；按数组元素逐次写入
  pieces: Buffer[];
  chunked?: boolean;
  delayMs?: number;
}

// 直接走原始 TCP 发送，按 pieces 逐段写入：调用方可以让一段恰好结束在多字节字符的
// UTF-8 序列中间，也可以在正文里放入任意原始字节（包括非法 UTF-8）。
function rawPost({ pieces, chunked = false, delayMs = 2 }: RawOptions): Promise<RawResponse> {
  const port = Number(new URL(server.origin).port);
  const totalBytes = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const headLines = [
    'POST /api/ideas HTTP/1.1',
    'Host: 127.0.0.1',
    'Content-Type: application/json',
    'Connection: close',
    chunked ? 'Transfer-Encoding: chunked' : `Content-Length: ${totalBytes}`,
  ];
  return new Promise<RawResponse>((resolve, reject) => {
    const sock: Socket = connect(port, '127.0.0.1');
    let received = Buffer.alloc(0);
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(error);
    };
    sock.on('error', (error) => fail(error));
    sock.on('data', (chunk) => {
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
      const declared = Number(headers['content-length']);
      if (Number.isFinite(declared)) {
        assert.equal(rawBody.length, declared, '响应正文应与 content-length 等长');
      }
      let json: any;
      try {
        json = JSON.parse(rawBody.toString('utf8'));
      } catch {
        json = undefined;
      }
      settled = true;
      resolve({ status, rawBody, json });
    });
    sock.on('connect', async () => {
      try {
        await write(sock, headLines.join('\r\n') + '\r\n\r\n');
        for (let i = 0; i < pieces.length; i++) {
          if (i > 0 && delayMs > 0) await sleep(delayMs);
          const piece = pieces[i];
          if (chunked) await write(sock, Buffer.from(`${piece.length.toString(16)}\r\n`, 'ascii'));
          await write(sock, piece);
          if (chunked) await write(sock, Buffer.from('\r\n', 'ascii'));
        }
        if (chunked) await write(sock, Buffer.from('0\r\n\r\n', 'ascii'));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function quote(value: Buffer): Buffer {
  return Buffer.concat([Buffer.from('"'), value, Buffer.from('"')]);
}

// 构造一份三个字段都存在的意见 JSON，把坏字节序列 bad 插入指定字段的普通文字中间，
// 其余字段为合法 ASCII。坏字节若被旧实现替换成“�”，整份仍是合法 JSON
// （“abc<bad>def” -> “abc�def”，非空白、长度合规）——正是被误判为成功保存的原 bug 形态。
function bodyWithBadField(badField: 'title' | 'description' | 'scenario', bad: Buffer): Buffer {
  const value = (field: string): Buffer =>
    field === badField ? Buffer.concat([Buffer.from('abc'), bad, Buffer.from('def')]) : Buffer.from('ok');
  return Buffer.concat([
    Buffer.from('{"title":'),
    quote(value('title')),
    Buffer.from(',"description":'),
    quote(value('description')),
    Buffer.from(',"scenario":'),
    quote(value('scenario')),
    Buffer.from('}'),
  ]);
}

// 各种不符合 UTF-8 规则的字节形态，覆盖题目点名的全部类别
const BAD_SEQUENCES: { name: string; bytes: Buffer }[] = [
  { name: '单独出现的续字节 0x80', bytes: Buffer.from([0x80]) },
  { name: '两个连续的孤立续字节 0x90 0x80', bytes: Buffer.from([0x90, 0x80]) },
  { name: '3 字节序列缺少最后一个续字节（E4 B8）', bytes: Buffer.from([0xe4, 0xb8]) },
  { name: '3 字节序列缺少两个续字节（E4 结尾）', bytes: Buffer.from([0xe4]) },
  { name: '4 字节序列缺少后续字节（F0 9F 98）', bytes: Buffer.from([0xf0, 0x9f, 0x98]) },
  { name: '4 字节起始字节后直接结束（F0）', bytes: Buffer.from([0xf0]) },
  { name: 'overlong 编码（C0 AF，本应是单字节 /）', bytes: Buffer.from([0xc0, 0xaf]) },
  { name: 'overlong 编码（E0 80 80，本应是 NUL）', bytes: Buffer.from([0xe0, 0x80, 0x80]) },
  { name: 'UTF-16 代理区编码（ED A0 80，U+D800）', bytes: Buffer.from([0xed, 0xa0, 0x80]) },
  { name: '4 字节序列超出 Unicode 范围（F4 90 80 80）', bytes: Buffer.from([0xf4, 0x90, 0x80, 0x80]) },
  { name: '永不合法的 FE', bytes: Buffer.from([0xfe]) },
  { name: '永不合法的 FF', bytes: Buffer.from([0xff]) },
];

// 先种入几条原有意见：含首尾/内部空白、换行、中文、表情，以及同标题不同 id 的两条。
// 所有被拒绝的请求都要证明这些记录逐字不变、不新增任何意见。
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
  baselineDisk = readFileSync(ideasFile());
});

test('坏字节在标题中：各种非法 UTF-8 形态完整送达且未超限，一律 400“请求体不是有效的 UTF-8”，不保存', async () => {
  for (const { name, bytes } of BAD_SEQUENCES) {
    const body = bodyWithBadField('title', bytes);
    assert.ok(body.length <= MAX_BODY_BYTES, `${name} 的用例正文不应超过大小上限`);
    const res = await rawPost({ pieces: [body] });
    assert.equal(res.status, 400, `${name}：应拒绝整次提交`);
    assert.deepEqual(res.json, { error: '请求体不是有效的 UTF-8' }, `${name}：错误说明必须是 UTF-8 编码错误`);
    assert.ok(!('idea' in (res.json ?? {})), `${name}：响应不能带表示保存成功的 idea`);
    assert.deepEqual(await listIdeas(), baseline, `${name}：不能新增意见，已有意见也不能变化`);
    assert.deepEqual(readFileSync(ideasFile()), baselineDisk, `${name}：磁盘内容逐字节不变`);
    assert.ok(!existsSync(`${ideasFile()}.tmp`), `${name}：不能残留 .tmp`);
  }
});

test('坏字节在详细说明中（缺尾的多字节字符）：400 UTF-8 错误，不保存', async () => {
  const body = bodyWithBadField('description', Buffer.from([0xe4, 0xb8]));
  const res = await rawPost({ pieces: [body] });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: '请求体不是有效的 UTF-8' });
  assert.ok(!('idea' in (res.json ?? {})));
  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readFileSync(ideasFile()), baselineDisk);
});

test('坏字节在使用场景中（孤立续字节）：400 UTF-8 错误，不保存', async () => {
  const body = bodyWithBadField('scenario', Buffer.from([0x80]));
  const res = await rawPost({ pieces: [body] });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: '请求体不是有效的 UTF-8' });
  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readFileSync(ideasFile()), baselineDisk);
});

test('坏字节出现在正文的字段外位置（额外键名中）：同样整次提交失败', async () => {
  // {"title":"ok","description":"ok","scenario":"ok","a<0x80>":1}
  // 替换后仍是合法 JSON 且三个意见字段全部合规，旧实现会误判 201——必须按编码拒绝。
  const body = Buffer.concat([
    Buffer.from('{"title":"ok","description":"ok","scenario":"ok","a'),
    Buffer.from([0x80]),
    Buffer.from('":1}'),
  ]);
  const res = await rawPost({ pieces: [body] });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: '请求体不是有效的 UTF-8' });
  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readFileSync(ideasFile()), baselineDisk);
});

test('非法 UTF-8 同时会让“替换后的文字”不再是合法 JSON：仍先报 UTF-8 编码错误，不退化成 JSON 格式错误', async () => {
  // E4 后紧跟反斜杠 0x5C（不是续字节）：UTF-8 非法；替换视角下串内会出现 "\d 这样的
  // 非法转义，JSON 也解析不了。编码判定在 JSON 解析之前，错误必须是 UTF-8。
  const body = Buffer.concat([
    Buffer.from('{"title":"abc'),
    Buffer.from([0xe4, 0x5c]),
    Buffer.from('def","description":"ok"}'),
  ]);
  const res = await rawPost({ pieces: [body] });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: '请求体不是有效的 UTF-8' });
  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readFileSync(ideasFile()), baselineDisk);
});

test('非法字节本身跨在两个 TCP 段的边界上（段尾 E4、段头 80，缺续字节）：重组后仍判非法并拒绝', async () => {
  const body = bodyWithBadField('title', Buffer.from([0xe4, 0x80]));
  const cut = body.indexOf(Buffer.from([0xe4, 0x80]));
  assert.ok(cut > 0);
  // 第一段恰好结束在 E4 之后、0x80 之前——坏序列被拆到相邻两段
  const res = await rawPost({ pieces: cutAt(body, [cut + 1]), chunked: true, delayMs: 3 });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: '请求体不是有效的 UTF-8' });
  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readFileSync(ideasFile()), baselineDisk);
});

test('对照：合法 3 字节中文字节被拆在相邻两段（段尾 E4、段头 B8 AD）：不是损坏，正常保存', async () => {
  const payload = { title: '中', description: 'ok' };
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const cut = body.indexOf(Buffer.from('中', 'utf8')); // E4 B8 AD 的起点
  assert.deepEqual(body.subarray(cut, cut + 3), Buffer.from([0xe4, 0xb8, 0xad]));
  // 第一段只发出 E4，后两个字节在第二段开头
  const res = await rawPost({ pieces: cutAt(body, [cut + 1]), chunked: false, delayMs: 3 });
  assert.equal(res.status, 201, '合法字符跨段到达不能被误判为非法 UTF-8');
  const saved = res.json.idea as Idea;
  assert.equal(saved.title, '中');
  assert.equal(saved.description, 'ok');
  const list = await listIdeas();
  assert.equal(list.length, baseline.length + 1);
  assert.deepEqual(list[0], saved);
  assert.deepEqual(list.slice(1), baseline);
  baseline = list;
  baselineDisk = readFileSync(ideasFile());
});

test('中文、表情、ZWJ 表情的 UTF-8 字节被拆到相邻多段：预先声明 Content-Length 与 chunked 结果相同，都 201 且逐字保存', async () => {
  const payload = {
    title: '编码边界标题 中文',
    description: '详细说明含中文：边界。\n第二行 😀 保留',
    scenario: '使用场景 😮‍💨🌙 尾',
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const indexOf = (s: string): number => body.indexOf(Buffer.from(s, 'utf8'));
  const face = indexOf('😮');
  const zwj = body.indexOf(Buffer.from([0xe2, 0x80, 0x8d]), face);
  // 偏移落在：标题“码”(E7 A0 81) 第 1 字节后、说明“中”第 2 字节后、😀 第 2 字节后、
  // 😮 第 3 字节后、ZWJ 第 1 字节后、💨 第 2 字节后
  const cuts = [
    indexOf('码') + 1,
    indexOf('中') + 2,
    indexOf('😀') + 2,
    face + 3,
    zwj + 1,
    indexOf('💨') + 2,
  ];
  for (const chunked of [false, true]) {
    const res = await rawPost({ pieces: cutAt(body, cuts), chunked, delayMs: 1 });
    assert.equal(res.status, 201, `${chunked ? 'chunked' : 'Content-Length'}：合法正文拆段发送仍应成功`);
    const saved = res.json.idea as Idea;
    assert.equal(saved.title, payload.title);
    assert.equal(saved.description, payload.description);
    assert.equal(saved.scenario, payload.scenario);
    assert.ok(!saved.title.includes('�') && !saved.description.includes('�') && !saved.scenario.includes('�'));
    const list = await listIdeas();
    assert.equal(list.length, baseline.length + 1);
    assert.deepEqual(list[0], saved, '随后查询应读到逐字完整的新意见');
    assert.deepEqual(list.slice(1), baseline);
    baseline = list;
    baselineDisk = readFileSync(ideasFile());
  }
});

test('用户原本输入的“�”以合法 UTF-8（EF BF BD）编码：是正常文字，三个字段都逐字保存', async () => {
  const payload = {
    title: '标题含 � 字',
    description: '说明里也有 � 与换行\n第二行 �',
    scenario: '场景中的 � 保留',
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  // 确认正文里确实带着合法编码的 U+FFFD，而不是非法字节被替换后的产物
  assert.ok(body.includes(FFFD));
  for (const chunked of [false, true]) {
    const res = await rawPost({ pieces: cutAt(body, [10, body.indexOf(FFFD) + 1]), chunked, delayMs: 1 });
    assert.equal(res.status, 201, '合法编码的“�”不能仅凭该字符被拒绝或替换');
    const saved = res.json.idea as Idea;
    assert.equal(saved.title, payload.title);
    assert.equal(saved.description, payload.description);
    assert.equal(saved.scenario, payload.scenario);
    const list = await listIdeas();
    assert.equal(list.length, baseline.length + 1);
    assert.deepEqual(list[0], saved);
    assert.deepEqual(list.slice(1), baseline);
    baseline = list;
    baselineDisk = readFileSync(ideasFile());
  }
});

test('合法“�”按普通码点参与原有规则：标题首尾空白照常去除，恰好 120 个可提交、121 个仍是字段错误', async () => {
  // 标题是空白 + 一个合法“�” + 空白：trim 后保存为单个“�”，编码完全合法
  const trimmed = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '   �   ', description: 'd' }),
  }).then((r) => r.json());
  assert.equal(trimmed.idea.title, '�');

  const atLimit = await rawPost({
    pieces: [Buffer.from(JSON.stringify({ title: '�'.repeat(120), description: 'd' }), 'utf8')],
  });
  assert.equal(atLimit.status, 201, '120 个合法“�”码点恰好达到标题上限，应接受');

  const overLimit = await rawPost({
    pieces: [Buffer.from(JSON.stringify({ title: '�'.repeat(121), description: 'd' }), 'utf8')],
  });
  assert.equal(overLimit.status, 400, '121 个“�”超过标题码点上限，仍按现有字段错误拒绝');
  assert.equal(overLimit.json.error, '标题最多 120 个字符');
  assert.ok(!('idea' in overLimit.json));

  // 上面只有两条成功（trimmed 与 atLimit）
  const list = await listIdeas();
  assert.equal(list.length, baseline.length + 2);
  baseline = list;
  baselineDisk = readFileSync(ideasFile());
});

test('正文超过 1000000 字节且同时含非法 UTF-8：仍报“请求体过大”，大小判定优先于编码判定', async () => {
  // 一份 1000001 字节的合法 JSON 填充体，把填充中间的一个 ASCII 字节原地换成孤立续字节
  // 0x80（长度不变）：既超限又含非法编码，错误必须仍是“请求体过大”。
  const base = JSON.stringify({ title: 'ok', description: 'ok', padding: '' });
  const need = MAX_BODY_BYTES + 1 - Buffer.byteLength(base, 'utf8');
  assert.ok(need > 0);
  const body = Buffer.from(JSON.stringify({ title: 'ok', description: 'ok', padding: 'x'.repeat(need) }), 'utf8');
  assert.equal(body.length, MAX_BODY_BYTES + 1);
  body[500000] = 0x80;
  const res = await rawPost({ pieces: cutAt(body, [200000, 800000]), chunked: false, delayMs: 1 });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: '请求体过大' });
  assert.ok(!('idea' in res.json));
  assert.ok(res.rawBody.length > 0, '应收到完整响应体而不是连接断开');
  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readFileSync(ideasFile()), baselineDisk);
  assert.ok(!existsSync(`${ideasFile()}.tmp`));
});

test('未超限、UTF-8 编码有效但 JSON 格式错误：仍返回现有的 JSON 格式错误', async () => {
  const body = Buffer.from('{这不是 json', 'utf8');
  assert.ok(body.length <= MAX_BODY_BYTES);
  const res = await rawPost({ pieces: [body] });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: '请求体不是有效的 JSON' });
  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readFileSync(ideasFile()), baselineDisk);
});

test('编码有效、JSON 合法但字段缺失或内容不合要求：仍按现有结构/字段错误拒绝', async () => {
  const missingTitle = await rawPost({ pieces: [Buffer.from(JSON.stringify({ description: 'd' }), 'utf8')] });
  assert.equal(missingTitle.status, 400);
  assert.equal(missingTitle.json.error, '缺少必填字段 title');

  const blankTitle = await rawPost({
    pieces: [Buffer.from(JSON.stringify({ title: '   ', description: 'd' }), 'utf8')],
  });
  assert.equal(blankTitle.status, 400);
  assert.equal(blankTitle.json.error, '标题去掉首尾空白后不能为空');

  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readFileSync(ideasFile()), baselineDisk);
});

test('全部编码拒绝尝试后：原有意见的数量、顺序、id、createdAt 与文字逐字保留，再提交合法意见仍正常', async () => {
  const list = await listIdeas();
  assert.deepEqual(list, baseline);
  assert.deepEqual(readFileSync(ideasFile()), baselineDisk);
  assert.ok(!existsSync(`${ideasFile()}.tmp`));

  // 原有内容中的空白、换行、中文、表情原样保留
  const first = list[list.length - 1]; // 最早种入的“原有意见 甲”
  assert.equal(first.title, '原有意见 甲');
  assert.equal(first.description, '第一行\n第二行 含中文 与 😀\n  保留首尾空格  ');
  assert.equal(first.scenario, '场景甲 🌙');
  const sameTitle = list.filter((idea) => idea.title === '同标题不同标识');
  assert.equal(sameTitle.length, 2);
  assert.notEqual(sameTitle[0].id, sameTitle[1].id);

  // 服务在一系列编码拒绝后继续可用：首页与列表读取方式不变，合法提交照常 201
  const home = await fetch(`${server.origin}/`);
  assert.equal(home.status, 200);
  const res = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '最后的正常意见', description: '编码拒绝后仍可提交', scenario: '夜间 😴' }),
  });
  assert.equal(res.status, 201);
  const saved = (await res.json()).idea as Idea;
  assert.equal(saved.title, '最后的正常意见');
  assert.equal(saved.scenario, '夜间 😴');
  const after = await listIdeas();
  assert.equal(after.length, list.length + 1);
  assert.deepEqual(after[0], saved);
  assert.deepEqual(after.slice(1), list, '已有记录保持原来的内容与排列');
});
