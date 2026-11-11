/**
 * Supplementary M03 guard (deliverable 6): the scenario compiler/runtime source has no file,
 * network, shell, timer, wall-clock, ambient-randomness, dynamic-import, or eval capability.
 * This is a static check over the package's own source; behavior is covered by T-009..T-015.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const ALLOWED_IMPORTS = new Set(['@routespec/contracts', 'yaml', 'node:crypto']);
const FORBIDDEN = [
  /\beval\s*\(/,
  /\bnew\s+Function\b/,
  /\bimport\s*\(/,
  /\brequire\s*\(/,
  /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b/,
  /\bMath\.random\b/,
  /\bDate\.now\b|\bperformance\.now\b|\bprocess\.hrtime\b/,
  /\bfetch\s*\(/,
  /\bprocess\.env\b/,
];

describe('scenario runtime isolation (static)', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
  it('imports only contracts, the yaml data parser, and node:crypto', () => {
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(join(SRC, file), 'utf8');
      for (const m of text.matchAll(/^\s*(?:import|export)[^'"]*from\s+'([^']+)'/gm)) {
        const spec = m[1] as string;
        if (spec.startsWith('./')) continue;
        expect(ALLOWED_IMPORTS.has(spec), `${file} imports ${spec}`).toBe(true);
      }
    }
  });

  it('contains no eval, dynamic import, timers, wall clock, ambient randomness, fetch, or env access', () => {
    for (const file of files) {
      const text = readFileSync(join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      for (const pattern of FORBIDDEN) expect(pattern.test(text), `${file} matches ${pattern}`).toBe(false);
    }
  });
});
