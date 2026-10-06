import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, removeDataDir, type StartedServer } from '../testing/server.ts';

// POST /api/ideas 请求体整份字节上限（1_000_000）的端到端回归，保护现有行为：
//   - 大小按实际传输的 UTF-8 字节数累计：JSON 的字段名、括号、引号与字段外空白都计入，
//     中文（3 字节）、😀（4 字节）不能按一个字符当一个字节；
//   - 这与三个字段按 Unicode 码点的上限（120/5000/1000）是两套独立规则，不能混为一谈；
//   - 恰好 1_000_000 字节且 JSON 与字段都合法：201 并完整保存；多一个字节：400，
//     error 为“请求体过大”，响应不带表示保存成功的 idea；
//   - 同一判定适用于明确 Content-Length 与不预先声明总长度的 Transfer-Encoding: chunked，
//     超限发生在中途或最后一段都一样；前面已像一份完整意见也不能提前接受；
//   - 超限后客户端继续发完正文并等待，必须收到完整、可解析的 400，不能只看到断连；
//     正文同时有 JSON 格式问题时仍报“请求体过大”，不被格式错误覆盖；未超限的无效 JSON
//     继续返回现有的格式错误；
//   - 被拒绝的请求不改变原有意见的数量、顺序、id、createdAt 与文字，不留截断记录、
//     不保存已收到的前缀，也不在磁盘上留下 .tmp。
// 只走公开的 POST/GET /api/ideas（裸 TCP 精确控制分帧），并直接比对 ideas.json。
//
// 三个字段内容本身按码点上限最多约二十几 KB，所以 1MB 边界只能靠字段外空白凑出：
// 这本身也在守护两套限制互不串用。

const MAX_BODY_BYTES = 1_000_000;

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
  // 两条同标题、不同 id 的原有意见；文字含首尾/内部空白、换行、制表符、中文与表情，
  // 每次拒绝后都必须与这里逐字段、逐次序保持不变。
  await postJson({
    title: ' 重复 标题 ',
    description: '原有说明 A 第一行\n第二行\t😀 中文结尾 ',
    scenario: '场景 A',
  });
  await postJson({ title: '重复 标题', description: '同标题的另一条记录' });
});

after(async () => {
  await server.stop();
  removeDataDir(server);
});

async function postJson(body: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function listIdeas(): Promise<Idea[]> {
  const res = await fetch(`${server.origin}/api/ideas`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.ideas));
  return data.ideas as Idea[];
}

function ideasFilePath(): string {
  return join(server.dataDir, 'ideas.json');
}

interface Snapshot {
  list: Idea[];
  bytes: Buffer;
}

async function snapshot(): Promise<Snapshot> {
  return { list: await listIdeas(), bytes: readFileSync(ideasFilePath()) };
}

// 拒绝后逐项核对：数量、顺序、id、createdAt、全部文字（含空白换行中文表情）不变，
// ideas.json 逐字节不变，没有留下截断记录或 .tmp 临时文件。
async function assertNothingSaved(before: Snapshot, label: string): Promise<void> {
  const afterList = await listIdeas();
  assert.deepEqual(afterList, before.list, `${label}：拒绝后列表必须与拒绝前完全一致`);
  assert.ok(
    readFileSync(ideasFilePath()).equals(before.bytes),
    `${label}：拒绝后 ideas.json 必须与请求前逐字节一致`,
  );
  assert.ok(!existsSync(`${ideasFilePath()}.tmp`), `${label}：不能残留 .tmp 临时文件`);
}

interface RawResponse {
  status: number;
  headers: Map<string, string>;
  rawBody: Buffer;
  text: string;
  data: any;
  // 响应首字节是否在客户端把整个请求体（含 chunked 终止帧）写完之前就到达。
  // 正确实现必须先排空整个请求体、在请求正常结束后才响应；超限就提前 respond+destroy
  // 的实现会在这里露出马脚（客户端还没发完，400 已经到了）。
  earlyResponse: boolean;
  // 发送请求体期间连接是否被对端提前断开/重置（“继续发完正文”必须可行）。
  failedWhileSending: boolean;
}

// 裸 TCP 发一份 HTTP/1.1 请求：请求头与请求体分帧完全由测试控制
// （可明确给 Content-Length，也可用 Transfer-Encoding: chunked）。
// 客户端始终发完整个正文并保持连接等待，用 Connection: close 读到响应结束。
function rawRequest(
  headers: Record<string, string>,
  frames: Buffer[],
  frameDelayMs = 5,
): Promise<RawResponse> {
  const target = new URL(server.origin);
  const head = Object.entries({
    Host: target.host,
    Connection: 'close',
    ...headers,
  })
    .map(([name, value]) => `${name}: ${value}`)
    .join('\r\n');

  return new Promise((resolve, reject) => {
    let sending = true;
    let earlyResponse = false;
    let failedWhileSending = false;
    const socket: Socket = connect(
      { host: target.hostname, port: Number(target.port) },
      async () => {
        socket.write(`POST /api/ideas HTTP/1.1\r\n${head}\r\n\r\n`);
        try {
          for (let i = 0; i < frames.length; i++) {
            // 延迟只放在帧与帧之间：最后一帧写完后到 sending 翻转为同步执行，
            // 服务端在请求结束后的响应必然落在后续事件循环，不会被误判为提前响应；
            // 而超限即提前回复的实现，其响应会在两帧之间的等待期间到达。
            if (i > 0 && frameDelayMs > 0) {
              await new Promise((r) => setTimeout(r, frameDelayMs));
            }
            if (!socket.write(frames[i])) {
              await new Promise<void>((drain) => socket.once('drain', drain));
            }
          }
        } catch (error) {
          reject(error);
          return;
        }
        // 同步翻转：后续 data 事件触发时发送必然已结束，
        // 因此该标志为 true 只可能是响应在请求发完之前到达。
        sending = false;
      },
    );
    socket.setTimeout(30_000, () => {
      socket.destroy(new Error('raw request timed out'));
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => {
      if (sending) earlyResponse = true;
      chunks.push(chunk);
    });
    socket.on('error', (error) => {
      if (sending) {
        // 还在发请求体就被断开/重置：客户端无法“继续发完正文并等待”，属于被保护的回归
        failedWhileSending = true;
        sending = false;
        reject(error);
        return;
      }
      reject(error);
    });
    socket.on('end', () => {
      const raw = Buffer.concat(chunks);
      const split = raw.indexOf('\r\n\r\n');
      assert.notEqual(split, -1, '必须收到完整响应头，不能只看到连接断开');
      const headText = raw.subarray(0, split).toString('utf8');
      const lines = headText.split('\r\n');
      const status = Number(lines[0].split(' ')[1]);
      const responseHeaders = new Map<string, string>();
      for (const line of lines.slice(1)) {
        const at = line.indexOf(':');
        responseHeaders.set(line.slice(0, at).toLowerCase(), line.slice(at + 1).trim());
      }
      const rawBody = raw.subarray(split + 4);
      const declared = responseHeaders.get('content-length');
      assert.ok(declared, '响应必须带 content-length，证明错误响应完整到达');
      assert.equal(
        rawBody.length,
        Number(declared),
        '响应体必须按 content-length 完整接收，不能被截断或只看到连接断开',
      );
      const text = rawBody.toString('utf8');
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
      resolve({ status, headers: responseHeaders, rawBody, text, data, earlyResponse, failedWhileSending });
    });
  });
}

async function sendWithContentLength(
  body: Buffer,
  splitOffsets?: number[],
  frameDelayMs = 0,
): Promise<RawResponse> {
  const frames = splitOffsets ? splitAt(body, splitOffsets) : [body];
  return rawRequest(
    {
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
    },
    frames,
    frameDelayMs,
  );
}

// chunked 分帧：每段 Buffer 编成一个 chunk，末帧由调用方在 frames 末尾放 terminator。
function chunkFrame(payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${payload.length.toString(16)}\r\n`),
    payload,
    Buffer.from('\r\n'),
  ]);
}

const CHUNKED_TERMINATOR = Buffer.from('0\r\n\r\n');

async function sendChunked(parts: Buffer[], frameDelayMs = 5): Promise<RawResponse> {
  const frames = parts.map(chunkFrame);
  frames.push(CHUNKED_TERMINATOR);
  return rawRequest(
    { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
    frames,
    frameDelayMs,
  );
}

// 按给定绝对偏移把 Buffer 切成多段（偏移可以落在多字节字符的 UTF-8 字节中间）。
function splitAt(body: Buffer, offsets: number[]): Buffer[] {
  const points = [...new Set(offsets)].filter((n) => n > 0 && n < body.length).sort((a, b) => a - b);
  const parts: Buffer[] = [];
  let start = 0;
  for (const point of points) {
    parts.push(body.subarray(start, point));
    start = point;
  }
  parts.push(body.subarray(start));
  return parts;
}

interface ExactBody {
  body: Buffer;
  idea: { title: string; description: string; scenario: string };
}

// 构造正文恰好 target 字节、JSON 合法且三个字段都符合现有码点规则的请求体。
// 字段内容故意包含中文、😀、换行与空白；字段内容本身只有几十字节，
// 到 1MB 的差额全部放在最后一个字段外、闭合括号前的空白里（空白也是正文字节）。
function buildExactBody(target = MAX_BODY_BYTES): ExactBody {
  const title = '字节边界标题';
  const description = '边界😀说明\n第二行 中文与 emoji 混排 ' + 'A'.repeat(40);
  const scenario = '使用场景：夜间 🌙';
  const prefix =
    `{"title":${JSON.stringify(title)},"description":${JSON.stringify(description)},` +
    `"scenario":${JSON.stringify(scenario)}`;
  const suffix = '}';
  // 先放一个基础空白段，再按实际字节差精确补齐，保证整份正文恰好 target 字节。
  let padding = ' '.repeat(64);
  let body = `${prefix}${padding}${suffix}`;
  const delta = target - Buffer.byteLength(body, 'utf8');
  assert.ok(delta >= 0, '字段内容本身已超过目标字节数，无法用字段外空白构造边界');
  padding += ' '.repeat(delta);
  body = `${prefix}${padding}${suffix}`;
  const buf = Buffer.from(body, 'utf8');

  // 构造侧自查：字节数恰好、JSON 合法、字段规则通过（码点远低于上限）。
  assert.equal(buf.length, target);
  const parsed = JSON.parse(body);
  assert.equal(parsed.title, title);
  assert.equal(parsed.description, description);
  assert.equal(parsed.scenario, scenario);
  assert.ok(Array.from(title).length <= 120);
  assert.ok(Array.from(description).length <= 5000);
  assert.ok(Array.from(scenario).length <= 1000);
  return { body: buf, idea: { title, description, scenario } };
}

function assertTooLarge(response: RawResponse, label: string): void {
  assert.equal(response.status, 400, `${label}：必须返回 400`);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  assert.ok(response.data && typeof response.data === 'object', `${label}：响应必须是可解析 JSON`);
  assert.equal(response.data.error, '请求体过大', `${label}：error 必须是“请求体过大”`);
  assert.ok(!('idea' in response.data), `${label}：拒绝响应不能带表示保存成功的 idea`);
  // 客户端发完整个正文之前不能先收到响应、也不能在发送途中被断开：
  // 必须等整份请求体排空后才回完整 400，客户端“继续发完正文并等待”必须可行。
  assert.equal(response.failedWhileSending, false, `${label}：发送正文期间连接不能被提前断开`);
  assert.equal(response.earlyResponse, false, `${label}：必须读完整个请求体后才能响应，不能超限即提前回复`);
}

test('字节计数按 UTF-8 实际传输字节：边界构造自身的中文与表情按 3/4 字节计入', () => {
  const { body } = buildExactBody();
  assert.equal(Buffer.byteLength('中', 'utf8'), 3);
  assert.equal(Buffer.byteLength('😀', 'utf8'), 4);
  // 正文长度远大于所有字段按“一个字符一个字节”能凑出的量：
  // 字段码点合计不足 120+5000+1000，若把字段外空白或多字节算错，边界就不成立。
  assert.equal(body.length, MAX_BODY_BYTES);
});

test('明确 Content-Length：正文恰好 1000000 字节返回 201，完整保存且随后可读到原样新意见', async () => {
  const before = await snapshot();
  const { body, idea } = buildExactBody();

  const response = await sendWithContentLength(body);
  assert.equal(response.status, 201);
  assert.ok(response.data && typeof response.data === 'object');
  assert.ok(typeof response.data.idea?.id === 'string' && response.data.idea.id.length > 0);
  assert.equal(typeof response.data.idea.createdAt, 'string');
  assert.equal(response.data.idea.title, idea.title);
  assert.equal(response.data.idea.description, idea.description);
  assert.equal(response.data.idea.scenario, idea.scenario);

  const list = await listIdeas();
  assert.equal(list.length, before.list.length + 1);
  assert.deepEqual(list[0], response.data.idea);
  // 原有意见的顺序、标识、时间与文字逐条不变
  assert.deepEqual(list.slice(1), before.list);
});

test('明确 Content-Length：只多一个字节返回 400“请求体过大”，响应完整可解析且不带 idea', async () => {
  const before = await snapshot();
  // 在闭合括号前多塞一个空白：仍是合法 JSON，但整份正文 1000001 字节，必须按字节上限拒绝。
  const exact = buildExactBody().body;
  const over = Buffer.concat([exact.subarray(0, exact.length - 1), Buffer.from(' }', 'utf8')]);
  assert.equal(over.length, MAX_BODY_BYTES + 1);
  assert.doesNotThrow(() => JSON.parse(over.toString('utf8')), '用例自身仍是合法 JSON');

  // 分两帧：先到 1000000 字节（恰好上限），再到最后一个字节，两帧之间留出间隙。
  const response = await sendWithContentLength(over, [MAX_BODY_BYTES], 20);
  assertTooLarge(response, 'Content-Length 超一个字节');
  await assertNothingSaved(before, 'Content-Length 超一个字节');

  // 服务仍正常可用
  assert.deepEqual(await listIdeas(), before.list);
});

test('明确 Content-Length：超限发生在中途时仍读完后续正文才回完整 400，不能提前回复或断连', async () => {
  const before = await snapshot();
  // 比上限多 500 字节（闭合括号前补空白，仍是可解析的结构只是字节超限）。
  const exact = buildExactBody().body;
  const over = Buffer.concat([
    exact.subarray(0, exact.length - 1),
    Buffer.from(' '.repeat(500), 'utf8'),
    Buffer.from('}', 'utf8'),
  ]);
  assert.equal(over.length, MAX_BODY_BYTES + 500);

  // 第 2 帧结束时已越限（累计 1000200），第 3 帧还要再发 300 字节：
  // 超限即 respond+destroy 的实现会在第 2、3 帧之间暴露（提前收到响应或发送被断）。
  const response = await sendWithContentLength(over, [800_000, 1_000_200], 30);
  assertTooLarge(response, 'Content-Length 中途超限');
  await assertNothingSaved(before, 'Content-Length 中途超限');
});

test('典型客户端（fetch 自动声明 Content-Length）超限同样收到 400 与完整 JSON 错误', async () => {
  const before = await snapshot();
  const exact = buildExactBody().body;
  const over = Buffer.concat([exact, Buffer.from('X', 'utf8')]);
  assert.equal(over.length, MAX_BODY_BYTES + 1);

  const res = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: over,
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error, '请求体过大');
  assert.ok(!('idea' in data));
  await assertNothingSaved(before, 'fetch 超限');
});

test('chunked 不预先声明总长度：中文与表情在传输时被拆到相邻段，恰好 1000000 字节仍 201 且文字完整', async () => {
  const before = await snapshot();
  const { body, idea } = buildExactBody();

  // 刻意把切点落在 😀（4 字节）的第 2、3、4 个字节中间、“边”（3 字节）的字节中间，
  // 再加几个与 3/4 字节边界不对齐的固定切点，保证多字节字符被拆到相邻两段传输。
  const emoji = Buffer.from('😀', 'utf8');
  const chinese = Buffer.from('边', 'utf8');
  const emojiAt = body.indexOf(emoji);
  const chineseAt = body.indexOf(chinese);
  assert.ok(emojiAt > 0 && chineseAt > 0);
  const parts = splitAt(body, [
    1,
    chineseAt + 1, // 切进“边”的 UTF-8 字节中间
    emojiAt + 1, // 切进 😀 的第 2 个字节
    emojiAt + 2, // 切进第 3 个字节
    emojiAt + 3, // 切进第 4 个字节
    99_991,
    262_144,
    524_287,
    700_001,
    999_983,
  ]);
  assert.ok(parts.length >= 10);
  assert.equal(Buffer.concat(parts).length, body.length);

  const response = await sendChunked(parts, 2);
  assert.equal(response.status, 201, '跨段拆开的多字节字符必须在服务端正确重组');
  assert.equal(response.data.idea.title, idea.title);
  assert.equal(response.data.idea.description, idea.description);
  assert.equal(response.data.idea.scenario, idea.scenario);

  const saved = (await listIdeas())[0];
  assert.deepEqual(saved, response.data.idea);
  // 不能出现替换字符或丢字：逐码点比对原文。
  assert.ok(!saved.description.includes('�'), '保存结果不能出现 U+FFFD 替换字符');
  assert.equal(Array.from(saved.description).join(''), idea.description);
  assert.equal(saved.scenario, idea.scenario);
  assert.deepEqual((await listIdeas()).slice(1), before.list);
});

test('chunked 超限发生在中途：完整排空后才回 400，已收到的前缀不被保存', async () => {
  const before = await snapshot();
  // 合法 JSON、整份 1000001 字节（闭合括号前两个空白）。
  const exact = buildExactBody().body;
  const over = Buffer.concat([exact.subarray(0, exact.length - 1), Buffer.from(' }', 'utf8')]);
  assert.equal(over.length, MAX_BODY_BYTES + 1);

  // 切点让超限在第 3 段中途发生（累计 800000 -> 1000001），后面还有第 4 段要排空。
  const parts = splitAt(over, [400_000, 800_000, 1_000_000]);
  const response = await sendChunked(parts, 10);
  assertTooLarge(response, 'chunked 中途超限');
  await assertNothingSaved(before, 'chunked 中途超限');
});

test('chunked 超限直到最后一段才发生：不能因单段较小就接受', async () => {
  const before = await snapshot();
  const exact = buildExactBody().body;
  const over = Buffer.concat([exact.subarray(0, exact.length - 1), Buffer.from(' }', 'utf8')]);
  assert.equal(over.length, MAX_BODY_BYTES + 1);

  // 前两段合计 999999（每段都不大），最后一段 2 字节才越过上限。
  const parts = splitAt(over, [500_000, 999_999]);
  assert.deepEqual(parts.map((p) => p.length), [500_000, 499_999, 2]);
  const response = await sendChunked(parts, 10);
  assertTooLarge(response, 'chunked 末段超限');
  await assertNothingSaved(before, 'chunked 末段超限');
});

test('chunked 前缀已是一份完整的 1000000 字节意见：多收一个字节仍必须整体拒绝，不能提前接受', async () => {
  const before = await snapshot();
  const exact = buildExactBody().body;
  // 第一段承载完整、合法、恰好 1000000 字节的整份意见（chunked 尚未终止）；
  // 之后再追加一个不属于 JSON 的字节并结束请求。服务不能在看到“完整意见”时就提前响应 201。
  const trailing = Buffer.from('X', 'utf8');
  const response = await sendChunked([exact, trailing], 20);
  // 若服务曾提前回 201，连接里先到的会是 201 状态行；最终第一条状态必须是 400。
  assertTooLarge(response, '完整意见前缀后再多一个字节');
  await assertNothingSaved(before, '完整意见前缀后再多一个字节');
});

test('超限与 JSON 格式问题同时存在时报告“请求体过大”；未超限的无效 JSON 仍是现有格式错误', async (t) => {
  await t.test('未超限但 JSON 无效：继续返回现有的格式错误', async () => {
    const before = await snapshot();
    const invalid = Buffer.from('{"title":"x" not-json', 'utf8');
    assert.ok(invalid.length < MAX_BODY_BYTES);
    const response = await sendWithContentLength(invalid);
    assert.equal(response.status, 400);
    assert.equal(response.data.error, '请求体不是有效的 JSON');
    assert.ok(!('idea' in response.data));
    await assertNothingSaved(before, '未超限的无效 JSON');
  });

  await t.test('超过 1000000 字节且 JSON 无法解析：仍报告“请求体过大”，不被格式错误覆盖', async () => {
    const before = await snapshot();
    const head = Buffer.from('{"title":"x","description":"y"', 'utf8'); // 没有闭合括号
    const body = Buffer.concat([
      head,
      Buffer.from(' '.repeat(MAX_BODY_BYTES + 1 - head.length - 1), 'utf8'),
      Buffer.from('Z', 'utf8'),
    ]);
    assert.equal(body.length, MAX_BODY_BYTES + 1);
    assert.throws(() => JSON.parse(body.toString('utf8')), '用例自身必须确实是无效 JSON');

    const response = await sendWithContentLength(body);
    assertTooLarge(response, '超限且 JSON 无效');
    await assertNothingSaved(before, '超限且 JSON 无效');
  });

  await t.test('chunked 中途超限且前缀本身不是合法 JSON：错误仍是“请求体过大”', async () => {
    const before = await snapshot();
    const head = Buffer.from('<<< 完全不是 JSON ', 'utf8');
    const body = Buffer.concat([
      head,
      Buffer.from(' '.repeat(MAX_BODY_BYTES + 1 - head.length), 'utf8'),
    ]);
    assert.equal(body.length, MAX_BODY_BYTES + 1);
    const parts = splitAt(body, [400_000, 800_000]);
    const response = await sendChunked(parts, 10);
    assertTooLarge(response, 'chunked 中途超限且 JSON 无效');
    await assertNothingSaved(before, 'chunked 中途超限且 JSON 无效');
  });
});

test('两套上限互不混淆：远小于 1MB 但字段超过码点上限时，返回的是字段错误而非“请求体过大”', async () => {
  const before = await snapshot();
  // 标题 121 个中文码点：正文只有几百字节，按字节远未超限，但按码点超标题上限。
  const { status, data } = await postJson({ title: '中'.repeat(121), description: '说明' });
  assert.equal(status, 400);
  assert.notEqual(data.error, '请求体过大');
  assert.ok(String(data.error).includes('标题'), `应指明标题字段，实际：${data.error}`);
  await assertNothingSaved(before, '字段码点超限');
});

test('所有拒绝结束后：同标题不同 id 的旧意见仍分别保留，空白/换行/中文/表情逐字不变', async () => {
  const list = await listIdeas();
  // before 钩子保存了两条记录，本文件的成功提交（恰好边界的两次）排在它们之前；
  // 这里只核对原始两条的内容与相对次序。
  const seeded = list.filter((idea) => idea.description.startsWith('原有说明 A') || idea.description === '同标题的另一条记录');
  assert.equal(seeded.length, 2);
  const [second, first] = seeded;
  assert.notEqual(first.id, second.id);
  assert.equal(first.title, '重复 标题'); // 首尾空白在保存时去掉
  assert.equal(first.description, '原有说明 A 第一行\n第二行\t😀 中文结尾 ');
  assert.equal(first.scenario, '场景 A');
  assert.equal(second.title, '重复 标题');
  assert.equal(second.description, '同标题的另一条记录');
  assert.equal(second.scenario, '');
});
