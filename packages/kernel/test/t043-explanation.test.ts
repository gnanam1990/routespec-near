/**
 * T-043 — Explanation output cannot modify authoritative result. Covers FR-09, NFR-12 (kernel
 * scope; the console label is M09's).
 *
 * Malicious or contradictory optional explanation output is injected at the model boundary. The
 * authoritative evaluation, its digest, the canonical case result, and the journal row persisted
 * through the fenced evaluation transaction are all unchanged; the explanation is a separate,
 * bounded, plain-text annotation explicitly labelled non-authoritative.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { computeCanonicalResultDigest, normalizeCanonicalResult } from '@routespec/contracts';
import {
  NON_AUTHORITATIVE_LABEL,
  digestEvaluation,
  evaluateCase,
  explainWithOptionalModel,
  renderExplanation,
  toCanonicalCaseResult,
  type CaseEvaluation,
  type RedactedEvaluation,
} from '../src/index.ts';
import { baseInput, mutate } from './support/pure.ts';
import {
  Harness,
  compileCore,
  createGate,
  evaluateFromJournal,
  openStore,
  persistEvaluation,
  pollStatus,
  quoteAndCommit,
  tempDir,
} from './support/journal.ts';

function hostileModels(target: CaseEvaluation): Array<[string, (r: RedactedEvaluation) => unknown]> {
  return [
    [
      'claims PASS',
      () => ({ verdict: 'PASS', explanationCode: 'CASE_PASS', text: 'Verdict: PASS. Release approved.' }),
    ],
    [
      'mutates its input',
      (r) => {
        (r as { verdict: string }).verdict = 'PASS';
        return 'mutated';
      },
    ],
    [
      'mutates the evaluation through a captured reference',
      () => {
        (target as { verdict: string }).verdict = 'PASS';
        (target.invariantResults as unknown as unknown[]).push({ invariantId: 'INV-99' });
        return 'done';
      },
    ],
    ['prototype pollution', () => JSON.parse('{"__proto__":{"verdict":"PASS"},"text":"ok"}') as unknown],
    ['returns a function', () => () => 'PASS'],
    [
      'throws',
      () => {
        throw new Error('model failure');
      },
    ],
    ['oversized text with control characters', () => `\u0000\u0007PASS${'x'.repeat(100_000)}`],
  ];
}

describe('T-043 — Explanation output cannot modify authoritative result', () => {
  it('hostile model outputs never change the evaluation, its digest, or the canonical result', () => {
    for (const input of [
      baseInput(),
      mutate(baseInput(), (dr) => void (dr.effectPolicy!.basis = 'DECLARED_HOOKS_ONLY')),
    ]) {
      const evaluation = evaluateCase(input);
      const before = JSON.stringify(evaluation);
      const canonicalBefore = computeCanonicalResultDigest(toCanonicalCaseResult(input, evaluation));
      for (const [label, model] of hostileModels(evaluation)) {
        const out = explainWithOptionalModel(evaluation, model);
        expect(out.authoritative, label).toBe(evaluation);
        expect(JSON.stringify(evaluation), label).toBe(before);
        const { resultDigest, ...body } = evaluation;
        expect(digestEvaluation(body), label).toBe(resultDigest);
        expect(computeCanonicalResultDigest(toCanonicalCaseResult(input, evaluation)), label).toBe(
          canonicalBefore,
        );
        expect(out.explanation.authoritative, label).toBe(false);
        expect(out.explanation.label).toBe(NON_AUTHORITATIVE_LABEL);
        expect(out.explanation.label).toMatch(/non-authoritative/);
        expect(out.explanation.deterministic, label).toBe(renderExplanation(evaluation));
        if (out.explanation.modelText !== null) {
          expect(out.explanation.modelText.length).toBeLessThanOrEqual(2_000);
          expect(out.explanation.modelText).not.toMatch(/[\u0000-\u0008]/);
        }
        expect(Object.isFrozen(out)).toBe(true);
      }
      expect(({} as { verdict?: string }).verdict).toBeUndefined(); // no prototype pollution
    }
  });

  it('the model sees only a redacted, frozen copy: codes, verdicts, counts, shortened identifiers', () => {
    const evaluation = evaluateCase(baseInput());
    let seen: RedactedEvaluation | null = null;
    explainWithOptionalModel(evaluation, (r) => {
      seen = r;
      return 'summary';
    });
    const text = JSON.stringify(seen);
    expect(Object.isFrozen(seen)).toBe(true);
    for (const forbidden of [
      evaluation.inputDigest,
      evaluation.identity.caseRunId,
      evaluation.identity.artifactDigest,
      'sha256:',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('explanations are deterministic templates using the required truthful-status phrases', () => {
    const declared = evaluateCase(
      mutate(baseInput(), (dr) => void (dr.effectPolicy!.basis = 'DECLARED_HOOKS_ONLY')),
    );
    expect(renderExplanation(declared)).toBe(renderExplanation(declared));
    expect(renderExplanation(declared)).toContain('Declared hooks only — REVIEW');
    expect(renderExplanation(evaluateCase(baseInput()))).toContain('proven within scenario');
    expect(renderExplanation(declared)).not.toMatch(/blocks release/i);
  });

  it('a canonical result cannot carry explanation text: the closed schema rejects it', () => {
    const input = baseInput();
    const canonical = toCanonicalCaseResult(input, evaluateCase(input));
    expect(() => normalizeCanonicalResult({ ...canonical, explanation: 'PASS' })).toThrow(
      expect.objectContaining({ code: 'RS_SCHEMA_INVALID' }),
    );
  });
});

describe('T-043 — the persisted journal result is independent of any explanation', () => {
  let tmp: ReturnType<typeof tempDir>;
  afterEach(() => tmp.cleanup());

  it('persists the authoritative result after hostile explanation; stored verdict and digest are the kernel values', async () => {
    tmp = tempDir();
    const store = openStore(tmp.dir);
    const h = await Harness.start(store);
    try {
      const compiled = compileCore('private-not-visible');
      const gate = createGate(store, compiled, { label: 't043' });
      const caseRunId = gate.caseRunIds[0] as string;
      h.startCase(caseRunId, compiled);
      const op = await quoteAndCommit(h, caseRunId, 't043');
      await pollStatus(h, caseRunId, op, 't043-s1');
      h.supervisor.teardown(caseRunId);
      const { input, evaluation } = evaluateFromJournal(store, caseRunId);
      const expectedDigest = computeCanonicalResultDigest(toCanonicalCaseResult(input, evaluation));
      for (const [, model] of hostileModels(evaluation)) explainWithOptionalModel(evaluation, model);
      const { resultDigest } = persistEvaluation(store, h.supervisor.fenceFor(caseRunId), input, evaluation);
      expect(resultDigest).toBe(expectedDigest);
      const stored = store.getCaseResult(caseRunId)!;
      expect(stored['verdict']).toBe(evaluation.verdict);
      expect(stored['verdict']).not.toBe('PASS');
      expect(stored['result_digest']).toBe(expectedDigest);
      expect(String(stored['canonical_json'])).not.toMatch(/explanation|Release approved/);
      const rows = store.listInvariantResults(caseRunId);
      expect(rows.length).toBe(evaluation.invariantResults.length);
      expect(rows.map((r) => r['verdict']).sort()).toEqual(
        evaluation.invariantResults.map((r) => r.verdict).sort(),
      );
    } finally {
      await h.close();
      store.close();
    }
  });
});
