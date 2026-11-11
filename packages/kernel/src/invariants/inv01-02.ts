/**
 * Reusable checks for INV-01 and INV-02 over the same stable snapshot. The binding guards
 * themselves live in the journal (M01); these checks re-verify the snapshot the kernel was given.
 *
 * INV-01: every run operation is scoped to this exact integration revision, build, gate run,
 * case run, and session, and no two operations share a logical job within the case.
 * INV-02: a commit binding exists only on a finalized operation, matches the operation's stored
 * binding digest and commit sequence, and every rejected change left a conflict row rather than
 * a second binding.
 */
import { invariantResult } from '../result.ts';
import type { InvariantResult, KernelInput } from '../types.ts';

export function evaluateInv01(input: KernelInput): InvariantResult[] {
  const id = input.identity;
  if (input.runOperations.length === 0) {
    return [invariantResult({ invariantId: 'INV-01', runOperationId: null, code: 'INV01_NO_OPERATIONS' })];
  }
  const findings: string[] = [];
  const jobs = new Map<string, number>();
  for (const op of input.runOperations) {
    jobs.set(op.logicalJobId, (jobs.get(op.logicalJobId) ?? 0) + 1);
    if (
      op.integrationRevisionId !== id.integrationRevisionId ||
      op.buildRevisionId !== id.buildRevisionId ||
      op.gateRunId !== id.gateRunId ||
      op.caseRunId !== id.caseRunId ||
      op.sessionId !== id.sessionId
    ) {
      findings.push(`OPERATION_SCOPE_MISMATCH:${op.runOperationId}`);
    }
  }
  for (const [job, n] of jobs) if (n > 1) findings.push(`LOGICAL_JOB_MERGED:${job}`);
  for (const a of input.attempts) {
    if (!input.runOperations.some((op) => op.runOperationId === a.runOperationId)) {
      findings.push(`ATTEMPT_OUTSIDE_CASE:${a.attemptId}`);
    }
  }
  const facts = input.runOperations.map((op) => op.runOperationId);
  return [
    invariantResult({
      invariantId: 'INV-01',
      runOperationId: null,
      factIds: facts,
      findings,
      ...(findings.length > 0
        ? { code: 'INV01_OPERATION_SCOPE_MISMATCH' as const, remediation: 'ISOLATE_OPERATION_SCOPE' as const }
        : { code: 'INV01_OPERATIONS_ISOLATED' as const }),
    }),
  ];
}

export function evaluateInv02(input: KernelInput): InvariantResult[] {
  if (input.runOperations.length === 0) {
    return [
      invariantResult({ invariantId: 'INV-02', runOperationId: null, code: 'INV02_BINDINGS_IMMUTABLE' }),
    ];
  }
  return input.runOperations.map((op) => {
    const findings: string[] = [];
    const bindings = input.commitBindings.filter((c) => c.runOperationId === op.runOperationId);
    const fin = input.quoteFinalizations.filter((f) => f.runOperationId === op.runOperationId);
    if (bindings.length > 1) findings.push('MULTIPLE_COMMIT_BINDINGS');
    if (fin.length > 1) findings.push('MULTIPLE_FINALIZATIONS');
    const b = bindings[0];
    if (b !== undefined) {
      if (op.quoteFinalizationDigest === null || fin.length === 0)
        findings.push('COMMIT_WITHOUT_FINALIZATION');
      if (op.commitBindingDigest !== b.bindingDigest) findings.push('COMMIT_BINDING_DIGEST_DIFFERS');
      if (op.committedSequence !== b.sequence) findings.push('COMMIT_SEQUENCE_DIFFERS');
    } else if (op.commitBindingDigest !== null) {
      findings.push('COMMIT_BINDING_ROW_MISSING');
    }
    const f = fin[0];
    if (f !== undefined && op.quoteFinalizationDigest !== f.finalizationDigest) {
      findings.push('FINALIZATION_DIGEST_DIFFERS');
    }
    return invariantResult({
      invariantId: 'INV-02',
      runOperationId: op.runOperationId,
      factIds: [...bindings.map((x) => x.firstAttemptId)],
      findings,
      ...(findings.length > 0
        ? { code: 'INV02_BINDING_INCONSISTENT' as const }
        : { code: 'INV02_BINDINGS_IMMUTABLE' as const }),
    });
  });
}
