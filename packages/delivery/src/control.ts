/**
 * The installed control service as its own OS process (M08 entry point), and a typed HTTP
 * client for its loopback API. The ephemeral control token arrives only over the inherited IPC
 * pipe (`--handoff ipc`); it is never written to disk, argv, or a log.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

export type J = Record<string, unknown>;
const PREFIX = '/__routespec/v1';

export class ApiError extends Error {
  readonly status: number;
  readonly body: J;
  constructor(method: string, path: string, status: number, body: J) {
    super(`${method} ${path} -> ${status} ${JSON.stringify(body).slice(0, 400)}`);
    this.status = status;
    this.body = body;
  }
}

export interface ControlStartOptions {
  readonly root: string;
  readonly data: string;
  readonly console?: boolean;
  readonly configuredSecrets?: readonly string[];
  readonly env: Record<string, string>;
}

export class ControlProcess {
  readonly child: ChildProcess;
  readonly origin: string;
  readonly consoleUrl: string;
  readonly pid: number;
  #token: string;
  #key = 0;
  #stderr = '';

  private constructor(child: ChildProcess, origin: string, token: string, consoleUrl: string) {
    this.child = child;
    this.origin = origin;
    this.#token = token;
    this.consoleUrl = consoleUrl;
    this.pid = child.pid ?? -1;
    child.stderr?.on(
      'data',
      (c: Buffer) => (this.#stderr = (this.#stderr + c.toString('utf8')).slice(-8000)),
    );
  }

  /** The value is needed only to drive the browser and to scan persisted files for it. */
  revealToken(): string {
    return this.#token;
  }

  get stderr(): string {
    return this.#stderr;
  }

  static start(o: ControlStartOptions): Promise<ControlProcess> {
    const args = ['--data', o.data, '--handoff', 'ipc'];
    if (o.console) args.push('--console', join(o.root, 'apps', 'console', 'dist'));
    const env = { ...o.env };
    if (o.configuredSecrets && o.configuredSecrets.length > 0) {
      env['ROUTESPEC_CONFIGURED_SECRETS'] = o.configuredSecrets.join('\n');
    }
    const child = fork(join(o.root, 'packages', 'control-api', 'src', 'main.ts'), args, {
      cwd: o.root,
      env,
      execArgv: ['--no-warnings'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    return new Promise((resolve, reject) => {
      let err = '';
      child.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
      const timer = setTimeout(() => reject(new Error(`control service did not start: ${err}`)), 60_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`control service exited ${String(code)}: ${err.slice(-2000)}`));
      });
      child.on('message', (m: unknown) => {
        const msg = m as J;
        if (msg['type'] === 'routespec.console') {
          clearTimeout(timer);
          child.removeAllListeners('exit');
          resolve(
            new ControlProcess(child, String(msg['origin']), String(msg['token']), String(msg['consoleUrl'])),
          );
        }
      });
    });
  }

  async raw(
    method: string,
    path: string,
    body?: unknown,
    ifMatch?: number,
    token: string | null = this.#token,
  ): Promise<{ status: number; body: J }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token !== null) headers['authorization'] = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['idempotency-key'] = `m12-${process.pid}-${this.pid}-${++this.#key}`;
    if (ifMatch !== undefined) headers['if-match'] = `"${ifMatch}"`;
    const res = await fetch(`${this.origin}${PREFIX}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: J = {};
    try {
      parsed = text.length > 0 ? (JSON.parse(text) as J) : {};
    } catch {
      parsed = { text: text.slice(0, 200) };
    }
    return { status: res.status, body: parsed };
  }

  async api(method: string, path: string, body?: unknown, ifMatch?: number): Promise<J> {
    const r = await this.raw(method, path, body, ifMatch);
    if (r.status < 200 || r.status >= 300) throw new ApiError(method, path, r.status, r.body);
    return r.body;
  }

  /**
   * Graceful stop: closing the IPC pipe makes the service close its server and the journal
   * (the entry point's `disconnect` handler). Signals are not used because on Windows they
   * terminate the process without running handlers.
   */
  stop(): Promise<number | null> {
    return new Promise((resolve) => {
      if (this.child.exitCode !== null) return resolve(this.child.exitCode);
      this.child.once('exit', (code) => resolve(code));
      if (this.child.connected) this.child.disconnect();
      setTimeout(() => this.child.kill('SIGKILL'), 15_000).unref();
    });
  }

  /** Crash: the process is killed without closing the journal (no checkpoint, WAL left behind). */
  kill(): Promise<void> {
    return new Promise((resolve) => {
      if (this.child.exitCode !== null) return resolve();
      this.child.once('exit', () => resolve());
      this.child.kill('SIGKILL');
    });
  }
}
