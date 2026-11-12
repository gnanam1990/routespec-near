/**
 * Response views over persisted records (ADR-0008 console contract, API-SPEC section 4).
 *
 * Views only read and reshape journal rows. They never compute a verdict: case verdicts are
 * the kernel's persisted values, gate decisions are the persisted gate evaluation, artifact
 * readiness is the export manifest's own column, and enforcement is capped at the gate
 * definition's mode. Independent axes stay independent fields. Token values, token digests, and
 * lease owners never appear.
 */
import type { DatabaseSync } from 'node:sqlite';
import { EVIDENCE_CLASSES, type EvidenceClass } from '@routespec/contracts';
import type { ControlJournal, RouteSpecStore } from '@routespec/store';

type Row = Record<string, unknown>;

export function iso(ms: unknown): string | null {
  return typeof ms === 'number' ? new Date(ms).toISOString() : null;
}

export function str(row: Row, key: string): string {
  return String(row[key]);
}

export function strOrNull(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' ? v : null;
}

export function rows(store: RouteSpecStore, sql: string, ...params: Array<string | number | null>): Row[] {
  return store.journal.read((db: DatabaseSync) => db.prepare(sql).all(...params) as Row[]);
}

export function row(
  store: RouteSpecStore,
  sql: string,
  ...params: Array<string | number | null>
): Row | undefined {
  return store.journal.read((db: DatabaseSync) => db.prepare(sql).get(...params) as Row | undefined);
}

export function projectView(r: Row): Record<string, unknown> {
  return {
    projectId: str(r, 'project_id'),
    name: str(r, 'name'),
    description: strOrNull(r, 'description'),
    settingsRevision: Number(r['revision']),
    createdAt: iso(r['created_at_ms']),
  };
}

export function revisionView(r: Row): Record<string, unknown> {
  return {
    integrationRevisionId: str(r, 'integration_revision_id'),
    projectId: str(r, 'project_id'),
    revisionLabel: str(r, 'revision_label'),
    commitSha: strOrNull(r, 'commit_sha'),
    configurationDigest: str(r, 'configuration_digest'),
    protocolProfileId: str(r, 'protocol_profile_id'),
    metadata: JSON.parse(str(r, 'metadata_json')) as unknown,
    identityDigest: str(r, 'identity_digest'),
    createdAt: iso(r['created_at_ms']),
  };
}

export function buildView(r: Row): Record<string, unknown> {
  return {
    buildRevisionId: str(r, 'build_revision_id'),
    projectId: str(r, 'project_id'),
    integrationRevisionId: str(r, 'integration_revision_id'),
    repositoryLocator: str(r, 'repository_locator'),
    commitSha: str(r, 'commit_sha'),
    dirtyTreeDigest: strOrNull(r, 'dirty_tree_digest'),
    artifactDigest: str(r, 'artifact_digest'),
    toolchainDigest: str(r, 'toolchain_digest'),
    lockDigest: str(r, 'lock_digest'),
    effectManifestDigest: str(r, 'effect_manifest_digest'),
    launchRecipeDigest: str(r, 'launch_recipe_digest'),
    ciWorkflowRunId: strOrNull(r, 'ci_workflow_run_id'),
    registrationClaim: str(r, 'registration_claim'),
    identityDigest: str(r, 'identity_digest'),
    createdAt: iso(r['created_at_ms']),
  };
}

const CLASS_ORDER: readonly EvidenceClass[] = [
  'STALE',
  'UNSUPPORTED',
  'UNKNOWN',
  'INFERRED',
  'REPORTED',
  'PROVEN',
];

/** Summary of persisted evidence items: the weakest class present and the union of reasons. */
export function evidenceSummary(items: readonly Row[]): {
  class: string;
  scope: string | null;
  reasons: string[];
} {
  if (items.length === 0) return { class: 'UNKNOWN', scope: null, reasons: ['MISSING'] };
  let weakest = items[0] as Row;
  for (const it of items) {
    if (
      CLASS_ORDER.indexOf(str(it, 'evidence_class') as EvidenceClass) <
      CLASS_ORDER.indexOf(str(weakest, 'evidence_class') as EvidenceClass)
    ) {
      weakest = it;
    }
  }
  const reasons = new Set<string>();
  for (const it of items) for (const r of JSON.parse(str(it, 'reasons_json')) as string[]) reasons.add(r);
  const cls = str(weakest, 'evidence_class');
  return {
    class: (EVIDENCE_CLASSES as readonly string[]).includes(cls) ? cls : 'UNKNOWN',
    scope: strOrNull(weakest, 'evidence_scope'),
    reasons: [...reasons].sort().slice(0, 16),
  };
}

function freshnessOf(att: Row | undefined, nowMs: number): string {
  if (!att) return 'NOT_APPLICABLE';
  if (
    att['principal_enabled'] !== 1 ||
    att['principal_current_revocation_epoch'] !== att['principal_revocation_epoch']
  ) {
    return 'REVOKED';
  }
  return Number(att['expires_at_ms']) > nowMs ? 'FRESH' : 'STALE';
}

export function attestationRef(
  control: ControlJournal,
  cls: string,
  attestationId: string | null,
  nowMs: number,
): Record<string, unknown> {
  const att = attestationId ? control.getAttestation(attestationId) : undefined;
  return {
    class: cls,
    attestationId,
    observedAt: att ? iso(att['verified_at_ms']) : null,
    freshness: freshnessOf(att, nowMs),
  };
}

/**
 * Effect coverage of a scope as the journal records it.
 *
 * `COMPLETE` is reported only from persisted kernel results: the scope's INV-04 (complete-effect)
 * results exist and every one is PASS, which the kernel gives only with an attested independent
 * interceptor, process-tree containment, and every required sink observed (M14). Otherwise the
 * finding is `INCOMPLETE` with the kernel's missing predicates. Without a scope (or without any
 * INV-04 result yet) it stays `INCOMPLETE`, never `COMPLETE`.
 */
export function coverageFor(
  store: RouteSpecStore,
  policyDigest: string,
  interceptorProfileDigest: string | null,
  scope?: {
    readonly caseRunIds: readonly string[];
    readonly control?: ControlJournal;
    readonly nowMs?: number;
  },
): Record<string, unknown> {
  const p = row(store, 'SELECT * FROM effect_coverage_policies WHERE policy_digest = ?', policyDigest);
  const basis = p ? str(p, 'basis') : null;
  const missing: string[] = [];
  if (!p) missing.push('EFFECT_POLICY_NOT_FOUND');
  if (basis === 'DECLARED_HOOKS_ONLY') missing.push('INDEPENDENT_INTERCEPTOR_NOT_SELECTED');
  if (interceptorProfileDigest === null) missing.push('NO_INTERCEPTOR_PROFILE');
  const profile = interceptorProfileDigest
    ? row(store, 'SELECT * FROM interceptor_profiles WHERE profile_digest = ?', interceptorProfileDigest)
    : undefined;
  let complete = false;
  let freshness = 'NOT_APPLICABLE';
  if (scope && scope.caseRunIds.length > 0 && basis !== null && basis !== 'DECLARED_HOOKS_ONLY') {
    const latest = scope.caseRunIds.map((caseRunId) =>
      row(
        store,
        `SELECT verdict, missing_predicates_json FROM invariant_results WHERE case_run_id = ? AND invariant_id = 'INV-04'
          ORDER BY created_at_ms DESC, rowid DESC LIMIT 1`,
        caseRunId,
      ),
    );
    complete = latest.every((r) => r !== undefined && r['verdict'] === 'PASS');
    for (const r of latest) {
      if (r === undefined) missing.push('INV04_NOT_EVALUATED');
      else if (r['verdict'] !== 'PASS') {
        for (const m of JSON.parse(str(r, 'missing_predicates_json')) as string[]) missing.push(m);
      }
    }
    if (scope.control && scope.caseRunIds.length === 1) {
      const inst = row(
        store,
        `SELECT attestation_id FROM effect_interceptor_instances WHERE case_run_id = ?
          ORDER BY started_at_ms DESC, rowid DESC LIMIT 1`,
        scope.caseRunIds[0] as string,
      );
      const attId = inst ? strOrNull(inst, 'attestation_id') : null;
      if (attId !== null)
        freshness = freshnessOf(scope.control.getAttestation(attId), scope.nowMs ?? Date.now());
    }
  }
  return {
    basis,
    finding: basis === null ? 'NOT_EVALUATED' : complete ? 'COMPLETE' : 'INCOMPLETE',
    missing: [...new Set(missing)].sort().slice(0, 64),
    interceptorProfileId: profile ? str(profile, 'profile_id') : null,
    interceptorFreshness: freshness,
    processTreeScope: profile ? str(profile, 'process_tree_scope') : null,
  };
}

/** The effect-coverage policy a case ran under: its own (M14) or the gate run's. */
export function casePolicyDigest(store: RouteSpecStore, c: Row, gate: Row): string {
  const sessionId = strOrNull(c, 'session_id');
  const session = sessionId === null ? undefined : store.getSession(sessionId);
  if (session && typeof session['effect_coverage_policy_digest'] === 'string')
    return str(session, 'effect_coverage_policy_digest');
  const own =
    store.schemaVersion >= 8
      ? row(
          store,
          'SELECT effect_coverage_policy_digest FROM gate_run_case_policies WHERE case_run_id = ?',
          str(c, 'case_run_id'),
        )
      : undefined;
  return own ? str(own, 'effect_coverage_policy_digest') : str(gate, 'effect_coverage_policy_digest');
}

export function rsCode(code: string): string {
  const up = code
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 60);
  return up.startsWith('RS_') ? up : `RS_${up}`;
}

const REVISION_OF: Record<string, number> = {
  DRAFT: 1,
  VALIDATING: 2,
  READY: 3,
  RUNNING: 4,
  EVALUATING: 5,
  RECOVERY_REQUIRED: 5,
  COMPLETED: 6,
  ABORTED: 6,
  ERROR: 6,
};

/** Gate runs carry no counter column; the lifecycle step is their optimistic revision. */
export function gateRunRevision(gate: Row): number {
  return REVISION_OF[str(gate, 'execution_lifecycle')] ?? 0;
}

export interface ViewDeps {
  readonly store: RouteSpecStore;
  readonly control: ControlJournal;
  readonly appRevision: string;
  readonly nowMs: () => number;
}

export function gateRunView(d: ViewDeps, gate: Row): Record<string, unknown> {
  const gateRunId = str(gate, 'gate_run_id');
  const build = d.control.getBuild(str(gate, 'build_revision_id')) as Row;
  const corpus = d.control.getCorpus(str(gate, 'corpus_revision_id')) as Row;
  const cases = d.control.caseRunsOf(gateRunId);
  const evaluation = d.control.latestGateEvaluation(gateRunId);
  const definition = strOrNull(gate, 'gate_definition_revision_id')
    ? row(
        d.store,
        'SELECT * FROM gate_definitions WHERE gate_definition_revision_id = ?',
        str(gate, 'gate_definition_revision_id'),
      )
    : undefined;
  const manifest = evaluation
    ? row(
        d.store,
        'SELECT * FROM artifact_manifests WHERE gate_evaluation_id = ? ORDER BY created_at_ms DESC LIMIT 1',
        str(evaluation, 'gate_evaluation_id'),
      )
    : undefined;
  const evidence = rows(
    d.store,
    'SELECT evidence_class, evidence_scope, reasons_json, created_at_ms FROM evidence_items WHERE gate_run_id = ?',
    gateRunId,
  );
  const counts = { total: cases.length, passed: 0, failed: 0, review: 0, unsupportedRequired: 0, notRun: 0 };
  for (const c of cases) {
    const v = strOrNull(c, 'verdict');
    if (v === 'PASS') counts.passed++;
    else if (v === 'FAIL') counts.failed++;
    else if (v === 'REVIEW') counts.review++;
    else if (v === 'UNSUPPORTED') counts.unsupportedRequired++;
    else counts.notRun++;
  }
  const findings = evaluation
    ? (JSON.parse(str(evaluation, 'findings_json')) as unknown[]).slice(0, 200).map((f) => {
        const code = typeof f === 'string' ? f : String((f as Record<string, unknown>)['code'] ?? 'FINDING');
        const caseRunId =
          typeof f === 'object' && f !== null
            ? (((f as Record<string, unknown>)['caseRunId'] as string | undefined) ?? null)
            : null;
        return {
          code: rsCode(code),
          level: 'REVIEW',
          message: 'Recorded gate evaluation finding.',
          caseRunId,
        };
      })
    : [];
  const running = cases.filter((c) =>
    ['RUNNING', 'EVALUATING', 'RECOVERY_REQUIRED'].includes(str(c, 'execution_lifecycle')),
  ).length;
  const queued = cases.filter((c) =>
    ['PENDING', 'READY', 'VALIDATING'].includes(str(c, 'execution_lifecycle')),
  ).length;
  const lastEvidence = evidence.reduce((m, e) => Math.max(m, Number(e['created_at_ms'])), 0);
  return {
    gateRunId,
    projectId: str(gate, 'project_id'),
    revisionId: str(gate, 'integration_revision_id'),
    mode: d.control.gateRunMode(gateRunId) ?? 'SIMULATE',
    lifecycle: str(gate, 'execution_lifecycle'),
    verdict: evaluation ? str(evaluation, 'decision') : 'NOT_RUN',
    verdictReason: evaluation ? null : 'No gate evaluation has been recorded.',
    evidence: evidenceSummary(evidence),
    attestation: attestationRef(
      d.control,
      str(gate, 'build_attestation_class'),
      strOrNull(gate, 'build_attestation_id'),
      d.nowMs(),
    ),
    effectCoverage: coverageFor(
      d.store,
      str(gate, 'effect_coverage_policy_digest'),
      strOrNull(gate, 'interceptor_profile_digest'),
      {
        caseRunIds: (
          d.store.journal.read((db) =>
            db
              .prepare('SELECT case_run_id FROM case_runs WHERE gate_run_id = ?')
              .all(str(gate, 'gate_run_id')),
          ) as Row[]
        ).map((r) => str(r, 'case_run_id')),
      },
    ),
    artifactReady: manifest ? manifest['artifact_ready'] === 1 : null,
    enforcementMode: evaluation
      ? str(evaluation, 'enforcement_mode')
      : definition
        ? str(definition, 'enforcement_mode')
        : 'LOCAL_ADVISORY',
    officialCompatibility: { status: 'NOT_RUN', recordId: null, observedAt: null },
    evaluatedAt: evaluation ? iso(evaluation['created_at_ms']) : null,
    evidenceObservedAt: lastEvidence > 0 ? iso(lastEvidence) : null,
    identity: {
      repository: build ? str(build, 'repository_locator').slice(0, 2000) : null,
      commitSha: build ? str(build, 'commit_sha') : null,
      dirtyTreeDigest: build ? strOrNull(build, 'dirty_tree_digest') : null,
      buildRevisionId: str(gate, 'build_revision_id'),
      artifactDigest: str(gate, 'artifact_digest'),
      effectPolicyDigest: str(gate, 'effect_coverage_policy_digest'),
      effectManifestDigest: str(gate, 'effect_manifest_digest'),
      callSiteInventoryDigest: strOrNull(gate, 'callsite_inventory_digest'),
      interceptorProfileDigest: strOrNull(gate, 'interceptor_profile_digest'),
      corpusRevisionId: str(gate, 'corpus_revision_id'),
      corpusDigest: corpus ? str(corpus, 'corpus_digest') : '',
      evaluatorRevision: str(gate, 'evaluator_revision'),
      adapterRevision: str(gate, 'adapter_revision'),
      protocolProfileId: str(gate, 'protocol_profile_id'),
      configurationDigest: str(gate, 'configuration_digest'),
      workflowRunId: build ? strOrNull(build, 'ci_workflow_run_id') : null,
      appRevision: d.appRevision,
    },
    interceptorAttestation: null,
    parallelism: { declared: Number(gate['max_parallel_cases']), running, queued },
    counts,
    findings,
    gateId: definition ? str(definition, 'gate_id') : null,
    gateEvaluationId: evaluation ? str(evaluation, 'gate_evaluation_id') : null,
    identityDigest: str(gate, 'identity_digest'),
    revision: gateRunRevision(gate),
  };
}

const CLIENT_STATE: Record<string, string> = {
  PENDING: 'NOT_STARTED',
  VALIDATING: 'NOT_STARTED',
  READY: 'NOT_STARTED',
  RUNNING: 'CONNECTED',
  RECOVERY_REQUIRED: 'CONNECTED',
  EVALUATING: 'TORN_DOWN',
};

export function caseRunView(d: ViewDeps, c: Row, gate: Row): Record<string, unknown> {
  const caseRunId = str(c, 'case_run_id');
  const lifecycle = str(c, 'execution_lifecycle');
  const started = strOrNull(c, 'session_id') !== null;
  const teardown = started && d.control.teardownRecorded(caseRunId);
  const terminal = ['COMPLETED', 'ABORTED', 'ERROR'].includes(lifecycle);
  const clientState =
    CLIENT_STATE[lifecycle] ?? (started ? (teardown ? 'TORN_DOWN' : 'TEARDOWN_INCOMPLETE') : 'NOT_STARTED');
  const corpusCase = d.control.corpusCase(str(gate, 'corpus_revision_id'), Number(c['case_ordinal']));
  const scenario = row(
    d.store,
    'SELECT scenario_stable_id, provenance_class FROM scenario_revisions WHERE scenario_revision_id = ?',
    str(c, 'scenario_revision_id'),
  );
  const evidence = rows(
    d.store,
    'SELECT evidence_class, evidence_scope, reasons_json FROM evidence_items WHERE case_run_id = ?',
    caseRunId,
  );
  const token = d.control.tokenStateFor(caseRunId, d.nowMs());
  const ops = d.store.listRunOperations(caseRunId).slice(0, 64);
  const verdict = strOrNull(c, 'verdict');
  const leaseExpiry = c['lease_expires_at_ms'];
  const leaseExpired =
    (lifecycle === 'RUNNING' || lifecycle === 'EVALUATING') &&
    started &&
    typeof leaseExpiry === 'number' &&
    leaseExpiry <= d.nowMs();
  return {
    caseRunId,
    gateRunId: str(c, 'gate_run_id'),
    ordinal: Number(c['case_ordinal']),
    scenarioRevisionId: str(c, 'scenario_revision_id'),
    scenarioName: scenario ? str(scenario, 'scenario_stable_id') : 'unknown',
    lineageRole: str(c, 'lineage_role'),
    logicalJobLabel: ops.length > 0 ? `${ops.length} run operation(s)` : 'none',
    lifecycle,
    verdict: verdict ?? 'NOT_RUN',
    verdictReason: verdict === null ? 'Not evaluated.' : null,
    evidence: evidenceSummary(evidence),
    clientState,
    resetState: !started
      ? 'PENDING'
      : terminal || teardown
        ? teardown
          ? 'COMPLETE'
          : 'INCOMPLETE'
        : 'PENDING',
    token: { state: token.state, purpose: token.purpose, expiresAt: iso(token.expiresAtMs) },
    fencingEpoch: Number(c['fencing_epoch']),
    effectCoverage: coverageFor(
      d.store,
      casePolicyDigest(d.store, c, gate),
      strOrNull(gate, 'interceptor_profile_digest'),
      { caseRunIds: [caseRunId], control: d.control, nowMs: d.nowMs() },
    ),
    severity: corpusCase ? str(corpusCase, 'severity') : null,
    requiredInvariants: JSON.parse(str(c, 'required_invariants_json')) as string[],
    queuePosition: lifecycle === 'READY' || lifecycle === 'PENDING' ? Number(c['case_ordinal']) : null,
    // Recovery is offered from persisted state only: a case already fenced into
    // RECOVERY_REQUIRED, or an executing case whose lease has expired (its runner stopped).
    recovery:
      lifecycle === 'RECOVERY_REQUIRED' || leaseExpired
        ? {
            available: true,
            action: 'RECONCILE_EXISTING_OPERATION',
            readOnly: true,
            reasonCode: lifecycle === 'RECOVERY_REQUIRED' ? 'RS_RECOVERY_REQUIRED' : 'RS_LEASE_EXPIRED',
          }
        : null,
    sessionId: strOrNull(c, 'session_id'),
    runOperationIds: ops.map((o) => str(o, 'run_operation_id')),
    provenance: scenario ? str(scenario, 'provenance_class') : null,
  };
}

export function sessionView(d: ViewDeps, s: Row): Record<string, unknown> {
  const stats = d.control.sessionEventStats(str(s, 'session_id'));
  return {
    sessionId: str(s, 'session_id'),
    gateRunId: str(s, 'gate_run_id'),
    caseRunId: str(s, 'case_run_id'),
    mode: str(s, 'mode'),
    lifecycle: str(s, 'execution_lifecycle'),
    fencingEpoch: Number(s['lease_fencing_epoch']),
    buildRevisionId: str(s, 'build_revision_id'),
    artifactDigest: str(s, 'artifact_digest'),
    subjectAttestationClass: str(s, 'subject_attestation_class'),
    caseLaunchAttestationId: strOrNull(s, 'case_launch_attestation_id'),
    adapterRevision: str(s, 'adapter_revision'),
    effectManifestDigest: strOrNull(s, 'effect_manifest_digest'),
    effectCoveragePolicyDigest: strOrNull(s, 'effect_coverage_policy_digest'),
    eventCount: stats.count,
    lastSequence: stats.lastSequence,
  };
}

const EVENT_KIND: Record<string, string> = {
  QUOTE_REQUEST_CREATED: 'PHASE_BINDING',
  QUOTE_REQUEST_JOINED: 'CLIENT_REQUEST',
  QUOTE_FINALIZED: 'PHASE_BINDING',
  COMMIT_ACCEPTED: 'PHASE_BINDING',
  COMMIT_RETRY_JOINED: 'CLIENT_REQUEST',
  PROVIDER_STATUS: 'PROVIDER_OBSERVATION',
  PROVIDER_STATUS_UNKNOWN: 'PROVIDER_OBSERVATION',
};

export function eventView(e: Row): Record<string, unknown> {
  const kind = str(e, 'event_kind');
  return {
    sequence: Number(e['sequence']),
    kind: EVENT_KIND[kind] ?? 'CLIENT_REQUEST',
    eventCode: kind.slice(0, 64),
    phase: strOrNull(e, 'exchange_phase'),
    runOperationId: strOrNull(e, 'run_operation_id'),
    source: str(e, 'source_kind') === 'PROXY' ? 'PROXY' : 'CONTROL',
    evidenceClass: null,
    evidenceScope: null,
    evidenceReasons: [],
    rawStatus: strOrNull(e, 'raw_status'),
    normalizedFact: strOrNull(e, 'normalized_fact'),
    virtualMs: typeof e['virtual_ms'] === 'number' ? e['virtual_ms'] : null,
    wallTime: iso(e['created_at_ms']),
    timerCanonical: e['attempt_timer_canonical'] === 1,
    summary: `${kind} at sequence ${String(e['sequence'])}`,
  };
}
