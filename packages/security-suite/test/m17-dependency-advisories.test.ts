/**
 * M17 dependency advisory follow-up (NFR-11 supply chain). Supplementary module test; it claims
 * no canonical test ID. It reads the committed lockfile and the installed packages only; no
 * registry is contacted.
 *
 * GHSA-g3hv-75wg-m249 (minimatch, moderate, "globparts amplification" denial of service) affects
 * minimatch >=7.0.0 <11.0.1. The only path into the graph was typescript-eslint (through
 * @typescript-eslint/typescript-estree). No typescript-eslint release depends on a fixed minimatch,
 * so the workspace overrides that range to a fixed release that passed the two-week cool-down
 * (M17 ADR in docs/adr). minimatch 3.x (through eslint itself) is outside the advisory range.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LOCK = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');

type Version = readonly [number, number, number];

function parse(v: string): Version {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`not a release version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmp(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return 0;
}

/** Every version of a package recorded in the lockfile's `packages:` section. */
function lockedVersions(name: string): string[] {
  const escaped = name.replace(/[/@.]/g, (c) => `\\${c}`);
  const re = new RegExp(`^  '?${escaped}@(\\d+\\.\\d+\\.\\d+)'?:`, 'gm');
  return [...new Set([...LOCK.matchAll(re)].map((m) => m[1] as string))].sort();
}

function inAdvisoryRange(v: string): boolean {
  const p = parse(v);
  return cmp(p, [7, 0, 0]) >= 0 && cmp(p, [11, 0, 1]) < 0;
}

/** Resolve a package the way a dependent package resolves it (pnpm's isolated layout). */
function requireFrom(fromPackageDir: string): NodeJS.Require {
  return createRequire(join(realpathSync(fromPackageDir), 'package.json'));
}

describe('M17 — GHSA-g3hv-75wg-m249 (minimatch) is resolved in the locked graph', () => {
  it('no locked minimatch version lies in the advisory range >=7.0.0 <11.0.1', () => {
    const versions = lockedVersions('minimatch');
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.filter(inAdvisoryRange)).toEqual([]);
  });

  it('the override is scoped to the advisory range and pins one exact fixed release', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    const overrides = manifest.pnpm?.overrides ?? {};
    // The fixed release's own dependencies are pinned too, to releases older than the cool-down
    // (their newest matching releases were days old when this was decided).
    expect(overrides).toEqual({
      'minimatch@>=7.0.0 <11.0.1': '11.0.3',
      'minimatch@11.0.3>brace-expansion': '5.0.12',
      'minimatch@11.0.3>@isaacs/nonrecursive-glob-match': '1.0.3',
    });
    // pnpm records the overrides in the lockfile, so a frozen install cannot drift from them.
    expect(LOCK).toMatch(/^overrides:\n {2}minimatch@>=7\.0\.0 <11\.0\.1: 11\.0\.3$/m);
    expect(lockedVersions('brace-expansion')).toEqual(['1.1.22', '5.0.12']);
    expect(lockedVersions('@isaacs/nonrecursive-glob-match')).toEqual(['1.0.3']);
  });

  it('typescript-estree loads the fixed minimatch and its glob matching still works', () => {
    const eslintPlugin = requireFrom(join(ROOT, 'node_modules', 'typescript-eslint'));
    const estreeDir = dirname(
      requireFrom(dirname(eslintPlugin.resolve('@typescript-eslint/parser/package.json'))).resolve(
        '@typescript-eslint/typescript-estree/package.json',
      ),
    );
    const fromEstree = requireFrom(estreeDir);
    const pkg = fromEstree('minimatch/package.json') as { version: string };
    expect(inAdvisoryRange(pkg.version)).toBe(false);
    expect(pkg.version).toBe('11.0.3');
    // The call typescript-estree makes (allowDefaultProject matching): named export, dot option.
    const { minimatch } = fromEstree('minimatch') as {
      minimatch: (p: string, pattern: string, o?: { dot?: boolean }) => boolean;
    };
    expect(minimatch('src/.hidden/a.ts', 'src/**/*.ts', { dot: true })).toBe(true);
    expect(minimatch('src/.hidden/a.ts', 'src/**/*.ts')).toBe(false);
    expect(minimatch('test/a.test.ts', '*.ts', { dot: true })).toBe(false);
    expect(minimatch('a.mjs', '*.{js,mjs}')).toBe(true);
  });

  it('minimatch 3.x (through eslint) stays outside the advisory range', () => {
    for (const v of lockedVersions('minimatch').filter((x) => parse(x)[0] < 7)) {
      expect(inAdvisoryRange(v)).toBe(false);
    }
  });
});
