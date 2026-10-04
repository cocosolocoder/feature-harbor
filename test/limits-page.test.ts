import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, removeDataDir, type StartedServer } from '../testing/server.ts';
import {
  Harness,
  flush,
  jsonResponse,
  makeIdea,
  SUCCESS_TEXT,
  assertArticleMatches,
} from '../testing/page-harness.ts';
import {
  LIMITS,
  codePoints,
  boundaryMixed,
  boundaryEmojiLast,
  titleSurroundingWhitespace,
  descriptionSurroundingWhitespace,
  descriptionPushedOverByWhitespace,
  fixedAfterRejection,
  overByOneCases,
  type IdeaForm,
} from '../testing/limits-fixtures.ts';

// 字符上限的首页表单侧回归。与接口侧（limits-api.test.ts）共用同一份边界载荷
// （testing/limits-fixtures.ts）：同一内容从表单入口提交必须与接口入口结果一致。
// 被测脚本是真实服务 GET / 返回的内联脚本原文，在带极简 DOM / 可控 fetch 的
// vm 沙箱中执行（沙箱与 page.test.ts 共用 testing/page-harness.ts）。
//
// 覆盖：
// - 三个字段恰好达上限（中文、表情、多码点序列、换行混合）：发出请求、成功提示、
//   展示服务确认保存的意见、未继续编辑时三个输入框按现有行为清空；
// - 任一字段超一个码点：发请求前显示对应字段错误、保留全部输入、列表不增加、无成功提示；
// - 标题首尾空白在判断长度前去除（请求体仍是原文），详细说明的首尾空白与换行计入长度并保留；
// - 超限后缩短到允许范围即可正常提交，之前的错误不继续阻止保存。

let server: StartedServer;
let pageScript: string;

before(async () => {
  server = await startServer();
  const res = await fetch(`${server.origin}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  const start = html.indexOf('<script>');
  const end = html.lastIndexOf('</script>');
  assert.notEqual(start, -1);
  assert.ok(end > start);
  pageScript = html.slice(start + '<script>'.length, end);
});

after(async () => {
  await server.stop();
  removeDataDir(server);
});

function setForm(h: Harness, form: IdeaForm): void {
  h.setForm({
    title: form.title,
    description: form.description,
    scenario: form.scenario ?? '',
  });
}

// 触发提交并只等一个微任务周期：前端校验失败时处理器在首个 await 之前同步返回，
// 此处即已落定；若错误实现放行了超限内容，处理器会挂在永不回应的 fetch 上，
// 但 postsIssued 等同步断言仍能立即失败，不依赖 mock 响应、也不会挂住测试。
async function submitExpectingClientRejection(h: Harness): Promise<void> {
  const pending = h.submit();
  await Promise.race([pending, flush()]);
}

// 按现有服务端规则构造“服务确认保存后”的响应记录：
// 标题去掉首尾空白，详细说明与使用场景原样保留。
function savedIdea(form: IdeaForm): Record<string, unknown> {
  return makeIdea({
    id: 'saved-1',
    title: form.title.trim(),
    description: form.description,
    scenario: form.scenario ?? '',
  });
}

test('三个字段恰好达上限的混合边界内容：发出请求，成功后展示实际保存的意见并清空三个输入框', async () => {
  assert.equal(codePoints(boundaryMixed.title), LIMITS.title);
  assert.equal(codePoints(boundaryMixed.description!), LIMITS.description);
  assert.equal(codePoints(boundaryMixed.scenario!), LIMITS.scenario);

  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  setForm(h, boundaryMixed);
  const done = h.submit();
  // 通过了前端校验、确实发出了提交请求，请求体就是三个输入框的原文
  assert.equal(h.postsIssued, 1);
  assert.deepEqual(JSON.parse(h.postBodies[0] as string), {
    title: boundaryMixed.title,
    description: boundaryMixed.description,
    scenario: boundaryMixed.scenario,
  });

  const saved = savedIdea(boundaryMixed);
  h.posts[0].resolve(jsonResponse(201, { idea: saved }));
  await done;
  await flush();

  // 服务确认保存后显示成功提示，展示的是服务端返回的实际记录（含换行与表情）
  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.success.textContent, SUCCESS_TEXT);
  assert.equal(h.els.error.hidden, true);
  const articles = h.articles();
  assert.equal(articles.length, 1);
  assertArticleMatches(articles[0], saved);
  // 详细说明中的换行在渲染文本中原样保留（class=pre，textContent 不做转义折行处理）
  assert.equal(
    articles[0].children.find((n) => n.tagName === 'P' && n.children.length === 0)!.textContent,
    boundaryMixed.description,
  );

  // 没有继续编辑：三个输入框按现有行为清空
  assert.equal(h.els['f-title'].value, '');
  assert.equal(h.els['f-desc'].value, '');
  assert.equal(h.els['f-scenario'].value, '');
});

test('😀 在三个字段中都只算一个码点：以表情收尾恰好到顶的内容通过前端校验并发出请求', async () => {
  const h = new Harness(pageScript);
  setForm(h, boundaryEmojiLast);
  const done = h.submit();
  assert.equal(h.postsIssued, 1, '😀 按 1 码点计时恰好到顶，不应被前端拦截');

  const saved = savedIdea(boundaryEmojiLast);
  h.posts[0].resolve(jsonResponse(201, { idea: saved }));
  await done;
  await flush();

  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.error.hidden, true);
  assertArticleMatches(h.articles()[0], saved);
});

test('带首尾空白的合法上限标题：去空白后判长通过，请求体保留原文，成功后展示服务端 trim 的标题', async () => {
  const form: IdeaForm = { title: titleSurroundingWhitespace, description: '说明' };
  const h = new Harness(pageScript);
  setForm(h, form);
  const done = h.submit();
  assert.equal(h.postsIssued, 1);
  // 前端发送的是输入框原文（含首尾空白与换行），trim 由服务端完成
  assert.deepEqual(JSON.parse(h.postBodies[0] as string), {
    title: titleSurroundingWhitespace,
    description: '说明',
    scenario: '',
  });

  const saved = savedIdea(form);
  h.posts[0].resolve(jsonResponse(201, { idea: saved }));
  await done;
  await flush();

  assert.equal(h.els.success.hidden, false);
  // 展示的是实际保存的标题（首尾空白已去除），共 120 码点
  assert.deepEqual(h.titles(), ['题'.repeat(LIMITS.title)]);
  assert.equal(codePoints(h.articles()[0].children.find((n) => n.tagName === 'H3')!.textContent), LIMITS.title);
});

test('详细说明恰好 5000 码点（首尾空白与换行计入长度）：通过校验，保存与展示原样保留', async () => {
  const form: IdeaForm = { title: '正文边界', description: descriptionSurroundingWhitespace };
  const h = new Harness(pageScript);
  setForm(h, form);
  const done = h.submit();
  assert.equal(h.postsIssued, 1);
  assert.deepEqual(JSON.parse(h.postBodies[0] as string), {
    title: '正文边界',
    description: descriptionSurroundingWhitespace,
    scenario: '',
  });

  const saved = savedIdea(form);
  h.posts[0].resolve(jsonResponse(201, { idea: saved }));
  await done;
  await flush();

  assert.equal(h.els.success.hidden, false);
  assertArticleMatches(h.articles()[0], saved);
});

test('关键区分：首尾空白的上限标题可提交，而仅被首尾空白推到超限的详细说明在发请求前被拒', async () => {
  // 合法：标题 trim 后恰好 120
  const h1 = new Harness(pageScript);
  h1.setForm({ title: titleSurroundingWhitespace, description: '合法标题说明' });
  const okSubmit = h1.submit();
  assert.equal(h1.postsIssued, 1, 'trim 后恰好 120 码点的标题应允许提交');
  h1.posts[0].resolve(jsonResponse(201, { idea: savedIdea({ title: titleSurroundingWhitespace, description: '合法标题说明' }) }));
  await okSubmit;
  assert.equal(h1.els.success.hidden, false);
  assert.equal(h1.els.error.hidden, true);

  // 拒绝：正文原文 5001 码点（首尾各一个空白），不能先 trim 再判
  const h2 = new Harness(pageScript);
  h2.setForm({ title: '被空白推超限', description: descriptionPushedOverByWhitespace });
  await submitExpectingClientRejection(h2);
  assert.equal(h2.postsIssued, 0, '详细说明按原文计长，超限必须在发请求前拦截');
  assert.equal(h2.els.error.hidden, false);
  assert.equal(h2.els.error.textContent, '详细说明最多 5000 个字符。');
  assert.equal(h2.els.success.hidden, true);
});

test('任一字段超一个码点：发请求前显示对应字段错误、保留全部输入、列表不增加、无成功提示', async (t) => {
  for (const c of overByOneCases) {
    await t.test(c.name, async () => {
      const h = new Harness(pageScript);
      // 列表里先有一条已有记录
      const existing = makeIdea({ id: 'r1', title: '已有意见' });
      h.gets[0].resolve(jsonResponse(200, { ideas: [existing] }));
      await flush();

      setForm(h, c.form);
      await submitExpectingClientRejection(h);

      // 请求根本没有发出
      assert.equal(h.postsIssued, 0, c.name);
      // 对应字段的明确错误
      assert.equal(h.els.error.hidden, false, c.name);
      assert.equal(h.els.error.textContent, c.pageError, c.name);
      // 不出现保存成功提示
      assert.equal(h.els.success.hidden, true, c.name);
      // 三个输入框的全部输入原样保留（含空白与换行）
      assert.equal(h.els['f-title'].value, c.form.title, c.name);
      assert.equal(h.els['f-desc'].value, c.form.description, c.name);
      assert.equal(h.els['f-scenario'].value, c.form.scenario ?? '', c.name);
      // 列表不增加记录
      assert.deepEqual(h.titles(), ['已有意见'], c.name);
    });
  }
});

test('超限被前端拦截后，把字段缩短到允许范围：之前的错误不再阻止保存，提交成功并清空表单', async () => {
  const h = new Harness(pageScript);
  h.gets[0].resolve(jsonResponse(200, { ideas: [] }));
  await flush();

  // 先用超限标题（120 个中文 + 😀 = 121 码点）提交，被前端拦截
  const overTitle = '题'.repeat(LIMITS.title) + '😀';
  h.setForm({
    title: overTitle,
    description: fixedAfterRejection.description,
    scenario: fixedAfterRejection.scenario,
  });
  await submitExpectingClientRejection(h);
  assert.equal(h.postsIssued, 0);
  assert.equal(h.els.error.textContent, '标题最多 120 个字符。');
  assert.equal(h.els['f-title'].value, overTitle);

  // 用户把标题缩短到允许范围（模拟真实编辑会触发 input 事件）
  h.edit('f-title', fixedAfterRejection.title);
  const retry = h.submit();
  assert.equal(h.postsIssued, 1, '缩短到上限后应能正常提交，之前的错误不能继续阻止保存');
  assert.deepEqual(JSON.parse(h.postBodies[0] as string), {
    title: fixedAfterRejection.title,
    description: fixedAfterRejection.description,
    scenario: fixedAfterRejection.scenario,
  });

  const saved = savedIdea(fixedAfterRejection);
  h.posts[0].resolve(jsonResponse(201, { idea: saved }));
  await retry;
  await flush();

  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.success.textContent, SUCCESS_TEXT);
  assert.equal(h.els.error.hidden, true);
  assert.equal(h.articles().length, 1);
  assertArticleMatches(h.articles()[0], saved);
  // 第二次提交后未再编辑，三个输入框清空
  assert.equal(h.els['f-title'].value, '');
  assert.equal(h.els['f-desc'].value, '');
  assert.equal(h.els['f-scenario'].value, '');
});

test('被首尾空白推超限的详细说明：缩短（去掉一个首尾空白）后通过校验并正常提交', async () => {
  const h = new Harness(pageScript);
  h.setForm({ title: '标题', description: descriptionPushedOverByWhitespace });
  await submitExpectingClientRejection(h);
  assert.equal(h.postsIssued, 0);
  assert.equal(h.els.error.textContent, '详细说明最多 5000 个字符。');

  // 去掉一个首尾空白，原文回到 5000 码点，且仍以非空白内容满足必填
  const fixedDescription = descriptionPushedOverByWhitespace.slice(1);
  assert.equal(codePoints(fixedDescription), LIMITS.description);
  h.edit('f-desc', fixedDescription);
  const retry = h.submit();
  assert.equal(h.postsIssued, 1);

  const saved = makeIdea({ id: 'saved-2', title: '标题', description: fixedDescription, scenario: '' });
  h.posts[0].resolve(jsonResponse(201, { idea: saved }));
  await retry;
  await flush();

  assert.equal(h.els.success.hidden, false);
  assert.equal(h.els.error.hidden, true);
  assertArticleMatches(h.articles()[0], saved);
});
