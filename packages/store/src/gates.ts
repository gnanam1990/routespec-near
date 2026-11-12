/**
 * Release-gate journal (module M06): gate definitions, consistent gate snapshots, immutable gate
 * evaluations with their ordered case links, case interruptions, and export plans/writes.
 *
 * Authority model (DATA-MODEL section 6, TDD section 15):
 * - A gate evaluation and its case links are written in one transaction. Before writing, the
 *   transaction re-reads every case run and compares it with the snapshot the aggregator used; a
 *   case that moved in between fails closed with RS_REVISION_CONFLICT (no partial decision).
 * - The decision digest is unique: re-evaluating the same immutable state returns the existing
 *   evaluation. Enforcement mode has its own digest and never enters the decision digest.
 * - Export plans/writes are administrative mutations: idempotency key plus expected optimistic
 *   revision, no case lease. `artifact_ready` follows the latest write and never changes the
 *   decision.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  ENFORCEMENT_MODES,
  RouteSpecError,
  canonicalJson,
  digestValue,
  type EnforcementMode,
  type ErrorCode,
  type Verdict,
} from '@routespec/contracts';
import { assertNoSecrets } from './guards.ts';
import { corpusEvidenceClassIn } from './imports.ts';
import type { RouteSpecStore } from './store.ts';

type Row = Record<string, unknown>;

export type BuildAttestationPolicy = 'ALLOW_USER_ASSERTED' | 'REQUIRE_TRUSTED';
export const BUILD_ATTESTATION_POLICIES: readonly BuildAttestationPolicy[] = Object.freeze([
  'ALLOW_USER_ASSERTED',
  'REQUIRE_TRUSTED',
]);

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
function sn(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' ? v : null;
}

export interface GateDefinitionView {
  readonly gateId: string;
  readonly gateDefinitionRevisionId: string;
  readonly projectId: string;
  readonly name: string;
  readonly corpusRevisionId: string;
  readonly enforcementMode: EnforcementMode;
  readonly buildAttestationPolicy: BuildAttestationPolicy;
  readonly createdAtMs: number;
}

/** Everything the gate aggregator reads, taken in one consistent read. */
export interface GateSnapshotRows {
  readonly schemaVersion: number;
  readonly gateRun: Row;
  readonly definition: GateDefinitionView | null;
  readonly corpusCases: readonly Row[];
  readonly caseRuns: readonly Row[];
  readonly caseResults: readonly Row[];
  readonly interruptions: readonly Row[];
  /** Per-case effect-coverage policies (M14, schema 8); absent or empty means none. */
  readonly casePolicies?: readonly Row[];
  /**
   * The gate run's selected build attestation joined with its principal's current enabled flag,
   * revocation epoch, and policy digest (TB-07), read in the same transaction as the cases.
   * Null: the gate run selects none, or the record is missing.
   */
  readonly buildAttestation?: Row | null;
}

export interface GateEvaluationCaseInput {
  readonly ordinal: number;
  readonly caseRunId: string | null;
  readonly required: boolean;
  readonly lifecycle: string | null;
  readonly caseVerdict: Verdict | null;
  readonly resultDigest: string | null;
  readonly fencingEpoch: number | null;
  readonly contribution: Verdict;
  readonly findings: readonly string[];
}

export interface PersistGateEvaluationInput {
  readonly gateRunId: string;
  readonly gateDefinitionRevisionId: string | null;
  readonly identity: unknown;
  readonly identityDigest: string;
  readonly caseResultDigests: readonly string[];
  readonly decision: Verdict;
  readonly findings: readonly string[];
  readonly decisionDigest: string;
  readonly enforcementMode: EnforcementMode;
  readonly enforcementDigest: string;
  readonly aggregatorRevision: string;
  readonly runtime: unknown;
  readonly cases: readonly GateEvaluationCaseInput[];
  /** Snapshot the decision was computed from; any drift fails closed. */
  readonly expected: {
    readonly gateLifecycle: string;
    readonly caseStates: ReadonlyArray<{
      caseRunId: string;
      lifecycle: string;
      fencingEpoch: number;
      terminalResultDigest: string | null;
    }>;
    /**
     * The selected build attester's state the decision saw (TB-07); a principal disabled,
     * revoked, or changed before the write fails closed. Absent: not checked.
     */
    readonly buildAttester?: {
      readonly principalEnabled: number;
      readonly revocationEpoch: number;
      readonly policyDigest: string;
    } | null;
  };
  /** Close a RUNNING gate run (RUNNING -> EVALUATING -> COMPLETED) with the decision as verdict. */
  readonly closeGateRun: boolean;
}

export interface GateEvaluationView {
  readonly gateEvaluationId: string;
  readonly gateRunId: string;
  readonly gateDefinitionRevisionId: string | null;
  readonly identity: Record<string, unknown>;
  readonly identityDigest: string;
  readonly caseResultDigests: readonly string[];
  readonly decision: Verdict;
  readonly findings: readonly string[];
  readonly decisionDigest: string;
  readonly enforcementMode: EnforcementMode;
  readonly enforcementDigest: string;
  readonly aggregatorRevision: string;
  readonly runtime: Record<string, unknown>;
  readonly createdAtMs: number;
  readonly cases: ReadonlyArray<GateEvaluationCaseInput>;
  /** Independent of the decision: true only when the latest write of some export succeeded. */
  readonly artifactReady: boolean;
  readonly exportIds: readonly string[];
}

export interface ExportFindingRecord {
  readonly category: string;
  readonly path: string;
  readonly count: number;
  readonly blocking: boolean;
}

export interface ExportEntryRecord {
  readonly path: string;
  readonly digest: string;
  readonly bytes: number;
  readonly kind: string;
}

export interface ExportPlanView {
  readonly exportId: string;
  readonly gateEvaluationId: string;
  readonly planDigest: string;
  readonly bundleDigest: string | null;
  readonly bundleBytes: number | null;
  readonly blocked: boolean;
  readonly privacyScanResult: string;
  readonly options: Record<string, unknown>;
  readonly findings: readonly ExportFindingRecord[];
  readonly entries: readonly ExportEntryRecord[];
  readonly exclusions: readonly string[];
  readonly attachments: ReadonlyArray<{ name: string; content: string }> | null;
  readonly revision: number;
  readonly artifactReady: boolean;
  readonly outputDigest: string | null;
  readonly retainedPath: string | null;
  readonly writes: ReadonlyArray<{
    outcome: 'WRITTEN' | 'FAILED';
    outputDigest: string | null;
    failureCode: string | null;
    overwrite: boolean;
    manifestRevision: number;
  }>;
  readonly createdAtMs: number;
}

export class GateJournal {
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

  private read<T>(fn: (db: DatabaseSync) => T): T {
    return this.store.journal.read(fn);
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

  /** Read a prior idempotent response without writing (null when the key is unused). */
  priorIdempotentResponse<T>(scope: string, key: string, request: unknown): T | null {
    const requestDigest = digestValue('routespec.idempotent-request/1', request);
    return this.read((db) => {
      const prior = one(
        db,
        'SELECT request_digest, response_json FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?',
        scope,
        key,
      );
      if (!prior) return null;
      if (prior['request_digest'] !== requestDigest) {
        fail('RS_IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used for a different request.', {
          scope,
        });
      }
      return JSON.parse(s(prior, 'response_json')) as T;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Gate definitions.

  createGateDefinition(input: {
    projectId: string;
    name: string;
    corpusRevisionId: string;
    enforcementMode: EnforcementMode;
    buildAttestationPolicy: BuildAttestationPolicy;
    gateId?: string;
  }): { gateId: string; gateDefinitionRevisionId: string; created: boolean } {
    if (!(ENFORCEMENT_MODES as readonly string[]).includes(input.enforcementMode)) {
      fail(
        'RS_ENFORCEMENT_CLAIM_REJECTED',
        'Enforcement mode is outside LOCAL_ADVISORY|CI_CHECK|REQUIRED_CHECK_UNVERIFIED.',
      );
    }
    if (!BUILD_ATTESTATION_POLICIES.includes(input.buildAttestationPolicy)) {
      fail('RS_SCHEMA_INVALID', 'Build attestation policy is not recognized.');
    }
    if (!/^[\x20-\x7e]{1,128}$/.test(input.name))
      fail('RS_SCHEMA_INVALID', 'Gate name must be 1-128 printable characters.');
    const requiredPolicy = { source: 'CORPUS', buildAttestation: input.buildAttestationPolicy };
    const stalePolicy = { reusePriorDecision: 'NEVER' };
    const artifactPolicy = { formats: ['JSON', 'JUNIT', 'SARIF_SOURCE_LOCATABLE_ONLY'], bundle: 'OPTIONAL' };
    return this.tx('gate-definition.create', (db) => {
      if (!one(db, 'SELECT 1 AS x FROM projects WHERE project_id = ?', input.projectId)) {
        fail('RS_NOT_FOUND', 'Project not found.');
      }
      if (
        !one(db, 'SELECT 1 AS x FROM corpus_revisions WHERE corpus_revision_id = ?', input.corpusRevisionId)
      ) {
        fail('RS_NOT_FOUND', 'Corpus revision not found.');
      }
      let gateId = input.gateId ?? null;
      if (gateId !== null) {
        const latest = one(
          db,
          'SELECT * FROM gate_definitions WHERE gate_id = ? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1',
          gateId,
        );
        if (!latest) fail('RS_NOT_FOUND', 'Gate not found.');
        if (latest['project_id'] !== input.projectId)
          fail('RS_IDENTITY_MISMATCH', 'Gate belongs to another project.');
        if (
          latest['name'] === input.name &&
          latest['corpus_revision_id'] === input.corpusRevisionId &&
          latest['enforcement_mode'] === input.enforcementMode &&
          latest['required_invariant_policy_json'] === canonicalJson(requiredPolicy)
        ) {
          return {
            gateId,
            gateDefinitionRevisionId: s(latest, 'gate_definition_revision_id'),
            created: false,
          };
        }
      } else {
        gateId = randomUUID();
      }
      const gateDefinitionRevisionId = randomUUID();
      run(
        db,
        `INSERT INTO gate_definitions(gate_definition_revision_id, gate_id, project_id, name, corpus_revision_id,
           required_invariant_policy_json, stale_result_policy_json, artifact_policy_json, enforcement_mode, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        gateDefinitionRevisionId,
        gateId,
        input.projectId,
        input.name,
        input.corpusRevisionId,
        json(requiredPolicy),
        json(stalePolicy),
        json(artifactPolicy),
        input.enforcementMode,
        this.now(),
      );
      return { gateId, gateDefinitionRevisionId, created: true };
    });
  }

  private definitionView(row: Row): GateDefinitionView {
    const policy = JSON.parse(s(row, 'required_invariant_policy_json')) as { buildAttestation?: string };
    const buildAttestationPolicy = (policy.buildAttestation ??
      'ALLOW_USER_ASSERTED') as BuildAttestationPolicy;
    return {
      gateId: s(row, 'gate_id'),
      gateDefinitionRevisionId: s(row, 'gate_definition_revision_id'),
      projectId: s(row, 'project_id'),
      name: s(row, 'name'),
      corpusRevisionId: s(row, 'corpus_revision_id'),
      enforcementMode: s(row, 'enforcement_mode') as EnforcementMode,
      buildAttestationPolicy,
      createdAtMs: n(row, 'created_at_ms'),
    };
  }

  latestGateDefinition(gateId: string): GateDefinitionView {
    return this.read((db) => {
      const row = one(
        db,
        'SELECT * FROM gate_definitions WHERE gate_id = ? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1',
        gateId,
      );
      if (!row) fail('RS_NOT_FOUND', 'Gate not found.');
      return this.definitionView(row);
    });
  }

  getGateDefinitionRevision(gateDefinitionRevisionId: string): GateDefinitionView | null {
    return this.read((db) => {
      const row = one(
        db,
        'SELECT * FROM gate_definitions WHERE gate_definition_revision_id = ?',
        gateDefinitionRevisionId,
      );
      return row ? this.definitionView(row) : null;
    });
  }

  getBuildRevision(buildRevisionId: string): Row | null {
    return this.read(
      (db) => one(db, 'SELECT * FROM build_revisions WHERE build_revision_id = ?', buildRevisionId) ?? null,
    );
  }

  /** Read the registered records a gate run would bind, in one consistent read (null: absent). */
  readGateResolution(input: {
    buildRevisionId: string;
    effectManifestDigest: string;
    effectCoveragePolicyDigest: string;
    corpusRevisionId: string;
    callsiteInventoryDigest: string | null;
  }): {
    build: Row | null;
    integrationRevision: Row | null;
    manifest: Row | null;
    policy: Row | null;
    inventory: Row | null;
    corpusCases: Row[];
    scenarios: Row[];
    profiles: Row[];
  } {
    return this.read((db) => {
      const build =
        one(db, 'SELECT * FROM build_revisions WHERE build_revision_id = ?', input.buildRevisionId) ?? null;
      const integrationRevision = build
        ? (one(
            db,
            'SELECT * FROM integration_revisions WHERE integration_revision_id = ?',
            s(build, 'integration_revision_id'),
          ) ?? null)
        : null;
      const corpusCases = all(
        db,
        'SELECT * FROM corpus_cases WHERE corpus_revision_id = ? ORDER BY case_ordinal',
        input.corpusRevisionId,
      );
      return {
        build,
        integrationRevision,
        manifest:
          one(db, 'SELECT * FROM effect_manifests WHERE manifest_digest = ?', input.effectManifestDigest) ??
          null,
        policy:
          one(
            db,
            'SELECT * FROM effect_coverage_policies WHERE policy_digest = ?',
            input.effectCoveragePolicyDigest,
          ) ?? null,
        inventory:
          input.callsiteInventoryDigest === null
            ? null
            : (one(
                db,
                'SELECT * FROM effect_callsite_inventories WHERE inventory_digest = ?',
                input.callsiteInventoryDigest,
              ) ?? null),
        corpusCases,
        scenarios: corpusCases.flatMap((c) => {
          const r = one(
            db,
            'SELECT * FROM scenario_revisions WHERE scenario_revision_id = ?',
            s(c, 'scenario_revision_id'),
          );
          return r ? [r] : [];
        }),
        profiles: all(db, 'SELECT profile_id FROM protocol_profiles ORDER BY profile_id'),
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Gate snapshot and evaluation.

  readGateSnapshot(gateRunId: string): GateSnapshotRows {
    return this.read((db) => {
      const gateRun = one(db, 'SELECT * FROM gate_runs WHERE gate_run_id = ?', gateRunId);
      if (!gateRun) fail('RS_NOT_FOUND', 'Gate run not found.');
      const definitionId = sn(gateRun, 'gate_definition_revision_id');
      const definitionRow =
        definitionId === null
          ? undefined
          : one(db, 'SELECT * FROM gate_definitions WHERE gate_definition_revision_id = ?', definitionId);
      return {
        schemaVersion: this.store.schemaVersion,
        gateRun,
        definition: definitionRow ? this.definitionView(definitionRow) : null,
        // Each corpus case carries how its scenario revision may be used (M16, RP-08).
        corpusCases: all(
          db,
          'SELECT * FROM corpus_cases WHERE corpus_revision_id = ? ORDER BY case_ordinal',
          s(gateRun, 'corpus_revision_id'),
        ).map((c) =>
          this.store.schemaVersion >= 9
            ? { ...c, evidence_class: corpusEvidenceClassIn(db, s(c, 'scenario_revision_id')) }
            : c,
        ),
        caseRuns: all(db, 'SELECT * FROM case_runs WHERE gate_run_id = ? ORDER BY case_ordinal', gateRunId),
        caseResults: all(
          db,
          `SELECT r.* FROM case_results r JOIN case_runs c USING (case_run_id) WHERE c.gate_run_id = ?
            ORDER BY c.case_ordinal`,
          gateRunId,
        ),
        interruptions: all(
          db,
          `SELECT i.* FROM case_interruptions i JOIN case_runs c USING (case_run_id) WHERE c.gate_run_id = ?
            ORDER BY i.created_at_ms, i.interruption_id`,
          gateRunId,
        ),
        casePolicies:
          this.store.schemaVersion >= 8
            ? all(db, 'SELECT * FROM gate_run_case_policies WHERE gate_run_id = ? ORDER BY rowid', gateRunId)
            : [],
        buildAttestation:
          sn(gateRun, 'build_attestation_id') === null
            ? null
            : (one(
                db,
                `SELECT a.attestation_id, a.attestation_class, a.scope, a.build_revision_id,
                        a.principal_revocation_epoch, a.principal_policy_digest,
                        p.enabled AS principal_enabled,
                        p.revocation_epoch AS principal_current_revocation_epoch,
                        p.policy_digest AS principal_current_policy_digest
                   FROM subject_attestations a JOIN attester_principals p USING (principal_id)
                  WHERE a.attestation_id = ?`,
                sn(gateRun, 'build_attestation_id'),
              ) ?? null),
      };
    });
  }

  persistGateEvaluation(input: PersistGateEvaluationInput): { gateEvaluationId: string; created: boolean } {
    return this.tx('gate.persist-evaluation', (db) => {
      const gate = one(db, 'SELECT * FROM gate_runs WHERE gate_run_id = ?', input.gateRunId);
      if (!gate) fail('RS_NOT_FOUND', 'Gate run not found.');
      const existing = one(
        db,
        'SELECT gate_evaluation_id FROM gate_evaluations WHERE decision_digest = ?',
        input.decisionDigest,
      );
      if (existing) return { gateEvaluationId: s(existing, 'gate_evaluation_id'), created: false };
      if (gate['execution_lifecycle'] !== input.expected.gateLifecycle) {
        fail('RS_REVISION_CONFLICT', 'Gate run changed while it was being evaluated.');
      }
      const current = all(
        db,
        'SELECT * FROM case_runs WHERE gate_run_id = ? ORDER BY case_ordinal',
        input.gateRunId,
      );
      if (current.length !== input.expected.caseStates.length) {
        fail('RS_REVISION_CONFLICT', 'Gate case set changed while it was being evaluated.');
      }
      current.forEach((c, i) => {
        const e = input.expected.caseStates[i];
        if (
          !e ||
          e.caseRunId !== c['case_run_id'] ||
          e.lifecycle !== c['execution_lifecycle'] ||
          e.fencingEpoch !== c['fencing_epoch'] ||
          e.terminalResultDigest !== (c['terminal_result_digest'] ?? null)
        ) {
          fail('RS_REVISION_CONFLICT', 'A case run changed while the gate was being evaluated.');
        }
      });
      if (input.expected.buildAttester !== undefined) {
        const attestationId = sn(gate, 'build_attestation_id');
        const p =
          attestationId === null
            ? undefined
            : one(
                db,
                `SELECT p.enabled, p.revocation_epoch, p.policy_digest
                   FROM subject_attestations a JOIN attester_principals p USING (principal_id)
                  WHERE a.attestation_id = ?`,
                attestationId,
              );
        const e = input.expected.buildAttester;
        const same =
          e === null
            ? p === undefined
            : p !== undefined &&
              p['enabled'] === e.principalEnabled &&
              p['revocation_epoch'] === e.revocationEpoch &&
              p['policy_digest'] === e.policyDigest;
        if (!same)
          fail('RS_REVISION_CONFLICT', 'The build attester changed while the gate was being evaluated.');
      }
      const gateEvaluationId = randomUUID();
      const now = this.now();
      run(
        db,
        `INSERT INTO gate_evaluations(gate_evaluation_id, gate_run_id, gate_definition_revision_id, identity_json,
           case_result_digests_json, decision, findings_json, decision_digest, enforcement_mode, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        gateEvaluationId,
        input.gateRunId,
        input.gateDefinitionRevisionId,
        json(input.identity),
        json([...input.caseResultDigests]),
        input.decision,
        json([...input.findings]),
        input.decisionDigest,
        input.enforcementMode,
        now,
      );
      for (const c of input.cases) {
        run(
          db,
          `INSERT INTO gate_evaluation_cases(gate_evaluation_id, case_ordinal, case_run_id, required, lifecycle, case_verdict,
             result_digest, fencing_epoch, contribution, findings_json) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          gateEvaluationId,
          c.ordinal,
          c.caseRunId,
          c.required ? 1 : 0,
          c.lifecycle,
          c.caseVerdict,
          c.resultDigest,
          c.fencingEpoch,
          c.contribution,
          json([...c.findings]),
        );
      }
      run(
        db,
        `INSERT INTO gate_evaluation_digests(gate_evaluation_id, identity_digest, enforcement_digest, aggregator_revision, runtime_json)
         VALUES (?,?,?,?,?)`,
        gateEvaluationId,
        input.identityDigest,
        input.enforcementDigest,
        input.aggregatorRevision,
        json(input.runtime),
      );
      if (input.closeGateRun && gate['execution_lifecycle'] === 'RUNNING') {
        run(
          db,
          `UPDATE gate_runs SET execution_lifecycle = 'EVALUATING' WHERE gate_run_id = ?`,
          input.gateRunId,
        );
        run(
          db,
          `UPDATE gate_runs SET execution_lifecycle = 'COMPLETED', verdict = ?, closed_at_ms = ? WHERE gate_run_id = ?`,
          input.decision,
          now,
          input.gateRunId,
        );
      }
      return { gateEvaluationId, created: true };
    });
  }

  private evaluationView(db: DatabaseSync, row: Row): GateEvaluationView {
    const id = s(row, 'gate_evaluation_id');
    const digests = one(db, 'SELECT * FROM gate_evaluation_digests WHERE gate_evaluation_id = ?', id) as Row;
    const cases = all(
      db,
      'SELECT * FROM gate_evaluation_cases WHERE gate_evaluation_id = ? ORDER BY case_ordinal',
      id,
    ).map((c) => ({
      ordinal: n(c, 'case_ordinal'),
      caseRunId: sn(c, 'case_run_id'),
      required: c['required'] === 1,
      lifecycle: sn(c, 'lifecycle'),
      caseVerdict: sn(c, 'case_verdict') as Verdict | null,
      resultDigest: sn(c, 'result_digest'),
      fencingEpoch: typeof c['fencing_epoch'] === 'number' ? c['fencing_epoch'] : null,
      contribution: s(c, 'contribution') as Verdict,
      findings: JSON.parse(s(c, 'findings_json')) as string[],
    }));
    const manifests = all(
      db,
      'SELECT export_id, artifact_ready FROM artifact_manifests WHERE gate_evaluation_id = ? ORDER BY created_at_ms, export_id',
      id,
    );
    return {
      gateEvaluationId: id,
      gateRunId: s(row, 'gate_run_id'),
      gateDefinitionRevisionId: sn(row, 'gate_definition_revision_id'),
      identity: JSON.parse(s(row, 'identity_json')) as Record<string, unknown>,
      identityDigest: s(digests, 'identity_digest'),
      caseResultDigests: JSON.parse(s(row, 'case_result_digests_json')) as string[],
      decision: s(row, 'decision') as Verdict,
      findings: JSON.parse(s(row, 'findings_json')) as string[],
      decisionDigest: s(row, 'decision_digest'),
      enforcementMode: s(row, 'enforcement_mode') as EnforcementMode,
      enforcementDigest: s(digests, 'enforcement_digest'),
      aggregatorRevision: s(digests, 'aggregator_revision'),
      runtime: JSON.parse(s(digests, 'runtime_json')) as Record<string, unknown>,
      createdAtMs: n(row, 'created_at_ms'),
      cases,
      artifactReady: manifests.some((m) => m['artifact_ready'] === 1),
      exportIds: manifests.map((m) => s(m, 'export_id')),
    };
  }

  getGateEvaluation(gateEvaluationId: string): GateEvaluationView {
    return this.read((db) => {
      const row = one(db, 'SELECT * FROM gate_evaluations WHERE gate_evaluation_id = ?', gateEvaluationId);
      if (!row) fail('RS_NOT_FOUND', 'Gate evaluation not found.');
      return this.evaluationView(db, row);
    });
  }

  listGateEvaluations(gateRunId: string): GateEvaluationView[] {
    return this.read((db) =>
      all(
        db,
        'SELECT * FROM gate_evaluations WHERE gate_run_id = ? ORDER BY created_at_ms, rowid',
        gateRunId,
      ).map((r) => this.evaluationView(db, r)),
    );
  }

  /** Record that a case's evaluation was interrupted (runner restart / expired lease). */
  recordCaseInterruption(input: {
    caseRunId: string;
    fencingEpoch: number;
    kind: 'LEASE_EXPIRED' | 'RUNNER_RESTART' | 'RECOVERY_PENDING';
  }): { interruptionId: string } {
    return this.tx('case.record-interruption', (db) => {
      if (!one(db, 'SELECT 1 AS x FROM case_runs WHERE case_run_id = ?', input.caseRunId)) {
        fail('RS_NOT_FOUND', 'Case run not found.');
      }
      const interruptionId = randomUUID();
      run(
        db,
        'INSERT INTO case_interruptions(interruption_id, case_run_id, fencing_epoch, kind, created_at_ms) VALUES (?,?,?,?,?)',
        interruptionId,
        input.caseRunId,
        input.fencingEpoch,
        input.kind,
        this.now(),
      );
      return { interruptionId };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Export plans and writes.

  createExportPlan(input: {
    gateEvaluationId: string;
    idempotencyKey: string;
    planDigest: string;
    bundleDigest: string | null;
    bundleBytes: number | null;
    options: Record<string, unknown>;
    findings: readonly ExportFindingRecord[];
    entries: readonly ExportEntryRecord[];
    exclusions: readonly string[];
    attachments: ReadonlyArray<{ name: string; content: string }> | null;
    blocked: boolean;
    privacyScanResult: 'CLEAN' | 'BLOCKED' | 'ADDRESSES_ACKNOWLEDGED';
  }): { exportId: string; created: boolean } {
    if (input.blocked !== (input.bundleDigest === null) || (input.blocked && input.attachments !== null)) {
      fail('RS_SCHEMA_INVALID', 'A blocked export plan must not carry bundle content.');
    }
    const request = {
      gateEvaluationId: input.gateEvaluationId,
      planDigest: input.planDigest,
    };
    return this.tx('export.plan', (db) =>
      this.idempotent(db, 'export.plan', input.idempotencyKey, request, () => {
        if (
          !one(db, 'SELECT 1 AS x FROM gate_evaluations WHERE gate_evaluation_id = ?', input.gateEvaluationId)
        ) {
          fail('RS_NOT_FOUND', 'Gate evaluation not found.');
        }
        const prior = one(db, 'SELECT export_id FROM export_plans WHERE plan_digest = ?', input.planDigest);
        if (prior) return { exportId: s(prior, 'export_id'), created: false };
        const exportId = randomUUID();
        const now = this.now();
        run(
          db,
          `INSERT INTO artifact_manifests(export_id, gate_evaluation_id, session_id, inclusion_policy_json, privacy_scan_result,
             included_digests_json, exclusions_json, artifact_ready, output_digest, retained_path, revision, created_at_ms)
           VALUES (?,?,NULL,?,?,?,?,0,NULL,NULL,1,?)`,
          exportId,
          input.gateEvaluationId,
          json(input.options),
          input.privacyScanResult,
          json(input.entries.map((e) => ({ path: e.path, digest: e.digest }))),
          json([...input.exclusions]),
          now,
        );
        run(
          db,
          `INSERT INTO export_plans(export_id, gate_evaluation_id, plan_digest, bundle_digest, bundle_bytes, options_json,
             findings_json, entries_json, attachments_json, blocked, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          exportId,
          input.gateEvaluationId,
          input.planDigest,
          input.bundleDigest,
          input.bundleBytes,
          json(input.options),
          json(input.findings.map((f) => ({ ...f }))),
          json(input.entries.map((e) => ({ ...e }))),
          input.attachments === null ? null : json(input.attachments.map((a) => ({ ...a }))),
          input.blocked ? 1 : 0,
          now,
        );
        return { exportId, created: true };
      }),
    );
  }

  getExportPlan(exportId: string): ExportPlanView {
    return this.read((db) => {
      const m = one(db, 'SELECT * FROM artifact_manifests WHERE export_id = ?', exportId);
      const p = one(db, 'SELECT * FROM export_plans WHERE export_id = ?', exportId);
      if (!m || !p) fail('RS_NOT_FOUND', 'Export not found.');
      return {
        exportId,
        gateEvaluationId: s(p, 'gate_evaluation_id'),
        planDigest: s(p, 'plan_digest'),
        bundleDigest: sn(p, 'bundle_digest'),
        bundleBytes: typeof p['bundle_bytes'] === 'number' ? p['bundle_bytes'] : null,
        blocked: p['blocked'] === 1,
        privacyScanResult: s(m, 'privacy_scan_result'),
        options: JSON.parse(s(p, 'options_json')) as Record<string, unknown>,
        findings: JSON.parse(s(p, 'findings_json')) as ExportFindingRecord[],
        entries: JSON.parse(s(p, 'entries_json')) as ExportEntryRecord[],
        exclusions: JSON.parse(s(m, 'exclusions_json')) as string[],
        attachments:
          p['attachments_json'] === null
            ? null
            : (JSON.parse(s(p, 'attachments_json')) as Array<{ name: string; content: string }>),
        revision: n(m, 'revision'),
        artifactReady: m['artifact_ready'] === 1,
        outputDigest: sn(m, 'output_digest'),
        retainedPath: sn(m, 'retained_path'),
        writes: all(
          db,
          'SELECT * FROM export_writes WHERE export_id = ? ORDER BY manifest_revision',
          exportId,
        ).map((w) => ({
          outcome: s(w, 'outcome') as 'WRITTEN' | 'FAILED',
          outputDigest: sn(w, 'output_digest'),
          failureCode: sn(w, 'failure_code'),
          overwrite: w['overwrite'] === 1,
          manifestRevision: n(w, 'manifest_revision'),
        })),
        createdAtMs: n(m, 'created_at_ms'),
      };
    });
  }

  /**
   * Record one export write attempt (administrative mutation: idempotency + expected revision).
   * Success sets `artifact_ready = 1`; failure sets it to 0. The gate decision is never touched.
   */
  recordExportWrite(input: {
    exportId: string;
    expectedRevision: number;
    idempotencyKey: string;
    outcome: 'WRITTEN' | 'FAILED';
    outputDigest: string | null;
    failureCode: string | null;
    overwrite: boolean;
    retainedPath: string | null;
  }): { revision: number; artifactReady: boolean } {
    const request = { ...input };
    return this.tx('export.write', (db) =>
      this.idempotent(db, 'export.write', input.idempotencyKey, request, () => {
        const m = one(db, 'SELECT * FROM artifact_manifests WHERE export_id = ?', input.exportId);
        const p = one(db, 'SELECT * FROM export_plans WHERE export_id = ?', input.exportId);
        if (!m || !p) fail('RS_NOT_FOUND', 'Export not found.');
        if (p['blocked'] === 1)
          fail('RS_EXPORT_BLOCKED', 'Export privacy scan blocked this plan; nothing is written.');
        if (n(m, 'revision') !== input.expectedRevision) {
          fail('RS_REVISION_CONFLICT', 'Export revision changed; re-read the plan.', {
            expected: input.expectedRevision,
            current: n(m, 'revision'),
          });
        }
        const revision = input.expectedRevision + 1;
        const ready = input.outcome === 'WRITTEN';
        run(
          db,
          `UPDATE artifact_manifests SET artifact_ready = ?, output_digest = ?, retained_path = ?, revision = ?
            WHERE export_id = ?`,
          ready ? 1 : 0,
          ready ? input.outputDigest : null,
          ready ? input.retainedPath : null,
          revision,
          input.exportId,
        );
        run(
          db,
          `INSERT INTO export_writes(write_id, export_id, outcome, output_digest, failure_code, overwrite, manifest_revision, created_at_ms)
           VALUES (?,?,?,?,?,?,?,?)`,
          randomUUID(),
          input.exportId,
          input.outcome,
          ready ? input.outputDigest : null,
          ready ? null : input.failureCode,
          input.overwrite ? 1 : 0,
          revision,
          this.now(),
        );
        run(
          db,
          'INSERT INTO audit_events(audit_id, action_code, subject_kind, subject_id, details_json, created_at_ms) VALUES (?,?,?,?,?,?)',
          randomUUID(),
          'EXPORT_WRITE',
          'export',
          input.exportId,
          json({ outcome: input.outcome, overwrite: input.overwrite, revision }),
          this.now(),
        );
        return { revision, artifactReady: ready };
      }),
    );
  }
}
