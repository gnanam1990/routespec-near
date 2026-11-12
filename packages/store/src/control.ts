/**
 * Control-plane repositories for the loopback control API (M08).
 *
 * - Idempotency: a PENDING marker is committed before a control mutation and replaced with the
 *   safe response afterwards. A replay of the same key and body returns the stored response; a
 *   changed body is `RS_IDEMPOTENCY_KEY_REUSED`; a PENDING marker means the earlier outcome is
 *   unknown and is never re-executed (`RS_IDEMPOTENCY_IN_PROGRESS`).
 * - Project scoping: content-addressed global records are bound to projects through
 *   `project_records`; every control read checks the binding.
 * - Attestation: attester principals, single-use local confirmations, single-use launcher
 *   challenges and their immutable outcomes. Completion consumes the challenge and records
 *   exactly one outcome in the same transaction, so a replay or a concurrent second completion
 *   fails closed. A successful completion creates a new immutable `subject_attestations` row and
 *   never updates a build revision or gate run.
 * - Session event paging by sequence for stable cursor pagination.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  RouteSpecError,
  canonicalJson,
  digestValue,
  type Digest,
  type ErrorCode,
} from '@routespec/contracts';
import { assertNoSecrets } from './guards.ts';
import type { RouteSpecStore } from './store.ts';

type Row = Record<string, unknown>;
type Param = string | number | null;

export const PROJECT_RECORD_KINDS = Object.freeze([
  'SCENARIO_REVISION',
  'CORPUS_REVISION',
  'EFFECT_MANIFEST',
  'EFFECT_POLICY',
  'CALLSITE_INVENTORY',
  'INTERCEPTOR_PROFILE',
  'ATTESTER_PRINCIPAL',
  'GATE_DEFINITION',
] as const);
export type ProjectRecordKind = (typeof PROJECT_RECORD_KINDS)[number];

export const CHALLENGE_SCOPES = Object.freeze([
  'BUILD_REGISTRATION',
  'CASE_LAUNCH',
  'EFFECT_INVENTORY',
  'EFFECT_INTERCEPTOR_LAUNCH',
] as const);
export type ChallengeScope = (typeof CHALLENGE_SCOPES)[number];
export type AttesterKind = 'LOCAL_LAUNCHER_KEY' | 'CI_OIDC';

function fail(
  code: ErrorCode,
  message: string,
  details?: Record<string, string | number | boolean | null>,
): never {
  throw new RouteSpecError(code, message, details ? { details } : undefined);
}

function one(db: DatabaseSync, sql: string, ...params: Param[]): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined;
}

function all(db: DatabaseSync, sql: string, ...params: Param[]): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

function run(db: DatabaseSync, sql: string, ...params: Param[]): number {
  return Number(db.prepare(sql).run(...params).changes);
}

function json(value: unknown, path = '$'): string {
  assertNoSecrets(value, path);
  return canonicalJson(value);
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

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

export type IdempotencyStart =
  | { readonly state: 'NEW' }
  | { readonly state: 'REPLAY'; readonly status: number; readonly body: unknown };

export interface ChallengeContext {
  readonly challenge: Row;
  readonly binding: Record<string, unknown>;
  readonly principal: Row;
  readonly policy: Record<string, unknown>;
  readonly nowMs: number;
}

export type ChallengeVerdict =
  | {
      readonly ok: true;
      readonly attestationClass: 'TRUSTED_LAUNCHER' | 'CI_ATTESTED';
      readonly observedDigests: readonly string[];
      readonly verifiedClaimsDigest: string;
    }
  | { readonly ok: false; readonly reasonCode: string };

export interface ChallengeOutcome {
  readonly challengeId: string;
  readonly scope: ChallengeScope;
  readonly outcome: 'ATTESTED' | 'REJECTED';
  readonly reasonCode: string | null;
  readonly attestationId: string | null;
  readonly attestationClass: 'TRUSTED_LAUNCHER' | 'CI_ATTESTED' | null;
  readonly attestationDigest: string | null;
  readonly expiresAtMs: number | null;
}

export interface SessionEventFilters {
  readonly runOperationId?: string;
  readonly eventKind?: string;
  readonly phase?: string;
  readonly logicalJobDigest?: string;
  readonly fromSequence?: number;
  readonly toSequence?: number;
}

export class ControlJournal {
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

  // -------------------------------------------------------------------------------------------
  // Idempotency.

  beginIdempotent(scope: string, key: string, request: unknown): IdempotencyStart {
    if (!IDEMPOTENCY_KEY.test(key))
      fail('RS_SCHEMA_INVALID', 'Idempotency-Key must be 8-128 safe characters.');
    const requestDigest = digestValue('routespec.control-request/1', request);
    return this.tx('control.idempotency.begin', (db) => {
      const prior = one(
        db,
        'SELECT * FROM control_idempotency WHERE scope = ? AND idempotency_key = ?',
        scope,
        key,
      );
      if (prior) {
        if (prior['request_digest'] !== requestDigest) {
          fail('RS_IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used for a different request.');
        }
        if (prior['state'] !== 'COMPLETE') {
          fail(
            'RS_IDEMPOTENCY_IN_PROGRESS',
            'The earlier request with this Idempotency-Key has an unknown outcome; inspect the records instead of resending.',
          );
        }
        return {
          state: 'REPLAY' as const,
          status: n(prior, 'status_code'),
          body: JSON.parse(s(prior, 'response_json')) as unknown,
        };
      }
      run(
        db,
        `INSERT INTO control_idempotency(scope, idempotency_key, request_digest, state, created_at_ms) VALUES (?,?,?,'PENDING',?)`,
        scope,
        key,
        requestDigest,
        this.now(),
      );
      return { state: 'NEW' as const };
    });
  }

  completeIdempotent(scope: string, key: string, status: number, body: unknown): void {
    this.tx('control.idempotency.complete', (db) => {
      const changed = run(
        db,
        `UPDATE control_idempotency SET state = 'COMPLETE', status_code = ?, response_json = ?, completed_at_ms = ?
          WHERE scope = ? AND idempotency_key = ? AND state = 'PENDING'`,
        status,
        json(body, '$.response'),
        this.now(),
        scope,
        key,
      );
      if (changed !== 1) fail('RS_INTERNAL', 'Idempotency record is not pending.');
    });
  }

  /** The mutation failed atomically before any effect: release the key for a corrected retry. */
  abandonIdempotent(scope: string, key: string): void {
    this.tx('control.idempotency.abandon', (db) => {
      run(
        db,
        `DELETE FROM control_idempotency WHERE scope = ? AND idempotency_key = ? AND state = 'PENDING'`,
        scope,
        key,
      );
    });
  }

  // -------------------------------------------------------------------------------------------
  // Project scoping and listings.

  scopeRecord(projectId: string, kind: ProjectRecordKind, recordId: string): void {
    this.tx('control.scope', (db) => {
      if (!one(db, 'SELECT 1 AS x FROM projects WHERE project_id = ?', projectId)) {
        fail('RS_NOT_FOUND', 'Project not found.');
      }
      run(
        db,
        'INSERT OR IGNORE INTO project_records(project_id, record_kind, record_id, created_at_ms) VALUES (?,?,?,?)',
        projectId,
        kind,
        recordId,
        this.now(),
      );
    });
  }

  inProject(projectId: string, kind: ProjectRecordKind, recordId: string): boolean {
    return this.read(
      (db) =>
        one(
          db,
          'SELECT 1 AS x FROM project_records WHERE project_id = ? AND record_kind = ? AND record_id = ?',
          projectId,
          kind,
          recordId,
        ) !== undefined,
    );
  }

  getProject(projectId: string): Row | undefined {
    return this.read((db) => one(db, 'SELECT * FROM projects WHERE project_id = ?', projectId));
  }

  /**
   * Keyset listings use SQLite's rowid: rows are only ever appended by the single serialized
   * writer and never deleted, so rowid order is commit order and a row committed after a page
   * was read always sorts after that page.
   */
  listProjects(afterRowid: number, limit: number): Row[] {
    return this.read((db) =>
      all(
        db,
        'SELECT rowid AS _rowid, * FROM projects WHERE deleted_at_ms IS NULL AND rowid > ? ORDER BY rowid LIMIT ?',
        afterRowid,
        limit,
      ),
    );
  }

  countRows(sql: string, ...params: Param[]): number {
    return this.read((db) => n(one(db, sql, ...params) as Row, 'n'));
  }

  listRevisions(projectId: string, afterRowid: number, limit: number): Row[] {
    return this.read((db) =>
      all(
        db,
        'SELECT rowid AS _rowid, * FROM integration_revisions WHERE project_id = ? AND rowid > ? ORDER BY rowid LIMIT ?',
        projectId,
        afterRowid,
        limit,
      ),
    );
  }

  getRevision(revisionId: string): Row | undefined {
    return this.read((db) =>
      one(db, 'SELECT * FROM integration_revisions WHERE integration_revision_id = ?', revisionId),
    );
  }

  getBuild(buildRevisionId: string): Row | undefined {
    return this.read((db) =>
      one(db, 'SELECT * FROM build_revisions WHERE build_revision_id = ?', buildRevisionId),
    );
  }

  listBuilds(projectId: string, afterRowid: number, limit: number): Row[] {
    return this.read((db) =>
      all(
        db,
        'SELECT rowid AS _rowid, * FROM build_revisions WHERE project_id = ? AND rowid > ? ORDER BY rowid LIMIT ?',
        projectId,
        afterRowid,
        limit,
      ),
    );
  }

  getManifestByDigest(digest: string): Row | undefined {
    return this.read((db) => one(db, 'SELECT * FROM effect_manifests WHERE manifest_digest = ?', digest));
  }

  getPolicyByDigest(digest: string): Row | undefined {
    return this.read((db) =>
      one(db, 'SELECT * FROM effect_coverage_policies WHERE policy_digest = ?', digest),
    );
  }

  getInventoryByDigest(digest: string): Row | undefined {
    return this.read((db) =>
      one(db, 'SELECT * FROM effect_callsite_inventories WHERE inventory_digest = ?', digest),
    );
  }

  listGateRuns(projectId: string, afterRowid: number, limit: number): Row[] {
    return this.read((db) =>
      all(
        db,
        'SELECT rowid AS _rowid, * FROM gate_runs WHERE project_id = ? AND rowid > ? ORDER BY rowid LIMIT ?',
        projectId,
        afterRowid,
        limit,
      ),
    );
  }

  latestGateEvaluation(gateRunId: string): Row | undefined {
    return this.read((db) =>
      one(
        db,
        `SELECT e.* FROM gate_evaluations e
          WHERE e.gate_run_id = ? ORDER BY e.created_at_ms DESC, e.gate_evaluation_id DESC LIMIT 1`,
        gateRunId,
      ),
    );
  }

  caseRunsOf(gateRunId: string): Row[] {
    return this.read((db) =>
      all(db, 'SELECT * FROM case_runs WHERE gate_run_id = ? ORDER BY case_ordinal', gateRunId),
    );
  }

  caseRunsPage(gateRunId: string, afterOrdinal: number, limit: number): Row[] {
    return this.read((db) =>
      all(
        db,
        'SELECT * FROM case_runs WHERE gate_run_id = ? AND case_ordinal > ? ORDER BY case_ordinal LIMIT ?',
        gateRunId,
        afterOrdinal,
        limit,
      ),
    );
  }

  corpusCase(corpusRevisionId: string, ordinal: number): Row | undefined {
    return this.read((db) =>
      one(
        db,
        'SELECT * FROM corpus_cases WHERE corpus_revision_id = ? AND case_ordinal = ?',
        corpusRevisionId,
        ordinal,
      ),
    );
  }

  getCorpus(corpusRevisionId: string): Row | undefined {
    return this.read((db) =>
      one(db, 'SELECT * FROM corpus_revisions WHERE corpus_revision_id = ?', corpusRevisionId),
    );
  }

  tokenStateFor(
    caseRunId: string,
    nowMs: number,
  ): { state: string; purpose: string | null; expiresAtMs: number | null } {
    return this.read((db) => {
      const t = one(
        db,
        `SELECT t.*, (SELECT 1 FROM token_revocations r WHERE r.token_digest = t.token_digest) AS revoked
           FROM case_tokens t WHERE t.case_run_id = ? ORDER BY t.issued_at_ms DESC, t.token_digest DESC LIMIT 1`,
        caseRunId,
      );
      if (!t) return { state: 'NOT_ISSUED', purpose: null, expiresAtMs: null };
      const expiresAtMs = n(t, 'expires_at_ms');
      const state = t['revoked'] === 1 ? 'REVOKED' : nowMs >= expiresAtMs ? 'EXPIRED' : 'ACTIVE';
      return { state, purpose: s(t, 'purpose'), expiresAtMs };
    });
  }

  teardownRecorded(caseRunId: string): boolean {
    return this.read((db) => {
      const row = one(
        db,
        `SELECT count(*) AS n FROM evidence_items WHERE case_run_id = ? AND source_kind = 'SCENARIO_RUNTIME'`,
        caseRunId,
      );
      return row !== undefined && n(row, 'n') > 0;
    });
  }

  setGateRunMode(gateRunId: string, mode: 'SIMULATE' | 'REPLAY'): void {
    this.tx('control.gate-run-mode', (db) => {
      run(
        db,
        'INSERT INTO gate_run_settings(gate_run_id, mode, created_at_ms) VALUES (?,?,?)',
        gateRunId,
        mode,
        this.now(),
      );
    });
  }

  gateRunMode(gateRunId: string): 'SIMULATE' | 'REPLAY' | null {
    return this.read((db) => {
      const row = one(db, 'SELECT mode FROM gate_run_settings WHERE gate_run_id = ?', gateRunId);
      return row ? (s(row, 'mode') as 'SIMULATE' | 'REPLAY') : null;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Interceptor profiles (declared, never reviewed by registration).

  registerInterceptorProfile(input: {
    projectId: string;
    interceptorArtifactDigest: string;
    containment: 'PROCESS_TREE_ENFORCED' | 'DECLARED_HOOKS_ONLY';
    processTreeScope: string;
    supportedSinks: readonly string[];
    denialMechanism: 'DENY' | 'CANARY_REDIRECT';
  }): { profileId: string; profileDigest: Digest; created: boolean } {
    const body = {
      interceptorArtifactDigest: input.interceptorArtifactDigest,
      containment: input.containment,
      processTreeScope: input.processTreeScope,
      supportedSinks: [...new Set(input.supportedSinks)].sort(),
      denialMechanism: input.denialMechanism,
    };
    const profileDigest = digestValue('routespec.interceptor-profile/1', body);
    return this.tx('control.interceptor-profile', (db) => {
      const existing = one(
        db,
        'SELECT profile_id FROM interceptor_profiles WHERE project_id = ? AND profile_digest = ?',
        input.projectId,
        profileDigest,
      );
      if (existing) return { profileId: s(existing, 'profile_id'), profileDigest, created: false };
      const profileId = randomUUID();
      run(
        db,
        `INSERT INTO interceptor_profiles(profile_id, project_id, profile_digest, interceptor_artifact_digest, containment,
           process_tree_scope, supported_sinks_json, denial_mechanism, review_state, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,'DECLARED_UNREVIEWED',?)`,
        profileId,
        input.projectId,
        profileDigest,
        body.interceptorArtifactDigest,
        body.containment,
        body.processTreeScope,
        json(body.supportedSinks),
        body.denialMechanism,
        this.now(),
      );
      run(
        db,
        `INSERT OR IGNORE INTO project_records(project_id, record_kind, record_id, created_at_ms) VALUES (?, 'INTERCEPTOR_PROFILE', ?, ?)`,
        input.projectId,
        profileDigest,
        this.now(),
      );
      return { profileId, profileDigest, created: true };
    });
  }

  getInterceptorProfile(projectId: string, profileDigest: string): Row | undefined {
    return this.read((db) =>
      one(
        db,
        'SELECT * FROM interceptor_profiles WHERE project_id = ? AND profile_digest = ?',
        projectId,
        profileDigest,
      ),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Single-use local confirmations (out-of-band; only the code digest persists).

  issueConfirmation(input: { actionCode: string; planDigest: string; ttlMs: number }): {
    confirmationId: string;
    code: string;
    expiresAtMs: number;
  } {
    const confirmationId = randomUUID();
    const code = randomBytes(18).toString('base64url');
    const now = this.now();
    const expiresAtMs = now + input.ttlMs;
    this.tx('control.confirmation.issue', (db) => {
      run(
        db,
        `INSERT INTO local_confirmations(confirmation_id, action_code, plan_digest, code_digest, issued_at_ms, expires_at_ms)
         VALUES (?,?,?,?,?,?)`,
        confirmationId,
        input.actionCode,
        input.planDigest,
        `sha256:${sha256(`routespec.local-confirmation/1\n${code}`)}`,
        now,
        expiresAtMs,
      );
    });
    return { confirmationId, code, expiresAtMs };
  }

  /** Consume a confirmation inside the caller's transaction (also used by profile reviews). */
  consumeConfirmation(
    db: DatabaseSync,
    input: { confirmationId: string; code: string; actionCode: string; planDigest: string },
  ): void {
    const row = one(db, 'SELECT * FROM local_confirmations WHERE confirmation_id = ?', input.confirmationId);
    const codeDigest = `sha256:${sha256(`routespec.local-confirmation/1\n${input.code}`)}`;
    if (
      !row ||
      row['consumed_at_ms'] !== null ||
      n(row, 'expires_at_ms') <= this.now() ||
      row['action_code'] !== input.actionCode ||
      row['plan_digest'] !== input.planDigest ||
      !sameSecret(s(row, 'code_digest'), codeDigest)
    ) {
      fail(
        'RS_LOCAL_CONFIRMATION_INVALID',
        'The local confirmation is missing, expired, used, or for another plan.',
      );
    }
    run(
      db,
      'UPDATE local_confirmations SET consumed_at_ms = ? WHERE confirmation_id = ? AND consumed_at_ms IS NULL',
      this.now(),
      input.confirmationId,
    );
  }

  /** Consume a confirmation on its own (for actions whose effect happens elsewhere). */
  confirm(input: { confirmationId: string; code: string; actionCode: string; planDigest: string }): void {
    this.tx('control.confirmation.consume', (db) => this.consumeConfirmation(db, input));
  }

  // -------------------------------------------------------------------------------------------
  // Attester principals.

  enrollPrincipal(input: {
    projectId: string;
    label: string;
    kind: AttesterKind;
    policy: Record<string, unknown>;
    keyOrIssuerPolicyDigest: string;
    claimPolicyDigest: string;
    audience: string | null;
    maxFreshnessMs: number;
    validFromMs: number;
    validUntilMs: number;
    confirmation: { confirmationId: string; code: string; planDigest: string };
  }): { principalId: string; policyDigest: Digest; revocationEpoch: number } {
    const policyDigest = digestValue('routespec.attester-policy/1', {
      kind: input.kind,
      policy: input.policy,
    });
    if (policyDigest !== input.confirmation.planDigest) {
      fail('RS_LOCAL_CONFIRMATION_INVALID', 'The confirmation was issued for a different enrollment plan.');
    }
    return this.tx('control.attester.enroll', (db) => {
      if (!one(db, 'SELECT 1 AS x FROM projects WHERE project_id = ?', input.projectId)) {
        fail('RS_NOT_FOUND', 'Project not found.');
      }
      this.consumeConfirmation(db, { ...input.confirmation, actionCode: 'ATTESTER_ENROLL' });
      // A launcher key is the operator's key: it can never also be an enrolled reviewer key.
      const x =
        input.kind === 'LOCAL_LAUNCHER_KEY' ? (input.policy['publicKeyJwk'] as { x?: unknown })?.x : null;
      if (
        typeof x === 'string' &&
        one(db, 'SELECT 1 AS x FROM profile_reviewers WHERE public_key_x = ?', x)
      ) {
        fail('RS_REVIEWER_NOT_INDEPENDENT', 'This key is enrolled as a profile reviewer key.');
      }
      const principalId = randomUUID();
      const now = this.now();
      run(
        db,
        `INSERT INTO attester_principals(principal_id, kind, key_or_issuer_policy_digest, audience, claim_policy_digest,
           max_freshness_ms, policy_digest, enabled, revocation_epoch, valid_from_ms, valid_until_ms, enrolled_at_ms)
         VALUES (?,?,?,?,?,?,?,1,0,?,?,?)`,
        principalId,
        input.kind,
        input.keyOrIssuerPolicyDigest,
        input.audience,
        input.claimPolicyDigest,
        input.maxFreshnessMs,
        policyDigest,
        input.validFromMs,
        input.validUntilMs,
        now,
      );
      run(
        db,
        `INSERT INTO attester_policies(principal_id, project_id, label, policy_json, policy_digest, confirmation_id)
         VALUES (?,?,?,?,?,?)`,
        principalId,
        input.projectId,
        input.label,
        json(input.policy, '$.policy'),
        policyDigest,
        input.confirmation.confirmationId,
      );
      run(
        db,
        `INSERT INTO project_records(project_id, record_kind, record_id, created_at_ms) VALUES (?, 'ATTESTER_PRINCIPAL', ?, ?)`,
        input.projectId,
        principalId,
        now,
      );
      this.auditIn(db, 'ATTESTER_ENROLLED', 'attester_principal', principalId, { kind: input.kind });
      return { principalId, policyDigest, revocationEpoch: 0 };
    });
  }

  revokePrincipal(input: {
    principalId: string;
    reasonCode: string;
    confirmation: { confirmationId: string; code: string; planDigest: string };
  }): { principalId: string; revocationEpoch: number; enabled: false } {
    return this.tx('control.attester.revoke', (db) => {
      const p = one(db, 'SELECT * FROM attester_principals WHERE principal_id = ?', input.principalId);
      if (!p) fail('RS_NOT_FOUND', 'Attester principal not found.');
      this.consumeConfirmation(db, { ...input.confirmation, actionCode: 'ATTESTER_REVOKE' });
      const epoch = n(p, 'revocation_epoch') + 1;
      run(
        db,
        'UPDATE attester_principals SET enabled = 0, revocation_epoch = ? WHERE principal_id = ?',
        epoch,
        input.principalId,
      );
      run(
        db,
        `INSERT INTO attester_revocations(revocation_id, principal_id, revocation_epoch, reason_code, revoked_at_ms) VALUES (?,?,?,?,?)`,
        randomUUID(),
        input.principalId,
        epoch,
        input.reasonCode,
        this.now(),
      );
      this.auditIn(db, 'ATTESTER_REVOKED', 'attester_principal', input.principalId, {
        reasonCode: input.reasonCode,
        revocationEpoch: epoch,
      });
      return { principalId: input.principalId, revocationEpoch: epoch, enabled: false as const };
    });
  }

  getPrincipal(
    principalId: string,
  ): { principal: Row; policy: Record<string, unknown>; projectId: string; label: string } | null {
    return this.read((db) => {
      const p = one(db, 'SELECT * FROM attester_principals WHERE principal_id = ?', principalId);
      const pol = one(db, 'SELECT * FROM attester_policies WHERE principal_id = ?', principalId);
      if (!p || !pol) return null;
      return {
        principal: p,
        policy: JSON.parse(s(pol, 'policy_json')) as Record<string, unknown>,
        projectId: s(pol, 'project_id'),
        label: s(pol, 'label'),
      };
    });
  }

  listPrincipals(projectId: string): Row[] {
    return this.read((db) =>
      all(
        db,
        `SELECT p.*, a.label FROM attester_principals p JOIN attester_policies a USING (principal_id)
          WHERE a.project_id = ? ORDER BY p.enrolled_at_ms, p.principal_id`,
        projectId,
      ),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Launcher challenges.

  createChallenge(input: {
    projectId: string;
    scope: ChallengeScope;
    principalId: string;
    binding: Record<string, unknown>;
    ttlMs: number;
  }): { challengeId: string; nonce: string; expiresAtMs: number; bindingDigest: Digest } {
    const bindingDigest = digestValue('routespec.challenge-binding/1', {
      scope: input.scope,
      ...input.binding,
    });
    const nonce = randomBytes(32).toString('base64url');
    const nonceDigest = `sha256:${sha256(`routespec.challenge-nonce/1\n${nonce}`)}`;
    return this.tx('control.challenge.create', (db) => {
      const p = one(db, 'SELECT * FROM attester_principals WHERE principal_id = ?', input.principalId);
      const pol = one(
        db,
        'SELECT project_id FROM attester_policies WHERE principal_id = ?',
        input.principalId,
      );
      if (!p || !pol || pol['project_id'] !== input.projectId)
        fail('RS_NOT_FOUND', 'Attester principal not found.');
      const now = this.now();
      if (p['enabled'] !== 1 || n(p, 'valid_from_ms') > now || n(p, 'valid_until_ms') <= now) {
        fail(
          'RS_ATTESTER_UNAVAILABLE',
          'The attester principal is disabled, revoked, or outside its validity window.',
        );
      }
      const challengeId = randomUUID();
      const expiresAtMs = Math.min(now + input.ttlMs, n(p, 'valid_until_ms'));
      run(
        db,
        `INSERT INTO launcher_challenges(challenge_id, scope, principal_id, principal_policy_digest, principal_revocation_epoch,
           nonce_digest, binding_digest, issued_at_ms, expires_at_ms) VALUES (?,?,?,?,?,?,?,?,?)`,
        challengeId,
        input.scope,
        input.principalId,
        s(p, 'policy_digest'),
        n(p, 'revocation_epoch'),
        nonceDigest,
        bindingDigest,
        now,
        expiresAtMs,
      );
      run(
        db,
        'INSERT INTO challenge_bindings(challenge_id, project_id, binding_json) VALUES (?,?,?)',
        challengeId,
        input.projectId,
        json(input.binding, '$.binding'),
      );
      return { challengeId, nonce, expiresAtMs, bindingDigest };
    });
  }

  getChallenge(challengeId: string): {
    challenge: Row;
    binding: Record<string, unknown>;
    projectId: string;
    outcome: Row | null;
  } | null {
    return this.read((db) => {
      const c = one(db, 'SELECT * FROM launcher_challenges WHERE challenge_id = ?', challengeId);
      const b = one(db, 'SELECT * FROM challenge_bindings WHERE challenge_id = ?', challengeId);
      if (!c || !b) return null;
      return {
        challenge: c,
        binding: JSON.parse(s(b, 'binding_json')) as Record<string, unknown>,
        projectId: s(b, 'project_id'),
        outcome: one(db, 'SELECT * FROM challenge_outcomes WHERE challenge_id = ?', challengeId) ?? null,
      };
    });
  }

  /**
   * Complete a challenge exactly once. Preconditions that do not prove who is completing
   * (unknown challenge, wrong nonce) leave the challenge untouched. Once the nonce matches, the
   * challenge is consumed in this transaction whatever the verdict, so a replay, a copy, or a
   * concurrent second completion can never produce a second outcome.
   */
  completeChallenge(input: {
    challengeId: string;
    nonce: string;
    channel: 'HTTP' | 'PRIVATE_IPC';
    evaluate: (ctx: ChallengeContext) => ChallengeVerdict;
  }): ChallengeOutcome {
    return this.tx('control.challenge.complete', (db) => {
      const c = one(db, 'SELECT * FROM launcher_challenges WHERE challenge_id = ?', input.challengeId);
      const b = one(db, 'SELECT * FROM challenge_bindings WHERE challenge_id = ?', input.challengeId);
      if (!c || !b) fail('RS_NOT_FOUND', 'Launcher challenge not found.');
      const nonceDigest = `sha256:${sha256(`routespec.challenge-nonce/1\n${input.nonce}`)}`;
      if (!sameSecret(s(c, 'nonce_digest'), nonceDigest)) {
        fail('RS_ATTESTATION_REJECTED', 'The challenge nonce does not match.');
      }
      if (c['consumed_at_ms'] !== null) {
        fail('RS_CHALLENGE_UNAVAILABLE', 'The challenge was already used.');
      }
      const now = this.now();
      const scope = s(c, 'scope') as ChallengeScope;
      run(
        db,
        'UPDATE launcher_challenges SET consumed_at_ms = ? WHERE challenge_id = ? AND consumed_at_ms IS NULL',
        now,
        input.challengeId,
      );
      const reject = (reasonCode: string): ChallengeOutcome => {
        run(
          db,
          `INSERT INTO challenge_outcomes(challenge_id, outcome, reason_code, attestation_id, completed_at_ms) VALUES (?, 'REJECTED', ?, NULL, ?)`,
          input.challengeId,
          reasonCode,
          now,
        );
        this.auditIn(db, 'ATTESTATION_REJECTED', 'launcher_challenge', input.challengeId, {
          scope,
          reasonCode,
          channel: input.channel,
        });
        return {
          challengeId: input.challengeId,
          scope,
          outcome: 'REJECTED',
          reasonCode,
          attestationId: null,
          attestationClass: null,
          attestationDigest: null,
          expiresAtMs: null,
        };
      };
      if (n(c, 'expires_at_ms') <= now) return reject('CHALLENGE_EXPIRED');
      const p = one(
        db,
        'SELECT * FROM attester_principals WHERE principal_id = ?',
        s(c, 'principal_id'),
      ) as Row;
      const pol = one(
        db,
        'SELECT * FROM attester_policies WHERE principal_id = ?',
        s(c, 'principal_id'),
      ) as Row;
      if (p['enabled'] !== 1) return reject('ATTESTER_REVOKED');
      if (n(p, 'revocation_epoch') !== n(c, 'principal_revocation_epoch'))
        return reject('REVOCATION_EPOCH_STALE');
      if (p['policy_digest'] !== c['principal_policy_digest']) return reject('ATTESTER_POLICY_CHANGED');
      if (n(p, 'valid_until_ms') <= now || n(p, 'valid_from_ms') > now)
        return reject('ATTESTER_OUTSIDE_VALIDITY');
      const binding = JSON.parse(s(b, 'binding_json')) as Record<string, unknown>;
      let verdict: ChallengeVerdict;
      try {
        verdict = input.evaluate({
          challenge: c,
          binding,
          principal: p,
          policy: JSON.parse(s(pol, 'policy_json')) as Record<string, unknown>,
          nowMs: now,
        });
      } catch {
        verdict = { ok: false, reasonCode: 'VERIFICATION_ERROR' };
      }
      if (!verdict.ok) return reject(verdict.reasonCode);
      if (scope === 'CASE_LAUNCH') {
        const session = one(db, 'SELECT * FROM sessions WHERE session_id = ?', String(binding['sessionId']));
        const caseRun = one(
          db,
          'SELECT * FROM case_runs WHERE case_run_id = ?',
          String(binding['caseRunId']),
        );
        if (
          !session ||
          !caseRun ||
          session['case_launch_attestation_id'] !== null ||
          caseRun['session_id'] !== binding['sessionId'] ||
          caseRun['fencing_epoch'] !== binding['fencingEpoch'] ||
          caseRun['execution_lifecycle'] !== 'RUNNING'
        ) {
          return reject('CASE_SCOPE_STALE');
        }
      }
      const attestationId = randomUUID();
      const observed = [...new Set(verdict.observedDigests)].sort();
      const expiresAtMs = Math.min(now + n(p, 'max_freshness_ms'), n(p, 'valid_until_ms'));
      const attestationDigest = digestValue('routespec.subject-attestation/1', {
        attestationId,
        attestationClass: verdict.attestationClass,
        scope,
        challengeId: input.challengeId,
        principalId: s(c, 'principal_id'),
        principalPolicyDigest: s(c, 'principal_policy_digest'),
        principalRevocationEpoch: n(c, 'principal_revocation_epoch'),
        bindingDigest: s(c, 'binding_digest'),
        verifiedClaimsDigest: verdict.verifiedClaimsDigest,
        observedDigests: observed,
        verifiedAtMs: now,
        expiresAtMs,
      });
      const buildRevisionId =
        typeof binding['buildRevisionId'] === 'string' ? binding['buildRevisionId'] : null;
      run(
        db,
        `INSERT INTO subject_attestations(attestation_id, attestation_class, scope, challenge_id, principal_id, principal_policy_digest,
           principal_revocation_epoch, build_revision_id, verified_claims_digest, observed_digests_json, verified_at_ms, expires_at_ms,
           attestation_digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        attestationId,
        verdict.attestationClass,
        scope,
        input.challengeId,
        s(c, 'principal_id'),
        s(c, 'principal_policy_digest'),
        n(c, 'principal_revocation_epoch'),
        buildRevisionId,
        verdict.verifiedClaimsDigest,
        json(observed),
        now,
        expiresAtMs,
        attestationDigest,
      );
      run(
        db,
        `INSERT INTO challenge_outcomes(challenge_id, outcome, reason_code, attestation_id, completed_at_ms) VALUES (?, 'ATTESTED', NULL, ?, ?)`,
        input.challengeId,
        attestationId,
        now,
      );
      if (scope === 'CASE_LAUNCH') {
        run(
          db,
          'UPDATE sessions SET case_launch_attestation_id = ? WHERE session_id = ? AND case_launch_attestation_id IS NULL',
          attestationId,
          String(binding['sessionId']),
        );
      }
      this.auditIn(db, 'ATTESTATION_RECORDED', 'subject_attestation', attestationId, {
        scope,
        attestationClass: verdict.attestationClass,
        channel: input.channel,
      });
      return {
        challengeId: input.challengeId,
        scope,
        outcome: 'ATTESTED',
        reasonCode: null,
        attestationId,
        attestationClass: verdict.attestationClass,
        attestationDigest,
        expiresAtMs,
      };
    });
  }

  getAttestation(attestationId: string): Row | undefined {
    return this.read((db) =>
      one(
        db,
        `SELECT a.*, p.enabled AS principal_enabled, p.revocation_epoch AS principal_current_revocation_epoch,
                p.policy_digest AS principal_current_policy_digest, b.project_id AS project_id
           FROM subject_attestations a JOIN attester_principals p USING (principal_id)
           JOIN challenge_bindings b USING (challenge_id) WHERE a.attestation_id = ?`,
        attestationId,
      ),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Session events (stable sequence-ordered paging).

  listSessionEvents(
    sessionId: string,
    afterSequence: number,
    limit: number,
    filters: SessionEventFilters,
  ): Row[] {
    const where: string[] = ['e.session_id = ?', 'e.sequence > ?'];
    const params: Param[] = [sessionId, afterSequence];
    if (filters.runOperationId !== undefined) {
      where.push('e.run_operation_id = ?');
      params.push(filters.runOperationId);
    }
    if (filters.eventKind !== undefined) {
      where.push('e.event_kind = ?');
      params.push(filters.eventKind);
    }
    if (filters.phase !== undefined) {
      where.push('x.phase = ?');
      params.push(filters.phase);
    }
    if (filters.logicalJobDigest !== undefined) {
      where.push('j.logical_job_key_digest = ?');
      params.push(filters.logicalJobDigest);
    }
    if (filters.fromSequence !== undefined) {
      where.push('e.sequence >= ?');
      params.push(filters.fromSequence);
    }
    if (filters.toSequence !== undefined) {
      where.push('e.sequence <= ?');
      params.push(filters.toSequence);
    }
    params.push(limit);
    return this.read((db) =>
      all(
        db,
        `SELECT e.*, x.phase AS exchange_phase, x.error_code AS exchange_error_code, x.route_template AS exchange_route,
                a.timer_canonical AS attempt_timer_canonical
           FROM lifecycle_events e
           LEFT JOIN proxy_exchanges x ON x.exchange_id = e.exchange_id
           LEFT JOIN attempts a ON a.attempt_id = x.attempt_id
           LEFT JOIN run_operations o ON o.run_operation_id = e.run_operation_id
           LEFT JOIN logical_jobs j ON j.logical_job_id = o.logical_job_id
          WHERE ${where.join(' AND ')}
          ORDER BY e.sequence LIMIT ?`,
        ...params,
      ),
    );
  }

  sessionEventStats(sessionId: string): { count: number; lastSequence: number } {
    return this.read((db) => {
      const row = one(
        db,
        'SELECT count(*) AS n, COALESCE(max(sequence), 0) AS last FROM lifecycle_events WHERE session_id = ?',
        sessionId,
      ) as Row;
      return { count: n(row, 'n'), lastSequence: n(row, 'last') };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Audit and deletion planning.

  /** Append an audit event inside the caller's transaction. */
  auditIn(
    db: DatabaseSync,
    actionCode: string,
    subjectKind: string,
    subjectId: string | null,
    details: Record<string, unknown>,
  ): void {
    run(
      db,
      'INSERT INTO audit_events(audit_id, action_code, subject_kind, subject_id, details_json, created_at_ms) VALUES (?,?,?,?,?,?)',
      randomUUID(),
      actionCode,
      subjectKind,
      subjectId,
      json(details, '$.details'),
      this.now(),
    );
  }

  audit(
    actionCode: string,
    subjectKind: string,
    subjectId: string | null,
    details: Record<string, unknown>,
  ): void {
    this.tx('control.audit', (db) => this.auditIn(db, actionCode, subjectKind, subjectId, details));
  }

  /** Records a project deletion would affect (dry run; nothing is changed). */
  deletionPlan(projectId: string): Record<string, number> {
    return this.read((db) => {
      const count = (sql: string) => n(one(db, sql, projectId) as Row, 'n');
      return {
        integrationRevisions: count('SELECT count(*) AS n FROM integration_revisions WHERE project_id = ?'),
        buildRevisions: count('SELECT count(*) AS n FROM build_revisions WHERE project_id = ?'),
        gateRuns: count('SELECT count(*) AS n FROM gate_runs WHERE project_id = ?'),
        caseRuns: count(
          'SELECT count(*) AS n FROM case_runs WHERE gate_run_id IN (SELECT gate_run_id FROM gate_runs WHERE project_id = ?)',
        ),
        sessions: count(
          'SELECT count(*) AS n FROM sessions WHERE gate_run_id IN (SELECT gate_run_id FROM gate_runs WHERE project_id = ?)',
        ),
        lifecycleEvents: count(
          'SELECT count(*) AS n FROM lifecycle_events WHERE gate_run_id IN (SELECT gate_run_id FROM gate_runs WHERE project_id = ?)',
        ),
        imports: count('SELECT count(*) AS n FROM imports WHERE project_id = ?'),
        scopedRecords: count('SELECT count(*) AS n FROM project_records WHERE project_id = ?'),
        exportPlans: count(
          `SELECT count(*) AS n FROM export_plans WHERE gate_evaluation_id IN
             (SELECT gate_evaluation_id FROM gate_evaluations WHERE gate_run_id IN (SELECT gate_run_id FROM gate_runs WHERE project_id = ?))`,
        ),
      };
    });
  }

  listImports(projectId: string, afterRowid: number, limit: number): Row[] {
    return this.read((db) =>
      all(
        db,
        'SELECT rowid AS _rowid, * FROM imports WHERE project_id = ? AND rowid > ? ORDER BY rowid LIMIT ?',
        projectId,
        afterRowid,
        limit,
      ),
    );
  }
}
