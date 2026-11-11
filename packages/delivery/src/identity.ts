/**
 * Installed-product identity for the M12 delivery record (RP-01): repository commit, dirty-tree
 * digest, lockfile digest, built-artifact tree digests, and the observed toolchain.
 *
 * Digests are plain SHA-256 over file bytes. A tree digest hashes the sorted list of
 * `relative-path NUL file-sha256 LF` lines, so it changes when any file is added, removed,
 * renamed, or edited, and it never depends on timestamps or the absolute install location.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { join, relative, sep } from 'node:path';

export type Sha256 = `sha256:${string}`;

export function sha256(bytes: Buffer | string): Sha256 {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function fileDigest(path: string): Sha256 {
  return sha256(readFileSync(path));
}

export interface TreeDigest {
  readonly digest: Sha256;
  readonly files: number;
  readonly bytes: number;
}

/** Digest every regular file below `dir` (links are refused), keyed by path relative to `base`. */
export function treeDigest(
  base: string,
  dirs: readonly string[],
  skip: (rel: string) => boolean,
): TreeDigest {
  const lines: string[] = [];
  let bytes = 0;
  const visit = (child: string) => {
    const rel = relative(base, child).split(sep).join('/');
    if (skip(rel)) return;
    const st = lstatSync(child);
    if (st.isSymbolicLink()) throw new Error(`unexpected link in artifact tree: ${rel}`);
    if (st.isDirectory()) walk(child);
    else if (st.isFile()) {
      const content = readFileSync(child);
      bytes += content.length;
      lines.push(`${rel}\u0000${sha256(content)}\n`);
    }
  };
  const walk = (full: string) => {
    for (const name of readdirSync(full).sort()) visit(join(full, name));
  };
  for (const d of dirs) if (existsSync(join(base, d))) visit(join(base, d));
  lines.sort();
  return { digest: sha256(lines.join('')), files: lines.length, bytes };
}

export interface CommandRecord {
  readonly command: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

export interface RunOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Needed for `pnpm` on Windows (a .cmd shim). Arguments are fixed strings, never user input. */
  readonly shell?: boolean;
  readonly timeoutMs?: number;
}

const tail = (s: string, n = 1200) => (s.length > n ? s.slice(-n) : s);

/** Run one fixed command and keep only a bounded tail of its output for the record. */
export function run(file: string, args: readonly string[], options: RunOptions): Promise<CommandRecord> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: { ...(options.env ?? process.env) } as NodeJS.ProcessEnv,
      shell: options.shell ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout = tail(stdout + c.toString('utf8'), 64_000)));
    child.stderr.on('data', (c: Buffer) => (stderr = tail(stderr + c.toString('utf8'), 64_000)));
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 15 * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        command: [file, ...args].join(' '),
        exitCode: code,
        durationMs: Date.now() - started,
        stdoutTail: tail(stdout),
        stderrTail: tail(stderr),
      });
    });
  });
}

export interface Toolchain {
  readonly os: string;
  readonly arch: string;
  readonly node: string;
  readonly pnpm: string;
  readonly git: string;
  readonly sqlite: string;
}

export async function observeToolchain(cwd: string): Promise<Toolchain> {
  const pnpm = await run('pnpm', ['--version'], { cwd, shell: process.platform === 'win32' });
  const git = await run('git', ['--version'], { cwd });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const sqlite = String((db.prepare('select sqlite_version() as v').get() as { v: string }).v);
  db.close();
  return {
    os: `${platform()} ${release()}`,
    arch: arch(),
    node: process.version,
    pnpm: pnpm.stdoutTail.trim(),
    git: git.stdoutTail.trim(),
    sqlite,
  };
}
