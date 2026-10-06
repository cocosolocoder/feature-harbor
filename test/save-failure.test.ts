import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../testing/server.ts';

// 保存失败的回归保障：保护「已有数据可以正常读取、提交内容也完全合法，但保存位置无法写入」
// 这一分支的现有行为（server.ts 中 saveIdeas 抛错时返回 500）。只走公开入口
// （GET/POST /api/ideas）并直接比对磁盘上的 ideas.json，要求：
//   1. POST 返回 500 和现有的 error（“保存意见失败，请稍后重试”），不能返回 201，
//      响应不带保存成功的 idea；这是保存未完成，不能算成字段填错的 400，
//      也不能误报成“无法读取已有意见数据”；
//   2. 失败不损伤此前收集到的意见：列表的数量、顺序、id、createdAt 与每条记录的
//      title/description/scenario 与失败前完全一致，失败的新意见不能混进列表；
//      磁盘上的 ideas.json 与请求前逐字节一致（不清空、不格式化重写、
//      不被只含新意见的内容覆盖），也不留下 .tmp 临时文件；
//   3. 保存位置恢复可写后，重新提交同一条合法意见按已有功能返回 201 和完整记录，
//      列表只增加这一条且它排在最前，旧记录的相对顺序与内容不变；
//   4. 此前从未保存过意见时保存失败：列表仍成功返回空数组，不能出现半条记录，
//      也不能把空数据误判为读取损坏。
// 发起提交的意见三个字段都合法，保证 500 只能来自保存位置不可写。

interface Idea {
  id: string;
  title: string;
  description: string;
  scenario: string;
  createdAt: string;
}

const SAVE_FAILED_ERROR = '保存意见失败，请稍后重试';
const READ_FAILED_ERROR = '无法读取已有意见数据，未保存新意见';

// 固定标识与提交时间的旧意见，用于逐字段精确比对：
// - 前两条标题、正文完全相同但 id 不同，失败分支不能把它们合并或丢弃；
// - 第三条带内部空白、换行、中文与表情，必须按原文保留。
const OLD_IDEAS: Idea[] = [
  {
    id: 'fixed-old-aaaa-0000',
    title: '相同的标题',
    description: '相同的正文内容',
    scenario: '场景甲：第一条',
    createdAt: '2024-02-03T04:05:06.001Z',
  },
  {
    id: 'fixed-old-bbbb-0000',
    title: '相同的标题',
    description: '相同的正文内容',
    scenario: '场景乙：标题正文相同但标识不同',
    createdAt: '2024-02-03T04:05:07.002Z',
  },
  {
    id: 'fixed-old-cccc-0000',
    title: '带 内部空白与中文 的标题',
    description: '正文首行\n  第二行带空格与表情 😀🎉\n末行',
    scenario: ' 场景空白与换行保留\n🇨🇳 末行 ',
    createdAt: '2024-02-03T04:05:08.003Z',
  },
];

// 先保存失败、恢复后重新提交的同一条合法意见（标题首尾空白在保存时去除）。
const RETRY_IDEA = {
  title: ' 保存位置恢复后重试的意见 ',
  retryTitle: '保存位置恢复后重试的意见',
  description: '第一次提交时保存位置不可写；恢复后重新提交同一条合法意见。\n第二行 😀',
  scenario: '写入恢复后的使用场景',
};

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'featureharbor-savefail-'));
}

function seedOldIdeas(dir: string): string {
  const file = join(dir, 'ideas.json');
  // 刻意使用与服务端不同的紧凑序列化（无缩进、无末尾换行）落盘：
  // 保存失败时连格式都不能被重写，逐字节比对才能发现“失败也重写了文件”。
  writeFileSync(file, JSON.stringify(OLD_IDEAS), 'utf8');
  return file;
}

async function postIdea(
  server: StartedServer,
  payload: unknown,
): Promise<{ status: number; contentType: string | null; data: any }> {
  const res = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { status: res.status, contentType: res.headers.get('content-type'), data };
}

async function getIdeas(
  server: StartedServer,
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${server.origin}/api/ideas`);
  return { status: res.status, data: await res.json() };
}

// 兜底停止：即使重复调用也不挂住测试（stop 内部另有 SIGKILL 兜底）。
async function safeStop(server: StartedServer | undefined): Promise<void> {
  if (!server) return;
  await Promise.race([
    server.stop(),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);
}

// 校验 201 响应是一条完整的保存结果，并返回这条意见。
function expectCompleteSavedIdea(posted: { status: number; contentType: string | null; data: any }): Idea {
  assert.equal(posted.status, 201);
  assert.match(posted.contentType ?? '', /application\/json/);
  assert.ok(posted.data && typeof posted.data === 'object');
  const idea = posted.data.idea;
  assert.ok(idea && typeof idea === 'object' && !Array.isArray(idea));
  assert.equal(typeof idea.id, 'string');
  assert.ok(idea.id.length > 0);
  assert.equal(typeof idea.createdAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(idea.createdAt)));
  return idea as Idea;
}

// 保存失败时对 POST 结果的统一断言：500 + 现有的保存失败说明，不带 idea，
// 既不是字段错误（400），也不是读取历史意见失败的另一条说明。
function expectSaveFailureResponse(posted: { status: number; contentType: string | null; data: any }): void {
  assert.equal(posted.status, 500);
  assert.match(posted.contentType ?? '', /application\/json/);
  assert.ok(posted.data && typeof posted.data === 'object');
  assert.equal(posted.data.error, SAVE_FAILED_ERROR);
  assert.notEqual(posted.data.error, READ_FAILED_ERROR);
  assert.equal(Object.prototype.hasOwnProperty.call(posted.data, 'idea'), false);
}

test('保存目录不可写时：合法提交返回 500 和保存失败说明，旧意见与磁盘内容逐字节保留；恢复后重试返回 201', async (t) => {
  // root 不受权限位约束，无法用只读目录模拟不可写；EISDIR 用例不依赖权限，仍会覆盖同一分支。
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root 身份下目录只读位不会阻止写入，跳过权限位用例');
    return;
  }
  const dir = freshDir();
  const file = seedOldIdeas(dir);
  const tmpFile = `${file}.tmp`;
  let server: StartedServer | undefined;
  try {
    server = await startServer(dir);

    // 失败前先通过公开列表接口留下基线：数量、顺序、标识、时间与各字段内容。
    const before = await getIdeas(server);
    assert.equal(before.status, 200);
    assert.deepEqual(before.data.ideas, OLD_IDEAS);
    const beforeBytes = readFileSync(file);

    // 从进程外把保存位置改成不可写：目录只读时无法创建 ideas.json.tmp；
    // 旧文件本身仍可正常读取，因此 500 只能来自保存未完成。
    chmodSync(dir, 0o555);

    const post1 = await postIdea(server, RETRY_IDEA);
    expectSaveFailureResponse(post1);

    // 最关键的保护：失败后磁盘内容一个字节都不能变——不清空、不格式化重写、
    // 不被只含新意见的列表覆盖，也不留下临时文件。
    assert.ok(readFileSync(file).equals(beforeBytes), '保存失败后 ideas.json 被改动');
    assert.equal(existsSync(tmpFile), false, '保存失败后不应留下临时文件');

    // 旧意见仍可正常读取，且与失败前完全一致；失败的新意见不能混入。
    const after1 = await getIdeas(server);
    assert.equal(after1.status, 200);
    assert.deepEqual(after1.data, before.data);
    assert.deepEqual(after1.data.ideas, OLD_IDEAS);
    assert.equal(after1.data.ideas.length, OLD_IDEAS.length);
    // 标题、正文相同但 id 不同的两条仍是独立意见，不能在失败分支被合并或丢弃。
    const sameTitle = after1.data.ideas.filter((i: Idea) => i.title === '相同的标题');
    assert.equal(sameTitle.length, 2);
    assert.notEqual(sameTitle[0].id, sameTitle[1].id);
    // 带空白、换行、中文与表情的文字按原文保留。
    assert.deepEqual(after1.data.ideas[2], OLD_IDEAS[2]);
    assert.ok(!after1.data.ideas.some((i: Idea) => i.title === RETRY_IDEA.retryTitle));

    // 再次提交同样失败：任何一次失败请求都不能触发写入或把新意见留在列表里。
    const post2 = await postIdea(server, RETRY_IDEA);
    expectSaveFailureResponse(post2);
    assert.ok(readFileSync(file).equals(beforeBytes), '第二次保存失败后 ideas.json 被改动');
    assert.equal(existsSync(tmpFile), false);
    const after2 = await getIdeas(server);
    assert.equal(after2.status, 200);
    assert.deepEqual(after2.data.ideas, OLD_IDEAS);

    // 保存位置恢复可写后，重新提交刚才那条合法意见：按已有功能返回 201 与完整记录。
    chmodSync(dir, 0o755);
    const retry = await postIdea(server, RETRY_IDEA);
    const saved = expectCompleteSavedIdea(retry);
    assert.equal(saved.title, RETRY_IDEA.retryTitle);
    assert.equal(saved.description, RETRY_IDEA.description);
    assert.equal(saved.scenario, RETRY_IDEA.scenario);
    assert.ok(!OLD_IDEAS.some((i) => i.id === saved.id));

    // 列表只增加成功的这一条，它排在最前；旧记录保持原来的相对顺序与全部内容。
    const listed = await getIdeas(server);
    assert.equal(listed.status, 200);
    assert.equal(listed.data.ideas.length, OLD_IDEAS.length + 1);
    assert.deepEqual(listed.data.ideas[0], saved);
    assert.deepEqual(listed.data.ideas.slice(1), OLD_IDEAS);

    // 落盘内容即列表内容，旧意见确实原样保留在文件里。
    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(persisted, listed.data.ideas);
  } finally {
    // 无论断言是否失败，先恢复权限再清理目录与进程，避免只读目录残留。
    chmodSync(dir, 0o755);
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('临时文件路径被占用导致写入失败：同样返回 500、旧数据不动；排除障碍后重试返回 201', async () => {
  const dir = freshDir();
  const file = seedOldIdeas(dir);
  const tmpFile = `${file}.tmp`;
  let server: StartedServer | undefined;
  try {
    server = await startServer(dir);

    const before = await getIdeas(server);
    assert.equal(before.status, 200);
    assert.deepEqual(before.data.ideas, OLD_IDEAS);
    const beforeBytes = readFileSync(file);

    // 让 ideas.json.tmp 成为一个已存在的目录：writeFileSync 写临时文件必然失败（EISDIR）。
    // 这与权限无关，专门固定“写临时文件这一步抛错”的失败形态。
    mkdirSync(tmpFile);

    const post1 = await postIdea(server, RETRY_IDEA);
    expectSaveFailureResponse(post1);
    assert.ok(readFileSync(file).equals(beforeBytes), '写入失败后 ideas.json 被改动');

    // 旧意见照常读取，失败的新意见不混入；读取走的是 ideas.json，不受障碍影响。
    const afterFail = await getIdeas(server);
    assert.equal(afterFail.status, 200);
    assert.deepEqual(afterFail.data.ideas, OLD_IDEAS);

    // 保存位置恢复（移除障碍）后重试同一条意见：201，新意见在最前，旧意见原样保留。
    rmSync(tmpFile, { recursive: true, force: true });
    const retry = await postIdea(server, RETRY_IDEA);
    const saved = expectCompleteSavedIdea(retry);
    assert.equal(saved.title, RETRY_IDEA.retryTitle);
    assert.equal(saved.description, RETRY_IDEA.description);
    assert.equal(saved.scenario, RETRY_IDEA.scenario);

    const listed = await getIdeas(server);
    assert.equal(listed.status, 200);
    assert.equal(listed.data.ideas.length, OLD_IDEAS.length + 1);
    assert.deepEqual(listed.data.ideas[0], saved);
    assert.deepEqual(listed.data.ideas.slice(1), OLD_IDEAS);
    // 成功保存后临时文件已被原子重命名掉，不应残留。
    assert.equal(existsSync(tmpFile), false);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('从未保存过意见时保存失败：列表仍成功返回空数组，无半条记录；恢复后提交返回 201', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root 身份下目录只读位不会阻止写入，跳过权限位用例');
    return;
  }
  const dir = freshDir();
  let server: StartedServer | undefined;
  const file = join(dir, 'ideas.json');
  const tmpFile = `${file}.tmp`;
  try {
    server = await startServer(dir);
    // 全新数据目录：服务启动时创建的就是 []\n，查询成功返回空列表。
    assert.equal(readFileSync(file, 'utf8'), '[]\n');
    const empty = await getIdeas(server);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data, { ideas: [] });

    chmodSync(dir, 0o555);

    // 保存失败：不能返回 201，也不能把空数据当成读取损坏（GET 不是 500）。
    const post1 = await postIdea(server, RETRY_IDEA);
    expectSaveFailureResponse(post1);

    // 列表仍是成功的空数组，不能出现失败请求的半条记录。
    const afterFail = await getIdeas(server);
    assert.equal(afterFail.status, 200);
    assert.deepEqual(afterFail.data, { ideas: [] });
    assert.equal(readFileSync(file, 'utf8'), '[]\n');
    assert.equal(existsSync(tmpFile), false);

    // 恢复后提交同一条意见：201，列表只含这一条完整记录。
    chmodSync(dir, 0o755);
    const retry = await postIdea(server, RETRY_IDEA);
    const saved = expectCompleteSavedIdea(retry);
    const listed = await getIdeas(server);
    assert.equal(listed.status, 200);
    assert.equal(listed.data.ideas.length, 1);
    assert.deepEqual(listed.data.ideas[0], saved);
  } finally {
    chmodSync(dir, 0o755);
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
