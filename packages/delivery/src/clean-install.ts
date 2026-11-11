/**
 * Clean-checkout install and build (M12, RP-01, T-054).
 *
 * Clones one exact commit into an empty directory, installs the pinned lockfile with pnpm in
 * offline mode while every proxy variable points at a closed local port (so any registry or
 * provider request fails instead of silently succeeding), builds the TypeScript project
 * references and the console, and records the installed product's identity: commit, dirty-tree
 * digest, lockfile digest, built-artifact tree digests, commands, exit codes, and toolchain.
 *
 *   node packages/delivery/src/clean-install.ts --source <repo> --commit <sha> --dir <empty dir> --out <json>
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  fileDigest,
  observeToolchain,
  run,
  sha256,
  treeDigest,
  type CommandRecord,
  type Sha256,
  type Toolchain,
  type TreeDigest,
} from './identity.ts';

/** Every request a package manager or client would make through a proxy hits a closed port. */
export const CLOSED_PROXY = 'http://127.0.0.1:9';

const STRIPPED =
  /^(?:ROUTESPEC_[A-Z_]+|HTTPS?_PROXY|https?_proxy|ALL_PROXY|all_proxy|NO_PROXY|no_proxy|NODE_OPTIONS|npm_config_.*|NPM_CONFIG_.*)$/;

/** Environment for every install/build/product command: offline, no proxy route out, no secrets. */
export function offlineEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIPPED.test(k)) env[k] = v;
  return {
    ...env,
    HTTP_PROXY: CLOSED_PROXY,
    HTTPS_PROXY: CLOSED_PROXY,
    http_proxy: CLOSED_PROXY,
    https_proxy: CLOSED_PROXY,
    npm_config_offline: 'true',
    npm_config_proxy: CLOSED_PROXY,
    npm_config_https_proxy: CLOSED_PROXY,
    CI: 'true',
    ...extra,
  };
}

export interface ArtifactIdentity {
  readonly productSource: TreeDigest;
  readonly packageManifests: TreeDigest;
  readonly consoleDist: TreeDigest;
  readonly emittedDeclarations: TreeDigest;
}

export interface InstallRecord {
  readonly schema: 'routespec.delivery.install/1';
  readonly commit: string;
  readonly cleanTreeBeforeInstall: boolean;
  readonly dirtyTreeDigest: Sha256;
  readonly cleanTreeAfterBuild: boolean;
  readonly lockDigest: Sha256;
  readonly artifacts: ArtifactIdentity;
  readonly toolchain: Toolchain;
  readonly commands: CommandRecord[];
  readonly authorPathHits: string[];
  readonly ok: boolean;
}

const isWin = process.platform === 'win32';

export function artifactIdentity(dir: string): ArtifactIdentity {
  const pkgDirs = readdirSync(join(dir, 'packages')).map((p) => `packages/${p}`);
  return {
    productSource: treeDigest(
      dir,
      pkgDirs.map((p) => `${p}/src`),
      () => false,
    ),
    packageManifests: treeDigest(
      dir,
      [
        'package.json',
        'pnpm-workspace.yaml',
        ...pkgDirs.map((p) => `${p}/package.json`),
        'apps/console/package.json',
      ],
      () => false,
    ),
    consoleDist: treeDigest(dir, ['apps/console/dist'], () => false),
    emittedDeclarations: treeDigest(
      dir,
      pkgDirs.map((p) => `${p}/dist`),
      (rel) => rel.endsWith('.map'),
    ),
  };
}

/** Absolute locations that must never be baked into a built artifact. */
function authorMarkers(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const abs = resolve(p);
    out.add(abs);
    out.add(abs.split('\\').join('/'));
    out.add(abs.split('\\').join('\\\\'));
  }
  return [...out].filter((m) => m.length > 3);
}

/** Search built files (console bundle, emitted JS/declarations) for absolute machine paths. */
export function scanForPaths(dir: string, roots: readonly string[], markers: readonly string[]): string[] {
  const hits: string[] = [];
  const needles = authorMarkers(markers).map((m) => Buffer.from(m, 'utf8'));
  const walk = (full: string, rel: string) => {
    if (!existsSync(full)) return;
    for (const name of readdirSync(full, { withFileTypes: true })) {
      const childRel = `${rel}/${name.name}`;
      const child = join(full, name.name);
      if (name.isDirectory()) walk(child, childRel);
      else if (name.isFile()) {
        const bytes = readFileSync(child);
        if (needles.some((n) => bytes.indexOf(n) >= 0)) hits.push(childRel.slice(1));
      }
    }
  };
  for (const r of roots) walk(join(dir, r), `/${r}`);
  return hits;
}

export interface CleanInstallOptions {
  readonly source: string;
  readonly commit: string;
  readonly dir: string;
  /** Absolute paths of the author's checkout that must not appear in built artifacts. */
  readonly authorPaths?: readonly string[];
}

export async function cleanInstall(options: CleanInstallOptions): Promise<InstallRecord> {
  const dir = resolve(options.dir);
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error('install directory is not empty');
  mkdirSync(dir, { recursive: true });
  const commands: CommandRecord[] = [];
  const env = offlineEnv();
  const step = async (file: string, args: readonly string[], cwd: string, shell = false) => {
    const r = await run(file, args, { cwd, env, shell });
    commands.push(r);
    if (r.exitCode !== 0) throw Object.assign(new Error(`command failed: ${r.command}`), { record: r });
    return r;
  };
  await step('git', ['clone', '--no-hardlinks', '--quiet', resolve(options.source), dir], resolve(dir, '..'));
  await step('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', options.commit], dir);
  const head = (await step('git', ['rev-parse', 'HEAD'], dir)).stdoutTail.trim();
  const before = (await step('git', ['status', '--porcelain=v1', '--untracked-files=all'], dir)).stdoutTail;
  await step('pnpm', ['install', '--frozen-lockfile', '--offline'], dir, isWin);
  await step('pnpm', ['run', 'build'], dir, isWin);
  await step('pnpm', ['run', 'build:console'], dir, isWin);
  const after = (await step('git', ['status', '--porcelain=v1', '--untracked-files=all'], dir)).stdoutTail;
  const authorPathHits = scanForPaths(
    dir,
    ['apps/console/dist', ...readdirSync(join(dir, 'packages')).map((p) => `packages/${p}/dist`)],
    [...(options.authorPaths ?? []), resolve(options.source), dir],
  );
  return {
    schema: 'routespec.delivery.install/1',
    commit: head,
    cleanTreeBeforeInstall: before.trim() === '',
    dirtyTreeDigest: sha256(before),
    cleanTreeAfterBuild: after.trim() === '',
    lockDigest: fileDigest(join(dir, 'pnpm-lock.yaml')),
    artifacts: artifactIdentity(dir),
    toolchain: await observeToolchain(dir),
    commands,
    authorPathHits,
    ok: true,
  };
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined) {
    process.stderr.write(`missing --${name}\n`);
    process.exit(4);
  }
  return v;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const record = await cleanInstall({ source: arg('source'), commit: arg('commit'), dir: arg('dir') });
  writeFileSync(arg('out'), `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: record.ok, commit: record.commit })}\n`);
}
