/**
 * The control service started through its real entry point (`packages/control-api/src/main.ts`)
 * as its own process, exactly as an operator would run it. One-time secrets reach this test only
 * over the inherited IPC pipe (`--handoff ipc`); stdout and stderr are captured so they can be
 * scanned like any other log.
 */
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { raw, type Reply } from '../../../control-api/test/support/fixture.ts';

export const MAIN = fileURLToPath(new URL('../../../control-api/src/main.ts', import.meta.url));
export const CONSOLE_APP = fileURLToPath(new URL('../../../../apps/console/', import.meta.url));
export const CONSOLE_DIST = join(CONSOLE_APP, 'dist');

/** Build the console bundle once if this checkout has none (same build as `pnpm build:console`). */
export function ensureConsoleBuilt(): string {
  if (!existsSync(join(CONSOLE_DIST, 'index.html'))) {
    execFileSync(process.execPath, [join(CONSOLE_APP, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
      cwd: CONSOLE_APP,
      stdio: 'ignore',
      timeout: 180_000,
    });
  }
  return CONSOLE_DIST;
}

export interface ControlProcess {
  readonly child: ChildProcess;
  readonly port: number;
  readonly origin: string;
  readonly token: string;
  readonly confirmations: Array<Record<string, unknown>>;
  stdout(): string;
  stderr(): string;
  api(
    method: string,
    path: string,
    body?: unknown,
    opts?: {
      idem?: string | null;
      ifMatch?: number;
      headers?: Record<string, string>;
      token?: string | null;
    },
  ): Promise<Reply>;
  kill(): Promise<void>;
}

let n = 0;
const key = () => `m11-${process.pid}-${++n}-${Math.random().toString(36).slice(2, 10)}`;

export async function startControlProcess(input: {
  dataDir: string;
  consoleDir?: string;
  env?: Record<string, string>;
}): Promise<ControlProcess> {
  const env: Record<string, string> = {};
  for (const k of [
    'PATH',
    'Path',
    'SystemRoot',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'HOME',
  ])
    if (process.env[k] !== undefined) env[k] = process.env[k] as string;
  Object.assign(env, input.env ?? {});
  const args = ['--data', input.dataDir, '--handoff', 'ipc'];
  if (input.consoleDir) args.push('--console', input.consoleDir);
  const child = fork(MAIN, args, {
    execArgv: ['--no-warnings'],
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
  child.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
  const confirmations: Array<Record<string, unknown>> = [];
  const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const onExit = (code: number | null) =>
      reject(new Error(`control process exited ${code}: ${err.slice(0, 400)}`));
    child.once('exit', onExit);
    child.on('message', (m: unknown) => {
      const msg = m as Record<string, unknown>;
      if (msg['type'] === 'routespec.confirmation') confirmations.push(msg);
      if (msg['type'] === 'routespec.console') {
        child.off('exit', onExit);
        resolve(msg);
      }
    });
  });
  const port = Number(ready['port']);
  const token = String(ready['token']);
  const api: ControlProcess['api'] = (method, path, body, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token !== null) headers['authorization'] = `Bearer ${opts.token ?? token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && opts.idem !== null) headers['idempotency-key'] = opts.idem ?? key();
    if (opts.ifMatch !== undefined) headers['if-match'] = `"${opts.ifMatch}"`;
    return raw(port, {
      method,
      path: `/__routespec/v1${path}`,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  };
  return {
    child,
    port,
    origin: String(ready['origin']),
    token,
    confirmations,
    stdout: () => out,
    stderr: () => err,
    api,
    kill: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
      }),
  };
}
