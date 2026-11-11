/**
 * INV-03 — Reconcile before retry under uncertainty (FR-07, TDD.md section 8).
 *
 * For every commit attempt whose outcome was unknown (`SENT_OUTCOME_UNKNOWN`, or later
 * `RECONCILED`) at journal sequence s on run operation X, at fencing epoch e:
 *
 * - FAIL if any quote finalization or new commit binding anywhere in the case was accepted
 *   after s and before X's first accepted terminal status (a second mutation);
 * - FAIL if an EXECUTION (mutation-capable) token exists at an epoch greater than e;
 * - REVIEW if the journal does not show the epoch-e tokens revoked, the epoch advanced, and a
 *   RECONCILIATION_ONLY token issued at the later epoch (recovery fence missing);
 * - REVIEW if an exact retry joined X before the fence (no new binding, but not provably safe);
 * - REVIEW if X has not reached an accepted terminal status (reconciliation incomplete);
 * - otherwise PASS.
 *
 * Cancellation, crash, timeout, or a user assertion never counts as a terminal result: only an
 * accepted terminal provider status observed through read-only reconciliation does.
 */
import { TERMINAL_RAW_STATUSES, type RawProviderStatus } from '@routespec/contracts';
import { invariantResult } from '../result.ts';
import type { InvariantResult, KernelInput } from '../types.ts';

const ID = 'INV-03';

export function evaluateInv03(input: KernelInput): InvariantResult[] {
  const exchangeByAttempt = new Map(
    input.exchanges.filter((x) => x.attemptId !== null).map((x) => [x.attemptId as string, x]),
  );
  const commitAttempts = input.attempts.filter((a) => a.phase === 'COMMIT_MUTATION');
  if (input.commitBindings.length === 0 && commitAttempts.length === 0) {
    return [invariantResult({ invariantId: ID, runOperationId: null, code: 'INV03_NO_COMMIT' })];
  }
  const uncertain = commitAttempts
    .filter((a) => a.outcome === 'SENT_OUTCOME_UNKNOWN' || a.outcome === 'RECONCILED')
    .map((a) => ({ attempt: a, exchange: exchangeByAttempt.get(a.attemptId) ?? null }))
    .sort((p, q) => (p.exchange?.sequence ?? Infinity) - (q.exchange?.sequence ?? Infinity));
  if (uncertain.length === 0) {
    return [
      invariantResult({
        invariantId: ID,
        runOperationId: null,
        code: 'INV03_NO_UNCERTAINTY',
        factIds: commitAttempts.map((a) => a.attemptId),
      }),
    ];
  }
  const results: InvariantResult[] = [];
  const seenOps = new Set<string>();
  for (const { attempt, exchange } of uncertain) {
    const op = attempt.runOperationId;
    if (seenOps.has(op)) continue;
    seenOps.add(op);
    const findings: string[] = [];
    const facts = [attempt.attemptId];
    const s = exchange?.sequence ?? null;
    const e = attempt.fencingEpoch;
    if (s === null) findings.push('UNCERTAIN_ATTEMPT_WITHOUT_EXCHANGE');
    const terminal = input.events
      .filter(
        (ev) =>
          ev.runOperationId === op &&
          ev.kind === 'PROVIDER_STATUS' &&
          ev.rawStatus !== null &&
          TERMINAL_RAW_STATUSES.includes(ev.rawStatus as RawProviderStatus) &&
          (s === null || ev.sequence > s),
      )
      .sort((a, b) => a.sequence - b.sequence)[0];
    const terminalSeq = terminal?.sequence ?? Infinity;
    if (terminal) facts.push(terminal.eventId);
    const after = (seq: number) => s !== null && seq > s && seq < terminalSeq;

    const secondMutations = [
      ...input.quoteFinalizations
        .filter((f) => after(f.sequence))
        .map((f) => `QUOTE_FINALIZATION_ACCEPTED:${f.runOperationId}`),
      ...input.commitBindings
        .filter((c) => after(c.sequence) && c.firstAttemptId !== attempt.attemptId)
        .map((c) => `COMMIT_ACCEPTED:${c.runOperationId}`),
    ];
    const joined = input.events.filter((ev) => ev.kind === 'COMMIT_RETRY_JOINED' && after(ev.sequence));
    const reissued = input.tokens.filter((t) => t.purpose === 'EXECUTION' && t.fencingEpoch > e);
    const staleRevoked = input.tokens
      .filter((t) => t.fencingEpoch === e)
      .every((t) => t.revoked && (t.revokedAtEpoch ?? -1) >= e);
    const reconciliationIssued = input.tokens.some(
      (t) => t.purpose === 'RECONCILIATION_ONLY' && t.fencingEpoch > e,
    );
    const fenced = staleRevoked && input.identity.fencingEpoch > e && reconciliationIssued;

    findings.push(...secondMutations, ...reissued.map((t) => `EXECUTION_TOKEN_AT_EPOCH:${t.fencingEpoch}`));
    findings.push(...joined.map((ev) => `RETRY_JOINED:${ev.eventId}`));
    if (!fenced) findings.push('RECOVERY_FENCE_MISSING');
    if (!terminal) findings.push('NO_ACCEPTED_TERMINAL');

    const base = { invariantId: ID, runOperationId: op, factIds: facts, findings };
    if (secondMutations.length > 0) {
      results.push(
        invariantResult({
          ...base,
          code: 'INV03_SECOND_MUTATION_UNDER_UNCERTAINTY',
          remediation: 'RECONCILE_BEFORE_RETRY',
        }),
      );
    } else if (reissued.length > 0) {
      results.push(
        invariantResult({
          ...base,
          code: 'INV03_MUTATION_AUTHORITY_REISSUED',
          remediation: 'RECONCILE_BEFORE_RETRY',
        }),
      );
    } else if (!fenced) {
      results.push(
        invariantResult({
          ...base,
          code: 'INV03_RECOVERY_FENCE_MISSING',
          remediation: 'RECONCILE_BEFORE_RETRY',
        }),
      );
    } else if (joined.length > 0) {
      results.push(
        invariantResult({
          ...base,
          code: 'INV03_RETRY_JOINED_BEFORE_FENCE',
          remediation: 'RECONCILE_BEFORE_RETRY',
        }),
      );
    } else if (!terminal) {
      results.push(
        invariantResult({
          ...base,
          code: 'INV03_RECONCILIATION_INCOMPLETE',
          remediation: 'COMPLETE_RECONCILIATION',
          missingPredicates: ['ACCEPTED_TERMINAL_STATUS'],
        }),
      );
    } else {
      results.push(invariantResult({ ...base, code: 'INV03_RECONCILED_WITHOUT_SECOND_MUTATION' }));
    }
  }
  return results;
}
