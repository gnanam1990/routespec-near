/**
 * Violated invariant results of one persisted gate evaluation, for fix advice (M53).
 *
 * The stored canonical case result keeps each invariant's verdict but not its explanation code.
 * To link a violation to a fix pattern this module re-runs the pure kernel over the same
 * journal snapshot, read-only, and uses the result only when it reproduces the stored result
 * digest exactly. A case that does not reproduce is listed as such and links no pattern.
 * Nothing here writes to the journal or changes a verdict or decision.
 *
 * `@routespec/fix-patterns` (which loads the TypeScript compiler) is imported for types only, so
 * loading the runner never loads the compiler; callers import it when advice is asked for.
 */
import { computeCanonicalResultDigest } from '@routespec/contracts';
import type { FixAdviceInput, InvariantViolation } from '@routespec/fix-patterns';
import { evaluateCase, snapshotFromJournal, toCanonicalCaseResult } from '@routespec/kernel';
import type { GateEvaluationView, RouteSpecStore } from '@routespec/store';

export interface CollectedViolations {
  readonly violations: readonly InvariantViolation[];
  readonly unreproduced: ReadonlyArray<{ ordinal: number; caseRunId: string | null; reason: string }>;
}

export function collectInvariantViolations(
  store: RouteSpecStore,
  view: GateEvaluationView,
): CollectedViolations {
  const violations: InvariantViolation[] = [];
  const unreproduced: Array<{ ordinal: number; caseRunId: string | null; reason: string }> = [];
  for (const c of view.cases) {
    if (c.contribution !== 'FAIL' && c.contribution !== 'REVIEW') continue;
    if (c.caseRunId === null || c.resultDigest === null) {
      unreproduced.push({ ordinal: c.ordinal, caseRunId: c.caseRunId, reason: 'NO_CASE_RESULT' });
      continue;
    }
    let evaluation: ReturnType<typeof evaluateCase>;
    try {
      const input = snapshotFromJournal(store.readEvaluationSnapshot(c.caseRunId));
      evaluation = evaluateCase(input);
      if (computeCanonicalResultDigest(toCanonicalCaseResult(input, evaluation)) !== c.resultDigest) {
        unreproduced.push({ ordinal: c.ordinal, caseRunId: c.caseRunId, reason: 'RESULT_NOT_REPRODUCED' });
        continue;
      }
    } catch {
      unreproduced.push({ ordinal: c.ordinal, caseRunId: c.caseRunId, reason: 'SNAPSHOT_UNREADABLE' });
      continue;
    }
    for (const r of evaluation.invariantResults) {
      if (r.verdict !== 'FAIL' && r.verdict !== 'REVIEW') continue;
      violations.push({
        ordinal: c.ordinal,
        caseRunId: c.caseRunId,
        required: c.required && evaluation.requiredInvariants.includes(r.invariantId),
        invariantId: r.invariantId,
        verdict: r.verdict,
        explanationCode: r.explanationCode,
        remediationCode: r.remediationCode,
      });
    }
  }
  return { violations, unreproduced };
}

/** The fix-advice input for a persisted gate evaluation (without a source). */
export function gateFixAdviceInput(
  store: RouteSpecStore,
  view: GateEvaluationView,
): Omit<FixAdviceInput, 'source'> {
  const { violations, unreproduced } = collectInvariantViolations(store, view);
  const artifact = view.identity['artifactDigest'];
  return {
    gate: {
      gateRunId: view.gateRunId,
      gateEvaluationId: view.gateEvaluationId,
      decision: view.decision,
      artifactDigest: typeof artifact === 'string' ? artifact : null,
    },
    violations,
    unreproduced,
  };
}
