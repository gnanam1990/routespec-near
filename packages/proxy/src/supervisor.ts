/**
 * Case supervisor for the networkless runtime (FR-07, FR-17, INV-03; TDD.md sections 5 and 8).
 *
 * Holds the execution fence (lease owner + fencing epoch) for each case it starts, owns one
 * scenario runtime per case, and hands credentials to the launcher channel. It never computes a
 * verdict: evaluation belongs to the kernel (M04) and gate aggregation to the runner (M06).
 *
 * Responsibilities:
 * - start: verify the compiled scenario is exactly the case's stored scenario revision, start
 *   the case (fresh session, client lease, one-time EXECUTION token), create the runtime;
 * - unknown outcome: when the proxy reports an undelivered commit response, revoke the token,
 *   increment the epoch (RECOVERY_REQUIRED), and issue exactly one RECONCILIATION_ONLY token
 *   bound to the same client instance, delivered through `onCredentials`;
 * - finish input: close the scenario and record ground-truth and runtime-summary evidence with
 *   separate class/scope/reason (PRIVATE legs are UNKNOWN / PRIVATE_NOT_VISIBLE / NOT_VISIBLE);
 * - abort: cancel with token revocation and teardown.
 */
import { randomBytes } from 'node:crypto';
import {
  ADAPTER_REVISION,
  CLIENT_INSTANCE_DIGEST_DOMAIN,
  RouteSpecError,
  digestValue,
  type EvidenceClass,
  type EvidenceReason,
  type EvidenceScope,
  type TokenPurpose,
} from '@routespec/contracts';
import {
  ScenarioRuntime,
  type CompiledScenario,
  type GroundTruthFact,
  type RuntimeSummary,
} from '@routespec/scenario';
import type { ExecutionFence, RouteSpecStore } from '@routespec/store';
import type { CaseRuntimeRegistry, UncertainOutcomeEvent } from './server.ts';

/** Everything the actual-client adapter needs; delivered over the launcher channel, never argv/env. */
export interface LaunchCredentials {
  readonly purpose: TokenPurpose;
  readonly token: string;
  readonly sessionId: string;
  readonly caseRunId: string;
  readonly adapterRevision: string;
  readonly fencingEpoch: number;
  readonly clientInstanceId: string;
}

export interface SupervisorOptions {
  readonly leaseTtlMs?: number;
  readonly tokenTtlMs?: number;
  /** Stable label of this runner; only its digest is stored as the lease owner. */
  readonly ownerLabel?: string;
  readonly onCredentials?: (caseRunId: string, credentials: LaunchCredentials) => void;
}

interface CaseState {
  readonly runtime: ScenarioRuntime;
  readonly compiled: CompiledScenario;
  readonly clientInstanceId: string;
  fence: ExecutionFence;
  fencedForUncertainty: boolean;
  /** Client input is closed (teardown or abort): the client can no longer act on this case. */
  inputClosed: boolean;
  readonly uncertain: UncertainOutcomeEvent[];
  summary: RuntimeSummary | null;
}

export const GROUND_TRUTH_SUBJECT: Readonly<Record<GroundTruthFact, string>> = Object.freeze({
  ORIGIN_DEPOSIT: 'origin_debit',
  DESTINATION_CREDIT: 'destination_credit',
  REFUND: 'refund_settlement',
  ORIGIN_FEE: 'origin_fee',
  LOCKED_VALUE: 'locked_value',
  EFFECT_COMPLETION_ACCEPTED: 'effect_completion',
});

export class CaseSupervisor implements CaseRuntimeRegistry {
  readonly store: RouteSpecStore;
  private readonly leaseTtlMs: number;
  private readonly tokenTtlMs: number;
  private readonly owner: string;
  private readonly onCredentials: (caseRunId: string, credentials: LaunchCredentials) => void;
  private readonly cases = new Map<string, CaseState>();

  constructor(store: RouteSpecStore, options: SupervisorOptions = {}) {
    this.store = store;
    this.leaseTtlMs = options.leaseTtlMs ?? 300_000;
    this.tokenTtlMs = options.tokenTtlMs ?? 600_000;
    this.owner = digestValue(
      'routespec.runner-owner/1',
      options.ownerLabel ?? `supervisor-${randomBytes(8).toString('hex')}`,
    );
    this.onCredentials = options.onCredentials ?? (() => undefined);
  }

  startCase(input: {
    caseRunId: string;
    compiled: CompiledScenario;
    mode: 'SIMULATE' | 'REPLAY';
    clientInstanceId?: string;
  }): LaunchCredentials {
    const caseRun = this.store.getCaseRun(input.caseRunId);
    if (!caseRun) throw new RouteSpecError('RS_NOT_FOUND', 'Case run not found.');
    const stored = this.store.getScenarioRevision(String(caseRun['scenario_revision_id']));
    if (!stored || stored['revision_digest'] !== input.compiled.revisionDigest) {
      throw new RouteSpecError(
        'RS_IDENTITY_MISMATCH',
        'Compiled scenario is not the case run scenario revision.',
      );
    }
    const clientInstanceId = input.clientInstanceId ?? `client-${randomBytes(16).toString('hex')}`;
    const started = this.store.startCase({
      caseRunId: input.caseRunId,
      leaseOwnerDigest: this.owner,
      clientInstanceDigest: digestValue(CLIENT_INSTANCE_DIGEST_DOMAIN, clientInstanceId),
      mode: input.mode,
      seed: input.compiled.plan.seed,
      leaseTtlMs: this.leaseTtlMs,
      tokenTtlMs: this.tokenTtlMs,
    });
    this.cases.set(input.caseRunId, {
      runtime: new ScenarioRuntime(input.compiled.plan),
      compiled: input.compiled,
      clientInstanceId,
      fence: { caseRunId: input.caseRunId, leaseOwnerDigest: this.owner, fencingEpoch: started.fencingEpoch },
      fencedForUncertainty: false,
      inputClosed: false,
      uncertain: [],
      summary: null,
    });
    return {
      purpose: 'EXECUTION',
      token: started.token,
      sessionId: started.sessionId,
      caseRunId: input.caseRunId,
      adapterRevision: started.auth.adapterRevision,
      fencingEpoch: started.fencingEpoch,
      clientInstanceId,
    };
  }

  runtimeFor(caseRunId: string): ScenarioRuntime | undefined {
    const state = this.cases.get(caseRunId);
    return state && state.summary === null ? state.runtime : undefined;
  }

  fenceFor(caseRunId: string): ExecutionFence {
    const state = this.cases.get(caseRunId);
    if (!state) throw new RouteSpecError('RS_NOT_FOUND', 'Case is not supervised here.');
    return state.fence;
  }

  uncertainOutcomes(caseRunId: string): readonly UncertainOutcomeEvent[] {
    return this.cases.get(caseRunId)?.uncertain ?? [];
  }

  /**
   * INV-03: fence immediately and issue exactly one reconciliation-only token.
   *
   * The proxy learns that a response was not delivered when its socket closes, and that close
   * can arrive after the case's client input was closed (the subject process exits, or the proxy
   * shuts down, after teardown or abort). By then the case's tokens are revoked, it is being or
   * has been evaluated (or was aborted), and the undelivered response is already in the journal
   * (never marked delivered). Such a late report must not move the fence of a closed case or
   * reach the store, which may already be closed.
   */
  onUncertainOutcome(event: UncertainOutcomeEvent): void {
    const state = this.cases.get(event.caseRunId);
    if (!state || state.inputClosed) return;
    state.uncertain.push(event);
    if (state.fencedForUncertainty) return;
    state.fencedForUncertainty = true;
    const fenced = this.store.requireRecovery(state.fence, 'OUTCOME_UNKNOWN');
    const recovered = this.store.recoverCase({
      caseRunId: event.caseRunId,
      recoveryOwnerDigest: this.owner,
      clientInstanceDigest: digestValue(CLIENT_INSTANCE_DIGEST_DOMAIN, state.clientInstanceId),
      expectedFencingEpoch: fenced.fencingEpoch,
      leaseTtlMs: this.leaseTtlMs,
      tokenTtlMs: this.tokenTtlMs,
    });
    state.fence = { ...state.fence, fencingEpoch: recovered.fencingEpoch };
    this.onCredentials(event.caseRunId, {
      purpose: 'RECONCILIATION_ONLY',
      token: recovered.token,
      sessionId: recovered.auth.sessionId,
      caseRunId: event.caseRunId,
      adapterRevision: recovered.auth.adapterRevision,
      fencingEpoch: recovered.fencingEpoch,
      clientInstanceId: state.clientInstanceId,
    });
  }

  /**
   * Close client input: finish the scenario runtime and record its ground truth and summary as
   * evidence under the current fence. Returns the summary and recorded evidence IDs.
   */
  finishInput(caseRunId: string): { summary: RuntimeSummary; evidenceIds: string[] } {
    const state = this.cases.get(caseRunId);
    if (!state) throw new RouteSpecError('RS_NOT_FOUND', 'Case is not supervised here.');
    if (state.summary !== null) throw new RouteSpecError('RS_PHASE_INVALID', 'Case input already finished.');
    const summary = state.runtime.finish();
    state.summary = summary;
    const operations = this.store.listRunOperations(caseRunId);
    const runOperationId = operations.length === 1 ? String(operations[0]?.['run_operation_id']) : null;
    const evidenceIds: string[] = [];
    for (const emission of summary.groundTruth) {
      const ev = emission.event;
      const visible = ev.visibility === 'VISIBLE';
      const evidenceClass: EvidenceClass = visible ? 'PROVEN' : 'UNKNOWN';
      const evidenceScope: EvidenceScope = visible ? 'SIMULATED_GROUND_TRUTH' : 'PRIVATE_NOT_VISIBLE';
      const reasons: EvidenceReason[] = visible ? [] : ['NOT_VISIBLE'];
      evidenceIds.push(
        this.store.recordEvidence(state.fence, {
          runOperationId,
          evidenceClass,
          evidenceScope,
          reasons,
          subject: GROUND_TRUTH_SUBJECT[ev.fact],
          sourceKind: 'SCENARIO_GROUND_TRUTH',
          assetId: visible ? ev.assetId : null,
          amount: visible ? ev.amount : null,
          singleUse: ev.singleUse,
          recipient: visible ? ev.recipient : null,
          // Identical payload for a duplicate emission: it is the same proof, observed twice.
          payload: {
            scenarioRevisionDigest: state.compiled.revisionDigest,
            eventId: ev.id,
            fact: ev.fact,
            virtualMs: emission.virtualMs,
          },
        }).evidenceId,
      );
    }
    evidenceIds.push(
      this.store.recordEvidence(state.fence, {
        runOperationId: null,
        evidenceClass: 'PROVEN',
        evidenceScope: 'SIMULATED_GROUND_TRUTH',
        reasons: summary.canonicalTimer ? [] : ['NONCANONICAL_TIMER'],
        subject: 'scenario_runtime',
        sourceKind: 'SCENARIO_RUNTIME',
        assetId: null,
        amount: null,
        singleUse: false,
        payload: {
          runtimeRevision: summary.runtimeRevision,
          eventLogDigest: summary.eventLogDigest,
          canonicalTimer: summary.canonicalTimer,
          assertionsFailed: summary.assertionsFailed,
          unexpectedRequests: summary.unexpectedRequests,
          limitBreached: summary.limitBreached,
          finalVirtualMs: summary.finalVirtualMs,
        },
      }).evidenceId,
    );
    return { summary, evidenceIds };
  }

  /**
   * Case teardown before evaluation: finish scenario input (recording its evidence) if that has
   * not happened yet, then revoke every active case token so the subject client is refused from
   * here on. The lifecycle stays RUNNING for the evaluator (M04).
   */
  teardown(caseRunId: string): { summary: RuntimeSummary; evidenceIds: string[]; revokedTokens: number } {
    const state = this.cases.get(caseRunId);
    if (!state) throw new RouteSpecError('RS_NOT_FOUND', 'Case is not supervised here.');
    const finished =
      state.summary === null
        ? this.finishInput(caseRunId)
        : { summary: state.summary, evidenceIds: [] as string[] };
    const { revokedTokens } = this.store.closeCaseInput(state.fence);
    state.inputClosed = true;
    return { ...finished, revokedTokens };
  }

  /**
   * Adopt the fence of a recovery performed outside this supervisor (control API recovery
   * after an expired lease). The epoch must only move forward; the runtime is kept so
   * read-only reconciliation can continue against the same scenario state.
   */
  adoptFence(caseRunId: string, fencingEpoch: number): void {
    const state = this.cases.get(caseRunId);
    if (!state) return;
    if (fencingEpoch <= state.fence.fencingEpoch) {
      throw new RouteSpecError('RS_STALE_FENCING_EPOCH', 'Adopted fence must advance the epoch.');
    }
    state.fence = { ...state.fence, fencingEpoch };
    state.fencedForUncertainty = true;
  }

  /** The current execution fence of a supervised case (null when not supervised here). */
  fenceOf(caseRunId: string): ExecutionFence | null {
    const state = this.cases.get(caseRunId);
    return state ? { ...state.fence } : null;
  }

  /** Whether scenario input of a supervised case has been closed (ground truth journaled). */
  inputFinished(caseRunId: string): boolean {
    return this.cases.get(caseRunId)?.summary != null;
  }

  supervises(caseRunId: string): boolean {
    return this.cases.has(caseRunId);
  }

  clientInstanceOf(caseRunId: string): string | null {
    return this.cases.get(caseRunId)?.clientInstanceId ?? null;
  }

  summaryFor(caseRunId: string): RuntimeSummary | null {
    return this.cases.get(caseRunId)?.summary ?? null;
  }

  abort(caseRunId: string, reason = 'RUNNER_CANCELLED'): void {
    const state = this.cases.get(caseRunId);
    if (!state) throw new RouteSpecError('RS_NOT_FOUND', 'Case is not supervised here.');
    this.store.abortCase(state.fence, reason);
    state.inputClosed = true;
    if (state.summary === null) state.summary = state.runtime.finish();
  }
}

export { ADAPTER_REVISION };
