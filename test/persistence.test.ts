import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../testing/server.ts';

// 意见保存功能的持久化回归：只走公开入口（POST/GET /api/ideas），在真实进程上
// 验证「提交成功 → 正常停止（SIGTERM）→ 用同一 --data-dir 再次启动」这一已有行为。
// 基线一律以 POST 201 返回的记录为准（即标题已 trim、正文与场景保留原空白的处理结果），
// 回归需要能发现：保存内容丢失、记录被合并/替换、id 或 createdAt 被重新生成、次序变化、
// 以及一条意见的文字被归到另一条意见名下。

interface Idea {
  id: string;
  title: string;
  description: string;
  scenario: string;
  createdAt: string;
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'featureharbor-persist-'));
}

async function listIdeas(server: StartedServer): Promise<Idea[]> {
  const res = await fetch(`${server.origin}/api/ideas`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.ideas));
  return data.ideas as Idea[];
}

async function createIdea(
  server: StartedServer,
  body: unknown,
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

// 正常停止当前进程，再用同一数据目录启动一份新服务（新进程、新端口）。
async function restart(server: StartedServer): Promise<StartedServer> {
  const dir = server.dataDir;
  await server.stop();
  return startServer(dir);
}

// 兜底停止：即使重复调用也不挂住测试（stop 内部另有 SIGKILL 兜底）。
async function safeStop(server: StartedServer): Promise<void> {
  await Promise.race([
    server.stop(),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);
}

test('停止后用同一数据目录重启：原有意见数量、标识、提交时间、逐条文字与次序完整保留', async () => {
  const dir = freshDir();
  let server = await startServer(dir);
  try {
    // 故意覆盖易错内容：首尾空白标题（应被 trim）、保留空白/换行/制表符的正文、
    // 省略场景与显式空场景、中文、emoji、看起来像网页标记的文本；
    // 其中第 2、3 条标题与正文完全相同，只能靠 id 区分，重新读取时不得合成一条。
    const payloads: unknown[] = [
      {
        title: '  深色模式  ',
        description: '  希望界面\n支持深色模式\t与强调色。 ',
        // scenario 省略，按现有规则保存为空字符串
      },
      {
        title: '重复标题',
        description: '重复说明\n第二行 <b>加粗</b> 😀',
        scenario: '夜间 🌙 使用\n场景第二行',
      },
      {
        title: '重复标题',
        description: '重复说明\n第二行 <b>加粗</b> 😀',
        scenario: '',
      },
      {
        title: ' 网页标记与表情 ',
        description: '多行\n\n保留空行：<p>段落</p><script>alert("x")</script> 🎉中文',
        scenario: '  场景首尾空白保留  ',
      },
    ];

    const saved: Idea[] = [];
    for (const payload of payloads) {
      const { status, data } = await createIdea(server, payload);
      assert.equal(status, 201);
      saved.push(data.idea as Idea);
    }

    // 先确认 POST 返回的就是现有提交规则处理后的结果
    assert.equal(saved[0].title, '深色模式');
    assert.equal(saved[0].description, '  希望界面\n支持深色模式\t与强调色。 ');
    assert.equal(saved[0].scenario, '');
    assert.equal(saved[1].title, saved[2].title);
    assert.equal(saved[1].description, saved[2].description);
    assert.notEqual(saved[1].id, saved[2].id);
    assert.equal(saved[1].scenario, '夜间 🌙 使用\n场景第二行');
    assert.equal(saved[2].scenario, '');
    assert.equal(saved[3].title, '网页标记与表情');
    assert.equal(saved[3].scenario, '  场景首尾空白保留  ');

    // 停止前的基线：后提交的在前面
    const expectedOrder = [...saved].reverse();
    const beforeStop = await listIdeas(server);
    assert.equal(beforeStop.length, saved.length);
    assert.deepEqual(beforeStop, expectedOrder);
    assert.deepEqual(beforeStop.map((i) => i.id), expectedOrder.map((i) => i.id));

    // 同文不同 id：重新读取前就应是两条独立记录
    const duplicated = beforeStop.filter(
      (i) => i.title === '重复标题' && i.description === '重复说明\n第二行 <b>加粗</b> 😀',
    );
    assert.equal(duplicated.length, 2);
    assert.notEqual(duplicated[0].id, duplicated[1].id);

    // 正常停止，并用原来的业务数据目录再次启动
    server = await restart(server);

    const afterRestart = await listIdeas(server);

    // 数量、每条记录的全部字段（含 id 与 createdAt）、排列次序逐一不变
    assert.equal(afterRestart.length, expectedOrder.length);
    assert.deepEqual(afterRestart, expectedOrder);
    assert.deepEqual(afterRestart.map((i) => i.id), expectedOrder.map((i) => i.id));

    // 每条意见的文字、标识、提交时间必须与自己对应，不能内容正确却归到另一条名下
    for (const expected of expectedOrder) {
      const found = afterRestart.find((i) => i.id === expected.id);
      if (!found) assert.fail(`意见 ${expected.id} 重启后丢失`);
      assert.equal(found.createdAt, expected.createdAt, `${expected.id} 的提交时间被改变`);
      assert.equal(found.title, expected.title, `${expected.id} 的标题被改变`);
      assert.equal(found.description, expected.description, `${expected.id} 的详细说明被改变`);
      assert.equal(found.scenario, expected.scenario, `${expected.id} 的使用场景被改变`);
    }
    // 场景字段不得串到别的记录上
    const byId = new Map(afterRestart.map((i) => [i.id, i]));
    assert.equal(byId.get(saved[0].id)?.scenario, '');
    assert.equal(byId.get(saved[1].id)?.scenario, '夜间 🌙 使用\n场景第二行');
    assert.equal(byId.get(saved[2].id)?.scenario, '');
    assert.equal(byId.get(saved[3].id)?.scenario, '  场景首尾空白保留  ');
    assert.equal(
      byId.get(saved[3].id)?.description,
      '多行\n\n保留空行：<p>段落</p><script>alert("x")</script> 🎉中文',
    );

    // 没有新增意见时，再次查询的列表次序与停止前一致
    assert.deepEqual(await listIdeas(server), expectedOrder);

    // 重启后继续成功提交一条：新意见出现在旧意见之前，旧记录原样保留
    const newestPayload = {
      title: '重启后新意见',
      description: '重启后提交\n新行 <em>em</em> 🚀',
      scenario: '再次启动后的场景',
    };
    const created = await createIdea(server, newestPayload);
    assert.equal(created.status, 201);
    const newest = created.data.idea as Idea;
    assert.equal(newest.title, '重启后新意见');
    assert.equal(newest.description, '重启后提交\n新行 <em>em</em> 🚀');
    assert.equal(newest.scenario, '再次启动后的场景');

    const afterNewSubmit = await listIdeas(server);
    assert.equal(afterNewSubmit.length, expectedOrder.length + 1);
    assert.equal(afterNewSubmit[0].id, newest.id);
    assert.deepEqual(afterNewSubmit[0], newest);
    // 旧记录的内容、标识、时间与相对次序都保留原样
    assert.deepEqual(afterNewSubmit.slice(1), expectedOrder);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('校验失败的提交不入库；停止并以同一数据目录重启后，列表仍只有此前成功保存的意见', async () => {
  const dir = freshDir();
  let server = await startServer(dir);
  try {
    // 先有一条已成功保存的意见
    const ok = await createIdea(server, {
      title: ' 已保存意见 ',
      description: '这条意见保存成功\n第二行 😀',
      scenario: '已有场景',
    });
    assert.equal(ok.status, 201);
    const savedIdea = ok.data.idea as Idea;
    assert.equal(savedIdea.title, '已保存意见');
    assert.equal(savedIdea.scenario, '已有场景');

    // 现有字段规则下应被拒绝的各类提交（错误提示仍由服务端原样给出，这里不改规则）
    const badBodies: unknown[] = [
      { title: '   ', description: '空白标题' },
      { description: '缺少标题' },
      { title: '标题', description: '   ' },
      { title: '标题', description: '说明', scenario: '字'.repeat(1001) },
      { title: 1, description: '标题类型错误' },
      { title: '标题', description: '说明', scenario: 2 },
    ];
    for (const body of badBodies) {
      const rejected = await createIdea(server, body);
      assert.equal(rejected.status, 400);
      assert.equal(typeof rejected.data.error, 'string');
    }

    // 停止前：失败内容没有进入列表，原有意见未被覆盖或重新排序
    assert.deepEqual(await listIdeas(server), [savedIdea]);

    // 停止服务并继续使用同一数据目录
    server = await restart(server);

    // 失败内容依旧不在，原意见（含标识与提交时间）原样保留，且没有占位记录
    const list = await listIdeas(server);
    assert.equal(list.length, 1);
    assert.deepEqual(list, [savedIdea]);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('从未保存过意见的数据目录再次使用时仍返回空列表，不出现占位记录', async () => {
  const dir = freshDir();
  let server = await startServer(dir);
  try {
    assert.deepEqual(await listIdeas(server), []);

    server = await restart(server);

    const list = await listIdeas(server);
    assert.ok(Array.isArray(list));
    assert.equal(list.length, 0);
    assert.deepEqual(list, []);
  } finally {
    await safeStop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
