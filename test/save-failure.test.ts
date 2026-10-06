import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../testing/server.ts';

// 保存位置无法写入时的回归保障：保护「已有数据能正常读取、提交内容也完全合法，
// 但保存（写临时文件或替换正式文件）失败」这一分支的现有行为。只走公开入口
// （GET/POST /api/ideas）并直接比对磁盘上的 ideas.json，在真实进程上验证：
//   1. POST 返回 500 与现有的 error（“保存意见失败，请稍后重试”），不是 201，
//      响应不带表示已保存的 idea，也不算字段错误 400 或读取历史失败；
//   2. 失败不损伤此前收集到的意见：列表数量、顺序、id、createdAt 与逐条文字不变，
//      ideas.json 与请求前逐字节一致，失败的新意见不混入；
//   3. 临时内容已写入但替换正式文件失败时，本次写出的 .tmp 普通文件被清除，
//      不被误认成已保存数据；清理本身因权限失败时也只放弃清理，响应与正式数据不变；
//   4. 保存位置恢复后，重新提交同一条合法意见返回 201，新意见排在原有意见之前，
//      列表只多出这一条，旧记录相对顺序与内容不变；
//   5. 此前没有任何意见时失败，列表仍成功返回空数组，磁盘仍是初始的 []，不出现半条记录。

interface Idea {
  id: string;
  title: string;
  description: string;
  scenario: string;
  createdAt: string;
}

// 失败期间提交的意见：三个字段都合法，任何拒绝都只能来自保存位置无法写入。
const NEW_IDEA = {
  title: '保存失败期间的新意见',
  description: '这一条标题、详细说明与使用场景都合法，失败只能来自写入存储位置。',
  scenario: '保存位置暂时不可写的场景',
};

// 故意覆盖易被破坏的文字：首尾空白标题（提交后按规则 trim）、正文与场景中的
// 空白/换行/制表符、中文、表情与网页标记样文本；第 2、3 条三字段完全相同，
// 只能靠 id 区分，失败分支里不能被合并成一条或丢弃。
const SEED_PAYLOADS: unknown[] = [
  {
    title: '  夜间模式  ',
    description: '第一行\n第二行\t保留 <b>原样</b> 😀',
    scenario: ' 场景换行\n第二行 🌙 ',
  },
  {
    title: '重复标题',
    description: '重复正文',
    scenario: '相同场景',
  },
  {
    title: '重复标题',
    description: '重复正文',
    scenario: '相同场景',
  },
];

interface Blocker {
  name: string;
  enable: (dataDir: string, file: string, tmpFile: string) => void;
  disable: (dataDir: string, file: string, tmpFile: string) => void;
  // 失败请求结束后 tmpFile 的预期形态：目录型阻塞下 tmpFile 是测试注入的目录；
  // 服务写出的临时普通文件可被删除时为 absent（不存在或已被服务清除）；
  // 临时文件已写出但目录只读导致服务无法删除时为 leftover-file（仍是普通文件）。
  tmpExpectation: 'injected-directory' | 'absent' | 'leftover-file';
  // root 进程拥有 CAP_DAC_OVERRIDE，chmod 只读不会真正阻止写入，这类环境下跳过该用例。
  requiresNonRoot?: boolean;
  // 注入方式本身依赖环境能力（如 chattr 需要 CAP_LINUX_IMMUTABLE），
  // 返回 false 时跳过该用例。
  isAvailable?: () => boolean;
}

// 探测当前环境能否给文件设置 immutable 标志（chattr +i 需要 CAP_LINUX_IMMUTABLE，
// 普通用户与部分容器内的 root 都不具备）；探测结果缓存，避免每个用例重复执行。
let immutableSupported: boolean | undefined;
function supportsImmutable(): boolean {
  if (immutableSupported !== undefined) return immutableSupported;
  const dir = freshDir();
  const probe = join(dir, 'probe');
  writeFileSync(probe, 'x');
  try {
    execFileSync('chattr', ['+i', probe], { stdio: ['ignore', 'ignore', 'ignore'] });
    immutableSupported = true;
  } catch {
    immutableSupported = false;
  }
  if (immutableSupported) {
    try {
      execFileSync('chattr', ['-i', probe], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      // 还原失败时下面的 rmSync 会连带失败，按不支持处理
      immutableSupported = false;
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    immutableSupported = false;
  }
  return immutableSupported;
}

const BLOCKERS: Blocker[] = [
  {
    // saveIdeas 先写 ideas.json.tmp 再 rename；在该路径放一个目录，
    // writeFileSync 以 EISDIR 失败，rename 根本不会执行。
    name: '临时文件路径被目录占用（writeFileSync EISDIR）',
    enable: (_dataDir, _file, tmpFile) => mkdirSync(tmpFile),
    disable: (_dataDir, _file, tmpFile) => rmdirSync(tmpFile),
    tmpExpectation: 'injected-directory',
  },
  {
    // 数据目录只读：无法在其中新建 ideas.json.tmp（EACCES），正式文件未被触碰。
    name: '数据目录只读，无法创建临时文件（EACCES）',
    enable: (dataDir) => chmodSync(dataDir, 0o555),
    disable: (dataDir) => chmodSync(dataDir, 0o755),
    tmpExpectation: 'absent',
    requiresNonRoot: true,
  },
  {
    // 正式文件不可变（chattr +i）：临时文件写入成功，rename 替换以 EPERM 失败；
    // 数据目录仍可写，本次写出的临时普通文件应被服务清除。
    name: '临时文件已写入但替换正式文件失败（rename EPERM）',
    enable: (_dataDir, file) => execFileSync('chattr', ['+i', file]),
    disable: (_dataDir, file) => execFileSync('chattr', ['-i', file]),
    tmpExpectation: 'absent',
    isAvailable: supportsImmutable,
  },
  {
    // 替换失败且临时文件无法删除：预先放置可写的普通临时文件使 writeFileSync 成功，
    // 数据目录只读使 rename 与清理临时文件都以 EACCES 失败；
    // 响应仍须是正常的保存失败，正式数据不动，遗留的临时普通文件保持普通文件形态。
    name: '替换失败且临时文件因权限无法删除（rename/unlink EACCES）',
    enable: (dataDir, _file, tmpFile) => {
      writeFileSync(tmpFile, '');
      chmodSync(dataDir, 0o555);
    },
    disable: (dataDir, _file, tmpFile) => {
      chmodSync(dataDir, 0o755);
      rmSync(tmpFile, { force: true });
    },
    tmpExpectation: 'leftover-file',
    requiresNonRoot: true,
  },
];

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'featureharbor-savefail-'));
}

async function postIdea(
  server: StartedServer,
  body: unknown,
): Promise<{ status: number; contentType: string | null; data: any }> {
  const res = await fetch(`${server.origin}/api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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

function isCompleteSavedIdea(idea: any): idea is Idea {
  return (
    typeof idea === 'object' &&
    idea !== null &&
    !Array.isArray(idea) &&
    typeof idea.id === 'string' &&
    idea.id.length > 0 &&
    typeof idea.title === 'string' &&
    typeof idea.description === 'string' &&
    typeof idea.scenario === 'string' &&
    typeof idea.createdAt === 'string' &&
    !Number.isNaN(Date.parse(idea.createdAt))
  );
}

// 失败响应必须满足的完整契约：500 + JSON 错误说明，不带任何已保存记录。
function assertSaveFailureResponse(result: { status: number; contentType: string | null; data: any }): void {
  assert.equal(result.status, 500);
  assert.notEqual(result.status, 201);
  assert.notEqual(result.status, 400);
  assert.match(result.contentType ?? '', /application\/json/);
  assert.deepEqual(result.data, { error: '保存意见失败，请稍后重试' });
  assert.equal(Object.prototype.hasOwnProperty.call(result.data, 'idea'), false);
}

// finally 中恢复环境：无论断言是否失败，先解除阻塞（含只读权限），
// 否则临时目录本身都可能无法删除。
function restoreBlocker(blocker: Blocker, dir: string, file: string, tmpFile: string): void {
  try {
    blocker.disable(dir, file, tmpFile);
  } catch {
    // 阻塞物可能已解除（如目录已不在），忽略清理时的恢复异常。
  }
}

test('保存位置无法写入：合法提交返回 500 且不损伤已有意见，恢复后重交返回 201', async (t) => {
  for (const blocker of BLOCKERS) {
    await t.test(blocker.name, async (st) => {
      if (blocker.requiresNonRoot && typeof process.getuid === 'function' && process.getuid() === 0) {
        st.skip('root 进程下只读目录不构成写入失败，跳过该注入方式');
        return;
      }
      if (blocker.isAvailable && !blocker.isAvailable()) {
        st.skip('当前环境不支持该注入方式，跳过该用例');
        return;
      }
      const dir = freshDir();
      const file = join(dir, 'ideas.json');
      const tmpFile = `${file}.tmp`;
      let server: StartedServer | undefined;
      try {
        server = await startServer(dir);

        // 通过公开接口先保存三条旧意见，基线完全以 201 返回的记录为准
        // （标题已 trim、正文与场景原空白保留）。后提交的排在前面。
        const seeded: Idea[] = [];
        for (const payload of SEED_PAYLOADS) {
          const result = await postIdea(server, payload);
          assert.equal(result.status, 201);
          assert.ok(isCompleteSavedIdea(result.data.idea));
          seeded.unshift(result.data.idea);
        }
        assert.equal(seeded.length, 3);
        // 第 2、3 条文字完全相同但必须仍是各自独立的两条记录。
        assert.notEqual(seeded[0].id, seeded[1].id);
        assert.equal(seeded[0].title, seeded[1].title);
        assert.equal(seeded[0].description, seeded[1].description);

        const beforeList = await getIdeas(server);
        assert.equal(beforeList.status, 200);
        assert.deepEqual(beforeList.data.ideas, seeded);
        const beforeBytes = readFileSync(file);

        // 让保存位置无法写入；已有数据本身仍可正常读取。
        blocker.enable(dir, file, tmpFile);

        // 第一次失败：500 + 现有错误说明，不是 201/400，响应不带 idea。
        const failed1 = await postIdea(server, NEW_IDEA);
        assertSaveFailureResponse(failed1);

        // 原有意见仍可正常读取：数量、顺序、标识、时间、逐条文字与失败前完全一致。
        const afterFail1 = await getIdeas(server);
        assert.equal(afterFail1.status, 200);
        assert.deepEqual(afterFail1.data.ideas, seeded);

        // 磁盘上的原有数据逐字节保留：不清空、不改格式、不被只含新意见的内容覆盖；
        // 也不残留服务写出的 .tmp 普通文件（除非本次清理本身因权限失败）。
        assert.ok(readFileSync(file).equals(beforeBytes), '保存失败后 ideas.json 被改动');
        if (blocker.tmpExpectation === 'absent') {
          assert.equal(existsSync(tmpFile), false, '失败后不应留下临时文件');
        } else if (blocker.tmpExpectation === 'leftover-file') {
          // 临时文件已写出且因目录只读无法删除：允许遗留，但必须仍是普通文件，
          // 正式数据与失败响应不受清理失败影响。
          assert.ok(existsSync(tmpFile) && lstatSync(tmpFile).isFile());
        } else {
          // 目录型阻塞：留在原地的只是测试注入的目录，服务没有把它写成普通文件。
          assert.ok(existsSync(tmpFile) && lstatSync(tmpFile).isDirectory());
        }

        // 再失败一次：任何一次失败请求都不能触发写入或“自愈”式重写。
        const failed2 = await postIdea(server, NEW_IDEA);
        assertSaveFailureResponse(failed2);
        const afterFail2 = await getIdeas(server);
        assert.equal(afterFail2.status, 200);
        assert.deepEqual(afterFail2.data.ideas, seeded);
        assert.ok(readFileSync(file).equals(beforeBytes), '再次保存失败后 ideas.json 被改动');

        // 保存位置恢复：列表依旧原样，恢复写入能力本身不应改动任何数据。
        blocker.disable(dir, file, tmpFile);
        assert.equal(existsSync(tmpFile), false, '恢复后不应残留临时文件');
        const afterRecoverList = await getIdeas(server);
        assert.equal(afterRecoverList.status, 200);
        assert.deepEqual(afterRecoverList.data.ideas, seeded);
        assert.ok(readFileSync(file).equals(beforeBytes), '仅恢复写入能力后 ideas.json 被改动');

        // 重新提交刚才那条合法意见：按已有功能 201 并返回完整保存结果。
        const retried = await postIdea(server, NEW_IDEA);
        assert.equal(retried.status, 201);
        assert.ok(isCompleteSavedIdea(retried.data.idea));
        const savedIdea = retried.data.idea as Idea;
        assert.equal(savedIdea.title, NEW_IDEA.title);
        assert.equal(savedIdea.description, NEW_IDEA.description);
        assert.equal(savedIdea.scenario, NEW_IDEA.scenario);
        for (const old of seeded) {
          assert.notEqual(savedIdea.id, old.id, '新意见不能复用旧记录的标识');
        }

        // 列表只多出这一条：新意见在最前，旧记录保持原来的相对顺序与内容。
        const afterSuccess = await getIdeas(server);
        assert.equal(afterSuccess.status, 200);
        assert.equal(afterSuccess.data.ideas.length, seeded.length + 1);
        assert.deepEqual(afterSuccess.data.ideas[0], savedIdea);
        assert.deepEqual(afterSuccess.data.ideas.slice(1), seeded);

        // 正常停止并用同一数据目录重启：失败期间没有半条记录，成功提交的一条与
        // 全部旧记录的标识、时间、文字与次序在重启后仍保持一致。
        await server.stop();
        server = undefined;
        server = await startServer(dir);
        const afterRestart = await getIdeas(server);
        assert.equal(afterRestart.status, 200);
        assert.deepEqual(afterRestart.data.ideas, [savedIdea, ...seeded]);
        assert.equal(existsSync(tmpFile), false);
      } finally {
        restoreBlocker(blocker, dir, file, tmpFile);
        await safeStop(server);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

test('此前没有任何意见时保存失败：列表仍成功返回空数组，磁盘保持初始空数据', async (t) => {
  for (const blocker of BLOCKERS) {
    await t.test(blocker.name, async (st) => {
      if (blocker.requiresNonRoot && typeof process.getuid === 'function' && process.getuid() === 0) {
        st.skip('root 进程下只读目录不构成写入失败，跳过该注入方式');
        return;
      }
      if (blocker.isAvailable && !blocker.isAvailable()) {
        st.skip('当前环境不支持该注入方式，跳过该用例');
        return;
      }
      const dir = freshDir();
      const file = join(dir, 'ideas.json');
      const tmpFile = `${file}.tmp`;
      let server: StartedServer | undefined;
      try {
        server = await startServer(dir);

        // 从未提交过：首启创建的就是 []\n，查询成功返回空列表。
        assert.equal(readFileSync(file, 'utf8'), '[]\n');
        const emptyBefore = await getIdeas(server);
        assert.equal(emptyBefore.status, 200);
        assert.deepEqual(emptyBefore.data, { ideas: [] });

        blocker.enable(dir, file, tmpFile);
        const failed = await postIdea(server, NEW_IDEA);
        assertSaveFailureResponse(failed);

        // 空数据可以正常读取：不能误报读取损坏（不是 500），也不能混入半条记录。
        const emptyAfter = await getIdeas(server);
        assert.equal(emptyAfter.status, 200);
        assert.deepEqual(emptyAfter.data, { ideas: [] });
        assert.equal(readFileSync(file, 'utf8'), '[]\n', '失败后初始空数据被改写');
        if (blocker.tmpExpectation === 'absent') {
          assert.equal(existsSync(tmpFile), false);
        } else if (blocker.tmpExpectation === 'leftover-file') {
          assert.ok(existsSync(tmpFile) && lstatSync(tmpFile).isFile());
        } else {
          assert.ok(lstatSync(tmpFile).isDirectory());
        }

        blocker.disable(dir, file, tmpFile);
        const retried = await postIdea(server, NEW_IDEA);
        assert.equal(retried.status, 201);
        assert.ok(isCompleteSavedIdea(retried.data.idea));
        const listed = await getIdeas(server);
        assert.equal(listed.status, 200);
        assert.equal(listed.data.ideas.length, 1);
        assert.deepEqual(listed.data.ideas[0], retried.data.idea);
      } finally {
        restoreBlocker(blocker, dir, file, tmpFile);
        await safeStop(server);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
