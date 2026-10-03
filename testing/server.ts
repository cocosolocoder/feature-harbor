import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_TS = join(REPO_ROOT, 'server.ts');

export interface StartedServer {
  origin: string;
  dataDir: string;
  stop: () => Promise<void>;
}

// 启动一份真实的 server.ts（端口 0 自动选择可用端口，数据目录相互隔离）。
export function startServer(dataDir?: string): Promise<StartedServer> {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'featureharbor-'));
  const child: ChildProcess = spawn(
    process.execPath,
    [SERVER_TS, 'serve', '--host', '127.0.0.1', '--port', '0', '--data-dir', dir],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onExit = (code: unknown): void => {
      reject(new Error(`测试服务提前退出，退出码 ${String(code)}`));
    };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      const match = buffer.match(/listening on (http:\/\/\S+)/);
      if (match) {
        child.removeListener('exit', onExit);
        child.stdout.off('data', onData);
        resolve({
          origin: match[1],
          dataDir: dir,
          stop: () =>
            new Promise<void>((done) => {
              child.once('exit', () => done());
              child.kill('SIGTERM');
              setTimeout(() => child.kill('SIGKILL'), 3000).unref();
            }),
        });
      }
    };
    child.on('exit', onExit);
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  });
}

export function removeDataDir(server: StartedServer): void {
  rmSync(server.dataDir, { recursive: true, force: true });
}
