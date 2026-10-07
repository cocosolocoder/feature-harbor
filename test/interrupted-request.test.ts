import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, removeDataDir, type StartedServer } from '../testing/server.ts';

// 请求中途断开（正文未完整接收就失去连接）的端到端回归。这里保护的是 POST /api/ideas
// 现有的“整次请求的正文接收完整后才判断内容并保存”行为：
//   - 发送方明确声明 Content-Length 却只发其中一部分随后断开（FIN 正常关闭或 RST 直接复位），
//     即使已收到的前缀恰好是一份可解析的 JSON、三个意见字段都已完整，也不能因为
//     文字看起来完整就提前保存；
//   - Transfer-Encoding: chunked 下已经发完整个意见的全部文字、但没发“0 长度分块”这一
//     请求结束标记就断开，同样属于未完成提交，不能入库；
//   - 中断不能损伤已保存的正式内容：数量、顺序、id、createdAt 与三个文字字段逐字保持，
//     不留下本次提交的临时保存（.tmp）；没有任何意见时列表仍返回空数组而不是读取失败；
//   - 连接已断开时不要求客户端必须收到某种错误响应，关键结果是没有保存意见；
//   - 中断后服务继续接受其他请求：查询正常，再完整提交一条合法意见仍返回现有的 201
//     和完整保存结果，新意见排在已有意见之前，旧记录内容与相对顺序不变；
//   - 完整送达但内容不合法的请求仍按已有规则拒绝（400），中断保护不放宽任何内容判定。
// 用原始 TCP 而不是 fetch：fetch 无法刻意少发 Content-Length 声明的字节，
// 也无法在 chunked 请求里省略结束标记后断开。

interface Idea {
  id: string;
  title: string;
  description: string;
  scenario: string;
  createdAt: string;
}

// 被中断的那条意见：三个字段都符合当前规则（标题去空白后非空且不超过 120 码点、
// 说明含非空白内容且不超过 5000、场景不超过 1000），整份 JSON 远低于 1000000 字节上限。
// 完整发送时必须能保存——否则“没保存”就可能只是内容被拒，而不是中断处理的结果。
const INTERRUPTED = {
  title: '中断的意见标题',
  description: '这一条的标题、详细说明与使用场景都合法，\n完整发送时应当可以保存。  ',
  scenario: '使用场景：中途断开，含中文与表情 😮‍💨🌙',
};
const FULL_BODY = Buffer.from(JSON.stringify(INTERRUPTED), 'utf8');
const points = (text: string): number => Array.from(text).length;
assert.ok(points(INTERRUPTED.title.trim()) > 0 && points(INTERRUPTED.title.trim()) <= 120);
assert.ok(INTERRUPTED.description.trim().length > 0 && points(INTERRUPTED.description) <= 5000);
assert.ok(points(INTERRUPTED.scenario) <= 1000);
assert.ok(FULL_BODY.length < 1_000_000, '中断的意见整份请求体应低于已有大小上限');
JSON.parse(FULL_BODY.toString('utf8')); // 整份（以及作为“完整前缀”使用时）是可解析 JSON

// 已有意见要覆盖易被破坏的文字：标题首尾空白、正文与场景里的空白、换行、中文与表情；
// 另放两条三字段完全相同、只能靠 id 区分的记录，防止中断把它们合并或重写。
const SEEDS = [
  {
    title: '  已有意见 甲 ',
    description: '第一行\n第二行 含空格、中文 与 😀\n  首尾空格也保留  ',
    scenario: ' 场景甲：换行\n与表情 🌙 ',
  },
  { title: '同标题同正文', description: '完全一样的内容', scenario: '相同场景' },
  { title: '同标题同正文', description: '完全一样的内容', scenario: '相同场景' },
];

let server: StartedServer;
let baseline: Idea[];
let baselineDisk: Buffer;

before(async () => {
  server = await startServer();
  for (const seed of SEEDS) {
    const res = await fetch(`${server.origin}/api/ideas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(seed),
    });
    assert.equal(res.status, 201, '准备数据：种入意见应成功');
  }
  const res = await fetch(`${server.origin}/api/ideas`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.ideas));
  baseline = data.ideas as Idea[];
  assert.equal(baseline.length, SEEDS.length);
  baselineDisk = readFileSync(join(server.dataDir, 'ideas.json'));
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
  assert.equal(res.status, 200, '中断后查询意见必须照常成功，不能变成读取失败');
  const data = await res.json();
  assert.ok(Array.isArray(data.ideas));
  return data.ideas as Idea[];
}

// 等服务侧把这次中断请求处理完：响应无处可写，唯一可观察的副作用就是“没有写入”。
// 用轮询而不是固定长睡：连接关闭事件传到服务、请求流结束、处理 Promise 落定都需要一拍，
// 期间服务绝不能有任何落盘；连续一小段时间列表与磁盘都稳定不变，才进入后续断言。
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const list = await listIdeas();
    const disk = readFileSync(ideasFile());
    if (list.length === baseline.length && disk.equals(baselineDisk)) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('中断后等待落盘稳定超时：列表或磁盘发生了变化');
}

function write(sock: Socket, data: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    sock.write(data, (error) => (error ? reject(error) : resolve()));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 在字节偏移处把正文切成多段（偏移可以落在一个多字节字符的 UTF-8 序列内部）
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

function requestHead(extraLine: string): string {
  return [
    'POST /api/ideas HTTP/1.1',
    'Host: 127.0.0.1',
    'Content-Type: application/json',
    extraLine,
    'Connection: close',
  ].join('\r\n') + '\r\n\r\n';
}

// 打开一条原始连接，按 sender 逐段发送，结束时以 FIN（end）或 RST（resetAndDestroy）断开。
// 全程不读取响应：连接已断开时不要求客户端收到任何错误，这里只制造“未发完就失去连接”。
function openInterruptingConnection(
  target: StartedServer,
  sender: (sock: Socket) => Promise<void>,
  mode: 'fin' | 'rst',
): Promise<void> {
  const port = Number(new URL(target.origin).port);
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1');
    let settled = false;
    // 不校验响应内容（连接已断开，不要求客户端收到某种错误），但必须排空：
    // 否则收到 FIN 的一侧保持暂停，'close' 不触发，辅助 Promise 会挂住。
    sock.resume();
    sock.on('error', () => {
      // 断开后服务回收 socket 可能回 RST/FIN：客户端本来就不期待响应，忽略即可
    });
    sock.on('close', () => {
      settled = true;
      resolve();
    });
    sock.on('connect', () => {
      sender(sock)
        .then(() => {
          if (mode === 'rst') sock.resetAndDestroy();
          else sock.end();
        })
        .catch((error) => {
          if (!settled) sock.destroy();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  });
}

// 中断后统一的数据保护断言：正式保存内容与中断前逐字一致，不残留本次临时内容
async function assertNothingSaved(): Promise<void> {
  const list = await listIdeas();
  assert.deepEqual(list, baseline, '中断的意见不能进入已保存列表，已有记录也不能变化');
  assert.deepEqual(readFileSync(ideasFile()), baselineDisk, '正式保存内容不能被中断清空、重写或混入前缀');
  assert.ok(!existsSync(`${ideasFile()}.tmp`), '不能留下本次提交的临时保存内容');

  // 已有意见的标识与提交时间原样保留；文字里的空白、换行、中文与表情逐字不变
  const oldest = list[list.length - 1];
  assert.equal(oldest.title, '已有意见 甲');
  assert.equal(oldest.description, '第一行\n第二行 含空格、中文 与 😀\n  首尾空格也保留  ');
  assert.equal(oldest.scenario, ' 场景甲：换行\n与表情 🌙 ');
  const twins = list.filter((idea) => idea.title === '同标题同正文');
  assert.equal(twins.length, 2);
  assert.notEqual(twins[0].id, twins[1].id);
  for (const idea of twins) {
    assert.ok(baseline.some((old) => old.id === idea.id && old.createdAt === idea.createdAt));
  }
  // 被中断那条的文字一个字都不能出现在列表里
  for (const idea of list) {
    assert.notEqual(idea.title, INTERRUPTED.title);
    assert.notEqual(idea.description, INTERRUPTED.description);
  }
}

test('Content-Length 明确声明整份长度却只发前半截（断在说明字段中间）随后 FIN：不保存', async () => {
  // 前缀既不是完整 JSON，也还没有 scenario 字段：最常见的“只收到一部分”
  const cut = Buffer.from(JSON.stringify({ title: INTERRUPTED.title, description: '' }), 'utf8').length + 8;
  assert.ok(cut > 0 && cut < FULL_BODY.length);
  const prefix = FULL_BODY.subarray(0, cut);
  await openInterruptingConnection(server, async (sock) => {
    await write(sock, requestHead(`Content-Length: ${FULL_BODY.length}`));
    // 分两段、中间停顿，确保服务在“只收到一部分”的状态上停留过
    await write(sock, prefix.subarray(0, 20));
    await sleep(5);
    await write(sock, prefix.subarray(20));
  }, 'fin');
  await settle();
  await assertNothingSaved();
});

test('Content-Length 大于实发、已收前缀本身是完整合法意见（三字段齐全且可解析）：FIN 断开也不保存', async () => {
  // 最关键的用例：声明的长度比实际多出一截，已发送的字节本身恰好是一份结构完整、
  // 三字段齐全、内容合法的意见 JSON。服务只能在整次请求的正文接收完整后判定，
  // 绝不能因为“文字看起来完整”就解析前缀并提前保存。
  const decoy = FULL_BODY;
  const declaredLength = decoy.length + 512; // 明确声明正文更长，剩下 512 字节永不发送
  await openInterruptingConnection(server, async (sock) => {
    await write(sock, requestHead(`Content-Length: ${declaredLength}`));
    // 分段慢速发送整段 decoy，并把表情的 UTF-8 字节拆到相邻两次写入
    const face = decoy.indexOf(Buffer.from('😮', 'utf8'));
    for (const piece of cutAt(decoy, [Math.floor(decoy.length / 3), face + 2, Math.floor((decoy.length * 2) / 3)])) {
      await sleep(3);
      await write(sock, piece);
    }
    // FIN：声明的剩余字节不再发送
  }, 'fin');
  await settle();
  await assertNothingSaved();
});

test('同样的“完整前缀”短发，这次以 RST 直接复位连接：仍然不保存', async () => {
  const decoy = FULL_BODY;
  const declaredLength = decoy.length + 256;
  await openInterruptingConnection(server, async (sock) => {
    await write(sock, requestHead(`Content-Length: ${declaredLength}`));
    await sleep(2);
    await write(sock, decoy);
    await sleep(2);
    // RST：请求流以异常方式中断，服务同样不能落盘
  }, 'rst');
  await settle();
  await assertNothingSaved();
});

test('只发了开头一小段（连 JSON 都不完整）就 RST：不保存，服务进程也不受影响', async () => {
  await openInterruptingConnection(server, async (sock) => {
    await write(sock, requestHead(`Content-Length: ${FULL_BODY.length}`));
    await write(sock, FULL_BODY.subarray(0, 20));
  }, 'rst');
  await settle();
  await assertNothingSaved();
});

test('chunked：意见全部文字已发完、只缺“0 长度分块”结束标记就 FIN：仍属于未完成提交', async () => {
  // 逐块发送整份意见（含拆在多字节字符中间的段），每段都带合法 chunk 帧头，
  // 唯独不发送 0\r\n\r\n：服务不能因为拼起来的文字已是完整意见就保存。
  const face = FULL_BODY.indexOf(Buffer.from('😮', 'utf8'));
  const pieces = cutAt(FULL_BODY, [50, face + 1, FULL_BODY.length - 30]);
  await openInterruptingConnection(server, async (sock) => {
    await write(sock, requestHead('Transfer-Encoding: chunked'));
    for (const piece of pieces) {
      await sleep(3);
      await write(sock, Buffer.from(`${piece.length.toString(16)}\r\n`, 'ascii'));
      await write(sock, piece);
      await write(sock, Buffer.from('\r\n', 'ascii'));
    }
    // 刻意没有发送 0 长度结束分块
  }, 'fin');
  await settle();
  await assertNothingSaved();
});

test('chunked 缺结束标记且以 RST 断开：同样不保存', async () => {
  const pieces = cutAt(FULL_BODY, [10, 100]);
  await openInterruptingConnection(server, async (sock) => {
    await write(sock, requestHead('Transfer-Encoding: chunked'));
    for (const piece of pieces) {
      await sleep(2);
      await write(sock, Buffer.from(`${piece.length.toString(16)}\r\n`, 'ascii'));
      await write(sock, piece);
      await write(sock, Buffer.from('\r\n', 'ascii'));
    }
  }, 'rst');
  await settle();
  await assertNothingSaved();
});

test('连续多次不同形态的中断之后：已有意见的数量、顺序、标识、时间与文字仍逐字不变', async () => {
  await assertNothingSaved();
});

test('中断之后服务继续可用：查询正常，再完整提交同一条合法意见返回 201，新意见排最前、旧记录不变', async () => {
  const res = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // 与被中断的内容逐字相同：这次完整送达，必须按现有行为保存
    body: JSON.stringify(INTERRUPTED),
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.ok(data.idea && typeof data.idea === 'object');
  const saved = data.idea as Idea;
  assert.equal(typeof saved.id, 'string');
  assert.ok(saved.id.length > 0);
  assert.equal(typeof saved.createdAt, 'string');
  assert.equal(saved.title, INTERRUPTED.title);
  assert.equal(saved.description, INTERRUPTED.description);
  assert.equal(saved.scenario, INTERRUPTED.scenario);

  const list = await listIdeas();
  assert.equal(list.length, baseline.length + 1);
  assert.deepEqual(list[0], saved, '新意见排在已有意见之前');
  assert.deepEqual(list.slice(1), baseline, '原有记录保持原来的内容与相对顺序');
  baseline = list;
  baselineDisk = readFileSync(ideasFile());
});

test('完整送达但内容不合法的请求仍按已有规则拒绝（中断保护不放宽任何内容判定）', async () => {
  const invalid = { title: '   ', description: '标题只有空白' };
  const res = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(invalid),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(String(data.error), /标题/);
  assert.ok(!('idea' in data));
  assert.deepEqual(await listIdeas(), baseline);
  assert.deepEqual(readFileSync(ideasFile()), baselineDisk);
});

// 空数据目录下发生中断：列表仍正常返回空数组，不能变成读取失败，磁盘保持初始空数据。
test('没有任何意见时中断：列表仍返回空数组；恢复后完整提交返回 201 且列表恰有这一条', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'featureharbor-interrupt-empty-'));
  let emptyServer: StartedServer | undefined;
  try {
    emptyServer = await startServer(dir);
    const emptyFile = join(dir, 'ideas.json');
    assert.equal(readFileSync(emptyFile, 'utf8'), '[]\n');

    // 声明长度但只发一份完整合法意见的字节（前缀本身可解析、三字段齐全），随后 FIN
    await openInterruptingConnection(emptyServer, async (sock) => {
      await write(sock, requestHead(`Content-Length: ${FULL_BODY.length + 64}`));
      await sleep(2);
      await write(sock, FULL_BODY);
    }, 'fin');

    // 空列表仍成功返回（不是读取失败，也不混入半截记录），磁盘保持初始内容且无 .tmp
    let stable = false;
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`${emptyServer.origin}/api/ideas`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data, { ideas: [] }, '没有意见时中断后仍应是空数组');
      if (readFileSync(emptyFile, 'utf8') === '[]\n' && !existsSync(`${emptyFile}.tmp`)) {
        stable = true;
        break;
      }
      await sleep(20);
    }
    assert.ok(stable, '中断后空数据目录应保持初始 [] 且不残留 .tmp');

    // 恢复后把同一条意见完整发送：201 和完整保存结果，列表恰有这一条
    const ok = await fetch(`${emptyServer.origin}/api/ideas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(INTERRUPTED),
    });
    assert.equal(ok.status, 201);
    const saved = (await ok.json()).idea as Idea;
    assert.equal(saved.title, INTERRUPTED.title);
    assert.equal(saved.description, INTERRUPTED.description);
    assert.equal(saved.scenario, INTERRUPTED.scenario);
    const listed = await fetch(`${emptyServer.origin}/api/ideas`).then((r) => r.json());
    assert.equal(listed.ideas.length, 1);
    assert.deepEqual(listed.ideas[0], saved);
  } finally {
    if (emptyServer) await emptyServer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
