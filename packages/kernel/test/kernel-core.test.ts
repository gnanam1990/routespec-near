/**
 * Kernel core properties (M04 deliverables 3, 5, 7; NFR-01). Supplementary to the owned tests:
 * purity (static import audit), determinism, immutability, FAIL dominance, case completeness,
 * evaluator-revision pinning, and the semantics digest pin.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVALUATOR_REVISION, KERNEL_SEMANTICS_DIGEST, combineVerdicts, evaluateCase } from '../src/index.ts';
import { baseInput, mutate } from './support/pure.ts';

describe('M04 kernel core', () => {
  it('the consistent baseline case passes every implemented invariant', () => {
    const e = evaluateCase(baseInput());
    expect(e.summaries.map((s) => [s.invariantId, s.verdict])).toEqual([
      ['INV-01', 'PASS'],
      ['INV-02', 'PASS'],
      ['INV-03', 'PASS'],
      ['INV-04', 'PASS'],
      ['INV-05', 'PASS'],
      ['INV-06', 'PASS'],
      ['INV-07', 'PASS'],
      ['INV-08', 'PASS'],
    ]);
    expect(e.verdict).toBe('PASS');
    expect(e.explanationCode).toBe('CASE_PASS');
  });

  it('is deterministic and byte-stable for the same input, and frozen', () => {
    const a = evaluateCase(baseInput());
    const b = evaluateCase(baseInput());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.resultDigest).toBe(b.resultDigest);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.invariantResults[0])).toBe(true);
    expect(() => {
      (a as { verdict: string }).verdict = 'FAIL';
    }).toThrow(TypeError);
  });

  it('changing any mandatory identity changes the input and result digests', () => {
    const base = evaluateCase(baseInput());
    for (const field of [
      'buildRevisionId',
      'gateRunId',
      'caseRunId',
      'effectManifestDigest',
      'seed',
    ] as const) {
      const changed = evaluateCase(
        mutate(baseInput(), (dr) => {
          (dr.identity as Record<string, unknown>)[field] = `${String(dr.identity[field])}-x`;
        }),
      );
      expect(changed.inputDigest, field).not.toBe(base.inputDigest);
      expect(changed.resultDigest, field).not.toBe(base.resultDigest);
    }
    const epoch = evaluateCase(mutate(baseInput(), (dr) => void (dr.identity.fencingEpoch = 2)));
    expect(epoch.resultDigest).not.toBe(base.resultDigest);
  });

  it('refuses to evaluate under an evaluator revision the gate run did not pin', () => {
    const other = mutate(
      baseInput(),
      (dr) => void (dr.identity.evaluatorRevision = 'routespec-kernel@0.9.0'),
    );
    expect(() => evaluateCase(other)).toThrow(expect.objectContaining({ code: 'RS_IDENTITY_MISMATCH' }));
  });

  it('FAIL dominates, NOT_RUN only when nothing ran, mixed incompleteness is REVIEW', () => {
    expect(combineVerdicts([])).toBe('NOT_RUN');
    expect(combineVerdicts(['NOT_RUN', 'NOT_RUN'])).toBe('NOT_RUN');
    expect(combineVerdicts(['PASS', 'NOT_RUN'])).toBe('REVIEW');
    expect(combineVerdicts(['PASS', 'UNSUPPORTED'])).toBe('REVIEW');
    expect(combineVerdicts(['PASS', 'REVIEW'])).toBe('REVIEW');
    expect(combineVerdicts(['REVIEW', 'FAIL', 'NOT_RUN'])).toBe('FAIL');
    expect(combineVerdicts(['PASS', 'PASS'])).toBe('PASS');
  });

  it('an incomplete case (input not closed, aborted, recovery pending) never passes', () => {
    const open = evaluateCase(mutate(baseInput(), (dr) => void (dr.caseState.inputClosed = false)));
    expect(open.verdict).toBe('REVIEW');
    expect(open.explanationCode).toBe('CASE_INCOMPLETE');
    for (const lifecycle of ['ABORTED', 'ERROR', 'RECOVERY_REQUIRED'] as const) {
      const e = evaluateCase(mutate(baseInput(), (dr) => void (dr.caseState.lifecycle = lifecycle)));
      expect(e.verdict, lifecycle).toBe('REVIEW');
    }
  });

  it('a required invariant this revision cannot evaluate is NOT_RUN and makes the case REVIEW', () => {
    const e = evaluateCase(
      mutate(baseInput(), (dr) => void (dr.caseState.requiredInvariants = ['INV-03', 'INV-09'])),
    );
    expect(e.summaries.find((s) => s.invariantId === 'INV-09')).toEqual({
      invariantId: 'INV-09',
      required: true,
      verdict: 'NOT_RUN',
    });
    expect(e.verdict).toBe('REVIEW');
    const none = evaluateCase(mutate(baseInput(), (dr) => void (dr.caseState.requiredInvariants = [])));
    expect(none.verdict).toBe('NOT_RUN');
  });

  it('pins the semantics digest of this evaluator revision', () => {
    // Changing any rule table requires a new evaluator revision; update both together.
    expect(EVALUATOR_REVISION).toBe('routespec-kernel@1.0.0');
    expect(KERNEL_SEMANTICS_DIGEST).toBe(
      'sha256:a4487ccaf1c84252f738f7b26a7fcb988c0a8ba368ab5ebc08214fc03794605c',
    );
  });

  it('static audit: kernel sources import only @routespec/contracts and local modules', () => {
    const src = fileURLToPath(new URL('../src/', import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
      );
    const files = walk(src);
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const file of files) {
      const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      for (const m of text.matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1] as string;
        expect(
          spec === '@routespec/contracts' || spec.startsWith('./') || spec.startsWith('../'),
          `${file}: ${spec}`,
        ).toBe(true);
      }
      for (const forbidden of [
        /\bDate\.now\s*\(/,
        /\bnew\s+Date\s*\(/,
        /Math\.random/,
        /\bfetch\s*\(/,
        /process\./,
        /require\s*\(/,
        /import\s*\(/,
      ]) {
        expect(forbidden.test(text), `${file} ${forbidden}`).toBe(false);
      }
    }
  });
});
