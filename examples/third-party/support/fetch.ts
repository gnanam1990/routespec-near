/**
 * Fetch the pinned third-party example sources (M48). Host side, read-only.
 *
 * For each pin: fetch exactly the pinned commit into a throw-away bare repository, read the
 * pinned files as git blobs (no checkout, so no hooks, filters, or line-ending conversion run),
 * check each blob against its pinned SHA-256, and only then write the files below
 * `.data/third-party/<id>/<commit>/` (ignored by git). Nothing fetched is ever executed here,
 * installed, or built: the only place these files run is the subject container.
 *
 * usage: node --no-warnings examples/third-party/support/fetch.ts [--only <id>] [--check]
 *   --check  verify what is already on disk and fetch nothing (no network)
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PinError,
  REPO_ROOT,
  loadPins,
  sha256,
  sourceDir,
  verifySourceTree,
  type PinnedSource,
} from './pins.ts';

export interface FetchOptions {
  /** Checkout that receives `.data/third-party/`. */
  readonly root: string;
  /** Fetch from this location instead of the pinned repository URL (tests use a local repository). */
  readonly remote?: string;
}

export interface FetchResult {
  readonly id: string;
  readonly commit: string;
  readonly dir: string;
  readonly status: 'FETCHED' | 'ALREADY_PRESENT';
  readonly files: number;
}

const MAX_FILE_BYTES = 1024 * 1024;

function git(cwd: string, args: readonly string[]): Buffer {
  const r = spawnSync(
    'git',
    [
      '-c',
      'core.hooksPath=',
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.symlinks=false',
      '-c',
      'fetch.fsckObjects=true',
      '-c',
      'advice.detachedHead=false',
      ...args,
    ],
    {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_LFS_SKIP_SMUDGE: '1' },
      maxBuffer: 8 * MAX_FILE_BYTES,
      windowsHide: true,
    },
  );
  if (r.status !== 0) {
    throw new PinError('FETCH_GIT_FAILED', `git ${args[0] ?? ''} failed (exit ${String(r.status)}).`);
  }
  return r.stdout;
}

/** Fetch one pin, or confirm that the verified files are already present. */
export function fetchSource(pin: PinnedSource, options: FetchOptions): FetchResult {
  const dir = sourceDir(options.root, pin);
  const done = (status: FetchResult['status']): FetchResult => ({
    id: pin.id,
    commit: pin.commit,
    dir,
    status,
    files: pin.files.length,
  });
  if (existsSync(dir)) {
    const check = verifySourceTree(dir, pin);
    if (check.ok) return done('ALREADY_PRESENT');
    throw new PinError(
      'FETCH_EXISTING_TREE_DIFFERS',
      `${pin.id}: the files on disk do not match the pin (${check.findings.join('; ')}). Remove the directory and fetch again.`,
    );
  }
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const scratch = join(parent, `.fetch-${randomBytes(6).toString('hex')}`);
  const bare = join(scratch, 'repo.git');
  const staged = join(scratch, 'tree');
  mkdirSync(bare, { recursive: true });
  try {
    git(bare, ['init', '--quiet', '--bare']);
    git(bare, [
      'fetch',
      '--quiet',
      '--depth',
      '1',
      '--no-tags',
      options.remote ?? pin.repository,
      pin.commit,
    ]);
    const head = git(bare, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']).toString('utf8').trim();
    if (head !== pin.commit) {
      throw new PinError('FETCH_COMMIT_MISMATCH', `${pin.id}: the remote did not return the pinned commit.`);
    }
    for (const file of pin.files) {
      const entry = git(bare, ['ls-tree', pin.commit, '--', file.path]).toString('utf8');
      const mode = entry.split(/\s/)[0] ?? '';
      if (mode !== '100644' && mode !== '100755') {
        throw new PinError('FETCH_NOT_A_REGULAR_FILE', `${pin.id}: ${file.path} is not a regular file.`);
      }
      const blob = git(bare, ['cat-file', 'blob', `${pin.commit}:${file.path}`]);
      if (blob.length > MAX_FILE_BYTES) {
        throw new PinError('FETCH_FILE_TOO_LARGE', `${pin.id}: ${file.path} is larger than the limit.`);
      }
      if (sha256(blob) !== file.sha256) {
        throw new PinError(
          'FETCH_DIGEST_MISMATCH',
          `${pin.id}: ${file.path} does not match its pinned digest.`,
        );
      }
      const target = join(staged, ...file.path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, blob, { mode: 0o444 });
    }
    renameSync(staged, dir);
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const check = verifySourceTree(dir, pin);
  if (!check.ok) {
    throw new PinError('FETCH_VERIFY_FAILED', `${pin.id}: ${check.findings.join('; ')}`);
  }
  return done('FETCHED');
}

function main(argv: readonly string[]): number {
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined;
  const checkOnly = argv.includes('--check');
  const pins = loadPins().filter((p) => only === undefined || p.id === only);
  if (pins.length === 0) {
    process.stderr.write('third-party fetch: no pinned source matches.\n');
    return 2;
  }
  let failed = 0;
  for (const pin of pins) {
    try {
      if (checkOnly) {
        const check = verifySourceTree(sourceDir(REPO_ROOT, pin), pin);
        process.stdout.write(
          `${pin.id} ${pin.commit} ${check.ok ? 'VERIFIED' : `NOT_VERIFIED (${check.findings.join('; ')})`}\n`,
        );
        if (!check.ok) failed++;
      } else {
        const r = fetchSource(pin, { root: REPO_ROOT });
        process.stdout.write(
          `${r.id} ${r.commit} ${r.status} (${String(r.files)} files, digests verified)\n`,
        );
      }
    } catch (error) {
      failed++;
      const code = error instanceof PinError ? error.code : 'FETCH_FAILED';
      process.stderr.write(`${pin.id} ${code}: ${(error as Error).message}\n`);
    }
  }
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
