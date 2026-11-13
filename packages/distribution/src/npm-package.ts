/**
 * npm package build for `npx routespec` (M54).
 *
 * The workspace runs its TypeScript sources directly with Node's type stripping, which Node
 * refuses for files under `node_modules`. A published package therefore ships the JavaScript that
 * `tsc -b` emits, never the sources. This module stages one self-contained package:
 *
 *   routespec/
 *     package.json          name, version and metadata from `npm/publish-manifest.json`
 *     bin/routespec.mjs     the `routespec` CLI (packages/cli)
 *     bin/routespec-ci.mjs  the CI entry point (packages/ci), the one the GitHub Action runs
 *     bin/withheld-names.mjs  names of credentials the action shell withholds (names only)
 *     node_modules/@routespec/<pkg>/src/**.js   compiled workspace packages
 *     node_modules/{zod,yaml,typescript}       the three third-party runtime dependencies
 *
 * Every runtime dependency is bundled (`bundleDependencies`), so installing the tarball fetches
 * nothing else and the provenance attestation of the tarball covers every file that runs.
 *
 * Child entry points that the code forks by file URL (`new URL('./main.ts', import.meta.url)`)
 * are rewritten to their compiled `.js` sibling; the build fails if a rewritten target does not
 * exist or if any relative `.ts` reference is left. It also fails on a stale build (a source file
 * without its compiled output) and on any bare import that is not bundled.
 *
 *   node packages/distribution/src/npm-package.ts --out <dir> [--no-build] [--pack]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
export const MANIFEST_TEMPLATE = join(ROOT, 'packages', 'distribution', 'npm', 'publish-manifest.json');
export const PACKAGE_README = join(ROOT, 'packages', 'distribution', 'npm', 'README.md');

/** The packages whose commands the npm package exposes. */
export const ENTRY_PACKAGES = ['@routespec/cli', '@routespec/ci'] as const;

export const BINS = {
  routespec: 'bin/routespec.mjs',
  'routespec-ci': 'bin/routespec-ci.mjs',
} as const;

type Json = Record<string, unknown>;

export interface WorkspacePackage {
  readonly name: string;
  readonly dir: string;
  readonly manifest: Json;
}

export interface ExternalPackage {
  readonly name: string;
  readonly version: string;
  readonly dir: string;
}

export interface Closure {
  readonly internal: WorkspacePackage[];
  readonly external: ExternalPackage[];
}

export interface PublishManifest {
  readonly name: string;
  readonly version: string;
  readonly [key: string]: unknown;
}

export function readPublishManifest(root: string = ROOT): PublishManifest {
  const m = JSON.parse(
    readFileSync(join(root, 'packages', 'distribution', 'npm', 'publish-manifest.json'), 'utf8'),
  ) as PublishManifest;
  if (typeof m.name !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version)) {
    throw new Error('publish-manifest.json needs a name and an exact semver version');
  }
  return m;
}

function readJson(file: string): Json {
  return JSON.parse(readFileSync(file, 'utf8')) as Json;
}

export function workspacePackages(root: string = ROOT): Map<string, WorkspacePackage> {
  const out = new Map<string, WorkspacePackage>();
  for (const entry of readdirSync(join(root, 'packages')).sort()) {
    const dir = join(root, 'packages', entry);
    const file = join(dir, 'package.json');
    if (!existsSync(file)) continue;
    const manifest = readJson(file);
    out.set(manifest['name'] as string, { name: manifest['name'] as string, dir, manifest });
  }
  return out;
}

function deps(manifest: Json): Record<string, string> {
  return (manifest['dependencies'] as Record<string, string> | undefined) ?? {};
}

/** Runtime dependency closure of the entry packages (dev dependencies are never shipped). */
export function packageClosure(root: string = ROOT): Closure {
  const workspace = workspacePackages(root);
  const internal = new Map<string, WorkspacePackage>();
  const external = new Map<string, ExternalPackage>();
  const queue: string[] = [...ENTRY_PACKAGES];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (internal.has(name)) continue;
    const pkg = workspace.get(name);
    if (pkg === undefined) throw new Error(`entry or workspace dependency not found: ${name}`);
    internal.set(name, pkg);
    for (const [dep, range] of Object.entries(deps(pkg.manifest))) {
      if (range.startsWith('workspace:')) {
        queue.push(dep);
        continue;
      }
      if (!/^\d+\.\d+\.\d+$/.test(range)) throw new Error(`${name} -> ${dep}@${range} is not an exact pin`);
      const dir = realpathSync(join(pkg.dir, 'node_modules', dep));
      const installed = readJson(join(dir, 'package.json'));
      if (installed['version'] !== range)
        throw new Error(`${dep}: installed ${String(installed['version'])}, pinned ${range}`);
      if (Object.keys(deps(installed)).length > 0) {
        throw new Error(`${dep} has its own dependencies; bundling it is not supported here`);
      }
      const seen = external.get(dep);
      if (seen !== undefined && seen.version !== range) throw new Error(`${dep} pinned at two versions`);
      external.set(dep, { name: dep, version: range, dir });
    }
  }
  return {
    internal: [...internal.values()].sort((a, b) => a.name.localeCompare(b.name)),
    external: [...external.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

const toPosix = (p: string): string => p.split(sep).join('/');

const ASSET_URL = /new URL\((['"])(\.{1,2}\/[^'"]*?)\.ts\1,(\s*)import\.meta\.url\)/g;
const RELATIVE_TS_LITERAL = /['"]\.{1,2}\/[^'"\n]*\.ts['"]/g;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;

function stageWorkspacePackage(pkg: WorkspacePackage, target: string, version: string): void {
  const srcDir = join(pkg.dir, 'src');
  const outDir = join(pkg.dir, 'dist', 'src');
  for (const file of walk(srcDir)) {
    const rel = relative(srcDir, file);
    if (file.endsWith('.ts')) {
      const compiled = join(outDir, rel.replace(/\.ts$/, '.js'));
      if (!existsSync(compiled))
        throw new Error(`stale build: ${pkg.name} ${toPosix(rel)} has no compiled output`);
      const dest = join(target, 'src', rel.replace(/\.ts$/, '.js'));
      mkdirSync(dirname(dest), { recursive: true });
      const text = readFileSync(compiled, 'utf8').replace(
        ASSET_URL,
        (_m, q: string, path: string, ws: string) => {
          return `new URL(${q}${path}.js${q},${ws}import.meta.url)`;
        },
      );
      writeFileSync(dest, text.replace(/\n\/\/# sourceMappingURL=.*$/m, ''));
    } else {
      const dest = join(target, 'src', rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(file, dest);
    }
  }
  const exportsIn = (pkg.manifest['exports'] as Record<string, { default: string }> | undefined) ?? {};
  const exportsOut: Record<string, string> = {};
  for (const [key, value] of Object.entries(exportsIn)) {
    exportsOut[key] = value.default.replace(/^\.\/src\//, './src/').replace(/\.ts$/, '.js');
  }
  const depsOut: Record<string, string> = {};
  for (const [dep, range] of Object.entries(deps(pkg.manifest))) {
    depsOut[dep] = range.startsWith('workspace:') ? version : range;
  }
  writeFileSync(
    join(target, 'package.json'),
    `${JSON.stringify(
      {
        name: pkg.name,
        version,
        description: pkg.manifest['description'],
        license: 'MIT',
        type: 'module',
        exports: exportsOut,
        dependencies: depsOut,
      },
      null,
      2,
    )}\n`,
  );
}

const QUIET_SQLITE_WARNING = [
  '// Node prints an ExperimentalWarning for node:sqlite; the repository runs with --no-warnings.',
  '// Only that one warning is dropped (stderr only); every other warning is printed.',
  'const emitWarning = process.emitWarning;',
  'process.emitWarning = function (warning, ...rest) {',
  "  const type = typeof warning === 'string' ? (typeof rest[0] === 'string' ? rest[0] : rest[0]?.type) : warning?.name;",
  "  if (type === 'ExperimentalWarning' && String(warning?.message ?? warning).includes('SQLite')) return;",
  '  return emitWarning.call(process, warning, ...rest);',
  '};',
];

/**
 * File-URL targets that are deliberately not in the package. `routespec mcp` (M52) loads the MCP
 * server package by URL; that package needs the official 1Click SDK and its dependency tree at run
 * time, which this self-contained package does not bundle. The npm `routespec` bin answers
 * `mcp` itself with a usage error (exit 4) and never reaches the missing file.
 */
export const NOT_SHIPPED_TARGETS = new Set(['node_modules/@routespec/mcp/src/main.js']);

const MCP_NOT_PACKAGED = [
  "if (process.argv[2] === 'mcp') {",
  '  const error = {',
  "    code: 'RS_MCP_NOT_PACKAGED',",
  "    message: 'routespec mcp is not part of the npm package; run it from a clone of the repository (pnpm run mcp).',",
  '  };',
  "  process.stdout.write(`${JSON.stringify({ ok: false, command: 'mcp', exitCode: 4, error })}\\n`);",
  '  process.exit(4);',
  '}',
];

const BIN_SOURCES: Record<string, string> = {
  'bin/routespec.mjs': [
    '#!/usr/bin/env node',
    '// RouteSpec CLI (compiled). One JSON document on stdout; exit codes as documented.',
    ...MCP_NOT_PACKAGED,
    ...QUIET_SQLITE_WARNING,
    "const { runMain } = await import('@routespec/cli');",
    '',
    'await runMain();',
    '',
  ].join('\n'),
  'bin/routespec-ci.mjs': [
    '#!/usr/bin/env node',
    '// RouteSpec CI entry point (compiled): routespec-ci run|certificate|sbom.',
    ...QUIET_SQLITE_WARNING,
    "const { runCiMain } = await import('@routespec/ci');",
    '',
    'await runCiMain();',
    '',
  ].join('\n'),
  'bin/withheld-names.mjs': [
    '#!/usr/bin/env node',
    '// Prints, one per line, the names (never values) of the step-environment variables the gate',
    '// withholds. The action shell removes them before it starts the entry point.',
    "import { withheldNames } from '@routespec/ci';",
    '',
    'for (const name of withheldNames(process.env)) process.stdout.write(`${name}\\n`);',
    '',
  ].join('\n'),
};

export interface StagedPackage {
  readonly dir: string;
  readonly name: string;
  readonly version: string;
  readonly internal: string[];
  readonly external: string[];
  readonly files: string[];
}

export interface StageOptions {
  readonly root?: string;
  readonly outDir: string;
  /** Run `tsc -b` first (default true). */
  readonly build?: boolean;
}

export function buildWorkspace(root: string = ROOT): void {
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(process.execPath, [tsc, '-b'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Problems that make a staged tree unfit to publish (empty when it is fit). */
export function auditStagedTree(dir: string, bundled: readonly string[]): string[] {
  const problems: string[] = [];
  const builtins = new Set(builtinModules);
  const allowed = new Set(bundled);
  for (const file of walk(dir)) {
    const rel = toPosix(relative(dir, file));
    if (
      /\.(?:ts|mts|cts)$/.test(file) &&
      !/\.d\.[mc]?ts$/.test(file) &&
      rel.includes('node_modules/@routespec/')
    ) {
      problems.push(`TypeScript source shipped: ${rel}`);
    }
    if (!/\.(?:js|mjs)$/.test(file) || (!rel.includes('@routespec/') && !rel.startsWith('bin/'))) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(RELATIVE_TS_LITERAL))
      problems.push(`relative .ts reference in ${rel}: ${m[0]}`);
    for (const m of text.matchAll(/new URL\((['"])(\.{1,2}\/[^'"]+)\1,\s*import\.meta\.url\)/g)) {
      const target = fileURLToPath(new URL(m[2] as string, pathToFileURL(file)));
      const shippedRel = toPosix(relative(dir, target));
      if (!existsSync(target) && !NOT_SHIPPED_TARGETS.has(shippedRel)) {
        problems.push(`missing file-URL target in ${rel}: ${m[2] as string}`);
      }
    }
    for (const m of text.matchAll(SPECIFIER)) {
      const spec = m[2] as string;
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
      const base = spec.startsWith('@')
        ? spec.split('/').slice(0, 2).join('/')
        : (spec.split('/')[0] as string);
      if (builtins.has(base) || allowed.has(base)) continue;
      problems.push(`unbundled import in ${rel}: ${spec}`);
    }
  }
  return problems;
}

export function stageNpmPackage(options: StageOptions): StagedPackage {
  const root = options.root ?? ROOT;
  if (options.build !== false) buildWorkspace(root);
  const manifest = readPublishManifest(root);
  const closure = packageClosure(root);
  const dir = join(resolve(options.outDir), manifest.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });

  for (const pkg of closure.internal) {
    stageWorkspacePackage(pkg, join(dir, 'node_modules', ...pkg.name.split('/')), manifest.version);
  }
  for (const ext of closure.external) {
    cpSync(ext.dir, join(dir, 'node_modules', ext.name), {
      recursive: true,
      filter: (src) => !toPosix(relative(ext.dir, src)).split('/').includes('node_modules'),
    });
  }
  for (const [rel, text] of Object.entries(BIN_SOURCES)) writeFileSync(join(dir, rel), text);
  cpSync(join(root, 'LICENSE'), join(dir, 'LICENSE'));
  cpSync(join(root, 'packages', 'distribution', 'npm', 'README.md'), join(dir, 'README.md'));

  const dependencies: Record<string, string> = {};
  for (const pkg of closure.internal) dependencies[pkg.name] = manifest.version;
  for (const ext of closure.external) dependencies[ext.name] = ext.version;
  const bundled = Object.keys(dependencies).sort();
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        ...manifest,
        bin: BINS,
        files: ['bin/', 'README.md', 'LICENSE'],
        dependencies,
        bundleDependencies: bundled,
      },
      null,
      2,
    )}\n`,
  );

  const problems = auditStagedTree(dir, bundled);
  if (problems.length > 0) throw new Error(`staged package is not publishable:\n${problems.join('\n')}`);
  return {
    dir,
    name: manifest.name,
    version: manifest.version,
    internal: closure.internal.map((p) => p.name),
    external: closure.external.map((p) => `${p.name}@${p.version}`),
    files: walk(dir).map((f) => toPosix(relative(dir, f))),
  };
}

/** Runs npm with fixed arguments (no user input reaches the command line). */
export function npm(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const win = process.platform === 'win32';
  const quoted = win ? args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
  return execFileSync(win ? 'npm.cmd' : 'npm', quoted, {
    cwd,
    env,
    encoding: 'utf8',
    shell: win,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export interface PackResult {
  readonly tarball: string;
  readonly integrity: string;
  readonly sha256: string;
  readonly size: number;
  readonly unpackedSize: number;
  readonly entryCount: number;
  readonly bundled: readonly string[];
  readonly files: readonly string[];
}

export function packNpmPackage(staged: StagedPackage, destination: string): PackResult {
  mkdirSync(destination, { recursive: true });
  const out = npm(['pack', '--json', '--pack-destination', resolve(destination)], staged.dir);
  const info = (JSON.parse(out) as Json[])[0] as Json;
  const tarball = join(resolve(destination), info['filename'] as string);
  return {
    tarball,
    integrity: info['integrity'] as string,
    sha256: `sha256:${createHash('sha256').update(readFileSync(tarball)).digest('hex')}`,
    size: info['size'] as number,
    unpackedSize: info['unpackedSize'] as number,
    entryCount: info['entryCount'] as number,
    bundled: (info['bundled'] as string[] | undefined) ?? [],
    files: ((info['files'] as Json[] | undefined) ?? []).map((f) => f['path'] as string),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf('--out');
  const out = outIndex === -1 ? join(ROOT, '.data', 'npm') : resolve(argv[outIndex + 1] as string);
  const staged = stageNpmPackage({ outDir: join(out, 'stage'), build: !argv.includes('--no-build') });
  const result: Json = {
    ok: true,
    name: staged.name,
    version: staged.version,
    internal: staged.internal,
    external: staged.external,
    stagedFiles: staged.files.length,
  };
  if (argv.includes('--pack')) {
    const packed = packNpmPackage(staged, out);
    Object.assign(result, {
      tarball: toPosix(relative(ROOT, packed.tarball)),
      integrity: packed.integrity,
      sha256: packed.sha256,
      size: packed.size,
      entryCount: packed.entryCount,
      bundled: packed.bundled.length,
    });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
