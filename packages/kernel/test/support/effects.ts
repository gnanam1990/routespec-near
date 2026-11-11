/**
 * Live protected-effect case driver for T-004 / T-059. Everything runs through real components:
 * the networkless proxy and supervisor (scenario + journal), the separately launched reviewed
 * canary interceptor process (`InterceptorHost`, private inherited IPC channel), subject effect
 * attempts over loopback HTTP at the interceptor's sink, subject self-reports through the
 * case-token path, the runner's fenced release authorization, and the pure kernel.
 */
import { randomBytes } from 'node:crypto';
import { digestValue } from '@routespec/contracts';
import {
  CANARY_INTERCEPTOR_PROFILE,
  INTERCEPTOR_CHANNEL_KEY_DOMAIN,
  InterceptorHost,
  interceptorProfileDigest,
} from '@routespec/proxy';
import type { RouteSpecStore, CaseAuth } from '@routespec/store';
import type { CaseEvaluation, InvariantResult, KernelInput } from '../../src/index.ts';
import {
  Harness,
  compileCore,
  createGate,
  evaluateFromJournal,
  pollStatus,
  quoteAndCommit,
  type Gate,
  type GateOptions,
} from './journal.ts';

export const CANARY_PROFILE_DIGEST = interceptorProfileDigest(CANARY_INTERCEPTOR_PROFILE);
export const SINK = 'fulfilment-webhook';

export async function attemptEffect(
  host: InterceptorHost,
  effectId: string,
  sink = SINK,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${host.sinkOrigin}/sink/${sink}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ effectId }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export function caseAuthFor(h: Harness, gate: Gate, caseRunId: string): CaseAuth {
  const creds = h.creds(caseRunId);
  const session = h.store.getSession(creds.sessionId) as Record<string, unknown>;
  return {
    token: creds.token,
    sessionId: creds.sessionId,
    caseRunId,
    gateRunId: gate.gateRunId,
    buildRevisionId: gate.buildRevisionId,
    artifactDigest: gate.artifactDigest,
    clientInstanceDigest: digestValue('routespec.client-instance/1', creds.clientInstanceId),
    adapterRevision: String(session['adapter_revision']),
    fencingEpoch: creds.fencingEpoch,
  };
}

export function report(
  store: RouteSpecStore,
  auth: CaseAuth,
  gate: Gate,
  over: Partial<Parameters<RouteSpecStore['recordSubjectEffectReport']>[1]> & {
    effectId: string;
    action: 'ATTEMPTED' | 'BLOCKED' | 'RELEASED';
  },
) {
  return store.recordSubjectEffectReport(auth, {
    runOperationId: null,
    policyDigest: gate.policyDigest,
    manifestDigest: gate.manifestDigest,
    hookId: 'fulfilment',
    hookRevision: '1',
    effectType: 'DELIVER_GOODS',
    idempotencyKey: `${over.effectId}-${over.action}`,
    ...over,
  });
}

export interface LiveCaseOptions extends GateOptions {
  /** Launch the reviewed canary interceptor (default true). */
  launch?: boolean;
  /** Release before any accepted completion (a forbidden release). */
  releaseEarly?: boolean;
  /** Cite this evidence subject class for the release authorization: proven ground truth or a provider report. */
  authorizeWith?: 'PROVEN_CREDIT' | 'PROVIDER_REPORT' | 'NONE';
  /** Orderly interceptor teardown before evaluation (default true). */
  teardown?: boolean;
  /** Kill the interceptor before evaluation (channel loss). */
  killInterceptor?: boolean;
  /** Fence the case (recovery) after launching the interceptor, making the instance stale. */
  staleInterceptor?: boolean;
  /** Record an interceptor-channel coverage finding through a second authenticated channel. */
  escapeFinding?: boolean;
  /** Subject self-reports an effect release the boundary never observed. */
  unobservedSubjectRelease?: boolean;
}

export interface LiveCase {
  readonly gate: Gate;
  readonly caseRunId: string;
  readonly input: KernelInput;
  readonly evaluation: CaseEvaluation;
  readonly inv04: InvariantResult;
  readonly attempts: Array<{ phase: string; status: number; body: Record<string, unknown> }>;
}

export async function runLiveEffectCase(
  h: Harness,
  label: string,
  options: LiveCaseOptions = {},
): Promise<LiveCase> {
  const store = h.store;
  const compiled = compileCore('happy-path');
  const gate = createGate(store, compiled, {
    label,
    requiredInvariants: ['INV-03', 'INV-04', 'INV-05', 'INV-06', 'INV-07', 'INV-08'],
    basis: options.basis ?? 'INDEPENDENT_BOUNDARY_INTERCEPT',
    interceptorProfileDigest:
      options.interceptorProfileDigest === undefined
        ? CANARY_PROFILE_DIGEST
        : options.interceptorProfileDigest,
    ...options,
  });
  const caseRunId = gate.caseRunIds[0] as string;
  h.startCase(caseRunId, compiled);
  const attempts: LiveCase['attempts'] = [];
  let host: InterceptorHost | null = null;
  try {
    if (options.launch !== false) {
      host = await InterceptorHost.launch({ store, fence: h.supervisor.fenceFor(caseRunId) });
    }
    if (options.staleInterceptor) {
      // The case is fenced after the interceptor bound itself: its epoch is now stale.
      store.requireRecovery(h.supervisor.fenceFor(caseRunId), 'RUNNER_CANCELLED');
    }
    const auth = caseAuthFor(h, gate, caseRunId);
    // Before accepted completion: the subject attempts the protected effect and self-reports it.
    if (!options.staleInterceptor)
      report(store, auth, gate, { effectId: `${label}-early`, action: 'ATTEMPTED' });
    if (options.releaseEarly && host) await host.release();
    if (host) attempts.push({ phase: 'before-completion', ...(await attemptEffect(host, `${label}-early`)) });
    if (options.unobservedSubjectRelease)
      report(store, auth, gate, { effectId: `${label}-bypass`, action: 'RELEASED' });
    if (options.escapeFinding) {
      const key = randomBytes(32).toString('base64url');
      const { interceptorInstanceId } = store.registerInterceptorInstance(h.supervisor.fenceFor(caseRunId), {
        interceptorProfileDigest: CANARY_PROFILE_DIGEST,
        interceptorArtifactDigest: CANARY_INTERCEPTOR_PROFILE.artifactDigest,
        sandboxScopeDigest: digestValue('routespec.sandbox-scope/1', { label }),
        supportedSinks: [SINK],
        containment: 'DECLARED_HOOKS_ONLY',
        channelKeyDigest: digestValue(INTERCEPTOR_CHANNEL_KEY_DOMAIN, key),
        peerPid: process.pid,
        attestationId: null,
      });
      store.recordCoverageFinding(
        { interceptorInstanceId, channelKey: key },
        {
          kind: 'PROCESS_TREE_ESCAPE',
          sinkClass: SINK,
          fencingEpoch: h.supervisor.fenceFor(caseRunId).fencingEpoch,
          detailDigest: digestValue('routespec.test/1', 'escape'),
        },
      );
      store.teardownInterceptor({ interceptorInstanceId, channelKey: key }, 'TEARDOWN');
    }

    // The swap runs to its accepted terminal status through the proxy.
    if (!options.staleInterceptor) {
      const op = await quoteAndCommit(h, caseRunId, label);
      for (let i = 1; i <= 3; i++) {
        const s = await pollStatus(h, caseRunId, op, `${label}-s${i}`);
        if ((s.body as { status?: string }).status === 'SUCCESS') break;
      }
      // Ground truth recorded under the fence; the runner then decides on release.
      h.supervisor.finishInput(caseRunId);
      const snapshot = store.readEvaluationSnapshot(caseRunId);
      const fence = h.supervisor.fenceFor(caseRunId);
      const authorizeWith = options.authorizeWith ?? 'PROVEN_CREDIT';
      if (authorizeWith !== 'NONE' && !options.releaseEarly) {
        let cited: string;
        if (authorizeWith === 'PROVEN_CREDIT') {
          cited = String(
            snapshot.evidence.find((e) => e['subject'] === 'destination_credit')?.['evidence_id'],
          );
        } else {
          cited = store.recordEvidence(fence, {
            runOperationId: op.runOperationId,
            evidenceClass: 'REPORTED',
            evidenceScope: 'PROVIDER_REPORTED',
            reasons: [],
            subject: 'destination_credit',
            sourceKind: 'PROVIDER_STATUS',
            assetId: null,
            amount: null,
            singleUse: false,
            payload: { rawStatus: 'SUCCESS' },
          }).evidenceId;
        }
        store.recordEffectReleaseAuthorization(fence, {
          interceptorInstanceId: host?.interceptorInstanceId ?? null,
          completionEvidenceIds: [cited],
        });
        if (host) await host.release();
      }
      if (host) attempts.push({ phase: 'after-completion', ...(await attemptEffect(host, `${label}-late`)) });
      report(store, caseAuthFor(h, gate, caseRunId), gate, { effectId: `${label}-late`, action: 'RELEASED' });
    }
    if (host && options.killInterceptor) {
      process.kill(host.peerPid);
      for (let i = 0; i < 100 && !host.closed; i++) await new Promise((r) => setTimeout(r, 20));
    } else if (host && options.teardown !== false) {
      await host.teardown();
    }
    if (!options.staleInterceptor) h.supervisor.teardown(caseRunId);
    const { input, evaluation } = evaluateFromJournal(store, caseRunId);
    const inv04 = evaluation.invariantResults.find((r) => r.invariantId === 'INV-04') as InvariantResult;
    return { gate, caseRunId, input, evaluation, inv04, attempts };
  } finally {
    if (host && !host.closed) await host.teardown().catch(() => undefined);
  }
}
