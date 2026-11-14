/**
 * M61 — a console restarted right after the previous one was stopped.
 *
 * Only one live process may write a data directory (the journal writer lock). A console that
 * was just killed can still be exiting when the next one starts; the new one waits a few seconds
 * for that holder to go away instead of failing at once, and when the holder stays alive it
 * exits with a plain RS_WRITER_LOCKED message. Real processes only: the control service entry
 * point and a separate Node process standing in for the previous holder.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  // Newest first: stop the processes before their data directory is removed.
  for (const c of cleanups.splice(0).reverse()) await c();
});

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  return exited;
}

function holder(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  cleanups.push(() => stop(child));
  return child;
}

function lockedDataDir(pid: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'routespec-m61-lock-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'journal.db.writer.lock'), JSON.stringify({ pid, token: 'previous-console' }));
  return dir;
}

function startControl(dataDir: string): {
  child: ChildProcess;
  firstLine: Promise<string | null>;
  exit: Promise<number | null>;
  stderr: () => string;
} {
  const child = spawn(
    process.execPath,
    ['--no-warnings', MAIN, '--data', dataDir, '--handoff', 'none', '--no-log'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  cleanups.push(() => stop(child));
  let out = '';
  let err = '';
  child.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
  const firstLine = new Promise<string | null>((resolve) => {
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
      if (out.includes('\n')) resolve(out.split('\n')[0] ?? null);
    });
    child.once('exit', () => resolve(null));
  });
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, firstLine, exit, stderr: () => err };
}

describe('M61 — console restart and the journal writer lock', () => {
  it('waits for a previous holder that exits shortly after, then starts', async () => {
    const previous = holder();
    const dir = lockedDataDir(previous.pid as number);
    const control = startControl(dir);
    setTimeout(() => previous.kill('SIGKILL'), 1_500);
    const line = await control.firstLine;
    expect(line, control.stderr()).not.toBeNull();
    expect(JSON.parse(line as string)).toMatchObject({
      origin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
    });
  });

  it('gives up with a plain RS_WRITER_LOCKED message while another live process holds the directory', async () => {
    const previous = holder();
    const dir = lockedDataDir(previous.pid as number);
    const control = startControl(dir);
    expect(await control.exit).toBe(4);
    expect(await control.firstLine).toBeNull();
    expect(control.stderr()).toContain('RS_WRITER_LOCKED');
    expect(control.stderr()).toContain('only one console or CLI process can open a data directory at a time');
  });
});
