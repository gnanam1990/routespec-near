/**
 * Import quarantine, review, and promotion repository (M05; DATA-MODEL.md `imports`,
 * `import_mappings`, transaction boundaries; SECURITY.md sections 8-9).
 *
 * Authority model: import writes are administrative. They need an idempotency key and the
 * caller's expected optimistic revision of the import; they never need a case lease. Every write
 * runs on the single journal writer connection in one `BEGIN IMMEDIATE` transaction.
 *
 * What is persisted:
 * - never raw source bytes and never a detected secret value;
 * - for a rejected (secret-bearing, oversized, or malformed) source: only the raw-source digest,
 *   byte count, and safe finding metadata (category, path, count);
 * - otherwise: the sanitized normalized representation plus the same metadata.
 *
 * Promotion is one transaction that re-checks every precondition against current rows, creates
 * the new immutable scenario revision and the new corpus revision (base cases copied unchanged,
 * the promoted case appended), records the promotion and corpus lineage, and moves the import to
 * PROMOTED. An existing scenario or corpus identity is never reused or modified.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  RouteSpecError,
  canonicalJson,
  digestValue,
  type Digest,
  type ErrorCode,
  type ImportOrigin,
  type ImportState,
  type ProvenanceClass,
} from '@routespec/contracts';
import { assertNoSecrets } from './guards.ts';
import type { RouteSpecStore } from './store.ts';

type Row = Record<string, unknown>;

export interface StoredFinding {
  readonly category: string;
  readonly path: string;
  readonly count: number;
  readonly blocking: boolean;
}

export interface CaptureBindingInput {
  readonly caseRunId: string;
  readonly gateRunId: string;
  readonly sessionId: string;
  readonly buildRevisionId: string;
  readonly artifactDigest: string;
  readonly scenarioRevisionId: string;
  readonly effectManifestDigest: string;
  readonly effectCoveragePolicyDigest: string;
  readonly callsiteInventoryDigest: string | null;
  readonly interceptorProfileDigest: string | null;
  readonly adapterRevision: string;
  readonly fencingEpoch: number;
  readonly identityDigest: string;
  readonly captureDigest: string;
}

export interface QuarantineInput {
  readonly projectId: string;
  readonly origin: ImportOrigin;
  readonly sourceSessionId: string | null;
  readonly sourceFilename: string | null;
  readonly rawByteCount: number;
  readonly rawSourceDigest: string;
  /** `REJECT` keeps digest + finding metadata only; `SANITIZE` also persists sanitized content. */
  readonly disposition: 'REJECT' | 'SANITIZE';
  readonly sanitized: unknown;
  readonly schemaState: 'VALID' | 'INVALID' | 'NOT_PARSED';
  readonly findings: readonly StoredFinding[];
  readonly scannerRevision: string;
  readonly captureBinding: CaptureBindingInput | null;
  readonly idempotencyKey: string;
}

export interface ImportRecordView {
  readonly importId: string;
  readonly projectId: string;
  readonly origin: ImportOrigin;
  readonly state: ImportState;
  readonly revision: number;
  readonly rawByteCount: number;
  readonly rawSourceDigest: string;
  readonly sourceFilename: string | null;
  readonly sourceSessionId: string | null;
  readonly schemaState: string;
  readonly sanitized: unknown;
  readonly sanitizedDigest: string | null;
  readonly provenanceClass: ProvenanceClass | null;
  readonly findings: readonly StoredFinding[];
  readonly blockingCount: number;
  readonly scanId: string | null;
  readonly captureBinding: Row | null;
}

export interface PromotionInput {
  readonly importId: string;
  readonly expectedRevision: number;
  readonly reviewId: string;
  readonly idempotencyKey: string;
  readonly scenario: {
    readonly revisionInput: {
      readonly scenarioStableId: string;
      readonly schemaVersion: string;
      readonly compiled: unknown;
      readonly seed: string;
      readonly resourceBudget: unknown;
      readonly provenanceClass: string;
      readonly compilerRevision: string;
    };
    readonly revisionDigest: string;
    readonly sourceLocator: string;
  };
  readonly corpus: {
    readonly label: string;
    readonly baseCorpusRevisionId: string | null;
    readonly newCase: {
      readonly requiredInvariants: readonly string[];
      readonly severity: string;
      readonly gatePolicy: string;
    };
  };
  /** Re-verification executed inside the promotion transaction (e.g. capture re-derivation). */
  readonly verifyInTransaction?: (db: DatabaseSync) => void;
}

export interface PromotionResult {
  readonly promotionId: string;
  readonly scenarioRevisionId: string;
  readonly scenarioRevisionDigest: string;
  readonly corpusRevisionId: string;
  readonly corpusDigest: Digest;
  readonly baseCorpusRevisionId: string | null;
  readonly promotionDigest: Digest;
}

export interface CorpusCaseInput {
  readonly scenarioRevisionId: string;
  readonly requiredInvariants: readonly string[];
  readonly severity: string;
  readonly gatePolicy: string;
}

function fail(
  code: ErrorCode,
  message: string,
  details?: Record<string, string | number | boolean | null>,
): never {
  throw new RouteSpecError(code, message, details ? { details } : undefined);
}

function json(value: unknown, path = '$'): string {
  assertNoSecrets(value, path);
  return canonicalJson(value);
}

function one(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined;
}

function all(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

function run(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): number {
  return Number(db.prepare(sql).run(...params).changes);
}

function s(row: Row, key: string): string {
  const v = row[key];
  if (typeof v !== 'string') throw new RouteSpecError('RS_INTERNAL', 'Journal row has an unexpected shape.');
  return v;
}

function n(row: Row, key: string): number {
  const v = row[key];
  if (typeof v !== 'number') throw new RouteSpecError('RS_INTERNAL', 'Journal row has an unexpected shape.');
  return v;
}

function sOrNull(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' ? v : null;
}

const FINDING_CATEGORY = /^[A-Z][A-Z0-9_]{1,63}$/;
const FINDING_PATH = /^\$[A-Za-z0-9_.[\]-]{0,255}$/;

export const CORPUS_DIGEST_DOMAIN = 'routespec.corpus-revision/1';

/** Corpus identity exactly as `RouteSpecStore.createCorpusRevision` computes it. */
export function corpusRevisionDigest(input: { label: string; cases: readonly CorpusCaseInput[] }): Digest {
  return digestValue(CORPUS_DIGEST_DOMAIN, {
    label: input.label,
    cases: input.cases.map((c) => ({
      scenarioRevisionId: c.scenarioRevisionId,
      requiredInvariants: [...c.requiredInvariants],
      severity: c.severity,
      gatePolicy: c.gatePolicy,
    })),
  });
}

export class ImportJournal {
  readonly store: RouteSpecStore;

  constructor(store: RouteSpecStore) {
    this.store = store;
  }

  private now(): number {
    return this.store.clock.nowMs();
  }

  private tx<T>(label: string, fn: (db: DatabaseSync) => T): T {
    return this.store.journal.transact(label, fn);
  }

  private idempotent<T>(db: DatabaseSync, scope: string, key: string, request: unknown, produce: () => T): T {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      fail('RS_SCHEMA_INVALID', 'Idempotency-Key must be 8-128 safe characters.');
    }
    const requestDigest = digestValue('routespec.idempotent-request/1', request);
    const prior = one(
      db,
      'SELECT request_digest, response_json FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?',
      scope,
      key,
    );
    if (prior) {
      if (prior['request_digest'] !== requestDigest) {
        fail('RS_IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used for a different request.', {
          scope,
        });
      }
      return JSON.parse(s(prior, 'response_json')) as T;
    }
    const response = produce();
    run(
      db,
      'INSERT INTO idempotency_keys(scope, idempotency_key, request_digest, response_json, created_at_ms) VALUES (?,?,?,?,?)',
      scope,
      key,
      requestDigest,
      json(response),
      this.now(),
    );
    return response;
  }

  private audit(
    db: DatabaseSync,
    actionCode: string,
    importId: string,
    details: Record<string, unknown>,
  ): void {
    run(
      db,
      `INSERT INTO audit_events(audit_id, action_code, subject_kind, subject_id, details_json, created_at_ms)
       VALUES (?,?, 'IMPORT', ?, ?, ?)`,
      randomUUID(),
      actionCode,
      importId,
      json(details),
      this.now(),
    );
  }

  /** Move the import one state forward under optimistic revision; the trigger enforces the edge. */
  private transition(
    db: DatabaseSync,
    importId: string,
    expectedRevision: number,
    to: ImportState,
    set: { sanitizedJson?: string | null; schemaState?: string; provenanceClass?: string | null } = {},
  ): number {
    const row = one(db, 'SELECT state, revision FROM imports WHERE import_id = ?', importId);
    if (!row) fail('RS_NOT_FOUND', 'Import not found.');
    if (n(row, 'revision') !== expectedRevision) {
      fail('RS_REVISION_CONFLICT', 'Import revision changed; reload and retry.', {
        expected: expectedRevision,
        current: n(row, 'revision'),
      });
    }
    const from = s(row, 'state');
    const changed = run(
      db,
      `UPDATE imports SET state = ?, revision = revision + 1,
         sanitized_json = CASE WHEN ? = 1 THEN ? ELSE sanitized_json END,
         schema_state = COALESCE(?, schema_state),
         provenance_class = CASE WHEN ? = 1 THEN ? ELSE provenance_class END
       WHERE import_id = ? AND revision = ?`,
      to,
      set.sanitizedJson === undefined ? 0 : 1,
      set.sanitizedJson ?? null,
      set.schemaState ?? null,
      set.provenanceClass === undefined ? 0 : 1,
      set.provenanceClass ?? null,
      importId,
      expectedRevision,
    );
    if (changed !== 1) fail('RS_REVISION_CONFLICT', 'Import revision changed; reload and retry.');
    this.audit(db, 'IMPORT_STATE_CHANGED', importId, { from, to, revision: expectedRevision + 1 });
    return expectedRevision + 1;
  }

  private assertFindings(findings: readonly StoredFinding[]): void {
    if (findings.length > 512) fail('RS_IMPORT_LIMIT_EXCEEDED', 'Too many finding records.');
    for (const f of findings) {
      if (
        !FINDING_CATEGORY.test(f.category) ||
        !FINDING_PATH.test(f.path) ||
        !Number.isInteger(f.count) ||
        f.count < 1 ||
        typeof f.blocking !== 'boolean'
      ) {
        fail('RS_SCHEMA_INVALID', 'Finding metadata must be category/path/count only.');
      }
    }
  }

  /**
   * Record a bounded, scanned source: CAPTURED_UNTRUSTED -> QUARANTINED -> (SANITIZED | REJECTED)
   * in one transaction, with the scan record and capture identity binding.
   */
  recordQuarantine(input: QuarantineInput): { importId: string; state: ImportState; revision: number } {
    this.assertFindings(input.findings);
    if (!/^sha256:[0-9a-f]{64}$/.test(input.rawSourceDigest)) {
      fail('RS_SCHEMA_INVALID', 'Raw source digest must be a sha256 digest.');
    }
    if (input.origin === 'INSTALLED_ARTIFACT_CAPTURE') {
      if (input.captureBinding === null || input.sourceSessionId === null) {
        fail('RS_IMPORT_CAPTURE_MISMATCH', 'An installed capture requires its exact source identity.');
      }
      if (input.captureBinding.sessionId !== input.sourceSessionId) {
        fail('RS_IMPORT_CAPTURE_MISMATCH', 'Capture binding names a different session.');
      }
    } else if (input.captureBinding !== null) {
      fail('RS_IMPORT_CAPTURE_MISMATCH', 'A user file can never carry an installed capture binding.');
    }
    if (input.disposition === 'SANITIZE' && (input.sanitized === null || input.sanitized === undefined)) {
      fail('RS_SCHEMA_INVALID', 'Sanitized content is required to persist a sanitized import.');
    }
    const sanitizedJson = input.disposition === 'SANITIZE' ? json(input.sanitized, '$.sanitized') : null;
    const findingsJson = json(input.findings.map((f) => ({ ...f })));
    const blocking = input.findings.filter((f) => f.blocking).length;
    const request = {
      projectId: input.projectId,
      origin: input.origin,
      rawSourceDigest: input.rawSourceDigest,
      rawByteCount: input.rawByteCount,
      captureDigest: input.captureBinding?.captureDigest ?? null,
    };
    return this.tx('import.quarantine', (db) =>
      this.idempotent(db, 'import.quarantine', input.idempotencyKey, request, () => {
        const importId = randomUUID();
        run(
          db,
          `INSERT INTO imports(import_id, project_id, origin, source_session_id, source_filename, raw_byte_count,
             raw_source_digest, sanitized_json, schema_state, secret_findings_json, determinism_findings_json,
             provenance_class, state, revision, created_at_ms)
           VALUES (?,?,?,?,?,?,?,NULL,'NOT_PARSED',?,?,NULL,'CAPTURED_UNTRUSTED',1,?)`,
          importId,
          input.projectId,
          input.origin,
          input.sourceSessionId,
          input.sourceFilename,
          input.rawByteCount,
          input.rawSourceDigest,
          json(input.findings.filter((f) => f.category.startsWith('SECRET_')).map((f) => ({ ...f }))),
          json(
            input.findings
              .filter(
                (f) => f.category.startsWith('NONDETERMINISTIC_') || f.category === 'DUPLICATE_SEQUENCE',
              )
              .map((f) => ({ ...f })),
          ),
          this.now(),
        );
        this.audit(db, 'IMPORT_CAPTURED', importId, {
          origin: input.origin,
          rawByteCount: input.rawByteCount,
        });
        if (input.captureBinding !== null) {
          const b = input.captureBinding;
          run(
            db,
            `INSERT INTO import_capture_bindings(import_id, case_run_id, gate_run_id, session_id, build_revision_id,
               artifact_digest, scenario_revision_id, effect_manifest_digest, effect_coverage_policy_digest,
               callsite_inventory_digest, interceptor_profile_digest, adapter_revision, fencing_epoch, identity_digest,
               capture_digest, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            importId,
            b.caseRunId,
            b.gateRunId,
            b.sessionId,
            b.buildRevisionId,
            b.artifactDigest,
            b.scenarioRevisionId,
            b.effectManifestDigest,
            b.effectCoveragePolicyDigest,
            b.callsiteInventoryDigest,
            b.interceptorProfileDigest,
            b.adapterRevision,
            b.fencingEpoch,
            b.identityDigest,
            b.captureDigest,
            this.now(),
          );
        }
        let revision = this.transition(db, importId, 1, 'QUARANTINED');
        const scanId = randomUUID();
        run(
          db,
          `INSERT INTO import_scans(scan_id, import_id, scanner_revision, findings_json, blocking_count, scan_digest, created_at_ms)
           VALUES (?,?,?,?,?,?,?)`,
          scanId,
          importId,
          input.scannerRevision,
          findingsJson,
          blocking,
          digestValue('routespec.import-scan/1', {
            importId,
            scannerRevision: input.scannerRevision,
            findings: input.findings,
          }),
          this.now(),
        );
        let state: ImportState;
        if (input.disposition === 'REJECT') {
          revision = this.transition(db, importId, revision, 'REJECTED', { schemaState: input.schemaState });
          state = 'REJECTED';
        } else {
          revision = this.transition(db, importId, revision, 'SANITIZED', {
            sanitizedJson,
            schemaState: input.schemaState,
          });
          state = 'SANITIZED';
        }
        return { importId, state, revision };
      }),
    );
  }

  getImport(importId: string): ImportRecordView {
    return this.store.journal.read((db) => this.view(db, importId));
  }

  private view(db: DatabaseSync, importId: string): ImportRecordView {
    const row = one(db, 'SELECT * FROM imports WHERE import_id = ?', importId);
    if (!row) fail('RS_NOT_FOUND', 'Import not found.');
    const scan = one(
      db,
      'SELECT * FROM import_scans WHERE import_id = ? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1',
      importId,
    );
    const binding = one(db, 'SELECT * FROM import_capture_bindings WHERE import_id = ?', importId) ?? null;
    const sanitizedJson = sOrNull(row, 'sanitized_json');
    return {
      importId,
      projectId: s(row, 'project_id'),
      origin: s(row, 'origin') as ImportOrigin,
      state: s(row, 'state') as ImportState,
      revision: n(row, 'revision'),
      rawByteCount: n(row, 'raw_byte_count'),
      rawSourceDigest: s(row, 'raw_source_digest'),
      sourceFilename: sOrNull(row, 'source_filename'),
      sourceSessionId: sOrNull(row, 'source_session_id'),
      schemaState: s(row, 'schema_state'),
      sanitized: sanitizedJson === null ? null : (JSON.parse(sanitizedJson) as unknown),
      sanitizedDigest:
        sanitizedJson === null
          ? null
          : digestValue('routespec.import-sanitized/1', JSON.parse(sanitizedJson)),
      provenanceClass: sOrNull(row, 'provenance_class') as ProvenanceClass | null,
      findings: scan ? (JSON.parse(s(scan, 'findings_json')) as StoredFinding[]) : [],
      blockingCount: scan ? n(scan, 'blocking_count') : 0,
      scanId: scan ? s(scan, 'scan_id') : null,
      captureBinding: binding,
    };
  }

  /** Save a reviewer mapping draft (an immutable mapping revision). Blocking findings refuse it. */
  saveMapping(input: {
    importId: string;
    expectedRevision: number;
    mapping: unknown;
    provenanceClass: ProvenanceClass;
    idempotencyKey: string;
  }): { mappingRevisionId: string; mappingDigest: Digest; revision: number } {
    const contentDigest = digestValue('routespec.import-mapping-content/1', {
      importId: input.importId,
      mapping: input.mapping,
    });
    return this.tx('import.mapping', (db) =>
      this.idempotent(db, 'import.mapping', input.idempotencyKey, { ...input, contentDigest }, () => {
        const v = this.view(db, input.importId);
        // Each mapping revision is a distinct immutable record, even when its content repeats.
        const mappingDigest = digestValue('routespec.import-mapping/1', {
          importId: input.importId,
          importRevision: v.revision,
          contentDigest,
        });
        if (!['SANITIZED', 'MAPPED', 'REPLAY_VERIFIED'].includes(v.state)) {
          fail('RS_IMPORT_STATE_INVALID', 'Only a sanitized import can be mapped.', { state: v.state });
        }
        if (v.sanitized === null) fail('RS_IMPORT_STATE_INVALID', 'Import has no sanitized content.');
        if (v.blockingCount > 0) {
          fail('RS_IMPORT_BLOCKED', 'Blocking quarantine findings prevent mapping.', {
            blocking: v.blockingCount,
          });
        }
        const mappingRevisionId = randomUUID();
        run(
          db,
          'INSERT INTO import_mappings(mapping_revision_id, import_id, mapping_json, mapping_digest, created_at_ms) VALUES (?,?,?,?,?)',
          mappingRevisionId,
          input.importId,
          json(input.mapping, '$.mapping'),
          mappingDigest,
          this.now(),
        );
        const revision = this.transition(db, input.importId, input.expectedRevision, 'MAPPED', {
          provenanceClass: input.provenanceClass,
        });
        return { mappingRevisionId, mappingDigest, revision };
      }),
    );
  }

  latestMapping(
    importId: string,
  ): { mappingRevisionId: string; mapping: unknown; mappingDigest: string } | null {
    return this.store.journal.read((db) => this.latestMappingIn(db, importId));
  }

  private latestMappingIn(
    db: DatabaseSync,
    importId: string,
  ): { mappingRevisionId: string; mapping: unknown; mappingDigest: string } | null {
    const row = one(
      db,
      'SELECT * FROM import_mappings WHERE import_id = ? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1',
      importId,
    );
    return row
      ? {
          mappingRevisionId: s(row, 'mapping_revision_id'),
          mapping: JSON.parse(s(row, 'mapping_json')) as unknown,
          mappingDigest: s(row, 'mapping_digest'),
        }
      : null;
  }

  /** Record a replay report; only a stable, faithful, finding-free report verifies the import. */
  recordReplayReport(input: {
    importId: string;
    expectedRevision: number;
    mappingRevisionId: string;
    scenarioRevisionDigest: string;
    evaluatorRevision: string;
    trialDigests: readonly string[];
    fidelity: 'MATCH' | 'MISMATCH';
    findings: readonly StoredFinding[];
    idempotencyKey: string;
  }): { reportId: string; reportDigest: Digest; verified: boolean; revision: number } {
    this.assertFindings(input.findings);
    if (input.trialDigests.length < 2) fail('RS_SCHEMA_INVALID', 'At least two replay trials are required.');
    const stable = input.trialDigests.every((d) => d === input.trialDigests[0]);
    const verified = stable && input.fidelity === 'MATCH' && input.findings.length === 0;
    const reportDigest = digestValue('routespec.import-replay-report/1', {
      importId: input.importId,
      mappingRevisionId: input.mappingRevisionId,
      scenarioRevisionDigest: input.scenarioRevisionDigest,
      evaluatorRevision: input.evaluatorRevision,
      trialDigests: input.trialDigests,
      stable,
      fidelity: input.fidelity,
      findings: input.findings,
    });
    return this.tx('import.replay-report', (db) =>
      this.idempotent(db, 'import.replay-report', input.idempotencyKey, { ...input, reportDigest }, () => {
        const v = this.view(db, input.importId);
        if (v.state !== 'MAPPED') {
          fail('RS_IMPORT_STATE_INVALID', 'Replay verification requires a mapped import.', {
            state: v.state,
          });
        }
        const latest = this.latestMappingIn(db, input.importId);
        if (latest?.mappingRevisionId !== input.mappingRevisionId) {
          fail('RS_IMPORT_STATE_INVALID', 'Replay verification must use the latest mapping revision.');
        }
        const reportId = randomUUID();
        run(
          db,
          `INSERT INTO import_replay_reports(report_id, import_id, mapping_revision_id, scenario_revision_digest,
             evaluator_revision, trials, trial_digests_json, stable, fidelity, findings_json, report_digest, created_at_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          reportId,
          input.importId,
          input.mappingRevisionId,
          input.scenarioRevisionDigest,
          input.evaluatorRevision,
          input.trialDigests.length,
          json([...input.trialDigests]),
          stable ? 1 : 0,
          input.fidelity,
          json(input.findings.map((f) => ({ ...f }))),
          reportDigest,
          this.now(),
        );
        let revision = v.revision;
        if (input.expectedRevision !== v.revision) {
          fail('RS_REVISION_CONFLICT', 'Import revision changed; reload and retry.');
        }
        if (verified) revision = this.transition(db, input.importId, v.revision, 'REPLAY_VERIFIED');
        else this.audit(db, 'IMPORT_REPLAY_UNVERIFIED', input.importId, { stable, fidelity: input.fidelity });
        return { reportId, reportDigest, verified, revision };
      }),
    );
  }

  latestReplayReport(importId: string): Row | null {
    return this.store.journal.read(
      (db) =>
        one(
          db,
          'SELECT * FROM import_replay_reports WHERE import_id = ? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1',
          importId,
        ) ?? null,
    );
  }

  /** Record the immutable explicit local review; only a replay-verified import can be reviewed. */
  recordReview(input: {
    importId: string;
    expectedRevision: number;
    mappingRevisionId: string;
    replayReportId: string;
    scanId: string;
    reviewerDigest: string;
    decisions: unknown;
    reviewDigest: string;
    idempotencyKey: string;
  }): { reviewId: string; revision: number } {
    return this.tx('import.review', (db) =>
      this.idempotent(db, 'import.review', input.idempotencyKey, input, () => {
        const v = this.view(db, input.importId);
        if (v.state !== 'REPLAY_VERIFIED') {
          fail('RS_IMPORT_STATE_INVALID', 'Review requires a replay-verified import.', { state: v.state });
        }
        const latest = this.latestMappingIn(db, input.importId);
        const report = one(
          db,
          'SELECT * FROM import_replay_reports WHERE import_id = ? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1',
          input.importId,
        );
        if (
          latest?.mappingRevisionId !== input.mappingRevisionId ||
          !report ||
          s(report, 'report_id') !== input.replayReportId ||
          s(report, 'mapping_revision_id') !== input.mappingRevisionId ||
          v.scanId !== input.scanId
        ) {
          fail('RS_IMPORT_REVIEW_INVALID', 'Review must cite the current mapping, replay report, and scan.');
        }
        const reviewId = randomUUID();
        run(
          db,
          `INSERT INTO import_reviews(review_id, import_id, import_revision, mapping_revision_id, replay_report_id, scan_id,
             reviewer_digest, decisions_json, review_digest, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          reviewId,
          input.importId,
          v.revision,
          input.mappingRevisionId,
          input.replayReportId,
          input.scanId,
          input.reviewerDigest,
          json(input.decisions, '$.decisions'),
          input.reviewDigest,
          this.now(),
        );
        const revision = this.transition(db, input.importId, input.expectedRevision, 'REVIEWED');
        return { reviewId, revision };
      }),
    );
  }

  getReview(reviewId: string): Row | undefined {
    return this.store.journal.read((db) =>
      one(db, 'SELECT * FROM import_reviews WHERE review_id = ?', reviewId),
    );
  }

  /** Reject an import (any non-terminal stage); content already persisted stays quarantined. */
  reject(input: {
    importId: string;
    expectedRevision: number;
    reasonCode: string;
    idempotencyKey: string;
  }): number {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(input.reasonCode)) fail('RS_SCHEMA_INVALID', 'Invalid reason code.');
    return this.tx('import.reject', (db) =>
      this.idempotent(db, 'import.reject', input.idempotencyKey, input, () => {
        const revision = this.transition(db, input.importId, input.expectedRevision, 'REJECTED');
        this.audit(db, 'IMPORT_REJECTED', input.importId, { reasonCode: input.reasonCode });
        return revision;
      }),
    );
  }

  /** Atomic promotion: new scenario revision + new corpus revision + lineage + PROMOTED. */
  promote(input: PromotionInput): PromotionResult {
    return this.tx('import.promote', (db) =>
      this.idempotent(
        db,
        'import.promote',
        input.idempotencyKey,
        {
          importId: input.importId,
          expectedRevision: input.expectedRevision,
          reviewId: input.reviewId,
          scenarioDigest: input.scenario.revisionDigest,
          corpus: input.corpus,
        },
        () => this.promoteIn(db, input),
      ),
    );
  }

  private promoteIn(db: DatabaseSync, input: PromotionInput): PromotionResult {
    const v = this.view(db, input.importId);
    if (v.state !== 'REVIEWED') {
      fail('RS_IMPORT_STATE_INVALID', 'Only a reviewed import can be promoted.', { state: v.state });
    }
    if (v.revision !== input.expectedRevision) {
      fail('RS_REVISION_CONFLICT', 'Import revision changed; reload and retry.');
    }
    if (v.sanitized === null || v.blockingCount > 0) {
      fail('RS_IMPORT_BLOCKED', 'Blocking quarantine findings prevent promotion.');
    }
    const review = one(
      db,
      'SELECT * FROM import_reviews WHERE review_id = ? AND import_id = ?',
      input.reviewId,
      input.importId,
    );
    if (!review) fail('RS_IMPORT_REVIEW_INVALID', 'Review record does not belong to this import.');
    const latestReview = one(
      db,
      'SELECT review_id FROM import_reviews WHERE import_id = ? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1',
      input.importId,
    );
    const mapping = this.latestMappingIn(db, input.importId);
    const report = one(
      db,
      'SELECT * FROM import_replay_reports WHERE report_id = ?',
      s(review, 'replay_report_id'),
    );
    if (
      latestReview?.['review_id'] !== input.reviewId ||
      mapping?.mappingRevisionId !== s(review, 'mapping_revision_id') ||
      !report ||
      n(report, 'stable') !== 1 ||
      s(report, 'fidelity') !== 'MATCH' ||
      s(report, 'scenario_revision_digest') !== input.scenario.revisionDigest ||
      s(review, 'scan_id') !== v.scanId
    ) {
      fail('RS_IMPORT_REVIEW_INVALID', 'Review no longer matches the mapping, replay report, or scenario.');
    }
    if (input.scenario.revisionInput.provenanceClass !== v.provenanceClass) {
      fail('RS_IMPORT_REVIEW_INVALID', 'Scenario provenance differs from the reviewed provenance.');
    }
    input.verifyInTransaction?.(db);

    const ri = input.scenario.revisionInput;
    const recomputed = digestValue('routespec.scenario-revision/1', {
      schemaVersion: ri.schemaVersion,
      compiled: ri.compiled,
      seed: ri.seed,
      resourceBudget: ri.resourceBudget,
      provenanceClass: ri.provenanceClass,
      compilerRevision: ri.compilerRevision,
    });
    if (recomputed !== input.scenario.revisionDigest) {
      fail('RS_IDENTITY_MISMATCH', 'Scenario revision digest does not match its content.');
    }
    if (one(db, 'SELECT 1 AS x FROM scenario_revisions WHERE revision_digest = ?', recomputed)) {
      fail('RS_DUPLICATE', 'Promotion must create a new scenario revision; this one already exists.');
    }
    const scenarioRevisionId = randomUUID();
    run(
      db,
      `INSERT INTO scenario_revisions(scenario_revision_id, scenario_stable_id, schema_version, compiled_json, seed,
         resource_budget_json, provenance_class, source_locator, review_status, compiler_revision, revision_digest, created_at_ms)
       VALUES (?,?,?,?,?,?,?,?,'REVIEWED',?,?,?)`,
      scenarioRevisionId,
      ri.scenarioStableId,
      ri.schemaVersion,
      json(ri.compiled),
      ri.seed,
      json(ri.resourceBudget),
      ri.provenanceClass,
      input.scenario.sourceLocator,
      ri.compilerRevision,
      recomputed,
      this.now(),
    );

    const baseCases: CorpusCaseInput[] =
      input.corpus.baseCorpusRevisionId === null
        ? []
        : this.corpusCasesIn(db, input.corpus.baseCorpusRevisionId);
    const cases: CorpusCaseInput[] = [
      ...baseCases,
      {
        scenarioRevisionId,
        requiredInvariants: [...input.corpus.newCase.requiredInvariants],
        severity: input.corpus.newCase.severity,
        gatePolicy: input.corpus.newCase.gatePolicy,
      },
    ];
    const corpusDigest = corpusRevisionDigest({ label: input.corpus.label, cases });
    if (one(db, 'SELECT 1 AS x FROM corpus_revisions WHERE corpus_digest = ?', corpusDigest)) {
      fail('RS_DUPLICATE', 'Promotion must create a new corpus identity.');
    }
    const corpusRevisionId = this.insertCorpus(db, input.corpus.label, corpusDigest, cases);
    this.insertLineage(
      db,
      corpusRevisionId,
      input.corpus.baseCorpusRevisionId,
      'PROMOTION_INTO',
      input.importId,
    );

    const promotionId = randomUUID();
    const promotionDigest = digestValue('routespec.import-promotion/1', {
      importId: input.importId,
      reviewDigest: s(review, 'review_digest'),
      mappingDigest: mapping.mappingDigest,
      replayReportDigest: s(report, 'report_digest'),
      scenarioRevisionDigest: recomputed,
      corpusDigest,
      baseCorpusRevisionId: input.corpus.baseCorpusRevisionId,
    });
    run(
      db,
      `INSERT INTO import_promotions(promotion_id, import_id, review_id, scenario_revision_id, corpus_revision_id,
         base_corpus_revision_id, promotion_digest, created_at_ms) VALUES (?,?,?,?,?,?,?,?)`,
      promotionId,
      input.importId,
      input.reviewId,
      scenarioRevisionId,
      corpusRevisionId,
      input.corpus.baseCorpusRevisionId,
      promotionDigest,
      this.now(),
    );
    this.transition(db, input.importId, input.expectedRevision, 'PROMOTED');
    this.audit(db, 'IMPORT_PROMOTED', input.importId, {
      scenarioRevisionId,
      corpusRevisionId,
      baseCorpusRevisionId: input.corpus.baseCorpusRevisionId,
    });
    return {
      promotionId,
      scenarioRevisionId,
      scenarioRevisionDigest: recomputed,
      corpusRevisionId,
      corpusDigest,
      baseCorpusRevisionId: input.corpus.baseCorpusRevisionId,
      promotionDigest,
    };
  }

  private insertCorpus(
    db: DatabaseSync,
    label: string,
    corpusDigest: Digest,
    cases: readonly CorpusCaseInput[],
  ): string {
    const corpusRevisionId = randomUUID();
    run(
      db,
      'INSERT INTO corpus_revisions(corpus_revision_id, label, corpus_digest, created_at_ms) VALUES (?,?,?,?)',
      corpusRevisionId,
      label,
      corpusDigest,
      this.now(),
    );
    cases.forEach((c, ordinal) => {
      if (
        !one(db, 'SELECT 1 AS x FROM scenario_revisions WHERE scenario_revision_id = ?', c.scenarioRevisionId)
      ) {
        fail('RS_NOT_FOUND', 'Corpus case names an unknown scenario revision.', { ordinal });
      }
      run(
        db,
        `INSERT INTO corpus_cases(corpus_revision_id, case_ordinal, scenario_revision_id, required_invariants_json, severity, gate_policy)
         VALUES (?,?,?,?,?,?)`,
        corpusRevisionId,
        ordinal,
        c.scenarioRevisionId,
        json([...c.requiredInvariants]),
        c.severity,
        c.gatePolicy,
      );
    });
    return corpusRevisionId;
  }

  private insertLineage(
    db: DatabaseSync,
    corpusRevisionId: string,
    parent: string | null,
    relation: 'REVISION_OF' | 'PROMOTION_INTO',
    importId: string | null,
  ): void {
    run(
      db,
      `INSERT INTO corpus_lineage(corpus_revision_id, parent_corpus_revision_id, relation, import_id, lineage_digest, created_at_ms)
       VALUES (?,?,?,?,?,?)`,
      corpusRevisionId,
      parent,
      relation,
      importId,
      digestValue('routespec.corpus-lineage/1', { corpusRevisionId, parent, relation, importId }),
      this.now(),
    );
  }

  private corpusCasesIn(db: DatabaseSync, corpusRevisionId: string): CorpusCaseInput[] {
    if (!one(db, 'SELECT 1 AS x FROM corpus_revisions WHERE corpus_revision_id = ?', corpusRevisionId)) {
      fail('RS_NOT_FOUND', 'Corpus revision not found.');
    }
    return all(
      db,
      'SELECT * FROM corpus_cases WHERE corpus_revision_id = ? ORDER BY case_ordinal',
      corpusRevisionId,
    ).map((r) => ({
      scenarioRevisionId: s(r, 'scenario_revision_id'),
      requiredInvariants: JSON.parse(s(r, 'required_invariants_json')) as string[],
      severity: s(r, 'severity'),
      gatePolicy: s(r, 'gate_policy'),
    }));
  }

  corpusCases(corpusRevisionId: string): CorpusCaseInput[] {
    return this.store.journal.read((db) => this.corpusCasesIn(db, corpusRevisionId));
  }

  getCorpus(corpusRevisionId: string): {
    corpusRevisionId: string;
    label: string;
    corpusDigest: string;
    cases: CorpusCaseInput[];
    parent: Row | null;
  } {
    return this.store.journal.read((db) => {
      const row = one(db, 'SELECT * FROM corpus_revisions WHERE corpus_revision_id = ?', corpusRevisionId);
      if (!row) fail('RS_NOT_FOUND', 'Corpus revision not found.');
      return {
        corpusRevisionId,
        label: s(row, 'label'),
        corpusDigest: s(row, 'corpus_digest'),
        cases: this.corpusCasesIn(db, corpusRevisionId),
        parent:
          one(db, 'SELECT * FROM corpus_lineage WHERE corpus_revision_id = ?', corpusRevisionId) ?? null,
      };
    });
  }

  /**
   * Explicit corpus revision: a new immutable corpus identity derived from a base revision. The
   * base is never modified. Reusing an existing identity is refused so a revision is always new.
   */
  reviseCorpus(input: {
    baseCorpusRevisionId: string;
    label: string;
    cases: readonly CorpusCaseInput[];
    idempotencyKey: string;
  }): { corpusRevisionId: string; corpusDigest: Digest } {
    const corpusDigest = corpusRevisionDigest({ label: input.label, cases: input.cases });
    return this.tx('corpus.revise', (db) =>
      this.idempotent(db, 'corpus.revise', input.idempotencyKey, { ...input, corpusDigest }, () => {
        this.corpusCasesIn(db, input.baseCorpusRevisionId);
        if (one(db, 'SELECT 1 AS x FROM corpus_revisions WHERE corpus_digest = ?', corpusDigest)) {
          fail('RS_DUPLICATE', 'A corpus revision with this exact identity already exists.');
        }
        const corpusRevisionId = this.insertCorpus(db, input.label, corpusDigest, input.cases);
        this.insertLineage(db, corpusRevisionId, input.baseCorpusRevisionId, 'REVISION_OF', null);
        return { corpusRevisionId, corpusDigest };
      }),
    );
  }

  /** Case runs of gate runs pinned to `corpusRevisionId` that execute `scenarioRevisionId`. */
  listCaseRunsFor(corpusRevisionId: string, scenarioRevisionId: string): Row[] {
    return this.store.journal.read((db) =>
      all(
        db,
        `SELECT c.case_run_id, c.gate_run_id, c.lineage_role, c.execution_lifecycle, c.verdict, c.terminal_result_digest,
                g.build_revision_id, g.artifact_digest, g.corpus_revision_id, g.identity_digest
           FROM case_runs c JOIN gate_runs g USING (gate_run_id)
          WHERE g.corpus_revision_id = ? AND c.scenario_revision_id = ?
          ORDER BY g.created_at_ms, c.case_ordinal`,
        corpusRevisionId,
        scenarioRevisionId,
      ),
    );
  }

  getPromotion(importId: string): Row | undefined {
    return this.store.journal.read((db) =>
      one(db, 'SELECT * FROM import_promotions WHERE import_id = ?', importId),
    );
  }

  listImportAudit(importId: string): Row[] {
    return this.store.journal.read((db) =>
      all(
        db,
        "SELECT action_code, details_json FROM audit_events WHERE subject_kind = 'IMPORT' AND subject_id = ? ORDER BY created_at_ms, rowid",
        importId,
      ),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Retention purge of quarantine content (M11 safe deletion; SECURITY.md section 9).

  /**
   * Which imports of a project are due for purge now, under the project's retention policy:
   * - REJECTED: after `rejectedImportHours`;
   * - CAPTURED_UNTRUSTED, QUARANTINED, SANITIZED (content not yet mapped): after
   *   `sessionPayloadDays`;
   * - every purgeable import of a logically deleted project: immediately.
   * MAPPED, REPLAY_VERIFIED, and REVIEWED imports are retained: their mapping, replay, and review
   * records are immutable reviewed evidence. PROMOTED imports are retained as regression sources.
   * The plan digest covers the due imports and their revisions, so a plan confirmed after any of
   * them changed no longer matches.
   */
  planRetentionPurge(projectId: string): RetentionPurgePlan {
    return this.store.journal.read((db) => this.planRetentionIn(db, projectId));
  }

  private planRetentionIn(db: DatabaseSync, projectId: string): RetentionPurgePlan {
    const project = one(
      db,
      'SELECT retention_policy_json, deleted_at_ms FROM projects WHERE project_id = ?',
      projectId,
    );
    if (!project) fail('RS_NOT_FOUND', 'Project not found.');
    const policy = JSON.parse(s(project, 'retention_policy_json')) as {
      rejectedImportHours?: number;
      sessionPayloadDays?: number;
    };
    const rejectedMs = Math.max(0, Number(policy.rejectedImportHours ?? 24)) * 3_600_000;
    const quarantineMs = Math.max(0, Number(policy.sessionPayloadDays ?? 30)) * 86_400_000;
    const deleted = project['deleted_at_ms'] !== null && project['deleted_at_ms'] !== undefined;
    const now = this.now();
    const rows = all(
      db,
      'SELECT import_id, state, revision, created_at_ms FROM imports WHERE project_id = ? ORDER BY rowid',
      projectId,
    );
    const due: RetentionPurgeItem[] = [];
    const retained: Array<{ importId: string; state: string; reason: string }> = [];
    for (const r of rows) {
      const state = s(r, 'state');
      const age = now - n(r, 'created_at_ms');
      const item = { importId: s(r, 'import_id'), state, revision: n(r, 'revision') };
      if (state === 'PURGED') continue;
      if (state === 'PROMOTED') retained.push({ ...item, reason: 'PROMOTED_REGRESSION_SOURCE' });
      else if (['MAPPED', 'REPLAY_VERIFIED', 'REVIEWED'].includes(state))
        retained.push({ ...item, reason: 'REVIEWED_RECORDS_IMMUTABLE' });
      else if (deleted) due.push(item);
      else if (state === 'REJECTED' ? age >= rejectedMs : age >= quarantineMs) due.push(item);
    }
    const planDigest = digestValue('routespec.retention-purge-plan/1', { projectId, due });
    return { projectId, projectDeleted: deleted, due, retained, planDigest };
  }

  /** Purge exactly the confirmed plan (state PURGED, sanitized content cleared) with secure deletion. */
  executeRetentionPurge(projectId: string, confirmDigest: string): RetentionPurgeResult {
    const { result, walTruncated } = this.store.journal.transactSecureDelete(
      'import.retention-purge',
      (db) => {
        const plan = this.planRetentionIn(db, projectId);
        if (plan.planDigest !== confirmDigest) {
          fail('RS_DELETION_PLAN_MISMATCH', 'The confirmation does not match the current purge plan.');
        }
        for (const item of plan.due) {
          this.transition(db, item.importId, item.revision, 'PURGED', { sanitizedJson: null });
        }
        run(
          db,
          `INSERT INTO audit_events(audit_id, action_code, subject_kind, subject_id, details_json, created_at_ms)
         VALUES (?, 'IMPORTS_RETENTION_PURGED', 'PROJECT', ?, ?, ?)`,
          randomUUID(),
          projectId,
          json({ planDigest: plan.planDigest, purged: plan.due.length, retained: plan.retained.length }),
          this.now(),
        );
        return plan;
      },
    );
    return { ...result, purged: result.due.length, walTruncated };
  }
}

export interface RetentionPurgeItem {
  readonly importId: string;
  readonly state: string;
  readonly revision: number;
}

export interface RetentionPurgePlan {
  readonly projectId: string;
  readonly projectDeleted: boolean;
  readonly due: readonly RetentionPurgeItem[];
  readonly retained: ReadonlyArray<{
    readonly importId: string;
    readonly state: string;
    readonly reason: string;
  }>;
  readonly planDigest: Digest;
}

export interface RetentionPurgeResult extends RetentionPurgePlan {
  readonly purged: number;
  readonly walTruncated: boolean;
}
