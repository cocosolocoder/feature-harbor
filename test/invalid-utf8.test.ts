import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, removeDataDir, type StartedServer } from '../testing/server.ts';

// POST /api/ideas 只接受能完整按 UTF-8 解码的请求正文的端到端回归。
// Buffer.toString('utf8') 会把非法字节静默替换成“�”：替换后若仍是合法 JSON 且字段
// 通过校验，旧实现会返回 201 并保存被改写的原文。这里真实起服务、走公开接口与原始
// TCP 连接（fetch 无法发送任意非法字节，也无法把多字节字符拆到相邻写入），保护：
//   - 已完整送达且未超 1000000 字节的正文含非法 UTF-8 时：400、error 为
//     “请求体不是有效的 UTF-8”，不带 idea、不新增意见；非法字节出现在标题、说明、
//     场景、额外字段还是字段外空白，都按整次提交失败；
//   - 覆盖单独的续字节、缺少后续字节的多字节字符、过长编码、代理区编码等非法形态，
//     包括“替换成 � 后恰好仍是合法 JSON、字段也合规”这种旧实现会误收的情况；
//   - 用户自己输入的“�”以合法 UTF-8（EF BF BD）编码时是普通文字，不能拒绝或替换；
//   - 合法多字节字符的字节被拆到相邻段（Content-Length 与 chunked 两种）不影响结果：
//     整份完整且编码有效就返回 201 并逐字保存，与一次性发送相同；
//   - 错误先后关系不变：超 1000000 字节（即使同时含非法编码）仍是“请求体过大”；
//     未超限、UTF-8 合法但 JSON 非法仍是现有的 JSON 格式错误；字段问题仍报字段错误；
//   - 每次失败后已有意见的数量、顺序、id、createdAt 与文字逐字保留，磁盘不残留 .tmp。

const MAX_BODY_BYTES = 1_000_000;

interface Idea {
  id: string;
  title: string;
  description: string;
  scenario: string;
  createdAt: string;
}

const FIELDS = {
  title: '编码边界标题 边界',
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

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  rawBody: Buffer;
  json: any;
}

interface RawOptions {
  pieces: Buffer[];
  chunked?: boolean;
  delayMs?: number;
}

// 直接走原始 TCP：fetch 既不能发送 0xFF 这类非法字节，也不能控制多字节字符跨段拆分。
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
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(error);
    };
    sock.on('error', (error) => fail(error));
    sock.on('data', (chunk) => { received = Buffer.concat([received, chunk]); });
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
      resolve({ status, headers, rawBody, json });
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

function write(sock: Socket, data: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    sock.write(data, (error) => (error ? reject(error) : resolve()));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// 把字段拼成合法 JSON 后，在指定 JSON 子串处写入一个非法字节（默认在该子串内部）。
// 关键场景：非法字节位于字符串内部时，替换成“�”后整份仍是合法 JSON 且字段合规，
// 旧实现会误回 201。
function bodyWithBadByte(field: 'title' | 'description' | 'scenario', bad: number[]): Buffer {
  const body = Buffer.from(JSON.stringify(FIELDS), 'utf8');
  const marker = Buffer.from(`"${field}":"`, 'ascii');
  const at = body.indexOf(marker);
  assert.notEqual(at, -1);
  const insertAt = at + marker.length;
  return Buffer.concat([body.subarray(0, insertAt), Buffer.from(bad), body.subarray(insertAt)]);
}

let baseline: Idea[];
let baselineDisk: Buffer;

test('准备：种入原有意见并记录磁盘基线', async () => {
  const seeds = [
    {
      title: '  原有意见 甲 ',
      description: '第一行\n第二行 含中文 与 😀\n  保留首尾空格  ',
      scenario: '场景甲 🌙',
    },
    { title: '同标题不同标识', description: '第一条同标题', scenario: '' },
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
  assert.equal(baseline.length, 2);
  baselineDisk = readDisk();
});

const BAD_CASES: Array<{ name: string; body: () => Buffer }> = [
  // 字符串内部：替换成“�”后恰好仍是合法 JSON、字段也合规——旧实现会保存被改写原文的核心场景
  { name: '标题中的单独续字节 0x80', body: () => bodyWithBadByte('title', [0x80]) },
  { name: '详细说明中的非法前导字节 0xFF', body: () => bodyWithBadByte('description', [0xff]) },
  { name: '使用场景中的单独续字节 0xBF', body: () => bodyWithBadByte('scenario', [0xbf]) },
  // 缺少后续字节的多字节字符
  { name: '标题中缺第 3 字节的 3 字节字符 E4 B8', body: () => bodyWithBadByte('title', [0xe4, 0xb8]) },
  { name: '说明中缺后续 3 字节的 4 字节字符 F0', body: () => bodyWithBadByte('description', [0xf0]) },
  { name: '场景中缺第 4 字节的 4 字节字符 F0 9F 98', body: () => bodyWithBadByte('scenario', [0xf0, 0x9f, 0x98]) },
  // 不符合 UTF-8 规则的编码
  { name: '标题中的过长编码 C0 AF', body: () => bodyWithBadByte('title', [0xc0, 0xaf]) },
  { name: '说明中的代理区编码 ED A0 80', body: () => bodyWithBadByte('description', [0xed, 0xa0, 0x80]) },
  { name: '场景中的超范围编码 F5 80 80 80', body: () => bodyWithBadByte('scenario', [0xf5, 0x80, 0x80, 0x80]) },
  // 正文的其他位置
  {
    name: '额外字段值中的非法字节（替换后 JSON 与意见字段都合法）',
    body: () => {
      const original = Buffer.from(JSON.stringify({ ...FIELDS, extra: 'x' }), 'utf8');
      const marker = Buffer.from('"extra":"', 'ascii');
      const at = original.indexOf(marker) + marker.length;
      return Buffer.concat([original.subarray(0, at), Buffer.from([0x80]), original.subarray(at + 1)]);
    },
  },
  {
    name: '字段外空白位置的非法字节',
    body: () => {
      // 紧接开头 { 之后放一个续字节：UTF-8 层面先失败，不会落到 JSON 解析
      return Buffer.concat([Buffer.from('{', 'ascii'), Buffer.from([0x80]), Buffer.from(JSON.stringify(FIELDS).slice(1), 'utf8')]);
    },
  },
  {
    name: '正文末尾的孤立前导字节 C2',
    body: () => {
      const text = JSON.stringify(FIELDS);
      return Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0xc2])]);
    },
  },
];

for (const c of BAD_CASES) {
  test(`非法 UTF-8（${c.name}）：400“请求体不是有效的 UTF-8”，不带 idea、不入库`, async () => {
    const body = c.body();
    assert.ok(body.length <= MAX_BODY_BYTES, '用例正文必须在大小上限之内，保证拒绝只来自编码');
    const res = await rawPost({ pieces: [body] });
    assert.equal(res.status, 400);
    assert.match(res.headers['content-type'] ?? '', /application\/json/);
    assert.deepEqual(res.json, { error: '请求体不是有效的 UTF-8' });
    assert.ok(!('idea' in (res.json ?? {})), '响应不能带表示保存成功的 idea');

    const list = await listIdeas();
    assert.deepEqual(list, baseline, '非法编码提交不能新增或改动任何意见');
    assert.deepEqual(readDisk(), baselineDisk, '磁盘内容必须与请求前逐字节一致');
    assert.ok(!existsSync(`${ideasFile()}.tmp`), '不能残留 .tmp 临时文件');
  });
}

test('非法 UTF-8 字节被慢速拆成多段送达（Content-Length）：整份完整后仍按编码失败', async () => {
  const body = bodyWithBadByte('description', [0xe4, 0xb8]);
  const res = await rawPost({ pieces: cutAt(body, [10, 40, 90, 160]), chunked: false, delayMs: 3 });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: '请求体不是有效的 UTF-8' });
  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readDisk(), baselineDisk);
});

test('非法 UTF-8 经 chunked 分段送达同样拒绝', async () => {
  const body = bodyWithBadByte('title', [0xff]);
  const res = await rawPost({ pieces: cutAt(body, [5, 30, body.length - 5]), chunked: true });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: '请求体不是有效的 UTF-8' });
  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readDisk(), baselineDisk);
});

test('错误先后：超过 1000000 字节且同时含非法编码，仍报“请求体过大”', async () => {
  // 合法填充正文凑到 1000001 字节，再把填充中的一个 ASCII 字节改成 0xFF：
  // 大小与编码同时不合法，理由必须仍是大小。
  const base = JSON.stringify({ ...FIELDS, padding: 'x'.repeat(1_000_001 - Buffer.byteLength(JSON.stringify({ ...FIELDS, padding: '' }), 'utf8')) });
  const body = Buffer.from(base, 'utf8');
  assert.equal(body.length, MAX_BODY_BYTES + 1);
  body[body.length - 3] = 0xff;
  const res = await rawPost({ pieces: cutAt(body, [250000, 600000, 900000]), delayMs: 1 });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: '请求体过大' });
  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readDisk(), baselineDisk);
});

test('未超限、UTF-8 合法但 JSON 格式错误：仍返回现有的 JSON 格式错误', async () => {
  const res = await rawPost({ pieces: [Buffer.from('{bad json', 'utf8')] });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: '请求体不是有效的 JSON' });
  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readDisk(), baselineDisk);
});

test('编码合法但字段不合要求：仍按现有字段错误拒绝（UTF-8 判定不抢先）', async () => {
  const body = Buffer.from(JSON.stringify({ title: '   ', description: '说明' }), 'utf8');
  const res = await rawPost({ pieces: [body] });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, '标题去掉首尾空白后不能为空');
  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readDisk(), baselineDisk);
});

test('用户输入的“�”以合法 UTF-8（EF BF BD）编码时是正常文字：201 并逐字保存，随后列表可读', async () => {
  const payload = {
    title: '  �标题含替换字符 ',
    description: '说明里也有 � 与中文',
    scenario: '场景里的 � 保留',
  };
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  // 确认正文中确实含合法的 EF BF BD 序列
  assert.ok(raw.includes(Buffer.from([0xef, 0xbf, 0xbd])));
  const res = await rawPost({ pieces: [raw] });
  assert.equal(res.status, 201);
  const saved = res.json.idea as Idea;
  assert.equal(saved.title, '�标题含替换字符');
  assert.equal(saved.description, '说明里也有 � 与中文');
  assert.equal(saved.scenario, '场景里的 � 保留');

  const list = await listIdeas();
  assert.equal(list.length, baseline.length + 1);
  assert.deepEqual(list[0], saved);
  assert.deepEqual(list.slice(1), baseline);
  baseline = list;
  baselineDisk = readDisk();
});

test('合法多字节字符的字节拆在相邻 TCP 写入（声明 Content-Length）：整份有效，201 逐字保存，与一次性发送相同', async () => {
  const body = Buffer.from(JSON.stringify(FIELDS), 'utf8');
  const indexOf = (s: string): number => body.indexOf(Buffer.from(s, 'utf8'));
  const face = indexOf('😮');
  const zwj = body.indexOf(Buffer.from([0xe2, 0x80, 0x8d]), face);
  // 切缝落在 3 字节中文第 1 字节后、4 字节表情第 2 字节后、ZWJ 第 2 字节后
  const cuts = [indexOf('边') + 1, indexOf('😀') + 2, face + 2, zwj + 1, indexOf('💨') + 2];
  const res = await rawPost({ pieces: cutAt(body, cuts), chunked: false, delayMs: 3 });
  assert.equal(res.status, 201);
  const saved = res.json.idea as Idea;
  assert.equal(saved.title, FIELDS.title);
  assert.equal(saved.description, FIELDS.description);
  assert.equal(saved.scenario, FIELDS.scenario);
  assert.ok(!saved.title.includes('�') && !saved.description.includes('�') && !saved.scenario.includes('�'));

  const list = await listIdeas();
  assert.equal(list.length, baseline.length + 1);
  assert.deepEqual(list[0], saved, '列表中应读到与发送内容逐字相同的意见');
  assert.deepEqual(list.slice(1), baseline);
  baseline = list;
  baselineDisk = readDisk();
});

test('同样的合法拆字经 chunked（不预告长度）发送：结果与预声明长度完全一致', async () => {
  const body = Buffer.from(JSON.stringify(FIELDS), 'utf8');
  const indexOf = (s: string): number => body.indexOf(Buffer.from(s, 'utf8'));
  const face = indexOf('😮');
  const zwj = body.indexOf(Buffer.from([0xe2, 0x80, 0x8d]), face);
  const cuts = [indexOf('边') + 2, indexOf('😀') + 1, face + 3, zwj + 2, indexOf('💨') + 1];
  const res = await rawPost({ pieces: cutAt(body, cuts), chunked: true, delayMs: 3 });
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

test('全部拒绝尝试后：原有意见的数量、顺序、id、createdAt 与文字逐字保留', async () => {
  const list = await listIdeas();
  assert.deepEqual(list, baseline);
  assert.deepEqual(readDisk(), baselineDisk);
  assert.ok(!existsSync(`${ideasFile()}.tmp`));

  const first = list[list.length - 1];
  assert.equal(first.title, '原有意见 甲');
  assert.equal(first.description, '第一行\n第二行 含中文 与 😀\n  保留首尾空格  ');
  assert.equal(first.scenario, '场景甲 🌙');
});
