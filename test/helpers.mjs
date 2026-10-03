import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const serverFile = join(projectRoot, 'server.ts');
// 默认使用系统 Chrome，可用 CHROME_BIN 指定其他可执行文件
const chromePath = process.env.CHROME_BIN || '/usr/bin/google-chrome';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 启动真实的 server.ts，端口由系统分配，数据使用独立临时目录
export async function startBackend({ dataDir } = {}) {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'featureharbor-'));
  const child = spawn(process.execPath,
    [serverFile, 'serve', '--host', '127.0.0.1', '--port', '0', '--data-dir', dir],
    { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待服务启动超时：\n${output}`)), 15000);
    child.stdout.on('data', function onData() {
      const match = output.match(/listening on (http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(match[1].endsWith('/') ? match[1] : `${match[1]}/`);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`服务提前退出（代码 ${code}）：\n${output}`));
    });
  });

  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${url}health`);
      if (res.ok) break;
    } catch {
      // 服务尚未就绪，继续等待
    }
    await sleep(50);
  }

  return {
    url,
    dir,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(3000),
      ]);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve)).catch(() => {});
      }
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
    // 直接破坏数据文件，用于制造接口 500
    corruptStore() {
      writeFileSync(join(dir, 'ideas.json'), '不是 JSON', 'utf8');
    },
  };
}

// 被测页面与真实服务之间的小型代理：
// 可以挂起/拒绝首次列表请求和提交请求，用于精确控制返回先后与失败场景
export async function startProxy(targetUrl) {
  const target = new URL(targetUrl);
  const heldGets = [];
  const holdWaiters = [];
  const counts = { getIdeas: 0, postIdeas: 0 };
  // getIdeas/postIdeas 取值：'normal' | 'fail' | 'hold' | 'destroy'，也可以是按次数决定动作的函数
  const config = { getIdeas: 'normal', postIdeas: 'normal' };

  function forward(req, res) {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', () => { try { res.destroy(); } catch { /* 连接已关闭 */ } });
    req.on('end', () => {
      const upstream = httpRequest({
        hostname: target.hostname,
        port: Number(target.port),
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      });
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        try { res.end(); } catch { /* 连接已关闭 */ }
      });
      for (const chunk of chunks) upstream.write(chunk);
      upstream.end();
    });
  }

  const proxy = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/api/ideas' && req.method === 'GET') {
      counts.getIdeas += 1;
      const action = typeof config.getIdeas === 'function' ? config.getIdeas(counts.getIdeas) : config.getIdeas;
      if (action === 'fail') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: '模拟列表加载失败' }));
        return;
      }
      if (action === 'hold') {
        const gate = {};
        gate.ready = new Promise((resolve) => { gate.go = resolve; });
        heldGets.push(gate);
        while (holdWaiters.length) holdWaiters.shift()();
        // 不传 reply 时放行到真实服务；传入 { status, json } 时直接返回模拟响应
        gate.ready.then((reply) => {
          if (reply && reply.json !== undefined) {
            const body = JSON.stringify(reply.json);
            res.writeHead(reply.status ?? 200, {
              'content-type': 'application/json; charset=utf-8',
              'content-length': Buffer.byteLength(body),
            });
            res.end(body);
          } else {
            forward(req, res);
          }
        });
        return;
      }
    }
    if (path === '/api/ideas' && req.method === 'POST') {
      counts.postIdeas += 1;
      const action = typeof config.postIdeas === 'function' ? config.postIdeas(counts.postIdeas) : config.postIdeas;
      if (action === 'fail') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: '模拟提交失败' }));
        return;
      }
      if (action === 'destroy') {
        req.resume();
        res.destroy();
        return;
      }
    }
    forward(req, res);
  });

  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const port = proxy.address().port;

  return {
    url: `http://127.0.0.1:${port}/`,
    config,
    counts,
    // 等待下一个进入挂起状态的列表请求
    waitForHeldGet() {
      if (heldGets.length > 0) return Promise.resolve();
      return new Promise((resolve) => holdWaiters.push(resolve));
    },
    // 放行最早被挂起的列表请求；传入 { status, json } 则返回模拟响应
    releaseGet(reply) {
      heldGets.shift()?.go(reply);
    },
    async close() {
      // 浏览器会保留到代理的空闲 keep-alive 连接，必须主动关闭，否则 close 回调不会触发
      proxy.close();
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.once('close', resolve));
    },
  };
}

// 组合：真实服务 + 控制代理
export async function startApp() {
  const backend = await startBackend();
  const proxy = await startProxy(backend.url);
  return {
    // 浏览器访问代理地址
    url: proxy.url,
    // 直接访问真实服务（准备数据、绕过代理）
    directUrl: backend.url,
    dir: backend.dir,
    config: proxy.config,
    counts: proxy.counts,
    waitForHeldGet: proxy.waitForHeldGet,
    releaseGet: proxy.releaseGet,
    corruptStore: backend.corruptStore,
    async stop() {
      await proxy.close();
      await backend.stop();
      backend.cleanup();
    },
  };
}

export async function launchBrowser() {
  return puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
}

// 直接调用接口创建意见，用于准备初始数据
export async function createIdea(baseUrl, body) {
  const res = await fetch(`${baseUrl}api/ideas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`准备数据失败：${JSON.stringify(data)}`);
  return data.idea;
}

const dom = {
  async open(browser, appUrl) {
    const page = await browser.newPage();
    page.pageErrors = [];
    page.on('pageerror', (error) => page.pageErrors.push(String(error)));
    const homeUrl = new URL('/', appUrl).toString();
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded' });
    return page;
  },
  async close(page) {
    await page.close().catch(() => {});
  },
  async fill(page, { title = '', description = '', scenario = '' } = {}) {
    await page.$eval('#f-title', (el, value) => { el.value = value; }, title);
    await page.$eval('#f-desc', (el, value) => { el.value = value; }, description);
    await page.$eval('#f-scenario', (el, value) => { el.value = value; }, scenario);
  },
  async values(page) {
    return page.evaluate(() => ({
      title: document.getElementById('f-title').value,
      description: document.getElementById('f-desc').value,
      scenario: document.getElementById('f-scenario').value,
    }));
  },
  submit(page) {
    return page.click('#idea-form button[type="submit"]');
  },
  // 页面当前展示的意见，按展示顺序返回
  ideas(page) {
    return page.evaluate(() => Array.from(document.querySelectorAll('#ideas .idea')).map((el) => {
      const scenarioLabel = Array.from(el.querySelectorAll('p strong'))
        .find((strong) => strong.textContent?.includes('使用场景'));
      return {
        title: el.querySelector('h3')?.textContent ?? null,
        description: el.querySelector('h3 + p.pre')?.textContent ?? null,
        hasScenario: Boolean(scenarioLabel),
        scenario: scenarioLabel?.parentElement.querySelector('span.pre')?.textContent ?? null,
        createdAt: el.querySelector('time')?.dateTime ?? null,
      };
    }));
  },
  status(page) {
    return page.evaluate(() => {
      const read = (id) => {
        const el = document.getElementById(id);
        return { text: el.textContent.trim(), hidden: el.hidden };
      };
      return { success: read('success'), error: read('error'), empty: read('empty') };
    });
  },
  waitIdeas(page, count) {
    return page.waitForFunction(
      (n) => document.querySelectorAll('#ideas .idea').length === n,
      { timeout: 10000 }, count,
    );
  },
  waitSuccessVisible(page) {
    return page.waitForFunction(
      () => !document.getElementById('success').hidden,
      { timeout: 10000 },
    );
  },
  waitErrorVisible(page) {
    return page.waitForFunction(
      () => !document.getElementById('error').hidden,
      { timeout: 10000 },
    );
  },
  waitEmptyText(page, text) {
    return page.waitForFunction(
      (expected) => {
        const el = document.getElementById('empty');
        return !el.hidden && el.textContent.trim() === expected;
      },
      { timeout: 10000 }, text,
    );
  },
};

export { dom };
