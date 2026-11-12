/**
 * Detail views for the run-operation explorer and the regression review workbench (API-SPEC
 * "GET /run-operations/{id}" and "GET /imports/{id}"; console contract ADR-0008, M09).
 *
 * Like views.ts these only read and reshape persisted rows. The run-operation outcome is the
 * kernel's persisted case verdict; invariant rows are the kernel's persisted results; subject
 * reports and independent boundary observations stay separate lists; locator-like fields are
 * masked. The import lineage is the M05 regression lineage, never recomputed here.
 */
import { EVIDENCE_CLASSES, NORMALIZED_FACTS, RAW_PROVIDER_STATUSES } from '@routespec/contracts';
import {
  REVIEW_CONFIRMATION,
  REVIEW_DECISIONS,
  classifyCaptureEvidence,
  regressionLineage,
} from '@routespec/regressions';
import type { ImportJournal } from '@routespec/store';
import { coverageFor, iso, row, rows, rsCode, str, strOrNull, type ViewDeps } from './views.ts';

type Row = Record<string, unknown>;

const INVARIANT_TITLES: Readonly<Record<string, string>> = {
  'INV-01': 'One scoped run operation per logical job',
  'INV-02': 'Operation binding is immutable',
  'INV-03': 'Reconcile before retry under uncertainty',
  'INV-04': 'Protected side effects wait for accepted completion evidence',
  'INV-05': 'Observable value conservation',
  'INV-06': 'Terminal outcomes do not regress',
  'INV-07': 'Evidence is consumed once',
  'INV-08': 'Missing or weak evidence cannot satisfy a stronger claim',
  'INV-09': 'Replay identity is deterministic',
  'INV-10': 'Safe modes cannot mutate real value',
  'INV-11': 'Secrets never cross the persistence boundary',
  'INV-12': 'A gate binds complete revision identity',
};

/** Locator-like fields are masked by default (API-SPEC: sensitive locators are masked). */
const MASKED_FIELDS = new Set(['recipient', 'refundTo', 'depositAddress', 'depositMemo', 'refundAddress']);

function scalar(v: unknown): string | null {
  if (typeof v === 'string') return v.slice(0, 200);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function fieldsOf(obj: Record<string, unknown>, keys: readonly string[]): Row[] {
  const out: Row[] = [];
  for (const k of keys) {
    const value = scalar(obj[k]);
    if (value === null) continue;
    const masked = MASKED_FIELDS.has(k);
    out.push({ name: k, value: masked ? 'masked' : value, masked });
  }
  return out;
}

function json<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === 'string' ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

const known = (values: readonly string[], v: string | null): string | null =>
  v !== null && values.includes(v) ? v : null;

export function runOperationView(d: ViewDeps, op: Row): Record<string, unknown> {
  const id = str(op, 'run_operation_id');
  const caseRunId = str(op, 'case_run_id');
  const gate = row(d.store, 'SELECT * FROM gate_runs WHERE gate_run_id = ?', str(op, 'gate_run_id')) as Row;
  const caseRun = row(d.store, 'SELECT verdict FROM case_runs WHERE case_run_id = ?', caseRunId) as Row;
  const job = row(
    d.store,
    'SELECT logical_job_key_digest FROM logical_jobs WHERE logical_job_id = ?',
    str(op, 'logical_job_id'),
  ) as Row;
  const fin = row(d.store, 'SELECT * FROM quote_finalizations WHERE run_operation_id = ?', id);
  const commit = row(d.store, 'SELECT * FROM commit_bindings WHERE run_operation_id = ?', id);
  const attempts = rows(d.store, 'SELECT outcome FROM attempts WHERE run_operation_id = ?', id);
  const lineage = rows(
    d.store,
    `SELECT relation, to_run_operation_id AS other FROM run_operation_lineage WHERE from_run_operation_id = ?
     UNION ALL
     SELECT relation, from_run_operation_id AS other FROM run_operation_lineage WHERE to_run_operation_id = ?`,
    id,
    id,
  ).slice(0, 16);
  const conflicts = rows(
    d.store,
    'SELECT phase, error_code, created_at_ms FROM operation_conflicts WHERE run_operation_id = ? ORDER BY created_at_ms LIMIT 64',
    id,
  );
  const statusEvents = rows(
    d.store,
    `SELECT raw_status, normalized_fact, created_at_ms FROM lifecycle_events
       WHERE run_operation_id = ? AND event_kind LIKE 'PROVIDER_STATUS%' ORDER BY sequence`,
    id,
  );
  const lastStatus = statusEvents[statusEvents.length - 1];
  const evidence = rows(
    d.store,
    `SELECT * FROM evidence_items WHERE case_run_id = ? AND (run_operation_id = ? OR run_operation_id IS NULL)
       ORDER BY sequence LIMIT 500`,
    caseRunId,
    id,
  );
  const latest = new Map<string, Row>();
  for (const r of rows(
    d.store,
    `SELECT * FROM invariant_results WHERE case_run_id = ? AND (run_operation_id = ? OR run_operation_id IS NULL)
       ORDER BY created_at_ms DESC`,
    caseRunId,
    id,
  )) {
    if (!latest.has(str(r, 'invariant_id'))) latest.set(str(r, 'invariant_id'), r);
  }
  const reports = rows(
    d.store,
    'SELECT * FROM protected_effect_observations WHERE run_operation_id = ? ORDER BY sequence LIMIT 250',
    id,
  );
  const boundary = rows(
    d.store,
    'SELECT * FROM effect_boundary_observations WHERE run_operation_id = ? ORDER BY sequence LIMIT 250',
    id,
  );
  const request = json<Record<string, unknown>>(op['quote_request_json'], {});
  const rawStatus =
    strOrNull(op, 'accepted_terminal_status') ?? (lastStatus ? strOrNull(lastStatus, 'raw_status') : null);
  const fact = known(
    NORMALIZED_FACTS,
    strOrNull(op, 'normalized_outcome') ?? (lastStatus ? strOrNull(lastStatus, 'normalized_fact') : null),
  );
  const coverage = coverageFor(
    d.store,
    str(op, 'effect_coverage_policy_digest'),
    strOrNull(gate, 'interceptor_profile_digest'),
    { caseRunIds: [str(op, 'case_run_id')], control: d.control, nowMs: d.nowMs() },
  );
  return {
    runOperationId: id,
    logicalJobDigest: str(job, 'logical_job_key_digest'),
    logicalJobLabel: `logical job ${str(job, 'logical_job_key_digest').slice(7, 19)}`,
    bindingDigest: strOrNull(op, 'commit_binding_digest'),
    lineage: lineage.map((l) => ({ relation: str(l, 'relation'), runOperationId: str(l, 'other') })),
    identity: {
      projectId: str(gate, 'project_id'),
      buildRevisionId: str(op, 'build_revision_id'),
      artifactDigest: str(op, 'artifact_digest'),
      gateRunId: str(op, 'gate_run_id'),
      caseRunId,
      sessionId: str(op, 'session_id'),
      adapterRevision: str(op, 'adapter_revision'),
      effectPolicyDigest: str(op, 'effect_coverage_policy_digest'),
      effectManifestDigest: str(op, 'effect_manifest_digest'),
      callSiteInventoryDigest: strOrNull(op, 'callsite_inventory_digest'),
      interceptorProfileDigest: strOrNull(gate, 'interceptor_profile_digest'),
      fencingEpoch: Number(op['fencing_epoch']),
    },
    currentPhase: str(op, 'current_phase'),
    phases: {
      quoteRequest: {
        state: 'BOUND',
        digest: str(op, 'quote_request_digest'),
        boundAt: iso(op['created_at_ms']),
        fields: fieldsOf(request, [
          'swapType',
          'originAsset',
          'destinationAsset',
          'amount',
          'slippageTolerance',
          'deadline',
          'recipient',
          'refundTo',
        ]),
      },
      quoteFinalization: {
        state: fin ? 'BOUND' : 'ABSENT',
        digest: fin ? strOrNull(op, 'quote_finalization_digest') : null,
        boundAt: fin ? iso(fin['created_at_ms']) : null,
        fields: fin
          ? fieldsOf(
              {
                correlationId: fin['correlation_id'],
                quoteTimestamp: fin['quote_timestamp'],
                depositAddress: fin['deposit_address'],
                depositMemo: fin['deposit_memo'],
              },
              ['correlationId', 'quoteTimestamp', 'depositAddress', 'depositMemo'],
            )
          : [],
      },
      commitBinding: {
        state: commit ? 'BOUND' : 'ABSENT',
        digest: commit ? strOrNull(op, 'commit_binding_digest') : null,
        boundAt: commit ? iso(commit['created_at_ms']) : null,
        fields: commit
          ? fieldsOf({ method: commit['method'], route: commit['route'] }, ['method', 'route'])
          : [],
      },
      reconciliation: {
        observations: statusEvents.length,
        lastObservedAt: lastStatus ? iso(lastStatus['created_at_ms']) : null,
      },
    },
    conflicts: conflicts.map((c) => ({
      code: rsCode(str(c, 'error_code')),
      phase: str(c, 'phase'),
      message: 'A conflicting binding was refused; the first binding stays authoritative.',
      observedAt: iso(c['created_at_ms']),
    })),
    providerReported: {
      rawStatus,
      rawStatusKnown: known(RAW_PROVIDER_STATUSES, rawStatus) !== null,
      normalizedFact: fact,
      observedAt: lastStatus ? iso(lastStatus['created_at_ms']) : null,
    },
    // The kernel's persisted case verdict: the API derives no per-operation verdict.
    evaluatedOutcome: { verdict: strOrNull(caseRun, 'verdict') ?? 'NOT_RUN', fact },
    attempts: {
      count: attempts.length,
      uncertainty: attempts.some((a) => a['outcome'] === 'SENT_OUTCOME_UNKNOWN') ? 'OUTCOME_UNKNOWN' : 'NONE',
    },
    effectCoverage: coverage,
    sinkObservations: [
      ...reports.map((r) => ({
        observationId: str(r, 'observation_id'),
        source: 'SUBJECT_REPORTED',
        hookId: strOrNull(r, 'hook_id'),
        sinkClass: 'subject-hook',
        effectType: str(r, 'effect_type').slice(0, 200),
        action: str(r, 'action'),
        sequence: Number(r['sequence']),
        interceptorProfileId: null,
        processTreeScope: null,
        freshness: 'NOT_APPLICABLE',
      })),
      ...boundary.map((b) => ({
        observationId: str(b, 'observation_id'),
        source: 'INDEPENDENT_BOUNDARY',
        hookId: null,
        sinkClass: str(b, 'sink_class').slice(0, 200),
        effectType: str(b, 'effect_id').slice(0, 200),
        action: str(b, 'action'),
        sequence: Number(b['sequence']),
        interceptorProfileId: coverage['interceptorProfileId'] ?? null,
        processTreeScope: coverage['processTreeScope'] ?? null,
        freshness: 'NOT_APPLICABLE',
      })),
    ],
    evidence: evidence.map((e) => ({
      evidenceId: str(e, 'evidence_id'),
      class: (EVIDENCE_CLASSES as readonly string[]).includes(str(e, 'evidence_class'))
        ? str(e, 'evidence_class')
        : 'UNKNOWN',
      // A missing scope is never upgraded: it is shown as not visible.
      scope: strOrNull(e, 'evidence_scope') ?? 'PRIVATE_NOT_VISIBLE',
      reasons: json<string[]>(e['reasons_json'], []).slice(0, 16),
      provenance: str(e, 'source_kind').slice(0, 200),
      subject: str(e, 'subject').slice(0, 200),
      observedAt: iso(e['created_at_ms']),
      collectedAt: iso(e['created_at_ms']),
      freshness: 'NOT_APPLICABLE',
      digest: str(e, 'payload_digest'),
      redacted: true,
    })),
    invariants: [...latest.values()]
      .sort((a, b) => str(a, 'invariant_id').localeCompare(str(b, 'invariant_id')))
      .map((r) => {
        const verdict = str(r, 'verdict');
        const invariantId = str(r, 'invariant_id');
        return {
          invariantId,
          title: INVARIANT_TITLES[invariantId] ?? invariantId,
          status: verdict,
          applicable: verdict !== 'NOT_RUN',
          facts: json<unknown[]>(r['reasons_json'], [])
            .map((f) => String(f).slice(0, 200))
            .slice(0, 64),
          evidenceIds: json<unknown[]>(r['evidence_ids_json'], []).map(String).slice(0, 64),
          missingPredicates: json<unknown[]>(r['missing_predicates_json'], [])
            .map((f) => String(f).slice(0, 200))
            .slice(0, 64),
          remediationCode:
            verdict === 'FAIL' || verdict === 'REVIEW' ? rsCode(`${invariantId}_${verdict}`) : null,
        };
      }),
    sensitiveLocators: 'MASKED',
  };
}

// ---------------------------------------------------------------------------------------------
// Import detail: quarantine row plus the M05 lineage, sanitized events, and review requirements.

type Stage =
  | 'CAPTURE'
  | 'QUARANTINE'
  | 'SANITIZE'
  | 'MAP'
  | 'REPLAY_VERIFICATION'
  | 'REVIEW'
  | 'PROMOTED_SCENARIO'
  | 'NEW_CORPUS'
  | 'CORRECTED_RERUN';

const STATE_ORDER = [
  'CAPTURED_UNTRUSTED',
  'QUARANTINED',
  'SANITIZED',
  'MAPPED',
  'REPLAY_VERIFIED',
  'REVIEWED',
  'PROMOTED',
] as const;

function traceEvents(trace: unknown): { source: Row[]; phases: Map<number, string | null> } {
  const t = (trace ?? {}) as Record<string, unknown>;
  const exchanges = Array.isArray(t['exchanges']) ? (t['exchanges'] as Row[]) : [];
  const events = Array.isArray(t['events']) ? (t['events'] as Row[]) : [];
  const phases = new Map<number, string | null>();
  const source: Row[] = [];
  for (const e of [...exchanges, ...events]) {
    const sequence = typeof e['sequence'] === 'number' ? e['sequence'] : null;
    if (sequence === null) continue;
    const route = scalar(e['route']) ?? scalar(e['kind']) ?? scalar(e['type']) ?? 'record';
    const status = scalar(e['rawStatus']) ?? scalar(e['status']) ?? scalar(e['responseStatus']);
    const phase = scalar(e['phase']);
    phases.set(sequence, phase);
    source.push({ sequence, summary: `${route}${status ? ` ${status}` : ''}`.slice(0, 200) });
  }
  source.sort((a, b) => Number(a['sequence']) - Number(b['sequence']));
  return { source: source.slice(0, 500), phases };
}

export function importDetailView(
  imports: ImportJournal,
  importId: string,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const view = imports.getImport(importId);
  const lineage = regressionLineage(imports, importId);
  const mapping = imports.latestMapping(importId);
  const report = imports.latestReplayReport(importId);
  const reached = (state: string) =>
    STATE_ORDER.indexOf(view.state as (typeof STATE_ORDER)[number]) >=
    STATE_ORDER.indexOf(state as (typeof STATE_ORDER)[number]);
  const rejected = view.state === 'REJECTED' || view.state === 'PURGED';
  const node = (
    stage: Stage,
    done: boolean,
    recordId: string | null = null,
    digest: string | null = null,
  ) => ({
    stage,
    state: done ? 'DONE' : rejected ? 'BLOCKED' : 'PENDING',
    recordId,
    digest,
  });
  const promotion = lineage.promotion;
  const corrected = lineage.correctedRuns;
  const passed = lineage.status === 'CORRECTED_RUN_PASSED';
  const stages = [
    node('CAPTURE', true, view.importId, view.rawSourceDigest),
    node('QUARANTINE', reached('QUARANTINED') && !rejected),
    node('SANITIZE', view.sanitizedDigest !== null, view.scanId, view.sanitizedDigest),
    node(
      'MAP',
      mapping !== null && reached('MAPPED'),
      mapping?.mappingRevisionId ?? null,
      mapping?.mappingDigest ?? null,
    ),
    node(
      'REPLAY_VERIFICATION',
      report !== null && report['stable'] === 1 && reached('REPLAY_VERIFIED'),
      report ? String(report['report_id']) : null,
      report ? String(report['report_digest']) : null,
    ),
    node('REVIEW', reached('REVIEWED')),
    node('PROMOTED_SCENARIO', promotion !== null, promotion?.scenarioRevisionId ?? null),
    node('NEW_CORPUS', promotion !== null, promotion?.corpusRevisionId ?? null),
    {
      stage: 'CORRECTED_RERUN',
      state: passed ? 'DONE' : 'PENDING',
      recordId: corrected[0]?.gateRunId ?? null,
      digest: null,
    },
  ];
  const { source, phases } = traceEvents(view.sanitized);
  const mapped = (mapping?.mapping ?? {}) as Record<string, unknown>;
  const ops = Array.isArray(mapped['operations']) ? (mapped['operations'] as Row[]) : [];
  const proposed =
    ops.length > 0
      ? source.map((e) => ({
          sequence: e['sequence'],
          phase: phases.get(Number(e['sequence'])) ?? null,
          summary: e['summary'],
        }))
      : [];
  return {
    ...base,
    lineage: stages,
    sourceEvents: source,
    proposedEvents: proposed.filter(
      (p) =>
        p.phase === null ||
        ['QUOTE_REQUEST', 'QUOTE_FINALIZATION', 'COMMIT_MUTATION', 'READ_ONLY_RECONCILIATION'].includes(
          String(p.phase),
        ),
    ),
    // Promotion alone is replay-only: the corrected client has not passed the new corpus yet.
    replayOnlyPass: promotion !== null && !passed,
    regressionStatus: lineage.status,
    promotion,
    // M16 (RP-08): whether this capture can be release evidence, derived from the journal now.
    releaseEvidence: (() => {
      if (rejected || view.sanitized === null) return null;
      let c: ReturnType<typeof classifyCaptureEvidence>;
      try {
        c = classifyCaptureEvidence(imports, importId);
      } catch {
        // The source journal rows are unavailable: no classification is shown, and promotion
        // re-checks inside its own transaction.
        return null;
      }
      return {
        releaseEvidence: c.releaseEvidence,
        refusalReasons: c.refusalReasons,
        promotableAs: c.releaseEvidence ? ['RELEASE_EVIDENCE', 'DIAGNOSTIC_ONLY'] : ['DIAGNOSTIC_ONLY'],
      };
    })(),
    correctedRuns: corrected,
    mapping: mapping
      ? { mappingRevisionId: mapping.mappingRevisionId, mappingDigest: mapping.mappingDigest }
      : null,
    replayReport: report
      ? {
          reportId: String(report['report_id']),
          stable: report['stable'] === 1,
          trials: Number(report['trials']),
          reportDigest: String(report['report_digest']),
        }
      : null,
    review: {
      decisions: [...REVIEW_DECISIONS],
      confirmationPhrase: REVIEW_CONFIRMATION,
      latestReviewId: latestReviewId(imports, importId),
    },
  };
}

function latestReviewId(imports: ImportJournal, importId: string): string | null {
  const r = imports.store.journal.read(
    (db) =>
      db
        .prepare(
          'SELECT review_id FROM import_reviews WHERE import_id = ? ORDER BY created_at_ms DESC LIMIT 1',
        )
        .get(importId) as Row | undefined,
  );
  return r ? String(r['review_id']) : null;
}
