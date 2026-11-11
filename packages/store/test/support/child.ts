/** Spawn the crash child and collect its JSON status lines. */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CHILD_SCRIPT = fileURLToPath(new URL('./crash-child.ts', import.meta.url));

export interface ChildRun {
  readonly child: ChildProcess;
  readonly lines: Array<Record<string, unknown>>;
  waitFor(event: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export function spawnChild(args: unknown): ChildRun {
  const child = spawn(process.execPath, ['--no-warnings', CHILD_SCRIPT, JSON.stringify(args)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  let buffer = '';
  let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) lines.push(JSON.parse(line) as Record<string, unknown>);
      waiters.splice(0).forEach((w) => w());
    }
  });
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => {
      waiters.splice(0).forEach((w) => w());
      resolve({ code, signal });
    }),
  );
  let exitedFlag = false;
  void exit.then(() => (exitedFlag = true));
  return {
    child,
    lines,
    waitFor(event: string, timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error(`timeout waiting for ${event}; stderr: ${stderr.slice(0, 2000)}`)),
          timeoutMs,
        );
        const check = () => {
          const hit = lines.find((l) => l['event'] === event);
          if (hit) {
            clearTimeout(deadline);
            resolve(hit);
          } else if (exitedFlag) {
            clearTimeout(deadline);
            reject(
              new Error(
                `child exited before ${event}; lines=${JSON.stringify(lines)}; stderr: ${stderr.slice(0, 2000)}`,
              ),
            );
          } else {
            waiters.push(check);
          }
        };
        check();
      });
    },
    exited: () => exit,
  };
}
