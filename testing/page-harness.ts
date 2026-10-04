import vm from 'node:vm';
import assert from 'node:assert/strict';

// page.test.ts 与字符上限页面回归共用的 vm 沙箱：
// GET / 取出内联脚本原文，在带极简 DOM / 可控 fetch 的沙箱中执行，
// 每个请求的成功、失败、返回先后都可以由测试精确控制。

export interface El {
  tagName: string;
  className: string;
  hidden: boolean;
  value: string;
  dateTime: string;
  children: El[];
  text: string | null;
  textContent: string;
  listeners: Record<string, Array<(event: unknown) => unknown>>;
  append(...nodes: El[]): void;
  replaceChildren(...nodes: El[]): void;
  addEventListener(type: string, fn: (event: unknown) => unknown): void;
  reset(): void;
}

export function makeElement(tag: string): El {
  const node = {
    tagName: tag.toUpperCase(),
    className: '',
    hidden: false,
    value: '',
    dateTime: '',
    children: [],
    text: null as string | null,
    listeners: {} as Record<string, Array<(event: unknown) => unknown>>,
    append(...nodes: El[]): void {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes: El[]): void {
      this.children = [...nodes];
    },
    addEventListener(type: string, fn: (event: unknown) => unknown): void {
      (this.listeners[type] ??= []).push(fn);
    },
    reset(): void {},
  };
  Object.defineProperty(node, 'textContent', {
    get(this: any): string {
      return this.text !== null ? this.text : this.children.map((c: El) => c.textContent).join('');
    },
    set(this: any, value: unknown): void {
      this.text = String(value);
    },
  });
  return node as El;
}

export interface Gate {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export function gate(): Gate {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function jsonResponse(status: number, body: unknown): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

export function brokenJsonResponse(status = 201): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('响应体不是有效 JSON');
    },
  };
}

export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let ideaSeq = 0;
export function makeIdea(partial: Record<string, unknown> = {}): Record<string, unknown> {
  ideaSeq += 1;
  return {
    id: `id-${ideaSeq}`,
    title: `标题 ${ideaSeq}`,
    description: `详细说明 ${ideaSeq}`,
    scenario: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

export const SUCCESS_TEXT = '提交成功，你的意见已保存。';
export const EMPTY_TEXT = '还没有意见记录。';
export const LOAD_FAILED_TEXT = '意见列表加载失败，请稍后刷新重试。';
export const NETWORK_ERROR_TEXT = '网络错误，提交未成功，请重试。';

export class Harness {
  els: Record<string, El> = {};
  gets: Gate[] = [];
  getsIssued = 0;
  posts: Gate[] = [];
  postsIssued = 0;
  postBodies: unknown[] = [];

  constructor(script: string) {
    const byId: Map<string, El> = new Map();
    const register = (id: string, tag: string, hidden = false): El => {
      const node = makeElement(tag);
      node.hidden = hidden;
      byId.set(id, node);
      this.els[id] = node;
      return node;
    };
    const form = register('idea-form', 'form');
    const titleInput = register('f-title', 'input');
    const descInput = register('f-desc', 'textarea');
    const scenarioInput = register('f-scenario', 'textarea');
    register('error', 'p', true);
    register('success', 'p', true);
    register('empty', 'p', true);
    register('ideas', 'div');
    form.reset = (): void => {
      titleInput.value = '';
      descInput.value = '';
      scenarioInput.value = '';
    };
    const documentMock = {
      getElementById: (id: string): El => byId.get(id)!,
      createElement: (tag: string): El => makeElement(tag),
    };
    const fetchMock = (url: unknown, init?: { method?: string; body?: unknown }): Promise<unknown> => {
      const method = init?.method ?? 'GET';
      const pending = gate();
      if (method === 'POST') {
        this.posts.push(pending);
        this.postsIssued += 1;
        this.postBodies.push(init?.body);
      } else {
        this.gets.push(pending);
        this.getsIssued += 1;
      }
      return pending.promise;
    };
    const context = vm.createContext({ console, document: documentMock, fetch: fetchMock });
    vm.runInContext(script, context, { filename: 'inline-page-script.js' });
  }

  setForm(values: { title?: string; description?: string; scenario?: string }): void {
    if (values.title !== undefined) this.els['f-title'].value = values.title;
    if (values.description !== undefined) this.els['f-desc'].value = values.description;
    if (values.scenario !== undefined) this.els['f-scenario'].value = values.scenario;
  }

  // 模拟真实用户输入：赋值并触发 input 事件（setForm 不触发事件，只用于布置初始状态）
  edit(id: string, value: string): void {
    const el = this.els[id];
    el.value = value;
    for (const fn of el.listeners.input ?? []) fn({ target: el });
  }

  // 触发表单 submit 监听器，返回监听器（async 函数）的 Promise
  submit(): Promise<unknown> {
    const handler = this.els['idea-form'].listeners.submit[0];
    return handler({ preventDefault(): void {} });
  }

  articles(): El[] {
    return this.els.ideas.children.filter((node) => node.tagName === 'ARTICLE');
  }

  titles(): string[] {
    return this.articles().map((article) => article.children.find((n) => n.tagName === 'H3')!.textContent);
  }
}

export function findScenario(article: El): El | undefined {
  return article.children.find(
    (node) =>
      node.tagName === 'P' &&
      node.children.some((child) => child.tagName === 'STRONG' && child.textContent === '使用场景：'),
  );
}

// 校验一条已渲染的意见与原记录逐字段对应：标题、详细说明、非空使用场景、提交时间
export function assertArticleMatches(article: El, idea: Record<string, unknown>): void {
  const heading = article.children.find((n) => n.tagName === 'H3')!;
  assert.equal(heading.textContent, idea.title);
  const description = article.children.find((n) => n.tagName === 'P' && n.children.length === 0)!;
  assert.equal(description.textContent, idea.description);
  const scenarioNode = findScenario(article);
  const expectsScenario =
    typeof idea.scenario === 'string' && idea.scenario.trim().length > 0;
  assert.equal(
    Boolean(scenarioNode),
    expectsScenario,
    `使用场景展示与否应与记录一致：${String(idea.scenario)}`,
  );
  if (expectsScenario) {
    const span = scenarioNode!.children.find((n) => n.tagName === 'SPAN')!;
    assert.equal(span.textContent, idea.scenario);
  }
  const time = article.children.find((n) => n.tagName === 'TIME')!;
  assert.equal(time.dateTime, idea.createdAt);
}
