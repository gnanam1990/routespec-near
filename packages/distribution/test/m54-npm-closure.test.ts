/**
 * M54: static checks of the npm package build (fast; the full pack-install-run check is the
 * `test:distribution` suite). The runtime closure ships no dev dependency, and the staged-tree
 * audit refuses the three ways a compiled package breaks after install.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { auditStagedTree, packageClosure, readPublishManifest } from '../src/npm-package.ts';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'routespec-m54-audit-'));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, ...rel.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}

describe('M54 npm package closure and audit', () => {
  it('ships the CLI and CI entry packages with exactly typescript, yaml and zod as third-party code', () => {
    const closure = packageClosure();
    const names = closure.internal.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['@routespec/cli', '@routespec/ci', '@routespec/store']));
    // Not runtime dependencies of the shipped commands.
    for (const absent of [
      '@routespec/console',
      '@routespec/delivery',
      '@routespec/control-api',
      '@routespec/mcp',
    ]) {
      expect(names).not.toContain(absent);
    }
    // typescript: the M53 fix-pattern finder parses SDK usage with the compiler API at run time.
    expect(closure.external.map((e) => `${e.name}@${e.version}`)).toEqual([
      'typescript@5.9.3',
      'yaml@2.8.4',
      'zod@4.6.7',
    ]);
  });

  it('publishes under an exact version with provenance', () => {
    const m = readPublishManifest();
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m['publishConfig']).toMatchObject({ provenance: true, access: 'public' });
  });

  it('accepts a compiled tree whose imports and file-URL targets all resolve', () => {
    const dir = tree({
      'bin/routespec.mjs': "const { runMain } = await import('@routespec/cli');\n",
      'node_modules/@routespec/cli/src/main.js':
        "import { z } from 'zod';\nimport { join } from 'node:path';\n",
      'node_modules/@routespec/cli/src/launcher.js': "const e = new URL('./main.js', import.meta.url);\n",
    });
    expect(auditStagedTree(dir, ['@routespec/cli', 'zod'])).toEqual([]);
  });

  it('refuses TypeScript sources, relative .ts references, missing targets, and unbundled imports', () => {
    const dir = tree({
      'node_modules/@routespec/cli/src/a.ts': 'export const a = 1;\n',
      'node_modules/@routespec/cli/src/b.js': [
        "const child = new URL('./child.js', import.meta.url);",
        "const entry = './main.ts';",
        "import axios from 'axios';",
        '',
      ].join('\n'),
    });
    const problems = auditStagedTree(dir, ['@routespec/cli']);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^TypeScript source shipped: .*a\.ts$/),
        expect.stringMatching(/^relative \.ts reference in .*b\.js/),
        expect.stringMatching(/^missing file-URL target in .*\.\/child\.js$/),
        expect.stringMatching(/^unbundled import in .*: axios$/),
      ]),
    );
  });
});
