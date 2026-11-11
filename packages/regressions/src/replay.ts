/**
 * Repeated no-network trial replay (FR-11, NFR-01; API-SPEC `POST /imports/{id}/verify-replay`).
 *
 * The mapped scenario is compiled by the M03 compiler, and the trace's observed exchange
 * sequence is replayed through the deterministic M03 runtime under a fixed trial identity that
 * pins the evaluator revision. Trials run in this process and at least once in a separately
 * launched process; every trial must produce the same canonical replay digest. The replay must
 * also be faithful to the trace: each observed exchange gets the same kind of decision
 * (response vs. deterministically lost response) and every observed status the same raw value.
 *
 * Findings that keep an import out of REPLAY_VERIFIED: unstable digests, unfaithful decisions,
 * a non-canonical client timer (retry under a wall-clock timer), unexpected requests, failed
 * assertions, or a resource-limit breach.
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ADAPTER_REVISION,
  ONECLICK_PROFILE_ID,
  RouteSpecError,
  digestValue,
  type Digest,
} from '@routespec/contracts';
import { EVALUATOR_REVISION } from '@routespec/kernel';
import {
  canonicalReplayDigest,
  compileScenario,
  type CompiledScenario,
  type Decision,
  type ReplayExchange,
} from '@routespec/scenario';
import type { ImportJournal, StoredFinding } from '@routespec/store';
import { compileMapping, scenarioSourceFromMapping, validateMapping, type Mapping } from './mapping.ts';
import type { TraceDocument } from './trace.ts';

export interface TrialInput {
  readonly identity: Record<string, unknown>;
  readonly source: unknown;
  readonly exchanges: readonly ReplayExchange[];
}

export interface TrialResult {
  readonly digest: string;
  readonly decisions: ReadonlyArray<Pick<Decision, 'kind' | 'rawStatus'>>;
  readonly canonicalTimer: boolean;
  readonly unexpectedRequests: number;
  readonly assertionsFailed: number;
  readonly limitBreached: boolean;
}

export type TrialRunner = (input: TrialInput, trial: number) => Promise<TrialResult>;

export function replayExchangesFromTrace(trace: TraceDocument): ReplayExchange[] {
  const jobOf = new Map(trace.operations.map((o) => [o.ref, o.logicalJobRef]));
  return trace.exchanges.map((ex) => ({
    request: {
      route: ex.route,
      material: ex.material,
      ...(ex.route === 'QUOTE' && ex.operationRef !== null
        ? { logicalJobKey: jobOf.get(ex.operationRef) as string }
        : {}),
    },
  }));
}

/** A fixed, fully specified trial identity: every field pinned, nothing host- or time-derived. */
export function trialIdentity(input: {
  importId: string;
  mappingDigest: string;
  trace: TraceDocument;
  compiled: CompiledScenario;
}): Record<string, unknown> {
  const id = input.trace.identity;
  const placeholder = (label: string): Digest =>
    digestValue('routespec.replay-trial/1', `${label}:${input.importId}`);
  return {
    projectRevisionId: id?.integrationRevisionId ?? `import-${input.importId}`,
    buildRevisionId: id?.buildRevisionId ?? `user-file-${input.importId}`,
    artifactDigest: id?.artifactDigest ?? placeholder('artifact'),
    buildAttestationClass: 'USER_ASSERTED_LOCAL',
    buildAttestationId: null,
    gateRunId: `trial-gate-${input.importId}`,
    caseRunId: `trial-case-${input.mappingDigest.slice(7, 39)}`,
    runOperationLineage: input.trace.operations.map((o) => ({
      relation: 'REPLAY_OF',
      runOperationId: o.ref,
    })),
    scenarioRevisionDigest: input.compiled.revisionDigest,
    seed: input.compiled.plan.seed,
    adapterRevision: id?.adapterRevision ?? ADAPTER_REVISION,
    protocolProfileId: ONECLICK_PROFILE_ID,
    evaluatorRevision: EVALUATOR_REVISION,
    effectCoveragePolicyDigest: id?.effectCoveragePolicyDigest ?? placeholder('policy'),
    effectManifestDigest: id?.effectManifestDigest ?? placeholder('manifest'),
    callsiteInventoryDigest: id?.callsiteInventoryDigest ?? null,
    interceptorProfileDigest: id?.interceptorProfileDigest ?? null,
    configurationDigest: placeholder('configuration'),
    fencingEpoch: 0,
  };
}

function summarize(compiled: CompiledScenario, input: TrialInput): TrialResult {
  const r = canonicalReplayDigest(input.identity, compiled, input.exchanges);
  return {
    digest: r.digest,
    decisions: r.decisions.map((d) => ({ kind: d.kind, rawStatus: d.rawStatus })),
    canonicalTimer: r.summary.canonicalTimer,
    unexpectedRequests: r.summary.unexpectedRequests,
    assertionsFailed: r.summary.assertionsFailed,
    limitBreached: r.summary.limitBreached,
  };
}

/** In-process trial: compile from source and replay from a fresh runtime. */
export const inProcessTrial: TrialRunner = (input) =>
  Promise.resolve(summarize(compileScenario(input.source, { format: 'json' }), input));

/** Separately launched trial process; data travels only over the IPC channel. */
export const childProcessTrial: TrialRunner = (input) =>
  new Promise((resolve, reject) => {
    const script = fileURLToPath(new URL('./replay-trial-child.ts', import.meta.url));
    const child = fork(script, [], {
      execArgv: ['--no-warnings'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        PATH: process.env['PATH'] ?? '',
        SystemRoot: process.env['SystemRoot'] ?? '',
        TZ: 'Pacific/Kiritimati',
      },
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new RouteSpecError('RS_INTERNAL', 'Replay trial process timed out.'));
    }, 30_000);
    child.once('message', (m: unknown) => {
      clearTimeout(timer);
      const msg = m as { ok: boolean; result?: TrialResult; code?: string };
      child.disconnect();
      if (msg.ok && msg.result) resolve(msg.result);
      else reject(new RouteSpecError('RS_INTERNAL', `Replay trial failed: ${String(msg.code)}`));
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.send(input);
  });

export interface ReplayVerification {
  readonly reportId: string;
  readonly reportDigest: string;
  readonly verified: boolean;
  readonly trialDigests: readonly string[];
  readonly fidelity: 'MATCH' | 'MISMATCH';
  readonly findings: readonly StoredFinding[];
  readonly scenarioRevisionDigest: string;
  readonly revision: number;
}

export async function verifyReplay(
  journal: ImportJournal,
  input: {
    importId: string;
    expectedRevision: number;
    idempotencyKey: string;
    inProcessTrials?: number;
    crossProcess?: boolean;
    /** Override the trial runners (used to prove that unstable digests block verification). */
    trialRunners?: readonly TrialRunner[];
  },
): Promise<ReplayVerification> {
  const view = journal.getImport(input.importId);
  if (view.state !== 'MAPPED') {
    throw new RouteSpecError('RS_IMPORT_STATE_INVALID', 'Replay verification requires a mapped import.', {
      details: { state: view.state },
    });
  }
  const latest = journal.latestMapping(input.importId);
  if (latest === null || view.sanitized === null) {
    throw new RouteSpecError('RS_IMPORT_STATE_INVALID', 'Import has no mapping or sanitized trace.');
  }
  const trace = view.sanitized as TraceDocument;
  const { mapping, issues } = validateMapping(trace, view.origin, latest.mapping);
  if (mapping === null || issues.length > 0) {
    throw new RouteSpecError('RS_IMPORT_MAPPING_INVALID', 'Stored mapping no longer validates.');
  }
  const compiled = compileMapping(mapping as Mapping, input.importId);
  const trialInput: TrialInput = {
    identity: trialIdentity({
      importId: input.importId,
      mappingDigest: digestValue('routespec.import-mapping-content/1', {
        importId: input.importId,
        mapping: latest.mapping,
      }),
      trace,
      compiled,
    }),
    source: JSON.parse(JSON.stringify(scenarioSourceFromMapping(mapping, input.importId))) as unknown,
    exchanges: replayExchangesFromTrace(trace),
  };
  const runners: TrialRunner[] = input.trialRunners
    ? [...input.trialRunners]
    : [
        ...Array.from({ length: Math.max(1, input.inProcessTrials ?? 2) }, () => inProcessTrial),
        ...(input.crossProcess === false ? [] : [childProcessTrial]),
      ];
  if (runners.length < 2)
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'At least two replay trials are required.');
  const results: TrialResult[] = [];
  for (let i = 0; i < runners.length; i++) results.push(await (runners[i] as TrialRunner)(trialInput, i));

  const findings = new FindingSetLike();
  let fidelity: 'MATCH' | 'MISMATCH' = 'MATCH';
  for (const r of results) {
    if (!r.canonicalTimer) findings.add('REPLAY_NONCANONICAL_TIMER', '$');
    if (r.unexpectedRequests > 0) findings.add('REPLAY_UNEXPECTED_REQUEST', '$');
    if (r.assertionsFailed > 0) findings.add('REPLAY_ASSERTION_FAILED', '$');
    if (r.limitBreached) findings.add('REPLAY_LIMIT_BREACHED', '$');
    if (r.decisions.length !== trace.exchanges.length) fidelity = 'MISMATCH';
    trace.exchanges.forEach((ex, i) => {
      const d = r.decisions[i];
      const want = ex.outcome === 'RESPONSE_LOST' ? 'DROP_AFTER_ACCEPT' : 'RESPOND';
      if (!d || d.kind !== want) fidelity = 'MISMATCH';
      else if (
        ex.route === 'STATUS' &&
        ex.observedRawStatus !== null &&
        d.rawStatus !== ex.observedRawStatus
      ) {
        fidelity = 'MISMATCH';
      }
    });
  }
  const digests = results.map((r) => r.digest);
  if (!digests.every((d) => d === digests[0])) findings.add('REPLAY_DIGEST_UNSTABLE', '$');
  const recorded = journal.recordReplayReport({
    importId: input.importId,
    expectedRevision: input.expectedRevision,
    mappingRevisionId: latest.mappingRevisionId,
    scenarioRevisionDigest: compiled.revisionDigest,
    evaluatorRevision: EVALUATOR_REVISION,
    trialDigests: digests,
    fidelity,
    findings: findings.list(),
    idempotencyKey: input.idempotencyKey,
  });
  return {
    reportId: recorded.reportId,
    reportDigest: recorded.reportDigest,
    verified: recorded.verified,
    trialDigests: digests,
    fidelity,
    findings: findings.list(),
    scenarioRevisionDigest: compiled.revisionDigest,
    revision: recorded.revision,
  };
}

/** Replay-report findings use the same safe category/path/count shape. */
class FindingSetLike {
  private readonly map = new Map<string, StoredFinding>();
  add(category: string, path: string): void {
    const key = `${category}\u0000${path}`;
    const prior = this.map.get(key);
    this.map.set(
      key,
      prior ? { ...prior, count: prior.count + 1 } : { category, path, count: 1, blocking: true },
    );
  }
  list(): StoredFinding[] {
    return [...this.map.values()].sort((a, b) => (a.category < b.category ? -1 : 1));
  }
}
