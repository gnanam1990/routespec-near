/**
 * SEC RS-05 — the journal data directory and journal files are owner-only.
 *
 * SECURITY.md section 9: the data directory uses owner-only permissions where supported,
 * whichever entry point creates or reuses it. Under the common 0022 umask a CLI command that
 * opens the journal must leave the directory at 0700 and journal.db (and its -wal, -shm and
 * writer-lock companions) at 0600, and a data directory that already existed with permissive
 * modes is tightened when it is reused. Windows has no POSIX mode bits, so the mode checks run
 * on POSIX hosts only.
 */
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RouteSpecStore, ensurePrivateDataDir } from '@routespec/store';
import { runCli } from '../src/index.ts';
import { tempDir } from './support/product.ts';

const posix = process.platform !== 'win32';
let tmp: ReturnType<typeof tempDir>;
let previousUmask = 0;

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

async function projectCreate(data: string): Promise<number> {
  const out: string[] = [];
  const code = await runCli(['project', 'create', '--data', data, '--name', 'rs05 project'], {
    env: {},
    stdout: (s: string) => out.push(s),
    stderr: () => undefined,
  });
  expect(code, out.join('')).toBe(0);
  return code;
}

function expectJournalPrivate(data: string): void {
  expect(mode(data).toString(8)).toBe('700');
  for (const suffix of ['', '-wal', '-shm', '.writer.lock']) {
    const file = join(data, `journal.db${suffix}`);
    if (existsSync(file)) expect(`${suffix}:${mode(file).toString(8)}`).toBe(`${suffix}:600`);
  }
}

describe.skipIf(!posix)('SEC RS-05: owner-only journal data directory', () => {
  beforeAll(() => {
    tmp = tempDir('routespec-rs05-');
    previousUmask = process.umask(0o022);
  });
  afterAll(() => {
    process.umask(previousUmask);
    tmp.cleanup();
  });

  it('a CLI-created data directory is 0700 and journal.db is 0600 under umask 0022', async () => {
    const data = join(tmp.dir, 'fresh', 'data');
    await projectCreate(data);
    expect(existsSync(join(data, 'journal.db'))).toBe(true);
    expectJournalPrivate(data);
  });

  it('an existing world-readable data directory and journal are tightened on reuse', async () => {
    const data = join(tmp.dir, 'existing');
    await projectCreate(data);
    chmodSync(data, 0o755);
    chmodSync(join(data, 'journal.db'), 0o644);
    await projectCreate(data);
    expectJournalPrivate(data);
  });

  it('the shared helper tightens an existing directory the way the service needs', () => {
    const data = join(tmp.dir, 'service');
    mkdirSync(data, { mode: 0o755 });
    chmodSync(data, 0o755);
    ensurePrivateDataDir(data);
    expect(mode(data).toString(8)).toBe('700');
  });

  it('the store tightens a permissive journal file it opens directly', () => {
    const dir = join(tmp.dir, 'store');
    ensurePrivateDataDir(dir);
    const path = join(dir, 'journal.db');
    writeFileSync(path, '', { mode: 0o644 });
    chmodSync(path, 0o644);
    const store = RouteSpecStore.open({ path });
    try {
      expectJournalPrivate(dir);
    } finally {
      store.close();
    }
  });
});
