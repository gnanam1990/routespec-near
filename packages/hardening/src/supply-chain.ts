/**
 * Supply-chain review of the installed dependency graph (NFR-11, SECURITY.md section 11).
 *
 * Reads the committed pnpm v9 lockfile and the package manifests pnpm materialized under
 * `node_modules/.pnpm`, then reports:
 *
 * - a license inventory (SPDX expression as declared by each package) and every package whose
 *   declared license is missing or outside the reviewed allowlist;
 * - every package that declares an install-time lifecycle script (`preinstall`, `install`,
 *   `postinstall`, or a native `binding.gyp`), and whether the workspace allows pnpm to run it.
 *   pnpm 10 runs none unless listed in `onlyBuiltDependencies`, so an unlisted script never ran;
 * - lockfile and toolchain identity (lockfile digest, pinned package manager, Node engine range).
 *
 * It reads files only. It never runs a package script and never contacts a registry; a
 * vulnerability advisory lookup is a separate, network-dependent step (see `pnpm audit`).
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const LICENSE_ALLOWLIST: ReadonlySet<string> = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'Python-2.0',
  'MPL-2.0',
  'Unlicense',
  // Font files bundled by the console (SIL Open Font License): reviewed for redistribution.
  'OFL-1.1',
]);

/**
 * Reviewed exceptions: packages whose declared license is not an SPDX id on the allowlist but
 * whose terms were read and accepted. Each entry names the reason; a new package is never
 * accepted silently.
 */
export const REVIEWED_LICENSE_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'jsonify@0.0.1':
    'Declares Public Domain (Douglas Crockford JSON reference code); reached only through json-stable-stringify of the pinned official 1Click SDK, which RouteSpec loads in test subjects, never in its own services.',
});

const LIFECYCLE = ['preinstall', 'install', 'postinstall'] as const;

export interface InstalledPackage {
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
  readonly lifecycleScripts: readonly string[];
  readonly nativeBuild: boolean;
}

export interface SupplyChainReport {
  readonly lockfileDigest: string;
  readonly packageManager: string | null;
  readonly nodeEngine: string | null;
  readonly lockedPackages: number;
  readonly inspectedPackages: number;
  readonly missingManifests: readonly string[];
  /** Locked packages restricted to another os/cpu (not installed here, by design). */
  readonly otherPlatformPackages: number;
  readonly licenses: Readonly<Record<string, number>>;
  readonly licenseFindings: ReadonlyArray<{ readonly pkg: string; readonly license: string | null }>;
  readonly installScripts: ReadonlyArray<{
    readonly pkg: string;
    readonly scripts: readonly string[];
    readonly allowedToRun: boolean;
  }>;
  readonly allowedBuilds: readonly string[];
}

const ENTRY = /^ {2}'?((?:@[^@\s'/]+\/)?[^@\s'/]+)@([^\s'():]+)'?:\s*$/;

/** `name@version` keys of the lockfile `packages:` section. */
export function lockedPackages(lockText: string): Array<{ name: string; version: string }> {
  const lines = lockText.split(/\r?\n/);
  const start = lines.indexOf('packages:');
  if (start === -1) return [];
  const out: Array<{ name: string; version: string }> = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\S/.test(line)) break;
    const m = ENTRY.exec(line);
    if (m) out.push({ name: m[1] as string, version: m[2] as string });
  }
  return out;
}

/** Normalize the many shapes of a `license` field into one SPDX-like expression string. */
export function declaredLicense(manifest: Record<string, unknown>): string | null {
  const l = manifest['license'];
  if (typeof l === 'string' && l.trim().length > 0) return l.trim();
  if (l !== null && typeof l === 'object' && typeof (l as { type?: unknown }).type === 'string')
    return (l as { type: string }).type;
  const ls = manifest['licenses'];
  if (Array.isArray(ls)) {
    const types = ls
      .map((x) => (x !== null && typeof x === 'object' ? (x as { type?: unknown }).type : x))
      .filter((x): x is string => typeof x === 'string');
    if (types.length > 0) return types.length === 1 ? (types[0] as string) : `(${types.join(' OR ')})`;
  }
  return null;
}

/** An SPDX expression is acceptable when one OR-branch consists only of allowlisted ids. */
export function licenseAccepted(expr: string | null): boolean {
  if (expr === null) return false;
  const clean = expr.replace(/[()]/g, ' ').trim();
  return clean.split(/\s+OR\s+/i).some((branch) =>
    branch
      .split(/\s+AND\s+/i)
      .map((id) => id.trim())
      .every((id) => LICENSE_ALLOWLIST.has(id)),
  );
}

/** Lockfile keys whose entry restricts `os` or `cpu` (installed only on matching platforms). */
export function platformRestricted(lockText: string): Set<string> {
  const out = new Set<string>();
  const lines = lockText.split(/\r?\n/);
  const start = lines.indexOf('packages:');
  let current: string | null = null;
  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\S/.test(line)) break;
    const m = ENTRY.exec(line);
    if (m) current = `${m[1]}@${m[2]}`;
    else if (current !== null && /^ {4}(os|cpu|libc):/.test(line)) out.add(current);
  }
  return out;
}

/**
 * Index the packages pnpm materialized: in every `.pnpm/<entry>/node_modules`, the one real
 * (non-link) package directory is that entry's package; its dependencies are links. Entry
 * names may be hashed when long, so the manifest, not the directory name, gives the identity.
 */
function installedIndex(pnpmDir: string): Map<string, string> {
  const index = new Map<string, string>();
  if (!existsSync(pnpmDir)) return index;
  for (const entry of readdirSync(pnpmDir)) {
    const nm = join(pnpmDir, entry, 'node_modules');
    if (!existsSync(nm)) continue;
    const candidates: string[] = [];
    for (const name of readdirSync(nm)) {
      const full = join(nm, name);
      if (name.startsWith('@')) {
        if (lstatSync(full).isSymbolicLink()) continue;
        for (const sub of readdirSync(full)) candidates.push(join(full, sub));
      } else candidates.push(full);
    }
    for (const dir of candidates) {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      const manifestPath = join(dir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown; version?: unknown };
      if (typeof m.name === 'string' && typeof m.version === 'string')
        index.set(`${m.name}@${m.version}`, manifestPath);
    }
  }
  return index;
}

export function auditSupplyChain(repoRoot: string): SupplyChainReport {
  const lockText = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
  const rootManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const workspaceYaml = existsSync(join(repoRoot, 'pnpm-workspace.yaml'))
    ? readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
    : '';
  const pnpmField = (rootManifest['pnpm'] ?? {}) as { onlyBuiltDependencies?: unknown };
  const allowedBuilds = new Set<string>(
    Array.isArray(pnpmField.onlyBuiltDependencies) ? (pnpmField.onlyBuiltDependencies as string[]) : [],
  );
  const yamlBlock = /^onlyBuiltDependencies:\s*\n((?:\s+-\s*.+\n?)*)/m.exec(workspaceYaml);
  if (yamlBlock)
    for (const m of (yamlBlock[1] as string).matchAll(/-\s*['"]?([^'"\s]+)['"]?/g))
      allowedBuilds.add(m[1] as string);

  const locked = lockedPackages(lockText);
  const index = installedIndex(join(repoRoot, 'node_modules', '.pnpm'));
  const restricted = platformRestricted(lockText);
  const inspected: InstalledPackage[] = [];
  const missing: string[] = [];
  const otherPlatform: string[] = [];
  for (const { name, version } of locked) {
    const key = `${name}@${version}`;
    const manifestPath = index.get(key);
    if (manifestPath === undefined) {
      (restricted.has(key) ? otherPlatform : missing).push(key);
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const scripts = (manifest['scripts'] ?? {}) as Record<string, unknown>;
    const lifecycleScripts = LIFECYCLE.filter((k) => typeof scripts[k] === 'string');
    const nativeBuild = existsSync(join(manifestPath, '..', 'binding.gyp'));
    inspected.push({ name, version, license: declaredLicense(manifest), lifecycleScripts, nativeBuild });
  }
  const licenses: Record<string, number> = {};
  for (const p of inspected) {
    const k = p.license ?? 'UNDECLARED';
    licenses[k] = (licenses[k] ?? 0) + 1;
  }
  return {
    lockfileDigest: `sha256:${createHash('sha256').update(lockText).digest('hex')}`,
    packageManager:
      typeof rootManifest['packageManager'] === 'string' ? rootManifest['packageManager'] : null,
    nodeEngine:
      typeof (rootManifest['engines'] as { node?: unknown } | undefined)?.node === 'string'
        ? (rootManifest['engines'] as { node: string }).node
        : null,
    lockedPackages: locked.length,
    inspectedPackages: inspected.length,
    missingManifests: missing,
    otherPlatformPackages: otherPlatform.length,
    licenses: Object.fromEntries(Object.entries(licenses).sort(([a], [b]) => (a < b ? -1 : 1))),
    licenseFindings: inspected
      .filter(
        (p) =>
          !licenseAccepted(p.license) && REVIEWED_LICENSE_EXCEPTIONS[`${p.name}@${p.version}`] === undefined,
      )
      .map((p) => ({ pkg: `${p.name}@${p.version}`, license: p.license })),
    installScripts: inspected
      .filter((p) => p.lifecycleScripts.length > 0 || p.nativeBuild)
      .map((p) => ({
        pkg: `${p.name}@${p.version}`,
        scripts: p.nativeBuild ? [...p.lifecycleScripts, 'binding.gyp'] : p.lifecycleScripts,
        allowedToRun: allowedBuilds.has(p.name),
      })),
    allowedBuilds: [...allowedBuilds].sort(),
  };
}
