/**
 * Installed-artifact capture (FR-11; API-SPEC `POST /case-runs/{caseRunId}/captures`).
 *
 * The capture is derived by RouteSpec from authoritative persisted journal rows of one closed
 * case run: exchanges (with their attempt outcomes), lifecycle events, recorded evidence,
 * separate subject self-reports, independent boundary observations, and proxy denials — under
 * the exact build/gate/case/session/scenario/effect-policy/manifest/inventory/interceptor
 * identity. The only input is the case run ID: a caller cannot supply, replace, or append
 * events, and a fixture can never become an installed capture.
 *
 * Derivation is deterministic, so promotion can re-derive the capture inside its transaction
 * and refuse a capture whose persisted form no longer matches the journal.
 */
import { RouteSpecError, digestValue, type Digest } from '@routespec/contracts';
import type { RouteSpecStore } from '@routespec/store';
import { TRACE_FORMAT, type TraceDocument, type TraceIdentity } from './trace.ts';

type Row = Record<string, unknown>;

const ROUTES: Readonly<Record<string, 'QUOTE' | 'COMMIT' | 'STATUS'>> = Object.freeze({
  '/v0/quote': 'QUOTE',
  '/v0/deposit/submit': 'COMMIT',
  '/v0/status': 'STATUS',
});

function str(row: Row, key: string): string {
  const v = row[key];
  if (typeof v !== 'string') throw new RouteSpecError('RS_INTERNAL', `Journal row field ${key} is missing.`);
  return v;
}
function strOrNull(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' ? v : null;
}
function numOrNull(row: Row, key: string): number | null {
  const v = row[key];
  return typeof v === 'number' ? v : null;
}

export const CAPTURE_DIGEST_DOMAIN = 'routespec.installed-capture/1';
export const CAPTURE_IDENTITY_DOMAIN = 'routespec.installed-capture-identity/1';

export interface InstalledCapture {
  readonly trace: TraceDocument;
  readonly captureDigest: Digest;
  readonly identityDigest: Digest;
  readonly sessionId: string;
}

/** Derive the installed capture of one closed case run. */
export function deriveInstalledCapture(store: RouteSpecStore, caseRunId: string): InstalledCapture {
  const caseRow = store.getCaseRun(caseRunId);
  if (!caseRow) throw new RouteSpecError('RS_NOT_FOUND', 'Case run not found.');
  if (caseRow['teardown_recorded_at_ms'] === null || caseRow['teardown_recorded_at_ms'] === undefined) {
    throw new RouteSpecError(
      'RS_IMPORT_STATE_INVALID',
      'Capture requires a closed case: client input must be torn down first.',
    );
  }
  const snap = store.readEvaluationSnapshot(caseRunId);
  const session = snap.session;
  const gate = snap.gateRun;
  const sessionId = str(session, 'session_id');

  const opRef = new Map<string, string>();
  const jobRef = new Map<string, string>();
  snap.runOperations.forEach((op) => {
    opRef.set(str(op, 'run_operation_id'), `op-${opRef.size + 1}`);
    const job = str(op, 'logical_job_id');
    if (!jobRef.has(job)) jobRef.set(job, `job-${jobRef.size + 1}`);
  });
  const ref = (id: string | null): string | null => (id === null ? null : (opRef.get(id) ?? null));
  const finalizationByOp = new Map(snap.quoteFinalizations.map((f) => [str(f, 'run_operation_id'), f]));
  const committed = new Set(snap.commitBindings.map((c) => str(c, 'run_operation_id')));
  const attemptById = new Map(snap.attempts.map((a) => [str(a, 'attempt_id'), a]));
  const statusByExchange = new Map<string, string>();
  for (const ev of snap.events) {
    const ex = strOrNull(ev, 'exchange_id');
    const raw = strOrNull(ev, 'raw_status');
    if (ex !== null && raw !== null) statusByExchange.set(ex, raw);
  }

  const operations = snap.runOperations.map((op) => {
    const id = str(op, 'run_operation_id');
    const fin = finalizationByOp.get(id);
    return {
      ref: opRef.get(id) as string,
      logicalJobRef: jobRef.get(str(op, 'logical_job_id')) as string,
      phase: str(op, 'current_phase') as TraceDocument['operations'][number]['phase'],
      depositAddress: fin ? strOrNull(fin, 'deposit_address') : null,
      committed: committed.has(id),
      acceptedTerminalStatus: strOrNull(op, 'accepted_terminal_status'),
    };
  });

  const exchanges = snap.exchanges.map((ex) => {
    const route = ROUTES[str(ex, 'route_template')];
    if (route === undefined)
      throw new RouteSpecError('RS_INTERNAL', 'Journal exchange has an unknown route.');
    const opId = strOrNull(ex, 'run_operation_id');
    const attemptId = strOrNull(ex, 'attempt_id');
    const attempt = attemptId === null ? undefined : attemptById.get(attemptId);
    const lost =
      attempt !== undefined &&
      (attempt['outcome'] === 'SENT_OUTCOME_UNKNOWN' || attempt['outcome'] === 'RECONCILED');
    const payloadJson = strOrNull(ex, 'request_payload_json');
    const payload = (payloadJson === null ? {} : JSON.parse(payloadJson)) as Record<string, unknown>;
    let material: Record<string, unknown> = payload;
    if (route === 'COMMIT') {
      const fin = opId === null ? undefined : finalizationByOp.get(opId);
      material = {
        depositAddress: fin ? strOrNull(fin, 'deposit_address') : null,
        transactionDigest: payload['transactionDigest'] ?? null,
      };
    }
    return {
      sequence: Number(ex['sequence']),
      route,
      phase: str(ex, 'phase') as TraceDocument['exchanges'][number]['phase'],
      operationRef: ref(opId),
      fencingEpoch: Number(ex['fencing_epoch']),
      outcome: lost ? ('RESPONSE_LOST' as const) : ('RESPONDED' as const),
      responseStatus: lost ? null : numOrNull(ex, 'response_status'),
      errorCode: strOrNull(ex, 'error_code') as TraceDocument['exchanges'][number]['errorCode'],
      observedRawStatus: lost ? null : (statusByExchange.get(str(ex, 'exchange_id')) ?? null),
      material,
      virtualMs: numOrNull(ex, 'virtual_ms'),
    };
  });

  const events = snap.events.map((ev) => ({
    sequence: Number(ev['sequence']),
    kind: str(ev, 'event_kind'),
    rawStatus: strOrNull(ev, 'raw_status'),
    normalizedFact: strOrNull(ev, 'normalized_fact') as TraceDocument['events'][number]['normalizedFact'],
    operationRef: ref(strOrNull(ev, 'run_operation_id')),
    virtualMs: numOrNull(ev, 'virtual_ms'),
  }));

  const evidence = snap.evidence.map((ev) => ({
    subject: str(ev, 'subject'),
    evidenceClass: str(ev, 'evidence_class') as TraceDocument['evidence'][number]['evidenceClass'],
    evidenceScope: str(ev, 'evidence_scope') as TraceDocument['evidence'][number]['evidenceScope'],
    reasons: JSON.parse(str(ev, 'reasons_json')) as TraceDocument['evidence'][number]['reasons'],
    sourceKind: str(ev, 'source_kind'),
    operationRef: ref(strOrNull(ev, 'run_operation_id')),
    assetId: strOrNull(ev, 'asset_id'),
    amount: strOrNull(ev, 'amount'),
  }));

  const subjectReports = snap.subjectReports.map((r) => ({
    sequence: Number(r['sequence']),
    hookId: str(r, 'hook_id'),
    effectType: str(r, 'effect_type'),
    action: str(r, 'action') as 'ATTEMPTED' | 'BLOCKED' | 'RELEASED',
    operationRef: ref(strOrNull(r, 'run_operation_id')),
  }));

  const boundaryObservations = snap.boundaryObservations.map((o) => ({
    sequence: Number(o['session_sequence'] ?? o['sequence']),
    sinkClass: str(o, 'sink_class'),
    action: str(o, 'action') as 'ATTEMPTED' | 'BLOCKED' | 'RELEASED',
    operationRef: ref(strOrNull(o, 'run_operation_id')),
  }));

  const denialCounts = new Map<string, number>();
  for (const a of store.listAuditEvents('PROXY_REQUEST_DENIED')) {
    if (a['subject_id'] !== sessionId) continue;
    const d = JSON.parse(String(a['details_json'])) as { path?: string; code?: string };
    const route = ROUTES[d.path ?? ''] ?? 'OTHER';
    const key = `${route}\u0000${d.code ?? 'RS_INTERNAL'}`;
    denialCounts.set(key, (denialCounts.get(key) ?? 0) + 1);
  }
  const denials = [...denialCounts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, count]) => {
      const [route, code] = key.split('\u0000') as [string, string];
      return { route, code, count } as TraceDocument['denials'][number];
    });

  const identity: TraceIdentity = {
    projectId: str(gate, 'project_id'),
    integrationRevisionId: str(gate, 'integration_revision_id'),
    buildRevisionId: str(gate, 'build_revision_id'),
    artifactDigest: str(gate, 'artifact_digest') as TraceIdentity['artifactDigest'],
    gateRunId: str(gate, 'gate_run_id'),
    caseRunId,
    sessionId,
    scenarioRevisionId: str(snap.scenario, 'scenario_revision_id'),
    scenarioRevisionDigest: str(snap.scenario, 'revision_digest') as TraceIdentity['scenarioRevisionDigest'],
    effectManifestDigest: str(session, 'effect_manifest_digest') as TraceIdentity['effectManifestDigest'],
    effectCoveragePolicyDigest: str(
      session,
      'effect_coverage_policy_digest',
    ) as TraceIdentity['effectCoveragePolicyDigest'],
    callsiteInventoryDigest: strOrNull(
      session,
      'callsite_inventory_digest',
    ) as TraceIdentity['callsiteInventoryDigest'],
    interceptorProfileDigest: strOrNull(
      gate,
      'interceptor_profile_digest',
    ) as TraceIdentity['interceptorProfileDigest'],
    adapterRevision: str(session, 'adapter_revision'),
    fencingEpoch: Number(caseRow['fencing_epoch']),
    caseVerdict: (strOrNull(caseRow, 'verdict') as TraceIdentity['caseVerdict']) ?? null,
    coverageBasis: (snap.policy
      ? str(snap.policy, 'basis')
      : 'DECLARED_HOOKS_ONLY') as TraceIdentity['coverageBasis'],
  };

  const containments = store.journal.read(
    (db) =>
      db
        .prepare(
          `SELECT c.containment FROM interceptor_channels c JOIN effect_interceptor_instances i USING (interceptor_instance_id)
            WHERE i.case_run_id = ?`,
        )
        .all(caseRunId) as Array<Record<string, unknown>>,
  );
  if (containments.length > 0) {
    identity.processTreeContainment = containments.every((r) => r['containment'] === 'PROCESS_TREE_ENFORCED')
      ? 'PROCESS_TREE_ENFORCED'
      : 'DECLARED_HOOKS_ONLY';
  }

  const trace: TraceDocument = {
    format: TRACE_FORMAT,
    origin: 'INSTALLED_ARTIFACT_CAPTURE',
    identity,
    operations,
    exchanges,
    events,
    evidence,
    subjectReports,
    boundaryObservations,
    denials,
    annotations: { title: null, notes: [], disputed: false },
  };
  return {
    trace,
    captureDigest: digestValue(CAPTURE_DIGEST_DOMAIN, trace),
    identityDigest: digestValue(CAPTURE_IDENTITY_DOMAIN, identity),
    sessionId,
  };
}

/** Compare a claimed trace identity with the journal (used for user files and captures). */
export function resolveClaimedIdentity(
  store: RouteSpecStore,
  identity: TraceIdentity,
): { result: 'MATCH' | 'MISMATCH' | 'UNKNOWN_SOURCE'; fields: string[] } {
  const caseRow = store.getCaseRun(identity.caseRunId);
  if (!caseRow) return { result: 'UNKNOWN_SOURCE', fields: [] };
  const gate = store.getGateRun(String(caseRow['gate_run_id']));
  const sessionId = caseRow['session_id'];
  const session = typeof sessionId === 'string' ? store.getSession(sessionId) : undefined;
  const scenario = store.getScenarioRevision(String(caseRow['scenario_revision_id']));
  const expected: Record<string, unknown> = {
    gateRunId: caseRow['gate_run_id'],
    sessionId: sessionId ?? null,
    buildRevisionId: gate?.['build_revision_id'],
    artifactDigest: gate?.['artifact_digest'],
    projectId: gate?.['project_id'],
    integrationRevisionId: gate?.['integration_revision_id'],
    scenarioRevisionId: caseRow['scenario_revision_id'],
    scenarioRevisionDigest: scenario?.['revision_digest'],
    effectManifestDigest: session?.['effect_manifest_digest'] ?? gate?.['effect_manifest_digest'],
    effectCoveragePolicyDigest:
      session?.['effect_coverage_policy_digest'] ?? gate?.['effect_coverage_policy_digest'],
    adapterRevision: caseRow['adapter_revision'],
  };
  const fields = Object.entries(expected)
    .filter(([k, v]) => (identity as unknown as Record<string, unknown>)[k] !== v)
    .map(([k]) => k)
    .sort();
  return { result: fields.length === 0 ? 'MATCH' : 'MISMATCH', fields };
}
