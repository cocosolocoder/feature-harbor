import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../testing/server.ts';

// 持久化回归：真实启动 server.ts，经公开入口 POST/GET /api/ideas 写入与查询，
// 再用 SIGTERM 正常停止服务、沿用同一个 --data-dir 重新启动，保护
// “重启后已有意见完整可查”这一既有行为：内容丢失、记录被合并/替换、
// id 或提交时间被重新生成、顺序变化都应能被这里发现。

interface IdeaRecord {
  id: string;
  title: string;
  description: string;
  scenario: string;
  createdAt: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function postIdea(origin: string, body: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function createIdea(origin: string, body: unknown): Promise<IdeaRecord> {
  const { status, data } = await postIdea(origin, body);
  assert.equal(status, 201);
  assert.ok(data && typeof data === 'object' && data.idea, '成功响应应包含 idea');
  return data.idea as IdeaRecord;
}

async function listIdeas(origin: string): Promise<IdeaRecord[]> {
  const res = await fetch(`${origin}/api/ideas`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data && Array.isArray(data.ideas), '响应应为 {ideas: [...]}');
  return data.ideas as IdeaRecord[];
}

// 既有返回格式中的公开字段；配合 deepEqual 同时锁定字段集合，防止多出占位字段
function snapshot(idea: IdeaRecord): IdeaRecord {
  return {
    id: idea.id,
    title: idea.title,
    description: idea.description,
    scenario: idea.scenario,
    createdAt: idea.createdAt,
  };
}

async function stopAndRestart(server: StartedServer): Promise<StartedServer> {
  const dir = server.dataDir;
  await server.stop();
  return startServer(dir);
}

async function cleanup(server: StartedServer): Promise<void> {
  await server.stop();
  rmSync(server.dataDir, { recursive: true, force: true });
}

test('停止服务并用原数据目录重启后，已有意见全部保留：数量、id、提交时间、顺序与逐条内容不变', async () => {
  let server = await startServer();
  try {
    // createdAt 为毫秒精度，提交之间留出间隔，保证各记录提交时间彼此可区分
    await sleep(10);
    const first = await createIdea(server.origin, {
      title: '  深色模式  ', // 标题按现有规则去掉首尾空白
      description: '\n第一行末尾保留两个空格  \n第二行有制表符\t原样保留\n<p>看起来像网页标记</p>\n  ',
      scenario: '\n 夜间使用 \n 场景第二行 \t', // 场景保留原有空白与换行（含首尾）
    });
    assert.equal(first.title, '深色模式');
    assert.equal(first.scenario, '\n 夜间使用 \n 场景第二行 \t');

    await sleep(10);
    // 标题/正文含中文、emoji、网页标记样文本；省略 scenario
    const second = await createIdea(server.origin, {
      title: '表情意见 🚀',
      description: 'emoji 内容 🎉 与换行\n<div class="x">标记原样</div>',
    });
    assert.equal(second.scenario, '');

    await sleep(10);
    // 标题与详细说明与上一条完全相同，但必须是独立的两条记录
    const third = await createIdea(server.origin, {
      title: '表情意见 🚀',
      description: 'emoji 内容 🎉 与换行\n<div class="x">标记原样</div>',
      scenario: '第三条自己的场景',
    });
    assert.notEqual(third.id, second.id);
    assert.notEqual(third.createdAt, second.createdAt);
    for (const idea of [first, second, third]) {
      assert.ok(!Number.isNaN(Date.parse(idea.createdAt)));
    }

    // 停止前：后提交的在最前
    const expectedOrdered = [third, second, first].map(snapshot);
    const beforeStop = await listIdeas(server.origin);
    assert.equal(beforeStop.length, 3);
    assert.deepEqual(beforeStop, expectedOrdered);

    // 正常停止，沿用同一数据目录再次启动
    server = await stopAndRestart(server);

    const afterRestart = await listIdeas(server.origin);
    // 一次性保护：数量不变、顺序不变、每条记录字段集合/id/时间/全文完全一致
    assert.equal(afterRestart.length, 3);
    assert.deepEqual(afterRestart, expectedOrdered);

    // 标识与提交时间逐条保持，且没有被重新生成
    assert.deepEqual(afterRestart.map((i) => i.id), [third.id, second.id, first.id]);
    assert.deepEqual(afterRestart.map((i) => i.createdAt), [third.createdAt, second.createdAt, first.createdAt]);
    assert.equal(new Set(afterRestart.map((i) => i.id)).size, 3);

    // 同标题同正文仍是两条独立记录，不按文字内容合并
    const sameText = afterRestart.filter(
      (i) => i.title === '表情意见 🚀' && i.description === 'emoji 内容 🎉 与换行\n<div class="x">标记原样</div>',
    );
    assert.equal(sameText.length, 2);
    assert.notEqual(sameText[0].id, sameText[1].id);

    // 场景必须与自己的记录对应，不能串到另一条上
    const byId = new Map(afterRestart.map((i) => [i.id, i]));
    assert.equal(byId.get(second.id)?.scenario, '');
    assert.equal(byId.get(third.id)?.scenario, '第三条自己的场景');
    assert.equal(byId.get(first.id)?.scenario, '\n 夜间使用 \n 场景第二行 \t');

    // 文字原样：首尾空白、换行、emoji、网页标记样文本不丢字符、不被改正文
    assert.equal(byId.get(first.id)?.description,
      '\n第一行末尾保留两个空格  \n第二行有制表符\t原样保留\n<p>看起来像网页标记</p>\n  ');
    assert.ok(byId.get(second.id)?.description.includes('🎉'));
    assert.ok(byId.get(second.id)?.description.includes('<div class="x">标记原样</div>'));
  } finally {
    await cleanup(server);
  }
});

test('无新增意见时重启后次序与停止前一致；重启后再提交，新意见在最前且旧记录原样保留', async () => {
  let server = await startServer();
  try {
    await sleep(10);
    const older = await createIdea(server.origin, { title: '先提交的意见', description: '较早的说明' });
    await sleep(10);
    const newer = await createIdea(server.origin, { title: '后提交的意见', description: '较晚的说明', scenario: '它的场景' });

    const beforeStop = await listIdeas(server.origin);
    assert.deepEqual(beforeStop, [newer, older].map(snapshot));

    server = await stopAndRestart(server);

    // 没有新增意见：列表次序与停止前一致
    const afterRestart = await listIdeas(server.origin);
    assert.deepEqual(afterRestart, [newer, older].map(snapshot));

    // 再次启动后继续提交一条
    await sleep(10);
    const created = await createIdea(server.origin, { title: '重启后的新意见', description: '重启后写入' });
    assert.notEqual(created.id, older.id);
    assert.notEqual(created.id, newer.id);
    assert.ok(created.createdAt > newer.createdAt, '新意见的提交时间应晚于旧意见');

    const finalList = await listIdeas(server.origin);
    assert.equal(finalList.length, 3);
    // 新意见出现在旧意见之前
    assert.deepEqual(finalList[0], snapshot(created));
    // 旧记录内容、标识、时间原样保留
    assert.deepEqual(finalList.slice(1), [newer, older].map(snapshot));
    assert.equal(finalList[1].id, newer.id);
    assert.equal(finalList[1].createdAt, newer.createdAt);
    assert.equal(finalList[2].id, older.id);
    assert.equal(finalList[2].createdAt, older.createdAt);
  } finally {
    await cleanup(server);
  }
});

test('校验失败被拒绝的提交不入库：重启后只剩此前成功保存的意见，未被覆盖或重排', async () => {
  let server = await startServer();
  try {
    const saved = await createIdea(server.origin, { title: '已保存意见', description: '应当继续保留', scenario: '原场景' });

    // 现有字段校验失败：标题去空白后为空
    const blankTitle = await postIdea(server.origin, { title: '   ', description: '不应进入列表的内容' });
    assert.equal(blankTitle.status, 400);
    assert.equal(blankTitle.data.error, '标题去掉首尾空白后不能为空');

    // 说明为空白同样被拒
    const blankDesc = await postIdea(server.origin, { title: '另一个失败标题', description: '   ' });
    assert.equal(blankDesc.status, 400);
    assert.equal(blankDesc.data.error, '详细说明必须包含非空白内容');

    // 同一进程内失败内容已与已有意见清楚区分
    assert.deepEqual(await listIdeas(server.origin), [snapshot(saved)]);

    server = await stopAndRestart(server);

    // 重启后只能查到此前成功保存的那一条，无占位、无覆盖、无重排
    const afterRestart = await listIdeas(server.origin);
    assert.equal(afterRestart.length, 1);
    assert.deepEqual(afterRestart, [snapshot(saved)]);
  } finally {
    await cleanup(server);
  }
});

test('从未保存过意见的数据目录再次使用时仍返回空列表，不出现占位记录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'featureharbor-empty-'));
  let server = await startServer(dir);
  try {
    assert.deepEqual(await listIdeas(server.origin), []);

    server = await stopAndRestart(server);

    assert.deepEqual(await listIdeas(server.origin), []);
  } finally {
    await cleanup(server);
  }
});
