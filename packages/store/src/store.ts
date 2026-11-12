/**
 * RouteSpec journal repositories (module M01).
 *
 * Authority model:
 * - Client-driven proxy writes (quote request, finalization, commit, status) present a
 *   `CaseAuth`: the one-time case token plus the bound identity headers. Inside the same
 *   transaction as the write, the token digest, revocation, bound build/artifact/gate/case/
 *   session/client/adapter identity, fencing epoch, expiry, phase permission, case lifecycle,
 *   and lease are verified.
 * - Runner/evaluator writes (evidence, consumption, evaluation) present an `ExecutionFence`:
 *   case run + lease owner + fencing epoch.
 * - Administrative writes are idempotent (identity digests / idempotency keys) and project
 *   updates are optimistic-revision checked. They never require a case lease.
 *
 * Every acknowledgement is returned only after COMMIT. Rejections that must leave a safe
 * audit trail (binding conflicts) commit a conflict row and then throw; nothing else changes.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  BUILD_REGISTRATION_CLAIM,
  ONECLICK_PROFILE,
  RouteSpecError,
  TOKEN_PURPOSE_PHASES,
  buildCaseResultRecord,
  canonicalJson,
  digestValue,
  foldOutcome,
  normalizeRawStatus,
  parseContract,
  validateCommit,
  validateQuoteFinalization,
  validateQuoteRequest,
  validateStatusQuery,
  type CaseLineageRole,
  type Digest,
  type ErrorCode,
  type EvidenceClass,
  type EvidenceReason,
  type EvidenceScope,
  type ExecutionLifecycle,
  type LineageRelation,
  type Mode,
  type NormalizedFact,
  type OperationPhase,
  type OutcomeState,
  type QuoteFinalization,
  type RawProviderStatus,
  type SubjectAttestationClass,
  type TokenPurpose,
  type ValidatedQuoteRequest,
  type Verdict,
} from '@routespec/contracts';
import { JournalDb, systemClock, type Clock, type OpenOptions } from './database.ts';
import { assertNoSecrets } from './guards.ts';

type Row = Record<string, unknown>;

export interface StoreOptions extends OpenOptions {
  readonly clock?: Clock;
}

/** Credentials presented by the actual-client adapter on every proxy write. */
export interface CaseAuth {
  readonly token: string;
  readonly sessionId: string;
  readonly caseRunId: string;
  readonly gateRunId: string;
  readonly buildRevisionId: string;
  readonly artifactDigest: string;
  readonly clientInstanceDigest: string;
  readonly adapterRevision: string;
  readonly fencingEpoch: number;
}

/** Runner/evaluator authority over one case run. */
export interface ExecutionFence {
  readonly caseRunId: string;
  readonly leaseOwnerDigest: string;
  readonly fencingEpoch: number;
}

export interface ExchangeAck {
  readonly ack: true;
  readonly duplicate: boolean;
  readonly joined: boolean;
  readonly runOperationId: string;
  readonly attemptId: string;
  readonly exchangeId: string;
  readonly sequence: number;
}

/** Private-channel credential of one registered interceptor instance (never a case token). */
/** Plain journal rows for one case, read in one consistent pass for the pure kernel (M04). */
export interface EvaluationSnapshotRows {
  readonly caseRun: Record<string, unknown>;
  readonly session: Record<string, unknown>;
  readonly gateRun: Record<string, unknown>;
  readonly scenario: Record<string, unknown>;
  readonly policy: Record<string, unknown> | null;
  readonly manifest: Record<string, unknown> | null;
  readonly manifestHooks: readonly Record<string, unknown>[];
  readonly inventory: Record<string, unknown> | null;
  readonly attestations: readonly Record<string, unknown>[];
  readonly interceptors: readonly Record<string, unknown>[];
  readonly boundaryObservations: readonly Record<string, unknown>[];
  readonly coverageFindings: readonly Record<string, unknown>[];
  readonly releaseAuthorizations: readonly Record<string, unknown>[];
  readonly subjectReports: readonly Record<string, unknown>[];
  readonly runOperations: readonly Record<string, unknown>[];
  readonly lineage: readonly Record<string, unknown>[];
  readonly quoteFinalizations: readonly Record<string, unknown>[];
  readonly commitBindings: readonly Record<string, unknown>[];
  readonly attempts: readonly Record<string, unknown>[];
  readonly exchanges: readonly Record<string, unknown>[];
  readonly events: readonly Record<string, unknown>[];
  readonly conflicts: readonly Record<string, unknown>[];
  readonly tokens: readonly Record<string, unknown>[];
  readonly evidence: readonly Record<string, unknown>[];
  readonly consumptions: readonly Record<string, unknown>[];
  readonly allocations: readonly Record<string, unknown>[];
}

export interface InterceptorChannelAuth {
  readonly interceptorInstanceId: string;
  readonly channelKey: string;
}

export interface CaseSpec {
  readonly scenarioRevisionId: string;
  readonly lineageRole: CaseLineageRole;
  readonly requiredInvariants: readonly string[];
  /** Per-case effect-coverage policy (M14); the gate run's policy when absent. */
  readonly effectCoveragePolicyDigest?: string;
}

export interface RecoveryResult {
  readonly token: string;
  readonly fencingEpoch: number;
  readonly auth: CaseAuth;
  readonly revokedTokens: number;
}

const ACTIVE_CASE_STATES: readonly ExecutionLifecycle[] = ['RUNNING', 'RECOVERY_REQUIRED', 'EVALUATING'];
const TOKEN_PREFIX = 'rsct_';

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

function tokenDigest(token: string): Digest {
  return digestValue('routespec.case-token/1', token);
}

function newToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
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

function str(row: Row, key: string): string {
  const v = row[key];
  if (typeof v !== 'string') throw new RouteSpecError('RS_INTERNAL', 'Journal row has an unexpected shape.');
  return v;
}

function num(row: Row, key: string): number {
  const v = row[key];
  if (typeof v !== 'number') throw new RouteSpecError('RS_INTERNAL', 'Journal row has an unexpected shape.');
  return v;
}

function strOrNull(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' ? v : null;
}

/** Deferred rejection: the conflict row commits, then the caller sees the typed error. */
class Rejection {
  readonly error: RouteSpecError;
  constructor(error: RouteSpecError) {
    this.error = error;
  }
}

export class RouteSpecStore {
  readonly journal: JournalDb;
  readonly clock: Clock;

  private constructor(journal: JournalDb, clock: Clock) {
    this.journal = journal;
    this.clock = clock;
  }

  static open(options: StoreOptions): RouteSpecStore {
    return new RouteSpecStore(JournalDb.open(options), options.clock ?? systemClock);
  }

  get mode(): JournalDb['mode'] {
    return this.journal.mode;
  }

  get schemaVersion(): number {
    return this.journal.schemaVersion;
  }

  close(): void {
    this.journal.close();
  }

  private now(): number {
    return this.clock.nowMs();
  }

  private tx<T>(label: string, fn: (db: DatabaseSync) => T | Rejection): T {
    const result = this.journal.transact(label, fn);
    if (result instanceof Rejection) throw result.error;
    return result;
  }

  // -------------------------------------------------------------------------------------------
  // Administrative writes: idempotency keys + optimistic revision, no case lease.

  private idempotent<T>(
    db: DatabaseSync,
    scope: string,
    idempotencyKey: string,
    request: unknown,
    produce: () => T,
  ): T {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      fail('RS_SCHEMA_INVALID', 'Idempotency-Key must be 8-128 safe characters.');
    }
    const requestDigest = digestValue('routespec.idempotent-request/1', request);
    const prior = one(
      db,
      'SELECT request_digest, response_json FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?',
      scope,
      idempotencyKey,
    );
    if (prior) {
      if (prior['request_digest'] !== requestDigest) {
        fail('RS_IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used for a different request.', {
          scope,
        });
      }
      return JSON.parse(str(prior, 'response_json')) as T;
    }
    const response = produce();
    run(
      db,
      'INSERT INTO idempotency_keys(scope, idempotency_key, request_digest, response_json, created_at_ms) VALUES (?,?,?,?,?)',
      scope,
      idempotencyKey,
      requestDigest,
      json(response),
      this.now(),
    );
    return response;
  }

  createProject(input: { name: string; description?: string | null; idempotencyKey: string }): {
    projectId: string;
    revision: number;
  } {
    const request = { name: input.name, description: input.description ?? null };
    return this.tx('project.create', (db) =>
      this.idempotent(db, 'project.create', input.idempotencyKey, request, () => {
        const projectId = randomUUID();
        const record = parseContract('project', {
          schemaVersion: '1.0',
          projectId,
          name: input.name,
          description: request.description,
          revision: 1,
          createdAtMs: this.now(),
        });
        run(
          db,
          'INSERT INTO projects(project_id, name, description, retention_policy_json, revision, created_at_ms) VALUES (?,?,?,?,?,?)',
          record.projectId,
          record.name,
          record.description,
          json({ rejectedImportHours: 24, sessionPayloadDays: 30 }),
          1,
          record.createdAtMs,
        );
        return { projectId, revision: 1 };
      }),
    );
  }

  updateProject(input: {
    projectId: string;
    expectedRevision: number;
    patch: { name?: string; description?: string | null };
    idempotencyKey: string;
  }): { projectId: string; revision: number } {
    return this.tx('project.update', (db) =>
      this.idempotent(db, `project.update:${input.projectId}`, input.idempotencyKey, input, () => {
        const row = one(db, 'SELECT * FROM projects WHERE project_id = ?', input.projectId);
        if (!row) fail('RS_NOT_FOUND', 'Project not found.');
        if (num(row, 'revision') !== input.expectedRevision) {
          fail('RS_REVISION_CONFLICT', 'Project revision does not match the expected revision.', {
            expected: input.expectedRevision,
            actual: num(row, 'revision'),
          });
        }
        assertNoSecrets(input.patch, '$.patch');
        const name = input.patch.name ?? str(row, 'name');
        const description =
          input.patch.description === undefined ? strOrNull(row, 'description') : input.patch.description;
        parseContract('project', {
          schemaVersion: '1.0',
          projectId: input.projectId,
          name,
          description,
          revision: input.expectedRevision + 1,
          createdAtMs: num(row, 'created_at_ms'),
        });
        const changed = run(
          db,
          'UPDATE projects SET name = ?, description = ?, revision = revision + 1 WHERE project_id = ? AND revision = ?',
          name,
          description,
          input.projectId,
          input.expectedRevision,
        );
        if (changed !== 1) fail('RS_REVISION_CONFLICT', 'Project changed concurrently.');
        return { projectId: input.projectId, revision: input.expectedRevision + 1 };
      }),
    );
  }

  registerProtocolProfile(profile: typeof ONECLICK_PROFILE = ONECLICK_PROFILE): string {
    return this.tx('profile.register', (db) => {
      const existing = one(
        db,
        'SELECT integrity_digest FROM protocol_profiles WHERE profile_id = ?',
        profile.profileId,
      );
      if (existing) {
        if (existing['integrity_digest'] !== profile.integrityDigest) {
          fail('RS_IMMUTABLE_RECORD', 'Protocol profile id is already bound to different content.');
        }
        return profile.profileId;
      }
      run(
        db,
        `INSERT INTO protocol_profiles(profile_id, sdk_package, sdk_version, sdk_git_head, route_schema_digest,
           material_registry_digest, status_schema_digest, integrity_digest, profile_json) VALUES (?,?,?,?,?,?,?,?,?)`,
        profile.profileId,
        profile.sdk.packageName,
        profile.sdk.version,
        profile.sdk.gitHead,
        profile.routeSchemaDigest,
        profile.materialRegistryDigest,
        profile.statusSchemaDigest,
        profile.integrityDigest,
        json(profile),
      );
      return profile.profileId;
    });
  }

  createIntegrationRevision(input: {
    projectId: string;
    revisionLabel: string;
    commitSha: string | null;
    configurationDigest: string;
    protocolProfileId: string;
    metadata?: Record<string, string | number | boolean>;
  }): { integrationRevisionId: string; identityDigest: Digest } {
    const metadata = input.metadata ?? {};
    const identityDigest = digestValue('routespec.integration-revision/1', {
      projectId: input.projectId,
      revisionLabel: input.revisionLabel,
      commitSha: input.commitSha,
      configurationDigest: input.configurationDigest,
      protocolProfileId: input.protocolProfileId,
      metadata,
    });
    return this.tx('integration-revision.create', (db) => {
      const existing = one(
        db,
        'SELECT integration_revision_id FROM integration_revisions WHERE project_id = ? AND identity_digest = ?',
        input.projectId,
        identityDigest,
      );
      if (existing)
        return { integrationRevisionId: str(existing, 'integration_revision_id'), identityDigest };
      const record = parseContract('integration-revision', {
        schemaVersion: '1.0',
        integrationRevisionId: randomUUID(),
        projectId: input.projectId,
        revisionLabel: input.revisionLabel,
        commitSha: input.commitSha,
        configurationDigest: input.configurationDigest,
        protocolProfileId: input.protocolProfileId,
        metadata,
        identityDigest,
      });
      run(
        db,
        `INSERT INTO integration_revisions(integration_revision_id, project_id, revision_label, commit_sha,
           configuration_digest, protocol_profile_id, metadata_json, identity_digest, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)`,
        record.integrationRevisionId,
        record.projectId,
        record.revisionLabel,
        record.commitSha,
        record.configurationDigest,
        record.protocolProfileId,
        json(metadata),
        identityDigest,
        this.now(),
      );
      return { integrationRevisionId: record.integrationRevisionId, identityDigest };
    });
  }

  /** Register an immutable, permanently USER_ASSERTED_LOCAL build revision. */
  registerBuild(input: {
    projectId: string;
    integrationRevisionId: string;
    repositoryLocator: string;
    commitSha: string;
    dirtyTreeDigest: string | null;
    artifactDigest: string;
    toolchainDigest: string;
    lockDigest: string;
    effectManifestDigest: string;
    ciWorkflowRunId: string | null;
    launchRecipeDigest: string;
  }): { buildRevisionId: string; identityDigest: Digest } {
    const identityDigest = digestValue('routespec.build-revision/1', input);
    return this.tx('build.register', (db) => {
      const existing = one(
        db,
        'SELECT build_revision_id FROM build_revisions WHERE identity_digest = ?',
        identityDigest,
      );
      if (existing) return { buildRevisionId: str(existing, 'build_revision_id'), identityDigest };
      const record = parseContract('build-revision', {
        schemaVersion: '1.0',
        buildRevisionId: randomUUID(),
        ...input,
        registrationClaim: BUILD_REGISTRATION_CLAIM,
        identityDigest,
      });
      run(
        db,
        `INSERT INTO build_revisions(build_revision_id, project_id, integration_revision_id, repository_locator, commit_sha,
           dirty_tree_digest, artifact_digest, toolchain_digest, lock_digest, effect_manifest_digest, ci_workflow_run_id,
           launch_recipe_digest, registration_claim, identity_digest, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        record.buildRevisionId,
        record.projectId,
        record.integrationRevisionId,
        record.repositoryLocator,
        record.commitSha,
        record.dirtyTreeDigest,
        record.artifactDigest,
        record.toolchainDigest,
        record.lockDigest,
        record.effectManifestDigest,
        record.ciWorkflowRunId,
        record.launchRecipeDigest,
        record.registrationClaim,
        identityDigest,
        this.now(),
      );
      return { buildRevisionId: record.buildRevisionId, identityDigest };
    });
  }

  createEffectManifest(input: {
    buildRevisionId: string;
    artifactDigest: string;
    adapterRevision: string;
    hooks: ReadonlyArray<{
      hookId: string;
      hookRevision: string;
      effectType: string;
      sinkClass: string;
      sourceLocatorDigest: string | null;
      mechanism: string;
      scenarioSelectors: readonly string[];
      coverageExpectation: 'REQUIRED' | 'OPTIONAL';
    }>;
  }): { manifestId: string; manifestDigest: Digest } {
    const manifestDigest = digestValue('routespec.effect-manifest/1', input);
    return this.tx('effect-manifest.create', (db) => {
      const existing = one(
        db,
        'SELECT manifest_id FROM effect_manifests WHERE manifest_digest = ?',
        manifestDigest,
      );
      if (existing) return { manifestId: str(existing, 'manifest_id'), manifestDigest };
      const record = parseContract('effect-manifest', {
        schemaVersion: '1.0',
        manifestId: randomUUID(),
        ...input,
        hooks: input.hooks.map((h) => ({ ...h, scenarioSelectors: [...h.scenarioSelectors] })),
        manifestDigest,
      });
      run(
        db,
        'INSERT INTO effect_manifests(manifest_id, build_revision_id, artifact_digest, adapter_revision, manifest_digest, created_at_ms) VALUES (?,?,?,?,?,?)',
        record.manifestId,
        record.buildRevisionId,
        record.artifactDigest,
        record.adapterRevision,
        manifestDigest,
        this.now(),
      );
      for (const h of record.hooks) {
        run(
          db,
          `INSERT INTO effect_manifest_hooks(manifest_id, hook_id, hook_revision, effect_type, sink_class, source_locator_digest,
             mechanism, scenario_selectors_json, coverage_expectation) VALUES (?,?,?,?,?,?,?,?,?)`,
          record.manifestId,
          h.hookId,
          h.hookRevision,
          h.effectType,
          h.sinkClass,
          h.sourceLocatorDigest,
          h.mechanism,
          json(h.scenarioSelectors),
          h.coverageExpectation,
        );
      }
      return { manifestId: record.manifestId, manifestDigest };
    });
  }

  createScenarioRevision(input: {
    scenarioStableId: string;
    schemaVersion: string;
    compiled: unknown;
    seed: string;
    resourceBudget: unknown;
    provenanceClass: string;
    compilerRevision: string;
    reviewStatus?: 'UNREVIEWED' | 'REVIEWED';
  }): { scenarioRevisionId: string; revisionDigest: Digest } {
    const revisionDigest = digestValue('routespec.scenario-revision/1', {
      schemaVersion: input.schemaVersion,
      compiled: input.compiled,
      seed: input.seed,
      resourceBudget: input.resourceBudget,
      provenanceClass: input.provenanceClass,
      compilerRevision: input.compilerRevision,
    });
    return this.tx('scenario.create', (db) => {
      const existing = one(
        db,
        'SELECT scenario_revision_id FROM scenario_revisions WHERE revision_digest = ?',
        revisionDigest,
      );
      if (existing) return { scenarioRevisionId: str(existing, 'scenario_revision_id'), revisionDigest };
      const scenarioRevisionId = randomUUID();
      run(
        db,
        `INSERT INTO scenario_revisions(scenario_revision_id, scenario_stable_id, schema_version, compiled_json, seed,
           resource_budget_json, provenance_class, source_locator, review_status, compiler_revision, revision_digest, created_at_ms)
         VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?)`,
        scenarioRevisionId,
        input.scenarioStableId,
        input.schemaVersion,
        json(input.compiled),
        input.seed,
        json(input.resourceBudget),
        input.provenanceClass,
        input.reviewStatus ?? 'UNREVIEWED',
        input.compilerRevision,
        revisionDigest,
        this.now(),
      );
      return { scenarioRevisionId, revisionDigest };
    });
  }

  createCorpusRevision(input: {
    label: string;
    cases: ReadonlyArray<{
      scenarioRevisionId: string;
      requiredInvariants: readonly string[];
      severity: string;
      gatePolicy: string;
    }>;
  }): { corpusRevisionId: string; corpusDigest: Digest } {
    const corpusDigest = digestValue('routespec.corpus-revision/1', input);
    return this.tx('corpus.create', (db) => {
      const existing = one(
        db,
        'SELECT corpus_revision_id FROM corpus_revisions WHERE corpus_digest = ?',
        corpusDigest,
      );
      if (existing) return { corpusRevisionId: str(existing, 'corpus_revision_id'), corpusDigest };
      const corpusRevisionId = randomUUID();
      run(
        db,
        'INSERT INTO corpus_revisions(corpus_revision_id, label, corpus_digest, created_at_ms) VALUES (?,?,?,?)',
        corpusRevisionId,
        input.label,
        corpusDigest,
        this.now(),
      );
      input.cases.forEach((c, ordinal) =>
        run(
          db,
          `INSERT INTO corpus_cases(corpus_revision_id, case_ordinal, scenario_revision_id, required_invariants_json, severity, gate_policy)
           VALUES (?,?,?,?,?,?)`,
          corpusRevisionId,
          ordinal,
          c.scenarioRevisionId,
          json(c.requiredInvariants),
          c.severity,
          c.gatePolicy,
        ),
      );
      return { corpusRevisionId, corpusDigest };
    });
  }

  createEffectCoveragePolicy(input: {
    buildRevisionId: string;
    artifactDigest: string;
    selectedAttestationId: string | null;
    scenarioRevisionId: string;
    manifestDigest: string;
    requiredSinkClasses: readonly string[];
    interceptorProfileDigest: string | null;
    callsiteInventoryDigest: string | null;
    basis:
      | 'INDEPENDENT_BOUNDARY_INTERCEPT'
      | 'TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT'
      | 'DECLARED_HOOKS_ONLY';
  }): { policyId: string; policyDigest: Digest } {
    const policyDigest = digestValue('routespec.effect-coverage-policy/1', input);
    return this.tx('effect-policy.create', (db) => {
      const existing = one(
        db,
        'SELECT policy_id FROM effect_coverage_policies WHERE policy_digest = ?',
        policyDigest,
      );
      if (existing) return { policyId: str(existing, 'policy_id'), policyDigest };
      const record = parseContract('effect-coverage-policy', {
        schemaVersion: '1.0',
        policyId: randomUUID(),
        ...input,
        requiredSinkClasses: [...input.requiredSinkClasses],
        policyDigest,
      });
      run(
        db,
        `INSERT INTO effect_coverage_policies(policy_id, build_revision_id, artifact_digest, selected_attestation_id, scenario_revision_id,
           manifest_digest, required_sink_classes_json, interceptor_profile_digest, callsite_inventory_digest, basis, policy_digest, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        record.policyId,
        record.buildRevisionId,
        record.artifactDigest,
        record.selectedAttestationId,
        record.scenarioRevisionId,
        record.manifestDigest,
        json(record.requiredSinkClasses),
        record.interceptorProfileDigest,
        record.callsiteInventoryDigest,
        record.basis,
        policyDigest,
        this.now(),
      );
      return { policyId: record.policyId, policyDigest };
    });
  }

  /** Create an immutable gate run and its exact ordered case runs in one transaction (DRAFT/PENDING). */
  createGateRun(input: {
    projectId: string;
    integrationRevisionId: string;
    buildRevisionId: string;
    artifactDigest: string;
    buildAttestation: { attestationClass: SubjectAttestationClass; attestationId: string | null };
    corpusRevisionId: string;
    protocolProfileId: string;
    adapterRevision: string;
    evaluatorRevision: string;
    proxyRevision: string;
    configurationDigest: string;
    effectManifestDigest: string;
    effectCoveragePolicyDigest: string;
    callsiteInventoryDigest: string | null;
    interceptorProfileDigest: string | null;
    maxParallelCases: number;
    cases: readonly CaseSpec[];
    /** Optional gate definition revision (M06); part of the identity digest when present. */
    gateDefinitionRevisionId?: string;
  }): { gateRunId: string; caseRunIds: string[]; identityDigest: Digest } {
    return this.tx('gate-run.create', (db) => {
      const gateRunId = randomUUID();
      const identityDigest = digestValue('routespec.gate-run/1', { gateRunId, ...input });
      const gateDefinitionRevisionId = input.gateDefinitionRevisionId ?? null;
      if (
        gateDefinitionRevisionId !== null &&
        !one(
          db,
          'SELECT 1 AS x FROM gate_definitions WHERE gate_definition_revision_id = ? AND project_id = ? AND corpus_revision_id = ?',
          gateDefinitionRevisionId,
          input.projectId,
          input.corpusRevisionId,
        )
      ) {
        fail('RS_IDENTITY_MISMATCH', 'Gate definition does not pin this project and corpus revision.');
      }
      parseContract('gate-run', {
        schemaVersion: '1.0',
        gateRunId,
        gateDefinitionRevisionId,
        projectId: input.projectId,
        integrationRevisionId: input.integrationRevisionId,
        buildRevisionId: input.buildRevisionId,
        artifactDigest: input.artifactDigest,
        buildAttestation: { ...input.buildAttestation, attestationDigest: null },
        corpusRevisionId: input.corpusRevisionId,
        protocolProfileId: input.protocolProfileId,
        adapterRevision: input.adapterRevision,
        evaluatorRevision: input.evaluatorRevision,
        proxyRevision: input.proxyRevision,
        configurationDigest: input.configurationDigest,
        effectManifestDigest: input.effectManifestDigest,
        effectCoveragePolicyDigest: input.effectCoveragePolicyDigest,
        callsiteInventoryDigest: input.callsiteInventoryDigest,
        interceptorProfileDigest: input.interceptorProfileDigest,
        maxParallelCases: input.maxParallelCases,
        executionLifecycle: 'DRAFT',
        verdict: null,
      });
      run(
        db,
        `INSERT INTO gate_runs(gate_run_id, gate_definition_revision_id, project_id, integration_revision_id, build_revision_id,
           artifact_digest, build_attestation_class, build_attestation_id, corpus_revision_id, protocol_profile_id, adapter_revision,
           evaluator_revision, proxy_revision, configuration_digest, effect_manifest_digest, effect_coverage_policy_digest,
           callsite_inventory_digest, interceptor_profile_digest, max_parallel_cases, execution_lifecycle, verdict, identity_digest, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',NULL,?,?)`,
        gateRunId,
        gateDefinitionRevisionId,
        input.projectId,
        input.integrationRevisionId,
        input.buildRevisionId,
        input.artifactDigest,
        input.buildAttestation.attestationClass,
        input.buildAttestation.attestationId,
        input.corpusRevisionId,
        input.protocolProfileId,
        input.adapterRevision,
        input.evaluatorRevision,
        input.proxyRevision,
        input.configurationDigest,
        input.effectManifestDigest,
        input.effectCoveragePolicyDigest,
        input.callsiteInventoryDigest,
        input.interceptorProfileDigest,
        input.maxParallelCases,
        identityDigest,
        this.now(),
      );
      const caseRunIds = input.cases.map((c, ordinal) => {
        const caseRunId = randomUUID();
        run(
          db,
          `INSERT INTO case_runs(case_run_id, gate_run_id, case_ordinal, scenario_revision_id, lineage_role, required_invariants_json,
             adapter_revision, execution_lifecycle, verdict, fencing_epoch) VALUES (?,?,?,?,?,?,?,'PENDING',NULL,0)`,
          caseRunId,
          gateRunId,
          ordinal,
          c.scenarioRevisionId,
          c.lineageRole,
          json(c.requiredInvariants),
          input.adapterRevision,
        );
        if (c.effectCoveragePolicyDigest !== undefined) {
          if (this.journal.schemaVersion < 8)
            fail('RS_SCHEMA_VERSION_UNSUPPORTED', 'Per-case policies need schema 8.');
          if (
            !one(
              db,
              'SELECT 1 AS x FROM effect_coverage_policies WHERE policy_digest = ?',
              c.effectCoveragePolicyDigest,
            )
          )
            fail('RS_NOT_FOUND', 'Effect coverage policy not found.');
          run(
            db,
            `INSERT INTO gate_run_case_policies(case_run_id, gate_run_id, scenario_revision_id, effect_coverage_policy_digest,
               created_at_ms) VALUES (?,?,?,?,?)`,
            caseRunId,
            gateRunId,
            c.scenarioRevisionId,
            c.effectCoveragePolicyDigest,
            this.now(),
          );
        }
        return caseRunId;
      });
      return { gateRunId, caseRunIds, identityDigest };
    });
  }

  /** Lifecycle transition for a gate run; the database trigger enforces the shared state machine. */
  transitionGateRun(gateRunId: string, from: ExecutionLifecycle, to: ExecutionLifecycle): void {
    this.tx('gate-run.transition', (db) => {
      const changed = run(
        db,
        "UPDATE gate_runs SET execution_lifecycle = ?, started_at_ms = COALESCE(started_at_ms, CASE WHEN ? = 'RUNNING' THEN ? END) WHERE gate_run_id = ? AND execution_lifecycle = ?",
        to,
        to,
        this.now(),
        gateRunId,
        from,
      );
      if (changed !== 1)
        fail('RS_LIFECYCLE_TRANSITION_INVALID', 'Gate run is not in the expected lifecycle state.', {
          from,
          to,
        });
    });
  }

  /** Pre-execution case transition (PENDING -> VALIDATING -> READY, or ABORTED/ERROR). */
  transitionCaseRun(caseRunId: string, from: ExecutionLifecycle, to: ExecutionLifecycle): void {
    if (from !== 'PENDING' && from !== 'VALIDATING' && from !== 'READY') {
      fail(
        'RS_LIFECYCLE_TRANSITION_INVALID',
        'Execution-phase case transitions require the fenced execution API.',
      );
    }
    this.tx('case-run.transition', (db) => {
      const changed = run(
        db,
        'UPDATE case_runs SET execution_lifecycle = ? WHERE case_run_id = ? AND execution_lifecycle = ?',
        to,
        caseRunId,
        from,
      );
      if (changed !== 1)
        fail('RS_LIFECYCLE_TRANSITION_INVALID', 'Case run is not in the expected lifecycle state.', {
          from,
          to,
        });
    });
  }

  linkLineage(input: {
    fromRunOperationId: string;
    toRunOperationId: string;
    relation: LineageRelation;
  }): Digest {
    const record = parseContract('run-operation-lineage', {
      schemaVersion: '1.0',
      ...input,
      lineageDigest: digestValue('routespec.run-operation-lineage/1', input),
    });
    return this.tx('lineage.link', (db) => {
      const existing = one(
        db,
        'SELECT lineage_digest FROM run_operation_lineage WHERE lineage_digest = ?',
        record.lineageDigest,
      );
      if (existing) return record.lineageDigest as Digest;
      run(
        db,
        'INSERT INTO run_operation_lineage(from_run_operation_id, to_run_operation_id, relation, lineage_digest, created_at_ms) VALUES (?,?,?,?,?)',
        record.fromRunOperationId,
        record.toRunOperationId,
        record.relation,
        record.lineageDigest,
        this.now(),
      );
      return record.lineageDigest as Digest;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Case execution: start, leases, tokens, fencing, recovery.

  private issueToken(
    db: DatabaseSync,
    args: {
      purpose: TokenPurpose;
      session: Row;
      caseRunId: string;
      clientInstanceDigest: string;
      adapterRevision: string;
      fencingEpoch: number;
      ttlMs: number;
    },
  ): { token: string; digest: Digest } {
    const token = newToken();
    const digest = tokenDigest(token);
    const now = this.now();
    run(
      db,
      `INSERT INTO case_tokens(token_digest, purpose, build_revision_id, artifact_digest, gate_run_id, case_run_id, session_id,
         client_instance_digest, adapter_revision, allowed_phases_json, fencing_epoch, issued_at_ms, expires_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      digest,
      args.purpose,
      str(args.session, 'build_revision_id'),
      str(args.session, 'artifact_digest'),
      str(args.session, 'gate_run_id'),
      args.caseRunId,
      str(args.session, 'session_id'),
      args.clientInstanceDigest,
      args.adapterRevision,
      JSON.stringify(TOKEN_PURPOSE_PHASES[args.purpose]),
      args.fencingEpoch,
      now,
      now + args.ttlMs,
    );
    run(db, 'UPDATE case_runs SET active_token_digest = ? WHERE case_run_id = ?', digest, args.caseRunId);
    return { token, digest };
  }

  private revokeActiveTokens(db: DatabaseSync, caseRunId: string, reason: string, epoch: number): number {
    const tokens = all(
      db,
      `SELECT t.token_digest FROM case_tokens t
       WHERE t.case_run_id = ? AND NOT EXISTS (SELECT 1 FROM token_revocations r WHERE r.token_digest = t.token_digest)`,
      caseRunId,
    );
    for (const t of tokens) {
      run(
        db,
        'INSERT INTO token_revocations(token_digest, reason_code, revoked_at_ms, revoked_at_epoch) VALUES (?,?,?,?)',
        str(t, 'token_digest'),
        reason,
        this.now(),
        epoch,
      );
    }
    run(db, 'UPDATE case_runs SET active_token_digest = NULL WHERE case_run_id = ?', caseRunId);
    return tokens.length;
  }

  private authFor(
    session: Row,
    caseRunId: string,
    token: string,
    clientInstanceDigest: string,
    adapterRevision: string,
    epoch: number,
  ): CaseAuth {
    return {
      token,
      sessionId: str(session, 'session_id'),
      caseRunId,
      gateRunId: str(session, 'gate_run_id'),
      buildRevisionId: str(session, 'build_revision_id'),
      artifactDigest: str(session, 'artifact_digest'),
      clientInstanceDigest,
      adapterRevision,
      fencingEpoch: epoch,
    };
  }

  /**
   * Start one isolated case run: new session, fresh client lease and one-time EXECUTION token.
   * Bounded parallelism is enforced across the gate run's active cases.
   */
  startCase(input: {
    caseRunId: string;
    leaseOwnerDigest: string;
    clientInstanceDigest: string;
    mode: Mode;
    seed: string;
    leaseTtlMs: number;
    tokenTtlMs: number;
  }): { sessionId: string; token: string; fencingEpoch: number; auth: CaseAuth } {
    if (input.mode === 'LIVE_DRY_PROBE') {
      fail('RS_MODE_POLICY_DENIED', 'Case runs execute only in the networkless SIMULATE/REPLAY runtime.');
    }
    return this.tx('case.start', (db) => {
      const now = this.now();
      const c = one(db, 'SELECT * FROM case_runs WHERE case_run_id = ?', input.caseRunId);
      if (!c) fail('RS_NOT_FOUND', 'Case run not found.');
      const lifecycle = str(c, 'execution_lifecycle') as ExecutionLifecycle;
      if (lifecycle !== 'READY') {
        const leaseExpiry = c['lease_expires_at_ms'];
        if (ACTIVE_CASE_STATES.includes(lifecycle) && typeof leaseExpiry === 'number' && leaseExpiry > now) {
          fail('RS_LEASE_HELD', 'Case run already has an active runner lease.');
        }
        if (ACTIVE_CASE_STATES.includes(lifecycle)) {
          fail('RS_LEASE_EXPIRED', 'Case run lease expired; only recovery may resume it.');
        }
        fail('RS_LIFECYCLE_TRANSITION_INVALID', 'Case run is not READY.', { lifecycle });
      }
      const g = one(db, 'SELECT * FROM gate_runs WHERE gate_run_id = ?', str(c, 'gate_run_id'));
      if (!g || g['execution_lifecycle'] !== 'RUNNING')
        fail('RS_LIFECYCLE_TRANSITION_INVALID', 'Gate run is not RUNNING.');
      const active = num(
        one(
          db,
          `SELECT count(*) AS n FROM case_runs WHERE gate_run_id = ? AND execution_lifecycle IN ('RUNNING','RECOVERY_REQUIRED','EVALUATING')`,
          str(g, 'gate_run_id'),
        ) as Row,
        'n',
      );
      if (active >= num(g, 'max_parallel_cases')) {
        fail('RS_PARALLELISM_EXCEEDED', 'Gate run bounded parallelism is exhausted.', {
          limit: num(g, 'max_parallel_cases'),
        });
      }
      const sessionId = randomUUID();
      const epoch = num(c, 'fencing_epoch') + 1;
      const casePolicy =
        this.journal.schemaVersion >= 8
          ? one(
              db,
              'SELECT effect_coverage_policy_digest FROM gate_run_case_policies WHERE case_run_id = ?',
              input.caseRunId,
            )
          : undefined;
      run(
        db,
        `INSERT INTO sessions(session_id, integration_revision_id, build_revision_id, artifact_digest, subject_attestation_class,
           gate_run_id, case_run_id, scenario_revision_id, corpus_revision_id, case_launch_attestation_id, adapter_revision,
           effect_manifest_digest, effect_coverage_policy_digest, callsite_inventory_digest, interceptor_instance_id, mode,
           evaluator_revision, configuration_digest, execution_lifecycle, verdict, seed, next_sequence, lease_owner_digest,
           lease_expires_at_ms, lease_fencing_epoch, started_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,NULL,?,?,?,'READY',NULL,?,0,?,?,?,?)`,
        sessionId,
        str(g, 'integration_revision_id'),
        str(g, 'build_revision_id'),
        str(g, 'artifact_digest'),
        str(g, 'build_attestation_class'),
        str(g, 'gate_run_id'),
        input.caseRunId,
        str(c, 'scenario_revision_id'),
        str(g, 'corpus_revision_id'),
        str(c, 'adapter_revision'),
        str(g, 'effect_manifest_digest'),
        casePolicy
          ? str(casePolicy, 'effect_coverage_policy_digest')
          : str(g, 'effect_coverage_policy_digest'),
        strOrNull(g, 'callsite_inventory_digest'),
        input.mode,
        str(g, 'evaluator_revision'),
        str(g, 'configuration_digest'),
        input.seed,
        input.leaseOwnerDigest,
        now + input.leaseTtlMs,
        epoch,
        now,
      );
      run(db, `UPDATE sessions SET execution_lifecycle = 'RUNNING' WHERE session_id = ?`, sessionId);
      run(
        db,
        `UPDATE case_runs SET execution_lifecycle = 'RUNNING', fencing_epoch = ?, session_id = ?, client_instance_digest = ?,
           lease_owner_digest = ?, lease_expires_at_ms = ? WHERE case_run_id = ? AND execution_lifecycle = 'READY'`,
        epoch,
        sessionId,
        input.clientInstanceDigest,
        input.leaseOwnerDigest,
        now + input.leaseTtlMs,
        input.caseRunId,
      );
      const session = one(db, 'SELECT * FROM sessions WHERE session_id = ?', sessionId) as Row;
      const { token } = this.issueToken(db, {
        purpose: 'EXECUTION',
        session,
        caseRunId: input.caseRunId,
        clientInstanceDigest: input.clientInstanceDigest,
        adapterRevision: str(c, 'adapter_revision'),
        fencingEpoch: epoch,
        ttlMs: input.tokenTtlMs,
      });
      return {
        sessionId,
        token,
        fencingEpoch: epoch,
        auth: this.authFor(
          session,
          input.caseRunId,
          token,
          input.clientInstanceDigest,
          str(c, 'adapter_revision'),
          epoch,
        ),
      };
    });
  }

  /** Verify a client-presented case token and bound identity inside the current transaction. */
  private authorize(
    db: DatabaseSync,
    auth: CaseAuth,
    phase: OperationPhase | null,
    touch = true,
  ): { session: Row; caseRun: Row; token: Row } {
    const now = this.now();
    const digest = tokenDigest(auth.token);
    const token = one(db, 'SELECT * FROM case_tokens WHERE token_digest = ?', digest);
    if (!token) fail('RS_TOKEN_INVALID', 'Case token is not recognized.');
    if (one(db, 'SELECT 1 AS x FROM token_revocations WHERE token_digest = ?', digest)) {
      fail('RS_TOKEN_REVOKED', 'Case token has been revoked.');
    }
    const bound: Array<[string, string]> = [
      ['case_run_id', auth.caseRunId],
      ['session_id', auth.sessionId],
      ['gate_run_id', auth.gateRunId],
      ['build_revision_id', auth.buildRevisionId],
      ['artifact_digest', auth.artifactDigest],
      ['adapter_revision', auth.adapterRevision],
    ];
    for (const [column, claimed] of bound) {
      if (token[column] !== claimed)
        fail('RS_IDENTITY_MISMATCH', 'Case token is bound to a different identity.', { field: column });
    }
    if (token['client_instance_digest'] !== auth.clientInstanceDigest) {
      fail('RS_CLIENT_CONFLICT', 'Case token is bound to a different client instance.');
    }
    const caseRun = one(db, 'SELECT * FROM case_runs WHERE case_run_id = ?', auth.caseRunId) as Row;
    if (
      num(token, 'fencing_epoch') !== auth.fencingEpoch ||
      num(caseRun, 'fencing_epoch') !== auth.fencingEpoch
    ) {
      fail('RS_STALE_FENCING_EPOCH', 'Fencing epoch is stale.', {
        presented: auth.fencingEpoch,
        current: num(caseRun, 'fencing_epoch'),
      });
    }
    if (caseRun['active_token_digest'] !== digest)
      fail('RS_TOKEN_REVOKED', 'Case token is no longer the active token.');
    if (now >= num(token, 'expires_at_ms')) fail('RS_TOKEN_EXPIRED', 'Case token has expired.');
    if (phase !== null && !(JSON.parse(str(token, 'allowed_phases_json')) as string[]).includes(phase)) {
      fail('RS_TOKEN_PHASE_DENIED', 'Token purpose does not permit this phase.', {
        phase,
        purpose: str(token, 'purpose'),
      });
    }
    if (caseRun['execution_lifecycle'] !== 'RUNNING') {
      fail('RS_PHASE_INVALID', 'Case run is not accepting client traffic.', {
        lifecycle: str(caseRun, 'execution_lifecycle'),
      });
    }
    const leaseExpiry = caseRun['lease_expires_at_ms'];
    if (typeof leaseExpiry !== 'number' || now >= leaseExpiry)
      fail('RS_LEASE_EXPIRED', 'Case run lease has expired.');
    const session = one(db, 'SELECT * FROM sessions WHERE session_id = ?', auth.sessionId) as Row;
    if (session['execution_lifecycle'] !== 'RUNNING') fail('RS_PHASE_INVALID', 'Session is not RUNNING.');
    if (touch) run(db, 'UPDATE case_tokens SET last_used_at_ms = ? WHERE token_digest = ?', now, digest);
    return { session, caseRun, token };
  }

  private assertFence(db: DatabaseSync, fence: ExecutionFence): Row {
    const c = one(db, 'SELECT * FROM case_runs WHERE case_run_id = ?', fence.caseRunId);
    if (!c) fail('RS_NOT_FOUND', 'Case run not found.');
    if (num(c, 'fencing_epoch') !== fence.fencingEpoch) {
      fail('RS_STALE_FENCING_EPOCH', 'Fencing epoch is stale.', {
        presented: fence.fencingEpoch,
        current: num(c, 'fencing_epoch'),
      });
    }
    if (c['lease_owner_digest'] !== fence.leaseOwnerDigest)
      fail('RS_LEASE_HELD', 'Another runner owns this case lease.');
    const expiry = c['lease_expires_at_ms'];
    if (typeof expiry !== 'number' || this.now() >= expiry)
      fail('RS_LEASE_EXPIRED', 'Case run lease has expired.');
    return c;
  }

  renewLease(fence: ExecutionFence, leaseTtlMs: number): number {
    return this.tx('case.renew-lease', (db) => {
      const c = this.assertFence(db, fence);
      if (str(c, 'execution_lifecycle') !== 'RUNNING' && str(c, 'execution_lifecycle') !== 'EVALUATING') {
        fail('RS_PHASE_INVALID', 'Only an executing case lease can be renewed.');
      }
      const expiresAt = this.now() + leaseTtlMs;
      run(
        db,
        'UPDATE case_runs SET lease_expires_at_ms = ? WHERE case_run_id = ?',
        expiresAt,
        fence.caseRunId,
      );
      run(
        db,
        'UPDATE sessions SET lease_expires_at_ms = ? WHERE case_run_id = ?',
        expiresAt,
        fence.caseRunId,
      );
      return expiresAt;
    });
  }

  private markRecoveryRequired(db: DatabaseSync, c: Row, reason: string): number {
    const caseRunId = str(c, 'case_run_id');
    const lifecycle = str(c, 'execution_lifecycle');
    const epoch = num(c, 'fencing_epoch') + 1;
    if (lifecycle !== 'RECOVERY_REQUIRED') {
      run(
        db,
        `UPDATE case_runs SET execution_lifecycle = 'RECOVERY_REQUIRED' WHERE case_run_id = ?`,
        caseRunId,
      );
    }
    const revoked = this.revokeActiveTokens(db, caseRunId, reason, epoch);
    run(
      db,
      'UPDATE case_runs SET fencing_epoch = ?, lease_owner_digest = NULL, lease_expires_at_ms = NULL WHERE case_run_id = ?',
      epoch,
      caseRunId,
    );
    const sessionId = strOrNull(c, 'session_id');
    if (sessionId) {
      const s = one(db, 'SELECT execution_lifecycle FROM sessions WHERE session_id = ?', sessionId) as Row;
      if (s['execution_lifecycle'] !== 'RECOVERY_REQUIRED') {
        run(
          db,
          `UPDATE sessions SET execution_lifecycle = 'RECOVERY_REQUIRED' WHERE session_id = ?`,
          sessionId,
        );
      }
      run(
        db,
        'UPDATE sessions SET lease_fencing_epoch = ?, lease_owner_digest = NULL, lease_expires_at_ms = NULL WHERE session_id = ?',
        epoch,
        sessionId,
      );
    }
    return revoked;
  }

  /** Move every executing case whose lease expired to RECOVERY_REQUIRED (revoke tokens, epoch + 1). */
  recoverExpiredLeases(): string[] {
    return this.tx('case.expire-leases', (db) => {
      const now = this.now();
      const expired = all(
        db,
        `SELECT * FROM case_runs WHERE execution_lifecycle IN ('RUNNING','EVALUATING')
           AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?)`,
        now,
      );
      for (const c of expired) this.markRecoveryRequired(db, c, 'LEASE_EXPIRED');
      return expired.map((c) => str(c, 'case_run_id'));
    });
  }

  /**
   * Recover one case: revoke stale authority, increment the fencing epoch, and issue exactly one
   * RECONCILIATION_ONLY token. `expectedFencingEpoch` makes concurrent recoveries compare-and-set.
   */
  recoverCase(input: {
    caseRunId: string;
    recoveryOwnerDigest: string;
    clientInstanceDigest: string;
    expectedFencingEpoch: number;
    leaseTtlMs: number;
    tokenTtlMs: number;
  }): RecoveryResult {
    return this.tx('case.recover', (db) => {
      const now = this.now();
      let c = one(db, 'SELECT * FROM case_runs WHERE case_run_id = ?', input.caseRunId);
      if (!c) fail('RS_NOT_FOUND', 'Case run not found.');
      if (num(c, 'fencing_epoch') !== input.expectedFencingEpoch) {
        fail('RS_STALE_FENCING_EPOCH', 'Another recovery already advanced the fencing epoch.', {
          expected: input.expectedFencingEpoch,
          current: num(c, 'fencing_epoch'),
        });
      }
      const lifecycle = str(c, 'execution_lifecycle');
      let revokedTokens = 0;
      if (lifecycle === 'RUNNING' || lifecycle === 'EVALUATING') {
        const expiry = c['lease_expires_at_ms'];
        if (typeof expiry === 'number' && expiry > now)
          fail('RS_LEASE_HELD', 'Case lease is still held; recovery not required.');
        revokedTokens = this.markRecoveryRequired(db, c, 'RECOVERY');
        c = one(db, 'SELECT * FROM case_runs WHERE case_run_id = ?', input.caseRunId) as Row;
      } else if (lifecycle !== 'RECOVERY_REQUIRED') {
        fail('RS_RECOVERY_NOT_REQUIRED', 'Case run is not in a recoverable state.', { lifecycle });
      }
      const epoch = num(c, 'fencing_epoch');
      const sessionId = strOrNull(c, 'session_id');
      if (!sessionId) fail('RS_RECOVERY_NOT_REQUIRED', 'Case run never started a session.');
      revokedTokens += this.revokeActiveTokens(db, input.caseRunId, 'RECOVERY', epoch);
      run(
        db,
        `UPDATE case_runs SET execution_lifecycle = 'RUNNING', lease_owner_digest = ?, lease_expires_at_ms = ? WHERE case_run_id = ?`,
        input.recoveryOwnerDigest,
        now + input.leaseTtlMs,
        input.caseRunId,
      );
      run(
        db,
        `UPDATE sessions SET execution_lifecycle = 'RUNNING', lease_owner_digest = ?, lease_expires_at_ms = ? WHERE session_id = ?`,
        input.recoveryOwnerDigest,
        now + input.leaseTtlMs,
        sessionId,
      );
      const session = one(db, 'SELECT * FROM sessions WHERE session_id = ?', sessionId) as Row;
      // A recovered case keeps its original client instance binding: another client is a conflict.
      if (c['client_instance_digest'] !== input.clientInstanceDigest) {
        fail('RS_CLIENT_CONFLICT', "Recovery must reconcile through the case run's bound client instance.");
      }
      const { token } = this.issueToken(db, {
        purpose: 'RECONCILIATION_ONLY',
        session,
        caseRunId: input.caseRunId,
        clientInstanceDigest: input.clientInstanceDigest,
        adapterRevision: str(c, 'adapter_revision'),
        fencingEpoch: epoch,
        ttlMs: input.tokenTtlMs,
      });
      return {
        token,
        fencingEpoch: epoch,
        revokedTokens,
        auth: this.authFor(
          session,
          input.caseRunId,
          token,
          input.clientInstanceDigest,
          str(c, 'adapter_revision'),
          epoch,
        ),
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Proxy journal: four profile phases. Exchange + attempt + event + sequence in one transaction.

  private nextSequence(db: DatabaseSync, sessionId: string): number {
    const row = one(db, 'SELECT next_sequence FROM sessions WHERE session_id = ?', sessionId) as Row;
    const seq = num(row, 'next_sequence');
    if (
      run(
        db,
        'UPDATE sessions SET next_sequence = ? WHERE session_id = ? AND next_sequence = ?',
        seq + 1,
        sessionId,
        seq,
      ) !== 1
    ) {
      fail('RS_INTERNAL', 'Sequence allocation raced; refusing to guess.');
    }
    return seq;
  }

  private insertAttempt(
    db: DatabaseSync,
    args: {
      runOperationId: string;
      sessionId: string;
      epoch: number;
      transportRequestId: string;
      phase: OperationPhase;
      virtualMs: number | null;
    },
  ): string {
    const ordinalRow = one(
      db,
      'SELECT COALESCE(MAX(attempt_ordinal), 0) AS n FROM attempts WHERE run_operation_id = ?',
      args.runOperationId,
    ) as Row;
    const attemptId = randomUUID();
    run(
      db,
      `INSERT INTO attempts(attempt_id, run_operation_id, session_id, fencing_epoch, attempt_ordinal, transport_request_id, phase,
         outcome, timer_canonical, virtual_start_ms, created_at_ms) VALUES (?,?,?,?,?,?,?,'SENT_OUTCOME_UNKNOWN',1,?,?)`,
      attemptId,
      args.runOperationId,
      args.sessionId,
      args.epoch,
      num(ordinalRow, 'n') + 1,
      args.transportRequestId,
      args.phase,
      args.virtualMs,
      this.now(),
    );
    return attemptId;
  }

  private insertExchange(
    db: DatabaseSync,
    args: {
      session: Row;
      runOperationId: string | null;
      attemptId: string | null;
      epoch: number;
      transportRequestId: string;
      sequence: number;
      phase: OperationPhase;
      method: 'GET' | 'POST';
      route: string;
      requestDigest: string;
      requestPayload: unknown;
      response?: { status: number; digest: string } | undefined;
      virtualMs: number | null;
    },
  ): string {
    const exchangeId = randomUUID();
    run(
      db,
      `INSERT INTO proxy_exchanges(exchange_id, build_revision_id, gate_run_id, case_run_id, session_id, run_operation_id, attempt_id,
         fencing_epoch, transport_request_id, sequence, phase, method, route_template, request_digest, request_payload_json,
         response_status, response_digest, virtual_ms, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      exchangeId,
      str(args.session, 'build_revision_id'),
      str(args.session, 'gate_run_id'),
      str(args.session, 'case_run_id'),
      str(args.session, 'session_id'),
      args.runOperationId,
      args.attemptId,
      args.epoch,
      args.transportRequestId,
      args.sequence,
      args.phase,
      args.method,
      args.route,
      args.requestDigest,
      json(args.requestPayload, '$.request'),
      args.response?.status ?? null,
      args.response?.digest ?? null,
      args.virtualMs,
      this.now(),
    );
    return exchangeId;
  }

  private insertEvent(
    db: DatabaseSync,
    args: {
      session: Row;
      runOperationId: string | null;
      exchangeId: string | null;
      epoch: number;
      sequence: number;
      kind: string;
      rawStatus?: string | null;
      fact?: NormalizedFact | null;
      payloadDigest?: string | null;
      virtualMs: number | null;
    },
  ): void {
    run(
      db,
      `INSERT INTO lifecycle_events(event_id, build_revision_id, gate_run_id, case_run_id, session_id, run_operation_id, exchange_id,
         fencing_epoch, sequence, event_kind, raw_status, normalized_fact, source_kind, payload_digest, virtual_ms, created_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'PROXY',?,?,?)`,
      randomUUID(),
      str(args.session, 'build_revision_id'),
      str(args.session, 'gate_run_id'),
      str(args.session, 'case_run_id'),
      str(args.session, 'session_id'),
      args.runOperationId,
      args.exchangeId,
      args.epoch,
      args.sequence,
      args.kind,
      args.rawStatus ?? null,
      args.fact ?? null,
      args.payloadDigest ?? null,
      args.virtualMs,
      this.now(),
    );
  }

  private conflict(
    db: DatabaseSync,
    args: {
      runOperationId: string | null;
      sessionId: string;
      phase: OperationPhase;
      code: ErrorCode;
      digest: string | null;
      epoch: number;
      message: string;
    },
  ): Rejection {
    run(
      db,
      `INSERT INTO operation_conflicts(conflict_id, run_operation_id, session_id, phase, error_code, attempted_digest, fencing_epoch, created_at_ms)
       VALUES (?,?,?,?,?,?,?,?)`,
      randomUUID(),
      args.runOperationId,
      args.sessionId,
      args.phase,
      args.code,
      args.digest,
      args.epoch,
      this.now(),
    );
    return new Rejection(new RouteSpecError(args.code, args.message, { details: { phase: args.phase } }));
  }

  private priorExchange(db: DatabaseSync, sessionId: string, transportRequestId: string): Row | undefined {
    return one(
      db,
      'SELECT * FROM proxy_exchanges WHERE session_id = ? AND transport_request_id = ?',
      sessionId,
      transportRequestId,
    );
  }

  private ackFrom(ex: Row, duplicate: boolean, joined: boolean): ExchangeAck {
    return {
      ack: true,
      duplicate,
      joined,
      runOperationId: str(ex, 'run_operation_id'),
      attemptId: str(ex, 'attempt_id'),
      exchangeId: str(ex, 'exchange_id'),
      sequence: num(ex, 'sequence'),
    };
  }

  /**
   * QUOTE_REQUEST: create (or join) the run operation scoped to
   * (integration revision, build, gate run, case run, logical job). A transport retry with the
   * same request ID is idempotent; a different request ID with identical material adds an
   * attempt; changed material fails closed without touching the original.
   */
  recordQuoteRequest(
    auth: CaseAuth,
    input: { transportRequestId: string; logicalJobKey: string; material: unknown; virtualMs?: number },
  ): ExchangeAck {
    const validated = validateQuoteRequest(input.material);
    assertNoSecrets(validated.material, '$.quoteRequest');
    return this.tx('proxy.quote-request', (db) => {
      const { session } = this.authorize(db, auth, 'QUOTE_REQUEST');
      const sessionId = auth.sessionId;
      const prior = this.priorExchange(db, sessionId, input.transportRequestId);
      if (prior) {
        if (prior['phase'] === 'QUOTE_REQUEST' && prior['request_digest'] === validated.quoteRequestDigest) {
          return this.ackFrom(prior, true, false);
        }
        return this.conflict(db, {
          runOperationId: strOrNull(prior, 'run_operation_id'),
          sessionId,
          phase: 'QUOTE_REQUEST',
          code: 'RS_DUPLICATE',
          digest: validated.quoteRequestDigest,
          epoch: auth.fencingEpoch,
          message: 'Transport request ID was already used for different content.',
        });
      }
      const integrationRevisionId = str(session, 'integration_revision_id');
      const keyDigest = digestValue('routespec.logical-job-key/1', input.logicalJobKey);
      let job = one(
        db,
        'SELECT logical_job_id FROM logical_jobs WHERE integration_revision_id = ? AND logical_job_key_digest = ?',
        integrationRevisionId,
        keyDigest,
      );
      if (!job) {
        const logicalJobId = randomUUID();
        run(
          db,
          'INSERT INTO logical_jobs(logical_job_id, integration_revision_id, logical_job_key_digest, created_at_ms) VALUES (?,?,?,?)',
          logicalJobId,
          integrationRevisionId,
          keyDigest,
          this.now(),
        );
        job = { logical_job_id: logicalJobId };
      }
      const logicalJobId = str(job, 'logical_job_id');
      const existing = one(
        db,
        `SELECT * FROM run_operations WHERE integration_revision_id = ? AND build_revision_id = ? AND gate_run_id = ?
           AND case_run_id = ? AND logical_job_id = ?`,
        integrationRevisionId,
        auth.buildRevisionId,
        auth.gateRunId,
        auth.caseRunId,
        logicalJobId,
      );
      let runOperationId: string;
      let joined = false;
      const sequence = this.nextSequence(db, sessionId);
      if (existing) {
        runOperationId = str(existing, 'run_operation_id');
        if (existing['quote_request_digest'] !== validated.quoteRequestDigest) {
          return this.conflict(db, {
            runOperationId,
            sessionId,
            phase: 'QUOTE_REQUEST',
            code: 'RS_MATERIAL_CHANGED',
            digest: validated.quoteRequestDigest,
            epoch: auth.fencingEpoch,
            message: 'Logical job reused with changed quote-request material.',
          });
        }
        if (existing['commit_binding_digest'] !== null) {
          return this.conflict(db, {
            runOperationId,
            sessionId,
            phase: 'QUOTE_REQUEST',
            code: 'RS_PHASE_INVALID',
            digest: validated.quoteRequestDigest,
            epoch: auth.fencingEpoch,
            message: 'Quote request after a bound commit is phase-invalid.',
          });
        }
        joined = true;
      } else {
        runOperationId = randomUUID();
        const outcome: OutcomeState = {
          acceptedTerminal: null,
          outcome: null,
          contradictory: false,
          unknownObserved: false,
          ignoredRegressions: 0,
          observations: 0,
        };
        run(
          db,
          `INSERT INTO run_operations(run_operation_id, integration_revision_id, build_revision_id, artifact_digest, gate_run_id, case_run_id,
             session_id, logical_job_id, protocol_profile_id, adapter_revision, effect_coverage_policy_digest, effect_manifest_digest,
             callsite_inventory_digest, interceptor_instance_id, fencing_epoch, current_phase, quote_request_digest, quote_request_json,
             outcome_flags_json, created_sequence, created_at_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'QUOTE_REQUEST',?,?,?,?,?)`,
          runOperationId,
          integrationRevisionId,
          auth.buildRevisionId,
          auth.artifactDigest,
          auth.gateRunId,
          auth.caseRunId,
          sessionId,
          logicalJobId,
          ONECLICK_PROFILE.profileId,
          auth.adapterRevision,
          str(session, 'effect_coverage_policy_digest'),
          str(session, 'effect_manifest_digest'),
          strOrNull(session, 'callsite_inventory_digest'),
          strOrNull(session, 'interceptor_instance_id'),
          auth.fencingEpoch,
          validated.quoteRequestDigest,
          json(validated.material, '$.quoteRequest'),
          json(outcome),
          sequence,
          this.now(),
        );
      }
      const virtualMs = input.virtualMs ?? null;
      const attemptId = this.insertAttempt(db, {
        runOperationId,
        sessionId,
        epoch: auth.fencingEpoch,
        transportRequestId: input.transportRequestId,
        phase: 'QUOTE_REQUEST',
        virtualMs,
      });
      const exchangeId = this.insertExchange(db, {
        session,
        runOperationId,
        attemptId,
        epoch: auth.fencingEpoch,
        transportRequestId: input.transportRequestId,
        sequence,
        phase: 'QUOTE_REQUEST',
        method: 'POST',
        route: '/v0/quote',
        requestDigest: validated.quoteRequestDigest,
        requestPayload: validated.material,
        virtualMs,
      });
      this.insertEvent(db, {
        session,
        runOperationId,
        exchangeId,
        epoch: auth.fencingEpoch,
        sequence,
        kind: joined ? 'QUOTE_REQUEST_JOINED' : 'QUOTE_REQUEST_CREATED',
        payloadDigest: validated.quoteRequestDigest,
        virtualMs,
      });
      return { ack: true, duplicate: false, joined, runOperationId, attemptId, exchangeId, sequence };
    });
  }

  private loadFinalization(db: DatabaseSync, runOperationId: string): QuoteFinalization | null {
    const f = one(db, 'SELECT * FROM quote_finalizations WHERE run_operation_id = ?', runOperationId);
    if (!f) return null;
    return {
      quoteRequestDigest: str(f, 'quote_request_digest') as Digest,
      correlationId: str(f, 'correlation_id'),
      quoteTimestamp: str(f, 'quote_timestamp'),
      signatureDigest: str(f, 'signature_digest') as Digest,
      depositAddress: strOrNull(f, 'deposit_address'),
      depositMemo: strOrNull(f, 'deposit_memo'),
      constraints: JSON.parse(str(f, 'constraints_json')) as QuoteFinalization['constraints'],
      extensions: JSON.parse(str(f, 'extensions_json')) as Record<string, unknown>,
      responseDigest: str(f, 'response_digest') as Digest,
      finalizationDigest: str(f, 'finalization_digest') as Digest,
    };
  }

  private loadOperation(db: DatabaseSync, auth: CaseAuth, runOperationId: string): Row {
    const op = one(db, 'SELECT * FROM run_operations WHERE run_operation_id = ?', runOperationId);
    if (!op) fail('RS_NOT_FOUND', 'Run operation not found.');
    if (
      op['session_id'] !== auth.sessionId ||
      op['case_run_id'] !== auth.caseRunId ||
      op['build_revision_id'] !== auth.buildRevisionId
    ) {
      fail('RS_IDENTITY_MISMATCH', 'Run operation belongs to a different case/build/session.');
    }
    return op;
  }

  /**
   * QUOTE_FINALIZATION: atomically bind the first complete quote response (quote/correlation
   * identity, constraints, response-assigned deposit address, extensions). Partial responses
   * write nothing; exact repeats are read-idempotent; changed re-finalization fails closed.
   */
  finalizeQuote(
    auth: CaseAuth,
    input: {
      transportRequestId: string;
      runOperationId: string;
      response: unknown;
      virtualMs?: number;
      /**
       * When true the attempt stays SENT_OUTCOME_UNKNOWN until the proxy confirms delivery via
       * `markResponseDelivered`, so a deterministically dropped quote response stays uncertain.
       */
      deliveryPending?: boolean;
    },
  ): ExchangeAck & { finalizationDigest: Digest; depositAddress: string | null } {
    return this.tx('proxy.quote-finalization', (db) => {
      const { session } = this.authorize(db, auth, 'QUOTE_FINALIZATION');
      const op = this.loadOperation(db, auth, input.runOperationId);
      const bound: ValidatedQuoteRequest = {
        material: JSON.parse(str(op, 'quote_request_json')) as ValidatedQuoteRequest['material'],
        quoteRequestDigest: str(op, 'quote_request_digest') as Digest,
      };
      const fin = validateQuoteFinalization(bound, input.response); // throws before any write if partial/unknown
      assertNoSecrets(fin.extensions, '$.quoteResponse.extensions');
      const ex = this.priorExchange(db, auth.sessionId, input.transportRequestId);
      if (!ex || ex['run_operation_id'] !== input.runOperationId || ex['phase'] !== 'QUOTE_REQUEST') {
        fail(
          'RS_IDENTITY_MISMATCH',
          "Finalization must answer this run operation's own quote-request exchange.",
        );
      }
      const existing = this.loadFinalization(db, input.runOperationId);
      if (existing) {
        if (existing.finalizationDigest !== fin.finalizationDigest) {
          return this.conflict(db, {
            runOperationId: input.runOperationId,
            sessionId: auth.sessionId,
            phase: 'QUOTE_FINALIZATION',
            code: 'RS_FINALIZATION_CONFLICT',
            digest: fin.finalizationDigest,
            epoch: auth.fencingEpoch,
            message: 'Run operation already has a different finalized quote.',
          });
        }
        if (ex['response_status'] === null) {
          run(
            db,
            'UPDATE proxy_exchanges SET response_status = 200, response_digest = ? WHERE exchange_id = ?',
            fin.responseDigest,
            str(ex, 'exchange_id'),
          );
          if (input.deliveryPending !== true) {
            run(
              db,
              `UPDATE attempts SET outcome = 'SENT_RESPONSE_RECEIVED' WHERE attempt_id = ? AND outcome = 'SENT_OUTCOME_UNKNOWN'`,
              str(ex, 'attempt_id'),
            );
          }
        }
        return {
          ...this.ackFrom(ex, true, true),
          finalizationDigest: existing.finalizationDigest,
          depositAddress: existing.depositAddress,
        };
      }
      if (ex['response_status'] !== null) fail('RS_IMMUTABLE_RECORD', 'Exchange already carries a response.');
      const sequence = this.nextSequence(db, auth.sessionId);
      run(
        db,
        `INSERT INTO quote_finalizations(run_operation_id, quote_request_digest, correlation_id, quote_timestamp, signature_digest,
           response_digest, deposit_address, deposit_memo, constraints_json, extensions_json, finalization_digest, sequence,
           fencing_epoch, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        input.runOperationId,
        fin.quoteRequestDigest,
        fin.correlationId,
        fin.quoteTimestamp,
        fin.signatureDigest,
        fin.responseDigest,
        fin.depositAddress,
        fin.depositMemo,
        json(fin.constraints),
        json(fin.extensions),
        fin.finalizationDigest,
        sequence,
        auth.fencingEpoch,
        this.now(),
      );
      run(
        db,
        `UPDATE run_operations SET quote_finalization_digest = ?, current_phase = 'QUOTE_FINALIZATION', finalized_sequence = ? WHERE run_operation_id = ?`,
        fin.finalizationDigest,
        sequence,
        input.runOperationId,
      );
      run(
        db,
        'UPDATE proxy_exchanges SET response_status = 200, response_digest = ? WHERE exchange_id = ?',
        fin.responseDigest,
        str(ex, 'exchange_id'),
      );
      if (input.deliveryPending !== true) {
        run(
          db,
          `UPDATE attempts SET outcome = 'SENT_RESPONSE_RECEIVED' WHERE attempt_id = ?`,
          str(ex, 'attempt_id'),
        );
      }
      this.insertEvent(db, {
        session,
        runOperationId: input.runOperationId,
        exchangeId: str(ex, 'exchange_id'),
        epoch: auth.fencingEpoch,
        sequence,
        kind: 'QUOTE_FINALIZED',
        payloadDigest: fin.finalizationDigest,
        virtualMs: input.virtualMs ?? null,
      });
      return {
        ...this.ackFrom(ex, false, false),
        sequence,
        finalizationDigest: fin.finalizationDigest,
        depositAddress: fin.depositAddress,
      };
    });
  }

  /**
   * COMMIT_MUTATION: the first commit atomically binds method/route, canonical body digest,
   * finalized quote, deposit address, and transaction digest before acknowledgement. Exact
   * retries join; changed or second commits fail closed without rewriting history. The returned
   * acknowledgement exists only after COMMIT; the attempt stays SENT_OUTCOME_UNKNOWN until the
   * proxy records response delivery.
   */
  commitMutation(
    auth: CaseAuth,
    input: { transportRequestId: string; runOperationId: string; body: unknown; virtualMs?: number },
  ): ExchangeAck & { bindingDigest: Digest } {
    assertNoSecrets(input.body, '$.commit');
    return this.tx('proxy.commit-mutation', (db) => {
      const { session } = this.authorize(db, auth, 'COMMIT_MUTATION');
      const op = this.loadOperation(db, auth, input.runOperationId);
      const finalization = this.loadFinalization(db, input.runOperationId);
      let binding;
      try {
        binding = validateCommit(finalization, input.body);
      } catch (error) {
        if (error instanceof RouteSpecError && error.code === 'RS_COMMIT_MATERIAL_MISMATCH') {
          return this.conflict(db, {
            runOperationId: input.runOperationId,
            sessionId: auth.sessionId,
            phase: 'COMMIT_MUTATION',
            code: error.code,
            digest: null,
            epoch: auth.fencingEpoch,
            message: error.message,
          });
        }
        throw error;
      }
      const prior = this.priorExchange(db, auth.sessionId, input.transportRequestId);
      const existing = one(
        db,
        'SELECT * FROM commit_bindings WHERE run_operation_id = ?',
        input.runOperationId,
      );
      if (prior) {
        if (
          prior['phase'] === 'COMMIT_MUTATION' &&
          prior['request_digest'] === binding.bodyDigest &&
          existing?.['binding_digest'] === binding.bindingDigest
        ) {
          return { ...this.ackFrom(prior, true, false), bindingDigest: binding.bindingDigest };
        }
        return this.conflict(db, {
          runOperationId: input.runOperationId,
          sessionId: auth.sessionId,
          phase: 'COMMIT_MUTATION',
          code: 'RS_DUPLICATE',
          digest: binding.bindingDigest,
          epoch: auth.fencingEpoch,
          message: 'Transport request ID was already used for different content.',
        });
      }
      if (existing && existing['binding_digest'] !== binding.bindingDigest) {
        return this.conflict(db, {
          runOperationId: input.runOperationId,
          sessionId: auth.sessionId,
          phase: 'COMMIT_MUTATION',
          code: 'RS_SECOND_COMMIT_REJECTED',
          digest: binding.bindingDigest,
          epoch: auth.fencingEpoch,
          message: 'Run operation already has a different bound commit.',
        });
      }
      const sequence = this.nextSequence(db, auth.sessionId);
      const virtualMs = input.virtualMs ?? null;
      const attemptId = this.insertAttempt(db, {
        runOperationId: input.runOperationId,
        sessionId: auth.sessionId,
        epoch: auth.fencingEpoch,
        transportRequestId: input.transportRequestId,
        phase: 'COMMIT_MUTATION',
        virtualMs,
      });
      const responseDigest = digestValue('routespec.commit-ack/1', {
        bindingDigest: binding.bindingDigest,
        sequence,
      });
      const exchangeId = this.insertExchange(db, {
        session,
        runOperationId: input.runOperationId,
        attemptId,
        epoch: auth.fencingEpoch,
        transportRequestId: input.transportRequestId,
        sequence,
        phase: 'COMMIT_MUTATION',
        method: 'POST',
        route: '/v0/deposit/submit',
        requestDigest: binding.bodyDigest,
        requestPayload: { bodyDigest: binding.bodyDigest, transactionDigest: binding.transactionDigest },
        response: { status: 200, digest: responseDigest },
        virtualMs,
      });
      if (!existing) {
        run(
          db,
          `INSERT INTO commit_bindings(run_operation_id, method, route, body_digest, quote_finalization_digest, deposit_address_digest,
             transaction_digest, binding_digest, first_attempt_id, sequence, fencing_epoch, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          input.runOperationId,
          binding.method,
          binding.route,
          binding.bodyDigest,
          binding.quoteFinalizationDigest,
          binding.depositAddressDigest,
          binding.transactionDigest,
          binding.bindingDigest,
          attemptId,
          sequence,
          auth.fencingEpoch,
          this.now(),
        );
        run(
          db,
          `UPDATE run_operations SET commit_binding_digest = ?, current_phase = 'COMMIT_MUTATION', committed_sequence = ? WHERE run_operation_id = ?`,
          binding.bindingDigest,
          sequence,
          str(op, 'run_operation_id'),
        );
      }
      this.insertEvent(db, {
        session,
        runOperationId: input.runOperationId,
        exchangeId,
        epoch: auth.fencingEpoch,
        sequence,
        kind: existing ? 'COMMIT_RETRY_JOINED' : 'COMMIT_ACCEPTED',
        payloadDigest: binding.bindingDigest,
        virtualMs,
      });
      return {
        ack: true,
        duplicate: false,
        joined: Boolean(existing),
        runOperationId: input.runOperationId,
        attemptId,
        exchangeId,
        sequence,
        bindingDigest: binding.bindingDigest,
      };
    });
  }

  /** Record that the proxy actually delivered an exchange's response to the client. */
  markResponseDelivered(auth: CaseAuth, exchangeId: string): void {
    this.tx('proxy.response-delivered', (db) => {
      this.authorize(db, auth, null);
      const ex = one(
        db,
        'SELECT * FROM proxy_exchanges WHERE exchange_id = ? AND session_id = ?',
        exchangeId,
        auth.sessionId,
      );
      if (!ex || ex['response_status'] === null)
        fail('RS_NOT_FOUND', 'No journaled response exists for this exchange.');
      run(
        db,
        `UPDATE attempts SET outcome = 'SENT_RESPONSE_RECEIVED' WHERE attempt_id = ? AND outcome = 'SENT_OUTCOME_UNKNOWN'`,
        str(ex, 'attempt_id'),
      );
    });
  }

  /**
   * READ_ONLY_RECONCILIATION: status read by the already bound deposit address. Appends the raw
   * observation and the derived normalized fact as separate fields; folds the terminal outcome so
   * a later non-terminal value can never replace an accepted terminal, and a different terminal
   * becomes CONTRADICTORY. Never creates, finalizes, or commits.
   */
  recordStatusObservation(
    auth: CaseAuth,
    input: {
      transportRequestId: string;
      runOperationId: string;
      query: unknown;
      rawStatus: string;
      virtualMs?: number;
      /** When true the attempt stays SENT_OUTCOME_UNKNOWN until `markResponseDelivered`. */
      deliveryPending?: boolean;
    },
  ): ExchangeAck & {
    outcome: NormalizedFact | null;
    acceptedTerminal: RawProviderStatus | null;
    contradictory: boolean;
  } {
    return this.tx('proxy.status', (db) => {
      const { session } = this.authorize(db, auth, 'READ_ONLY_RECONCILIATION');
      const op = this.loadOperation(db, auth, input.runOperationId);
      const query = validateStatusQuery(this.loadFinalization(db, input.runOperationId), input.query);
      const requestDigest = digestValue('routespec.oneclick.status-query/1', query);
      const prior = this.priorExchange(db, auth.sessionId, input.transportRequestId);
      const state = JSON.parse(str(op, 'outcome_flags_json')) as OutcomeState;
      if (prior) {
        if (prior['phase'] === 'READ_ONLY_RECONCILIATION' && prior['request_digest'] === requestDigest) {
          return {
            ...this.ackFrom(prior, true, false),
            outcome: state.outcome,
            acceptedTerminal: state.acceptedTerminal,
            contradictory: state.contradictory,
          };
        }
        return this.conflict(db, {
          runOperationId: input.runOperationId,
          sessionId: auth.sessionId,
          phase: 'READ_ONLY_RECONCILIATION',
          code: 'RS_DUPLICATE',
          digest: requestDigest,
          epoch: auth.fencingEpoch,
          message: 'Transport request ID was already used for different content.',
        });
      }
      if (
        typeof input.rawStatus !== 'string' ||
        input.rawStatus.length === 0 ||
        input.rawStatus.length > 64
      ) {
        fail('RS_MATERIAL_INVALID', 'Raw status must be a bounded string.');
      }
      const observation = normalizeRawStatus(input.rawStatus);
      const next = foldOutcome(state, input.rawStatus);
      const sequence = this.nextSequence(db, auth.sessionId);
      const virtualMs = input.virtualMs ?? null;
      const attemptId = this.insertAttempt(db, {
        runOperationId: input.runOperationId,
        sessionId: auth.sessionId,
        epoch: auth.fencingEpoch,
        transportRequestId: input.transportRequestId,
        phase: 'READ_ONLY_RECONCILIATION',
        virtualMs,
      });
      const exchangeId = this.insertExchange(db, {
        session,
        runOperationId: input.runOperationId,
        attemptId,
        epoch: auth.fencingEpoch,
        transportRequestId: input.transportRequestId,
        sequence,
        phase: 'READ_ONLY_RECONCILIATION',
        method: 'GET',
        route: '/v0/status',
        requestDigest,
        requestPayload: query,
        response: {
          status: 200,
          digest: digestValue('routespec.status-observation/1', { rawStatus: input.rawStatus }),
        },
        virtualMs,
      });
      if (input.deliveryPending !== true) {
        run(db, `UPDATE attempts SET outcome = 'SENT_RESPONSE_RECEIVED' WHERE attempt_id = ?`, attemptId);
      }
      this.insertEvent(db, {
        session,
        runOperationId: input.runOperationId,
        exchangeId,
        epoch: auth.fencingEpoch,
        sequence,
        kind: observation.known ? 'PROVIDER_STATUS' : 'PROVIDER_STATUS_UNKNOWN',
        rawStatus: input.rawStatus,
        fact: observation.fact,
        virtualMs,
      });
      const phaseUpdate =
        op['commit_binding_digest'] !== null ? `, current_phase = 'READ_ONLY_RECONCILIATION'` : '';
      run(
        db,
        `UPDATE run_operations SET accepted_terminal_status = ?, normalized_outcome = ?, outcome_flags_json = ?${phaseUpdate} WHERE run_operation_id = ?`,
        next.acceptedTerminal,
        next.outcome,
        json(next),
        input.runOperationId,
      );
      return {
        ack: true,
        duplicate: false,
        joined: false,
        runOperationId: input.runOperationId,
        attemptId,
        exchangeId,
        sequence,
        outcome: next.outcome,
        acceptedTerminal: next.acceptedTerminal,
        contradictory: next.contradictory,
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Evidence: separate class/scope/reason; single-use consumption; explicit aggregate allocation.

  recordEvidence(
    fence: ExecutionFence,
    input: {
      runOperationId: string | null;
      evidenceClass: EvidenceClass;
      evidenceScope: EvidenceScope;
      reasons: readonly EvidenceReason[];
      subject: string;
      sourceKind: string;
      assetId: string | null;
      amount: string | null;
      singleUse: boolean;
      payload: unknown;
      /** Optional recipient binding; only its digest is stored. */
      recipient?: string | null;
    },
  ): { evidenceId: string; sequence: number } {
    return this.tx('evidence.record', (db) => {
      const c = this.assertFence(db, fence);
      const sessionId = str(c, 'session_id');
      const s = one(db, 'SELECT * FROM sessions WHERE session_id = ?', sessionId) as Row;
      if (input.runOperationId !== null) {
        const op = one(
          db,
          'SELECT case_run_id FROM run_operations WHERE run_operation_id = ?',
          input.runOperationId,
        );
        if (!op || op['case_run_id'] !== fence.caseRunId)
          fail('RS_IDENTITY_MISMATCH', 'Evidence must bind a run operation of the same case run.');
      }
      const evidenceId = randomUUID();
      assertNoSecrets(input.payload, '$.payload');
      const payloadDigest = digestValue('routespec.evidence-payload/1', input.payload);
      parseContract('evidence-item', {
        schemaVersion: '1.0',
        evidenceId,
        integrationRevisionId: str(s, 'integration_revision_id'),
        buildRevisionId: str(s, 'build_revision_id'),
        artifactDigest: str(s, 'artifact_digest'),
        buildAttestationClass: str(s, 'subject_attestation_class'),
        caseLaunchAttestationId: strOrNull(s, 'case_launch_attestation_id'),
        gateRunId: str(s, 'gate_run_id'),
        caseRunId: fence.caseRunId,
        sessionId,
        scenarioRevisionId: str(s, 'scenario_revision_id'),
        effectCoveragePolicyDigest: str(s, 'effect_coverage_policy_digest'),
        effectManifestDigest: str(s, 'effect_manifest_digest'),
        fencingEpoch: fence.fencingEpoch,
        runOperationId: input.runOperationId,
        evidenceClass: input.evidenceClass,
        evidenceScope: input.evidenceScope,
        reasons: [...input.reasons],
        subject: input.subject,
        assetId: input.assetId,
        amount: input.amount,
        payloadDigest,
      });
      const sequence = this.nextSequence(db, sessionId);
      const recipient = input.recipient ?? null;
      if (recipient !== null && this.journal.schemaVersion < 3) {
        fail('RS_SCHEMA_VERSION_UNSUPPORTED', 'Recipient-bound evidence requires schema version 3.');
      }
      run(
        db,
        `INSERT INTO evidence_items(evidence_id, integration_revision_id, build_revision_id, artifact_digest, build_attestation_class,
           case_launch_attestation_id, gate_run_id, case_run_id, session_id, scenario_revision_id, effect_coverage_policy_digest,
           effect_manifest_digest, callsite_inventory_digest, interceptor_instance_id, fencing_epoch, run_operation_id, evidence_class,
           evidence_scope, reasons_json, subject, source_kind, asset_id, amount, single_use, payload_digest, sequence, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        evidenceId,
        str(s, 'integration_revision_id'),
        str(s, 'build_revision_id'),
        str(s, 'artifact_digest'),
        str(s, 'subject_attestation_class'),
        strOrNull(s, 'case_launch_attestation_id'),
        str(s, 'gate_run_id'),
        fence.caseRunId,
        sessionId,
        str(s, 'scenario_revision_id'),
        str(s, 'effect_coverage_policy_digest'),
        str(s, 'effect_manifest_digest'),
        strOrNull(s, 'callsite_inventory_digest'),
        strOrNull(s, 'interceptor_instance_id'),
        fence.fencingEpoch,
        input.runOperationId,
        input.evidenceClass,
        input.evidenceScope,
        json([...new Set(input.reasons)].sort()),
        input.subject,
        input.sourceKind,
        input.assetId,
        input.amount,
        input.singleUse ? 1 : 0,
        payloadDigest,
        sequence,
        this.now(),
      );
      if (recipient !== null) {
        run(
          db,
          'INSERT INTO evidence_recipients(evidence_id, recipient_digest) VALUES (?,?)',
          evidenceId,
          digestValue('routespec.evidence-recipient/1', recipient),
        );
      }
      return { evidenceId, sequence };
    });
  }

  private assertSameCaseOperation(db: DatabaseSync, evidence: Row, runOperationId: string): void {
    const op = one(
      db,
      'SELECT case_run_id, build_revision_id FROM run_operations WHERE run_operation_id = ?',
      runOperationId,
    );
    if (!op) fail('RS_NOT_FOUND', 'Run operation not found.');
    if (
      op['case_run_id'] !== evidence['case_run_id'] ||
      op['build_revision_id'] !== evidence['build_revision_id']
    ) {
      fail('RS_IDENTITY_MISMATCH', 'Evidence and run operation belong to different case/build identities.');
    }
  }

  /** Consume evidence for one operation predicate. Single-use evidence may close only one operation. */
  consumeEvidence(
    fence: ExecutionFence,
    input: { evidenceId: string; runOperationId: string; predicate: string; allocationId?: string },
  ): string {
    return this.tx('evidence.consume', (db) => {
      this.assertFence(db, fence);
      const ev = one(db, 'SELECT * FROM evidence_items WHERE evidence_id = ?', input.evidenceId);
      if (!ev) fail('RS_NOT_FOUND', 'Evidence not found.');
      this.assertSameCaseOperation(db, ev, input.runOperationId);
      const existing = one(
        db,
        'SELECT consumption_id FROM evidence_consumptions WHERE evidence_id = ? AND run_operation_id = ? AND predicate = ?',
        input.evidenceId,
        input.runOperationId,
        input.predicate,
      );
      if (existing) return str(existing, 'consumption_id');
      const consumptionId = randomUUID();
      run(
        db,
        'INSERT INTO evidence_consumptions(consumption_id, evidence_id, run_operation_id, predicate, allocation_id, created_at_ms) VALUES (?,?,?,?,?,?)',
        consumptionId,
        input.evidenceId,
        input.runOperationId,
        input.predicate,
        input.allocationId ?? null,
        this.now(),
      );
      return consumptionId;
    });
  }

  /** Explicit aggregate allocation: the parts must exactly partition the evidence amount (base units). */
  allocateEvidence(
    fence: ExecutionFence,
    input: { evidenceId: string; parts: ReadonlyArray<{ runOperationId: string; amount: string }> },
  ): string {
    return this.tx('evidence.allocate', (db) => {
      this.assertFence(db, fence);
      const ev = one(db, 'SELECT * FROM evidence_items WHERE evidence_id = ?', input.evidenceId);
      if (!ev) fail('RS_NOT_FOUND', 'Evidence not found.');
      const total = strOrNull(ev, 'amount');
      const asset = strOrNull(ev, 'asset_id');
      if (total === null || asset === null)
        fail('RS_ALLOCATION_INVALID', 'Only amount-bearing evidence can be allocated.');
      if (input.parts.length < 2)
        fail('RS_ALLOCATION_INVALID', 'An aggregate allocation needs at least two parts.');
      if (one(db, 'SELECT 1 AS x FROM evidence_consumptions WHERE evidence_id = ?', input.evidenceId)) {
        fail('RS_EVIDENCE_ALREADY_CONSUMED', 'Evidence was already consumed without an allocation.');
      }
      const seen = new Set<string>();
      let sum = 0n;
      for (const p of input.parts) {
        if (!/^(0|[1-9][0-9]{0,77})$/.test(p.amount) || p.amount === '0')
          fail('RS_ALLOCATION_INVALID', 'Allocation parts must be positive base-unit integers.');
        if (seen.has(p.runOperationId))
          fail('RS_ALLOCATION_INVALID', 'Allocation parts must target distinct operations.');
        seen.add(p.runOperationId);
        this.assertSameCaseOperation(db, ev, p.runOperationId);
        sum += BigInt(p.amount);
      }
      if (sum !== BigInt(total)) {
        fail('RS_ALLOCATION_INVALID', 'Allocation parts do not exactly partition the evidence amount.');
      }
      const allocationId = randomUUID();
      run(
        db,
        'INSERT INTO evidence_allocations(allocation_id, evidence_id, asset_id, total_amount, partition_digest, created_at_ms) VALUES (?,?,?,?,?,?)',
        allocationId,
        input.evidenceId,
        asset,
        total,
        digestValue('routespec.evidence-allocation/1', {
          evidenceId: input.evidenceId,
          parts: [...input.parts],
        }),
        this.now(),
      );
      for (const p of input.parts) {
        run(
          db,
          'INSERT INTO evidence_allocation_parts(allocation_id, run_operation_id, amount) VALUES (?,?,?)',
          allocationId,
          p.runOperationId,
          p.amount,
        );
      }
      return allocationId;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Evaluation persistence: all invariant results + case terminal transition in one fenced transaction.

  persistCaseEvaluation(
    fence: ExecutionFence,
    input: {
      verdict: Verdict;
      evaluatorRevision: string;
      invariantResults: ReadonlyArray<{
        invariantId: string;
        verdict: Verdict;
        runOperationId: string | null;
        evidenceIds: readonly string[];
        missingPredicates: readonly string[];
        reasons: readonly EvidenceReason[];
      }>;
      canonical: unknown;
      envelope: unknown;
    },
  ): { resultDigest: Digest } {
    const record = buildCaseResultRecord(input.canonical, input.envelope);
    if (
      record.canonical.verdict !== input.verdict ||
      record.canonical.caseRunId !== fence.caseRunId ||
      record.canonical.fencingEpoch !== fence.fencingEpoch
    ) {
      fail('RS_IDENTITY_MISMATCH', 'Canonical result does not match the fenced case evaluation.');
    }
    return this.tx('case.persist-evaluation', (db) => {
      const c = this.assertFence(db, fence);
      if (str(c, 'execution_lifecycle') !== 'RUNNING' && str(c, 'execution_lifecycle') !== 'EVALUATING') {
        fail('RS_PHASE_INVALID', 'Case run is not executing.');
      }
      const s = one(db, 'SELECT * FROM sessions WHERE session_id = ?', str(c, 'session_id')) as Row;
      if (
        record.canonical.sessionId !== str(s, 'session_id') ||
        record.canonical.buildRevisionId !== str(s, 'build_revision_id')
      ) {
        fail('RS_IDENTITY_MISMATCH', 'Canonical result identity does not match the session.');
      }
      if (str(c, 'execution_lifecycle') === 'RUNNING') {
        run(
          db,
          `UPDATE case_runs SET execution_lifecycle = 'EVALUATING' WHERE case_run_id = ?`,
          fence.caseRunId,
        );
        run(
          db,
          `UPDATE sessions SET execution_lifecycle = 'EVALUATING' WHERE session_id = ?`,
          str(s, 'session_id'),
        );
      }
      for (const ir of input.invariantResults) {
        const resultDigest = digestValue('routespec.invariant-result/1', {
          ...ir,
          caseRunId: fence.caseRunId,
          fencingEpoch: fence.fencingEpoch,
          evaluatorRevision: input.evaluatorRevision,
        });
        run(
          db,
          `INSERT INTO invariant_results(result_id, integration_revision_id, build_revision_id, artifact_digest, gate_run_id, case_run_id,
             session_id, scenario_revision_id, effect_coverage_policy_digest, effect_manifest_digest, run_operation_id, invariant_id, verdict,
             evaluator_revision, evidence_ids_json, missing_predicates_json, reasons_json, fencing_epoch, result_digest, created_at_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          randomUUID(),
          str(s, 'integration_revision_id'),
          str(s, 'build_revision_id'),
          str(s, 'artifact_digest'),
          str(s, 'gate_run_id'),
          fence.caseRunId,
          str(s, 'session_id'),
          str(s, 'scenario_revision_id'),
          str(s, 'effect_coverage_policy_digest'),
          str(s, 'effect_manifest_digest'),
          ir.runOperationId,
          ir.invariantId,
          ir.verdict,
          input.evaluatorRevision,
          json([...ir.evidenceIds]),
          json([...ir.missingPredicates]),
          json([...ir.reasons]),
          fence.fencingEpoch,
          resultDigest,
          this.now(),
        );
      }
      run(
        db,
        `INSERT INTO case_results(case_run_id, session_id, result_digest, canonical_json, envelope_digest, envelope_json, verdict,
           evaluator_revision, fencing_epoch, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        fence.caseRunId,
        str(s, 'session_id'),
        record.resultDigest,
        json(record.canonical),
        record.envelopeDigest,
        json(record.envelope),
        input.verdict,
        input.evaluatorRevision,
        fence.fencingEpoch,
        this.now(),
      );
      this.revokeActiveTokens(db, fence.caseRunId, 'CASE_TERMINAL', fence.fencingEpoch);
      run(
        db,
        `UPDATE case_runs SET execution_lifecycle = 'COMPLETED', verdict = ?, terminal_result_digest = ?, teardown_recorded_at_ms = ?,
           lease_owner_digest = NULL, lease_expires_at_ms = NULL WHERE case_run_id = ?`,
        input.verdict,
        record.resultDigest,
        this.now(),
        fence.caseRunId,
      );
      run(
        db,
        `UPDATE sessions SET execution_lifecycle = 'COMPLETED', verdict = ?, result_digest = ?, closed_at_ms = ?, lease_owner_digest = NULL,
           lease_expires_at_ms = NULL WHERE session_id = ?`,
        input.verdict,
        record.resultDigest,
        this.now(),
        str(s, 'session_id'),
      );
      return { resultDigest: record.resultDigest };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Maintenance: checkpoint, verified backup, storage-fault recovery.

  private recordMaintenance(db: DatabaseSync, kind: string, outcome: string, details: unknown): void {
    if (this.journal.schemaVersion < 2) return;
    run(
      db,
      'INSERT INTO maintenance_events(maintenance_id, kind, outcome, details_json, created_at_ms) VALUES (?,?,?,?,?)',
      randomUUID(),
      kind,
      outcome,
      json(details),
      this.now(),
    );
  }

  /** WAL checkpoint (TRUNCATE). An incomplete checkpoint is reported, never silently ignored. */
  checkpoint(): { complete: boolean; walFrames: number; checkpointedFrames: number } {
    if (!this.journal.isWritable) fail('RS_READ_ONLY_RECOVERY', 'Checkpoint requires a writable journal.');
    if (this.journal.faulted) fail('RS_STORAGE_UNAVAILABLE', 'Journal is in a storage-fault state.');
    let row: Row;
    try {
      row = this.journal.read((db) => one(db, 'PRAGMA wal_checkpoint(TRUNCATE)') as Row);
    } catch (error) {
      this.journal.setStorageFault('RS_STORAGE_UNAVAILABLE');
      throw new RouteSpecError(
        'RS_STORAGE_UNAVAILABLE',
        'WAL checkpoint failed; acknowledgements are suspended.',
        {
          details: { cause: error instanceof Error ? error.message.slice(0, 80) : 'unknown' },
        },
      );
    }
    const result = {
      complete: num(row, 'busy') === 0,
      walFrames: num(row, 'log'),
      checkpointedFrames: num(row, 'checkpointed'),
    };
    this.journal.transact('maintenance.checkpoint', (db) =>
      this.recordMaintenance(db, 'CHECKPOINT', result.complete ? 'COMPLETE' : 'INCOMPLETE', result),
    );
    return result;
  }

  /**
   * Write a transactionally consistent backup with `VACUUM INTO`, then verify it independently
   * (integrity_check, schema version, per-table row counts). Any failure enters the storage-fault
   * state: no further acknowledgement until `resumeAfterStorageFault()`.
   */
  backupVerified(destinationPath: string): { verified: true; tables: number; rows: number } {
    if (!this.journal.isWritable) fail('RS_READ_ONLY_RECOVERY', 'Backup requires a writable journal.');
    if (this.journal.faulted) fail('RS_STORAGE_UNAVAILABLE', 'Journal is in a storage-fault state.');
    const tables = this.journal.read((db) =>
      all(
        db,
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).map((r) => str(r, 'name')),
    );
    try {
      if (existsSync(destinationPath)) fail('RS_BACKUP_FAILED', 'Backup destination already exists.');
      // VACUUM INTO cannot run inside a transaction. Counts and copy are taken back-to-back on the
      // single writer connection with no interleaving writer (synchronous call + writer lock).
      const counts = this.journal.read((db) => {
        const c = Object.fromEntries(
          tables.map((t) => [t, num(one(db, `SELECT count(*) AS n FROM "${t}"`) as Row, 'n')]),
        );
        db.prepare('VACUUM INTO ?').run(destinationPath);
        return c;
      });
      const copy = new DatabaseSync(destinationPath, { readOnly: true });
      try {
        const integrity = one(copy, 'PRAGMA integrity_check') as Row;
        if (integrity['integrity_check'] !== 'ok') fail('RS_BACKUP_FAILED', 'Backup failed integrity_check.');
        const version = num(one(copy, 'SELECT MAX(version) AS v FROM schema_migrations') as Row, 'v');
        if (version !== this.journal.schemaVersion)
          fail('RS_BACKUP_FAILED', 'Backup schema version differs.');
        for (const t of tables) {
          if (num(one(copy, `SELECT count(*) AS n FROM "${t}"`) as Row, 'n') !== counts[t]) {
            fail('RS_BACKUP_FAILED', 'Backup row counts differ from the source snapshot.', { table: t });
          }
        }
      } finally {
        copy.close();
      }
      const rows = Object.values(counts).reduce((a, b) => a + b, 0);
      this.journal.transact('maintenance.backup', (db) =>
        this.recordMaintenance(db, 'BACKUP', 'VERIFIED', { tables: tables.length, rows }),
      );
      return { verified: true, tables: tables.length, rows };
    } catch (error) {
      this.journal.setStorageFault('RS_BACKUP_FAILED');
      try {
        if (existsSync(destinationPath)) unlinkSync(destinationPath);
      } catch {
        // leave unverified copy for inspection if it cannot be removed
      }
      if (error instanceof RouteSpecError && error.code === 'RS_BACKUP_FAILED') throw error;
      throw new RouteSpecError('RS_BACKUP_FAILED', 'Verified backup failed; acknowledgements are suspended.');
    }
  }

  /**
   * Leave the storage-fault state only after `PRAGMA quick_check` succeeds and every executing
   * case has been fenced into RECOVERY_REQUIRED (tokens revoked, epoch + 1). Work that was in
   * flight therefore resumes only through read-only reconciliation, never as PASS.
   */
  resumeAfterStorageFault(): { fencedCases: string[] } {
    const fault = this.journal.faulted;
    if (fault === null) return { fencedCases: [] };
    const check = this.journal.read((db) => one(db, 'PRAGMA quick_check') as Row);
    if (check['quick_check'] !== 'ok')
      fail('RS_STORAGE_CORRUPT', 'quick_check failed; journal stays fail-closed.');
    const fenced = this.journal.transactDuringFault('maintenance.resume', (db) => {
      const active = all(db, `SELECT * FROM case_runs WHERE execution_lifecycle IN ('RUNNING','EVALUATING')`);
      for (const c of active) this.markRecoveryRequired(db, c, 'STORAGE_FAULT');
      this.recordMaintenance(db, 'STORAGE_RESUME', 'COMPLETE', { fault, fencedCases: active.length });
      return active.map((c) => str(c, 'case_run_id'));
    });
    this.journal.clearStorageFault();
    return { fencedCases: fenced };
  }

  // -------------------------------------------------------------------------------------------
  // Reads (bounded, project-scoped by caller).

  // -------------------------------------------------------------------------------------------
  // M02: proxy support, case fencing on uncertainty, cancellation, interceptor channel.

  /**
   * Read-only verification of a client-presented case token and identity (no write). The proxy
   * uses it before applying a fault that needs no journal write (transport error before
   * acceptance), so an unauthenticated request can never consume a scenario step.
   */
  verifyCaseAuth(auth: CaseAuth, phase: OperationPhase | null): { sessionId: string; mode: Mode } {
    return this.journal.read((db) => {
      const { session } = this.authorize(db, auth, phase, false);
      return { sessionId: str(session, 'session_id'), mode: str(session, 'mode') as Mode };
    });
  }

  /**
   * Fence a running case immediately (INV-03): an accepted commit whose response was lost leaves
   * the outcome unknown, so the runner revokes every active token, increments the fencing epoch,
   * and moves the case to RECOVERY_REQUIRED in one transaction. Only `recoverCase` (one
   * RECONCILIATION_ONLY token) can resume it. Returns the new fencing epoch.
   */
  requireRecovery(
    fence: ExecutionFence,
    reason: 'OUTCOME_UNKNOWN' | 'RUNNER_CANCELLED',
  ): { fencingEpoch: number; revokedTokens: number } {
    return this.tx('case.require-recovery', (db) => {
      const c = this.assertFence(db, fence);
      if (str(c, 'execution_lifecycle') !== 'RUNNING') {
        fail('RS_PHASE_INVALID', 'Only a RUNNING case can be fenced for recovery.', {
          lifecycle: str(c, 'execution_lifecycle'),
        });
      }
      const revokedTokens = this.markRecoveryRequired(db, c, reason);
      return { fencingEpoch: fence.fencingEpoch + 1, revokedTokens };
    });
  }

  /**
   * Close client input for a running case (teardown before evaluation): revoke every active case
   * token so the subject client can no longer reach the case, and record the teardown time once.
   * The lifecycle stays RUNNING; only the evaluator (`persistCaseEvaluation`) moves it on.
   */
  closeCaseInput(fence: ExecutionFence): { revokedTokens: number } {
    return this.tx('case.close-input', (db) => {
      const c = this.assertFence(db, fence);
      if (str(c, 'execution_lifecycle') !== 'RUNNING') {
        fail('RS_PHASE_INVALID', 'Only a RUNNING case can close client input.', {
          lifecycle: str(c, 'execution_lifecycle'),
        });
      }
      const revokedTokens = this.revokeActiveTokens(
        db,
        fence.caseRunId,
        'CASE_INPUT_CLOSED',
        fence.fencingEpoch,
      );
      run(
        db,
        'UPDATE case_runs SET teardown_recorded_at_ms = ? WHERE case_run_id = ? AND teardown_recorded_at_ms IS NULL',
        this.now(),
        fence.caseRunId,
      );
      return { revokedTokens };
    });
  }

  /**
   * Cancel a case: revoke its tokens, record teardown, and close the lifecycle ABORTED without
   * a verdict. The gate aggregator (M06) treats an aborted required case as REVIEW.
   */
  abortCase(fence: ExecutionFence, reason: string): void {
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(reason)) fail('RS_SCHEMA_INVALID', 'Abort reason must be a code.');
    this.tx('case.abort', (db) => {
      const c = this.assertFence(db, fence);
      const lifecycle = str(c, 'execution_lifecycle');
      if (!['RUNNING', 'RECOVERY_REQUIRED', 'EVALUATING'].includes(lifecycle)) {
        fail('RS_PHASE_INVALID', 'Only an executing case can be aborted.', { lifecycle });
      }
      this.revokeActiveTokens(db, fence.caseRunId, reason, fence.fencingEpoch);
      run(
        db,
        `UPDATE case_runs SET execution_lifecycle = 'ABORTED', teardown_recorded_at_ms = ?, lease_owner_digest = NULL,
           lease_expires_at_ms = NULL WHERE case_run_id = ?`,
        this.now(),
        fence.caseRunId,
      );
      const sessionId = strOrNull(c, 'session_id');
      if (sessionId) {
        run(
          db,
          `UPDATE sessions SET execution_lifecycle = 'ABORTED', closed_at_ms = ?, lease_owner_digest = NULL,
             lease_expires_at_ms = NULL WHERE session_id = ?`,
          this.now(),
          sessionId,
        );
      }
      this.closeOpenInterceptors(db, fence.caseRunId, 'CASE_TERMINAL');
    });
  }

  private closeOpenInterceptors(db: DatabaseSync, caseRunId: string, reason: string): void {
    if (this.journal.schemaVersion < 3) return;
    for (const inst of all(
      db,
      'SELECT interceptor_instance_id FROM effect_interceptor_instances WHERE case_run_id = ? AND teardown_at_ms IS NULL',
      caseRunId,
    )) {
      const id = str(inst, 'interceptor_instance_id');
      run(
        db,
        'INSERT INTO interceptor_teardowns(interceptor_instance_id, reason, created_at_ms) VALUES (?,?,?)',
        id,
        reason,
        this.now(),
      );
      run(
        db,
        'UPDATE effect_interceptor_instances SET teardown_at_ms = ? WHERE interceptor_instance_id = ?',
        this.now(),
        id,
      );
    }
  }

  /**
   * Record a locally denied proxy request that could not be attributed to an authenticated case
   * (unknown route, bad host/origin, malformed transport). Only safe codes are stored: method,
   * a sanitized path, the error code, and the explicit no-upstream facts.
   */
  recordProxyDenial(input: {
    method: string;
    path: string;
    code: ErrorCode;
    sessionId?: string | null;
  }): void {
    const method = /^[A-Z]{1,16}$/.test(input.method) ? input.method : 'OTHER';
    const path = (input.path.split('?')[0] ?? '/').replace(/[^A-Za-z0-9/_.{}-]/g, '_').slice(0, 128);
    this.tx('proxy.denial', (db) => {
      run(
        db,
        `INSERT INTO audit_events(audit_id, action_code, subject_kind, subject_id, details_json, created_at_ms)
         VALUES (?, 'PROXY_REQUEST_DENIED', 'PROXY', ?, ?, ?)`,
        randomUUID(),
        input.sessionId ?? null,
        json({
          method,
          path,
          code: input.code,
          upstreamAttempted: false,
          credentialAttached: false,
          dnsAttempted: false,
        }),
        this.now(),
      );
    });
  }

  getScenarioRevision(scenarioRevisionId: string): Row | undefined {
    return this.journal.read((db) =>
      one(db, 'SELECT * FROM scenario_revisions WHERE scenario_revision_id = ?', scenarioRevisionId),
    );
  }

  /**
   * Register a separately launched boundary interceptor for one case (M02 deliverable 9). The
   * runner holds the execution fence; only the digest of the private channel key is stored. The
   * containment class is the honest platform result: without an OS/container sandbox that can
   * confine the subject process tree it is `DECLARED_HOOKS_ONLY`.
   */
  registerInterceptorInstance(
    fence: ExecutionFence,
    input: {
      interceptorProfileDigest: string;
      interceptorArtifactDigest: string;
      sandboxScopeDigest: string;
      supportedSinks: readonly string[];
      containment: 'PROCESS_TREE_ENFORCED' | 'DECLARED_HOOKS_ONLY';
      channelKeyDigest: string;
      peerPid: number;
      attestationId: string | null;
    },
  ): { interceptorInstanceId: string } {
    return this.tx('interceptor.register', (db) => {
      const c = this.assertFence(db, fence);
      if (str(c, 'execution_lifecycle') !== 'RUNNING') fail('RS_PHASE_INVALID', 'Case is not RUNNING.');
      const s = one(db, 'SELECT * FROM sessions WHERE session_id = ?', str(c, 'session_id')) as Row;
      const interceptorInstanceId = randomUUID();
      run(
        db,
        `INSERT INTO effect_interceptor_instances(interceptor_instance_id, interceptor_profile_digest, artifact_digest,
           sandbox_scope_digest, supported_sinks_json, build_revision_id, case_run_id, session_id, fencing_epoch, attestation_id,
           started_at_ms, teardown_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`,
        interceptorInstanceId,
        input.interceptorProfileDigest,
        input.interceptorArtifactDigest,
        input.sandboxScopeDigest,
        json([...new Set(input.supportedSinks)].sort()),
        str(s, 'build_revision_id'),
        fence.caseRunId,
        str(s, 'session_id'),
        fence.fencingEpoch,
        input.attestationId,
        this.now(),
      );
      run(
        db,
        `INSERT INTO interceptor_channels(interceptor_instance_id, channel_key_digest, gate_run_id, policy_digest, manifest_digest,
           containment, peer_pid, created_at_ms) VALUES (?,?,?,?,?,?,?,?)`,
        interceptorInstanceId,
        input.channelKeyDigest,
        str(s, 'gate_run_id'),
        str(s, 'effect_coverage_policy_digest'),
        str(s, 'effect_manifest_digest'),
        input.containment,
        input.peerPid,
        this.now(),
      );
      if (s['interceptor_instance_id'] === null) {
        run(
          db,
          'UPDATE sessions SET interceptor_instance_id = ? WHERE session_id = ?',
          interceptorInstanceId,
          str(s, 'session_id'),
        );
      }
      return { interceptorInstanceId };
    });
  }

  private assertChannel(db: DatabaseSync, channel: InterceptorChannelAuth): Row {
    const inst = one(
      db,
      `SELECT i.*, c.channel_key_digest, c.gate_run_id, c.policy_digest, c.manifest_digest, c.containment, c.peer_pid
         FROM effect_interceptor_instances i JOIN interceptor_channels c USING (interceptor_instance_id)
        WHERE i.interceptor_instance_id = ?`,
      channel.interceptorInstanceId,
    );
    if (!inst) fail('RS_CHANNEL_AUTH_FAILED', 'Interceptor channel is not recognized.');
    if (
      inst['channel_key_digest'] !== digestValue('routespec.interceptor-channel-key/1', channel.channelKey)
    ) {
      fail('RS_CHANNEL_AUTH_FAILED', 'Interceptor channel authentication failed.');
    }
    if (inst['teardown_at_ms'] !== null)
      fail('RS_INTERCEPTOR_TORN_DOWN', 'Interceptor instance was torn down.');
    return inst;
  }

  /**
   * Journal one independent boundary observation. Callable only with the private channel key of
   * a registered interceptor instance: no case token, control token, or subject path reaches it.
   * Every binding must equal the instance's registered binding at the case's current fencing
   * epoch. An exact duplicate frame is idempotent; a different frame at the same sequence fails.
   */
  recordBoundaryObservation(
    channel: InterceptorChannelAuth,
    obs: {
      sequence: number;
      frameDigest: string;
      buildRevisionId: string;
      gateRunId: string;
      caseRunId: string;
      sessionId: string;
      fencingEpoch: number;
      policyDigest: string;
      manifestDigest: string;
      interceptorProfileDigest: string;
      runOperationId: string | null;
      sinkClass: string;
      effectId: string;
      effectType: string;
      action: 'ATTEMPTED' | 'BLOCKED' | 'RELEASED';
      virtualMs: number | null;
    },
  ): { observationId: string; duplicate: boolean } {
    return this.tx('interceptor.observe', (db) => {
      const inst = this.assertChannel(db, channel);
      const binding: Array<[string, string | number]> = [
        ['build_revision_id', obs.buildRevisionId],
        ['gate_run_id', obs.gateRunId],
        ['case_run_id', obs.caseRunId],
        ['session_id', obs.sessionId],
        ['fencing_epoch', obs.fencingEpoch],
        ['policy_digest', obs.policyDigest],
        ['manifest_digest', obs.manifestDigest],
        ['interceptor_profile_digest', obs.interceptorProfileDigest],
      ];
      // (`interceptor_profile_digest` is the instance column; the others come from the channel.)
      for (const [column, claimed] of binding) {
        if (inst[column] !== claimed) {
          fail('RS_CHANNEL_BINDING_MISMATCH', 'Boundary observation binding differs from the instance.', {
            field: column,
          });
        }
      }
      const c = one(db, 'SELECT * FROM case_runs WHERE case_run_id = ?', obs.caseRunId) as Row;
      if (num(c, 'fencing_epoch') !== obs.fencingEpoch) {
        fail('RS_STALE_FENCING_EPOCH', 'Interceptor instance is bound to a stale fencing epoch.');
      }
      if (!(JSON.parse(str(inst, 'supported_sinks_json')) as string[]).includes(obs.sinkClass)) {
        fail('RS_SINK_UNSUPPORTED', 'Sink class is outside the interceptor profile.', {
          sinkClass: obs.sinkClass,
        });
      }
      if (obs.runOperationId !== null) {
        const op = one(
          db,
          'SELECT case_run_id FROM run_operations WHERE run_operation_id = ?',
          obs.runOperationId,
        );
        if (!op || op['case_run_id'] !== obs.caseRunId) {
          fail('RS_CHANNEL_BINDING_MISMATCH', 'Run operation belongs to a different case.');
        }
      }
      const prior = one(
        db,
        `SELECT o.observation_id, f.frame_digest FROM effect_boundary_observations o
           JOIN boundary_observation_frames f USING (observation_id) WHERE o.interceptor_instance_id = ? AND o.sequence = ?`,
        channel.interceptorInstanceId,
        obs.sequence,
      );
      if (prior) {
        if (prior['frame_digest'] === obs.frameDigest) {
          return { observationId: str(prior, 'observation_id'), duplicate: true };
        }
        fail('RS_DUPLICATE', 'A different boundary observation already holds this sequence.');
      }
      const s = one(db, 'SELECT * FROM sessions WHERE session_id = ?', obs.sessionId) as Row;
      const observationId = randomUUID();
      run(
        db,
        `INSERT INTO effect_boundary_observations(observation_id, interceptor_instance_id, build_revision_id, artifact_digest,
           policy_digest, manifest_digest, gate_run_id, case_run_id, session_id, run_operation_id, scenario_revision_id, sink_class,
           effect_id, action, fencing_epoch, sequence, virtual_ms, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        observationId,
        channel.interceptorInstanceId,
        obs.buildRevisionId,
        str(s, 'artifact_digest'),
        obs.policyDigest,
        obs.manifestDigest,
        obs.gateRunId,
        obs.caseRunId,
        obs.sessionId,
        obs.runOperationId,
        str(c, 'scenario_revision_id'),
        obs.sinkClass,
        obs.effectId,
        obs.action,
        obs.fencingEpoch,
        obs.sequence,
        obs.virtualMs,
        this.now(),
      );
      run(
        db,
        `INSERT INTO boundary_observation_frames(observation_id, effect_type, interceptor_profile_digest, callsite_inventory_digest,
           frame_digest) VALUES (?,?,?,?,?)`,
        observationId,
        obs.effectType,
        obs.interceptorProfileDigest,
        strOrNull(s, 'callsite_inventory_digest'),
        obs.frameDigest,
      );
      if (this.journal.schemaVersion >= 4) {
        // One total order with the case journal, so INV-04 can order a release frame against
        // the release authorization (migration 004).
        run(
          db,
          'INSERT INTO boundary_observation_order(observation_id, session_id, session_sequence) VALUES (?,?,?)',
          observationId,
          obs.sessionId,
          this.nextSequence(db, obs.sessionId),
        );
      }
      return { observationId, duplicate: false };
    });
  }

  /** Close an interceptor instance: orderly `TEARDOWN` from the interceptor or `CHANNEL_LOST`. */
  teardownInterceptor(channel: InterceptorChannelAuth, reason: 'TEARDOWN' | 'CHANNEL_LOST'): void {
    this.tx('interceptor.teardown', (db) => {
      const inst = this.assertChannel(db, channel);
      run(
        db,
        'INSERT INTO interceptor_teardowns(interceptor_instance_id, reason, created_at_ms) VALUES (?,?,?)',
        channel.interceptorInstanceId,
        reason,
        this.now(),
      );
      run(
        db,
        'UPDATE effect_interceptor_instances SET teardown_at_ms = ? WHERE interceptor_instance_id = ?',
        this.now(),
        str(inst, 'interceptor_instance_id'),
      );
    });
  }

  // -------------------------------------------------------------------------------------------
  // Protected-effect observation (M04): subject self-report, call-site inventory, release
  // authorization, interceptor coverage findings, and the consistent evaluation snapshot.

  /**
   * Record one subject-reported protected-effect observation (TDD.md section 18). The caller
   * presents the case token; every binding field through the fencing epoch is digested. An exact
   * retry (same idempotency key, same binding) returns the original report; a changed binding
   * under the same key, an undeclared or forged hook, or a foreign policy/manifest/operation
   * fails closed. The row is always `SUBJECT_REPORTED` correlation and never proves coverage.
   */
  recordSubjectEffectReport(
    auth: CaseAuth,
    input: {
      runOperationId: string | null;
      policyDigest: string;
      manifestDigest: string;
      hookId: string;
      hookRevision: string;
      effectId: string;
      effectType: string;
      action: 'ATTEMPTED' | 'BLOCKED' | 'RELEASED';
      idempotencyKey: string;
      virtualMs?: number | null;
    },
  ): {
    observationId: string;
    duplicate: boolean;
    sequence: number;
    coverageClassification: 'SUBJECT_REPORTED';
  } {
    for (const [field, value] of [
      ['hookId', input.hookId],
      ['hookRevision', input.hookRevision],
      ['effectId', input.effectId],
      ['effectType', input.effectType],
      ['idempotencyKey', input.idempotencyKey],
    ] as const) {
      if (typeof value !== 'string' || !/^[A-Za-z0-9._:@/-]{1,128}$/.test(value)) {
        fail('RS_MATERIAL_INVALID', 'Effect report field is not a bounded identifier.', { field });
      }
    }
    if (!['ATTEMPTED', 'BLOCKED', 'RELEASED'].includes(input.action)) {
      fail('RS_MATERIAL_INVALID', 'Effect report action is not supported.', { field: 'action' });
    }
    return this.tx('effect.subject-report', (db) => {
      const { session } = this.authorize(db, auth, null);
      const virtualMs = input.virtualMs ?? null;
      const binding = {
        buildRevisionId: auth.buildRevisionId,
        artifactDigest: auth.artifactDigest,
        gateRunId: auth.gateRunId,
        caseRunId: auth.caseRunId,
        sessionId: auth.sessionId,
        runOperationId: input.runOperationId,
        policyDigest: input.policyDigest,
        manifestDigest: input.manifestDigest,
        hookId: input.hookId,
        hookRevision: input.hookRevision,
        effectId: input.effectId,
        effectType: input.effectType,
        action: input.action,
        fencingEpoch: auth.fencingEpoch,
        virtualMs,
      };
      const resultDigest = digestValue('routespec.subject-effect-report/1', binding);
      const keyDigest = digestValue('routespec.effect-idempotency-key/1', input.idempotencyKey);
      const prior = one(
        db,
        'SELECT * FROM protected_effect_observations WHERE session_id = ? AND idempotency_key_digest = ?',
        auth.sessionId,
        keyDigest,
      );
      if (prior) {
        if (prior['result_digest'] === resultDigest) {
          return {
            observationId: str(prior, 'observation_id'),
            duplicate: true,
            sequence: num(prior, 'sequence'),
            coverageClassification: 'SUBJECT_REPORTED' as const,
          };
        }
        fail('RS_IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used for a different effect report.');
      }
      if (
        input.policyDigest !== str(session, 'effect_coverage_policy_digest') ||
        input.manifestDigest !== str(session, 'effect_manifest_digest')
      ) {
        fail('RS_IDENTITY_MISMATCH', 'Effect report names a policy or manifest other than the case binding.');
      }
      const hook = one(
        db,
        `SELECT h.* FROM effect_manifest_hooks h JOIN effect_manifests m USING (manifest_id)
          WHERE m.manifest_digest = ? AND h.hook_id = ?`,
        input.manifestDigest,
        input.hookId,
      );
      if (!hook || hook['hook_revision'] !== input.hookRevision || hook['effect_type'] !== input.effectType) {
        fail('RS_EFFECT_HOOK_UNDECLARED', 'Effect hook is not declared by the bound manifest.', {
          hookId: input.hookId,
        });
      }
      if (input.runOperationId !== null) {
        const op = one(
          db,
          'SELECT case_run_id FROM run_operations WHERE run_operation_id = ?',
          input.runOperationId,
        );
        if (!op || op['case_run_id'] !== auth.caseRunId) {
          fail('RS_IDENTITY_MISMATCH', 'Effect report names a run operation of a different case.');
        }
      }
      const sequence = this.nextSequence(db, auth.sessionId);
      const observationId = randomUUID();
      run(
        db,
        `INSERT INTO protected_effect_observations(observation_id, build_revision_id, gate_run_id, case_run_id, session_id,
           run_operation_id, policy_digest, manifest_digest, hook_id, hook_revision, effect_id, effect_type, action,
           idempotency_key_digest, fencing_epoch, sequence, coverage_classification, result_digest, virtual_ms, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'SUBJECT_REPORTED',?,?,?)`,
        observationId,
        auth.buildRevisionId,
        auth.gateRunId,
        auth.caseRunId,
        auth.sessionId,
        input.runOperationId,
        input.policyDigest,
        input.manifestDigest,
        input.hookId,
        input.hookRevision,
        input.effectId,
        input.effectType,
        input.action,
        keyDigest,
        auth.fencingEpoch,
        sequence,
        resultDigest,
        virtualMs,
        this.now(),
      );
      return {
        observationId,
        duplicate: false,
        sequence,
        coverageClassification: 'SUBJECT_REPORTED' as const,
      };
    });
  }

  /**
   * Register an immutable build-time call-site inventory for a build and manifest. Idempotent by
   * digest. Its attestation (if any) is selected by the caller; the kernel decides whether it is
   * acceptable. An inventory never replaces runtime interception.
   */
  registerCallsiteInventory(input: {
    buildRevisionId: string;
    manifestDigest: string;
    analyzerDigest: string;
    attestationId: string | null;
    callsites: ReadonlyArray<{
      callsiteId: string;
      sinkClass: string;
      hookId: string | null;
      dynamic: boolean;
    }>;
    unsupportedFindings: number;
  }): { inventoryId: string; inventoryDigest: Digest } {
    if (!Number.isInteger(input.unsupportedFindings) || input.unsupportedFindings < 0) {
      fail('RS_MATERIAL_INVALID', 'Unsupported finding count must be a non-negative integer.');
    }
    const callsites = [...input.callsites]
      .map((c) => ({
        callsiteId: c.callsiteId,
        sinkClass: c.sinkClass,
        hookId: c.hookId,
        dynamic: c.dynamic,
      }))
      .sort((a, b) => (a.callsiteId < b.callsiteId ? -1 : a.callsiteId > b.callsiteId ? 1 : 0));
    const body = {
      buildRevisionId: input.buildRevisionId,
      manifestDigest: input.manifestDigest,
      analyzerDigest: input.analyzerDigest,
      attestationId: input.attestationId,
      callsites,
      unsupportedFindings: input.unsupportedFindings,
    };
    const inventoryDigest = digestValue('routespec.effect-callsite-inventory/1', body);
    return this.tx('effect-inventory.register', (db) => {
      const existing = one(
        db,
        'SELECT inventory_id FROM effect_callsite_inventories WHERE inventory_digest = ?',
        inventoryDigest,
      );
      if (existing) return { inventoryId: str(existing, 'inventory_id'), inventoryDigest };
      const manifest = one(
        db,
        'SELECT build_revision_id FROM effect_manifests WHERE manifest_digest = ?',
        input.manifestDigest,
      );
      if (!manifest || manifest['build_revision_id'] !== input.buildRevisionId) {
        fail('RS_IDENTITY_MISMATCH', 'Inventory build and manifest do not belong together.');
      }
      const inventoryId = randomUUID();
      run(
        db,
        `INSERT INTO effect_callsite_inventories(inventory_id, build_revision_id, manifest_digest, analyzer_digest, attestation_id,
           inventory_json, unsupported_findings, inventory_digest, issued_at_ms) VALUES (?,?,?,?,?,?,?,?,?)`,
        inventoryId,
        input.buildRevisionId,
        input.manifestDigest,
        input.analyzerDigest,
        input.attestationId,
        json(callsites),
        input.unsupportedFindings,
        inventoryDigest,
        this.now(),
      );
      return { inventoryId, inventoryDigest };
    });
  }

  /**
   * Journal the runner's decision to release protected effects, citing the completion evidence
   * it relied on, at one session sequence. The cited evidence must belong to this case; whether it
   * was acceptable is the kernel's independent judgement (a weak citation makes a later release
   * a forbidden release).
   */
  recordEffectReleaseAuthorization(
    fence: ExecutionFence,
    input: { interceptorInstanceId: string | null; completionEvidenceIds: readonly string[] },
  ): { authorizationId: string; sequence: number; decisionDigest: Digest } {
    if (input.completionEvidenceIds.length === 0 || input.completionEvidenceIds.length > 64) {
      fail('RS_MATERIAL_INVALID', 'A release authorization cites between 1 and 64 evidence items.');
    }
    return this.tx('effect.release-authorization', (db) => {
      const c = this.assertFence(db, fence);
      if (str(c, 'execution_lifecycle') !== 'RUNNING') fail('RS_PHASE_INVALID', 'Case is not RUNNING.');
      const sessionId = str(c, 'session_id');
      const ids = [...new Set(input.completionEvidenceIds)].sort();
      for (const id of ids) {
        const ev = one(db, 'SELECT case_run_id FROM evidence_items WHERE evidence_id = ?', id);
        if (!ev || ev['case_run_id'] !== fence.caseRunId) {
          fail('RS_IDENTITY_MISMATCH', 'Release authorization cites evidence of a different case.');
        }
      }
      if (input.interceptorInstanceId !== null) {
        const inst = one(
          db,
          'SELECT case_run_id FROM effect_interceptor_instances WHERE interceptor_instance_id = ?',
          input.interceptorInstanceId,
        );
        if (!inst || inst['case_run_id'] !== fence.caseRunId) {
          fail('RS_IDENTITY_MISMATCH', 'Release authorization names an interceptor of a different case.');
        }
      }
      const decisionDigest = digestValue('routespec.effect-release-authorization/1', {
        caseRunId: fence.caseRunId,
        fencingEpoch: fence.fencingEpoch,
        interceptorInstanceId: input.interceptorInstanceId,
        completionEvidenceIds: ids,
      });
      const sequence = this.nextSequence(db, sessionId);
      const authorizationId = randomUUID();
      run(
        db,
        `INSERT INTO effect_release_authorizations(authorization_id, case_run_id, session_id, interceptor_instance_id, fencing_epoch,
           session_sequence, completion_evidence_ids_json, decision_digest, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)`,
        authorizationId,
        fence.caseRunId,
        sessionId,
        input.interceptorInstanceId,
        fence.fencingEpoch,
        sequence,
        json(ids),
        decisionDigest,
        this.now(),
      );
      return { authorizationId, sequence, decisionDigest };
    });
  }

  /**
   * Persist the engine-verified containment record of one contained subject launch (M14), once,
   * at teardown. The record cites the case's session and, when present, its interceptor
   * instance and the case-launch and interceptor-launch attestations; it is immutable.
   */
  recordSubjectContainment(input: {
    caseRunId: string;
    interceptorInstanceId: string | null;
    engine: string;
    engineVersion: string;
    imageId: string;
    containerId: string;
    containment: 'PROCESS_TREE_ENFORCED' | 'DECLARED_HOOKS_ONLY';
    findings: readonly string[];
    sandboxScopeDigest: string | null;
    scope: unknown;
    selfObservation: unknown;
    caseLaunchAttestationId: string | null;
    interceptorAttestationId: string | null;
    containerRemoved: boolean;
    teardown: unknown;
    startedAtMs: number;
  }): { containmentId: string; recordDigest: Digest } {
    if (this.journal.schemaVersion < 8)
      fail('RS_SCHEMA_VERSION_UNSUPPORTED', 'Containment records need schema 8.');
    return this.tx('containment.record', (db) => {
      const c = one(db, 'SELECT * FROM case_runs WHERE case_run_id = ?', input.caseRunId);
      if (!c || c['session_id'] === null) fail('RS_NOT_FOUND', 'Case run has no session.');
      if (input.interceptorInstanceId !== null) {
        const inst = one(
          db,
          'SELECT case_run_id FROM effect_interceptor_instances WHERE interceptor_instance_id = ?',
          input.interceptorInstanceId,
        );
        if (!inst || inst['case_run_id'] !== input.caseRunId)
          fail('RS_IDENTITY_MISMATCH', 'Containment names an interceptor of a different case.');
      }
      const containmentId = randomUUID();
      const tornDownAtMs = this.now();
      const record = {
        caseRunId: input.caseRunId,
        sessionId: str(c, 'session_id'),
        interceptorInstanceId: input.interceptorInstanceId,
        engine: input.engine,
        engineVersion: input.engineVersion,
        imageId: input.imageId,
        containerId: input.containerId,
        containment: input.containment,
        findings: [...input.findings].sort(),
        sandboxScopeDigest: input.sandboxScopeDigest,
        caseLaunchAttestationId: input.caseLaunchAttestationId,
        interceptorAttestationId: input.interceptorAttestationId,
        containerRemoved: input.containerRemoved,
      };
      const recordDigest = digestValue('routespec.subject-containment/1', record);
      run(
        db,
        `INSERT INTO subject_containments(containment_id, case_run_id, session_id, interceptor_instance_id, engine, engine_version,
           image_id, container_id, containment, findings_json, sandbox_scope_digest, scope_json, self_observation_json,
           case_launch_attestation_id, interceptor_attestation_id, container_removed, teardown_json, started_at_ms,
           torn_down_at_ms, record_digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        containmentId,
        input.caseRunId,
        str(c, 'session_id'),
        input.interceptorInstanceId,
        input.engine,
        input.engineVersion,
        input.imageId,
        input.containerId,
        input.containment,
        json(record.findings),
        input.sandboxScopeDigest,
        json(input.scope ?? null),
        json(input.selfObservation ?? null),
        input.caseLaunchAttestationId,
        input.interceptorAttestationId,
        input.containerRemoved ? 1 : 0,
        json(input.teardown ?? null),
        input.startedAtMs,
        tornDownAtMs,
        recordDigest,
      );
      return { containmentId, recordDigest };
    });
  }

  /** Containment records of one case (M14), oldest first. */
  listSubjectContainments(caseRunId: string): Row[] {
    if (this.journal.schemaVersion < 8) return [];
    return this.journal.read(
      (db) =>
        db
          .prepare('SELECT * FROM subject_containments WHERE case_run_id = ? ORDER BY started_at_ms, rowid')
          .all(caseRunId) as Row[],
    );
  }

  /** Evidence items journaled for one case, in commit order (M14 effect release decision). */
  listCaseEvidence(caseRunId: string): Row[] {
    return this.journal.read(
      (db) =>
        db
          .prepare('SELECT * FROM evidence_items WHERE case_run_id = ? ORDER BY rowid')
          .all(caseRunId) as Row[],
    );
  }

  /** Per-case effect-coverage policies of a gate run (M14). */
  listCasePolicies(gateRunId: string): Row[] {
    if (this.journal.schemaVersion < 8) return [];
    return this.journal.read(
      (db) =>
        db
          .prepare('SELECT * FROM gate_run_case_policies WHERE gate_run_id = ? ORDER BY rowid')
          .all(gateRunId) as Row[],
    );
  }

  /**
   * Journal a coverage defect reported by an authenticated interceptor over its private channel.
   * Exact duplicates are idempotent. Only the channel key reaches this path.
   */
  recordCoverageFinding(
    channel: InterceptorChannelAuth,
    input: {
      kind: 'PROCESS_TREE_ESCAPE' | 'UNSUPPORTED_DYNAMIC_CALL' | 'SINK_BYPASS';
      sinkClass: string | null;
      fencingEpoch: number;
      detailDigest: string;
    },
  ): { findingId: string; duplicate: boolean } {
    return this.tx('interceptor.coverage-finding', (db) => {
      const inst = this.assertChannel(db, channel);
      const c = one(db, 'SELECT * FROM case_runs WHERE case_run_id = ?', str(inst, 'case_run_id')) as Row;
      if (
        num(inst, 'fencing_epoch') !== input.fencingEpoch ||
        num(c, 'fencing_epoch') !== input.fencingEpoch
      ) {
        fail('RS_STALE_FENCING_EPOCH', 'Interceptor instance is bound to a stale fencing epoch.');
      }
      if (!['PROCESS_TREE_ESCAPE', 'UNSUPPORTED_DYNAMIC_CALL', 'SINK_BYPASS'].includes(input.kind)) {
        fail('RS_MATERIAL_INVALID', 'Coverage finding kind is not supported.');
      }
      const findingDigest = digestValue('routespec.effect-coverage-finding/1', {
        interceptorInstanceId: channel.interceptorInstanceId,
        kind: input.kind,
        sinkClass: input.sinkClass,
        fencingEpoch: input.fencingEpoch,
        detailDigest: input.detailDigest,
      });
      const prior = one(
        db,
        'SELECT finding_id FROM effect_coverage_findings WHERE interceptor_instance_id = ? AND finding_digest = ?',
        channel.interceptorInstanceId,
        findingDigest,
      );
      if (prior) return { findingId: str(prior, 'finding_id'), duplicate: true };
      const sessionId = str(inst, 'session_id');
      const findingId = randomUUID();
      run(
        db,
        `INSERT INTO effect_coverage_findings(finding_id, interceptor_instance_id, case_run_id, session_id, kind, sink_class,
           fencing_epoch, session_sequence, finding_digest, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        findingId,
        channel.interceptorInstanceId,
        str(inst, 'case_run_id'),
        sessionId,
        input.kind,
        input.sinkClass,
        input.fencingEpoch,
        this.nextSequence(db, sessionId),
        findingDigest,
        this.now(),
      );
      return { findingId, duplicate: false };
    });
  }

  listSubjectEffectReports(caseRunId: string): Row[] {
    return this.journal.read((db) =>
      all(
        db,
        'SELECT * FROM protected_effect_observations WHERE case_run_id = ? ORDER BY sequence',
        caseRunId,
      ),
    );
  }

  /**
   * One consistent read of every journal row the kernel evaluates for a case (TDD.md section 11).
   * Plain rows only: the pure kernel maps and validates them; this method computes nothing.
   */
  readEvaluationSnapshot(caseRunId: string): EvaluationSnapshotRows {
    return this.journal.read((db) => {
      const caseRun = one(db, 'SELECT * FROM case_runs WHERE case_run_id = ?', caseRunId);
      if (!caseRun) fail('RS_NOT_FOUND', 'Case run not found.');
      const sessionId = strOrNull(caseRun, 'session_id');
      if (sessionId === null) fail('RS_PHASE_INVALID', 'Case run never started a session.');
      const session = one(db, 'SELECT * FROM sessions WHERE session_id = ?', sessionId) as Row;
      const gateRun = one(
        db,
        'SELECT * FROM gate_runs WHERE gate_run_id = ?',
        str(caseRun, 'gate_run_id'),
      ) as Row;
      const scenario = one(
        db,
        `SELECT scenario_revision_id, scenario_stable_id, compiled_json, revision_digest, seed
           FROM scenario_revisions WHERE scenario_revision_id = ?`,
        str(caseRun, 'scenario_revision_id'),
      ) as Row;
      const policy =
        one(
          db,
          'SELECT * FROM effect_coverage_policies WHERE policy_digest = ?',
          str(session, 'effect_coverage_policy_digest'),
        ) ?? null;
      const manifest =
        one(
          db,
          'SELECT * FROM effect_manifests WHERE manifest_digest = ?',
          str(session, 'effect_manifest_digest'),
        ) ?? null;
      const manifestHooks = manifest
        ? all(
            db,
            'SELECT * FROM effect_manifest_hooks WHERE manifest_id = ? ORDER BY hook_id',
            str(manifest, 'manifest_id'),
          )
        : [];
      const inventoryDigest =
        (policy ? strOrNull(policy, 'callsite_inventory_digest') : null) ??
        strOrNull(session, 'callsite_inventory_digest');
      const inventory =
        inventoryDigest === null
          ? null
          : (one(
              db,
              'SELECT * FROM effect_callsite_inventories WHERE inventory_digest = ?',
              inventoryDigest,
            ) ?? null);
      const interceptors = all(
        db,
        `SELECT i.*, c.gate_run_id, c.policy_digest, c.manifest_digest, c.containment, c.peer_pid,
                t.reason AS teardown_reason
           FROM effect_interceptor_instances i JOIN interceptor_channels c USING (interceptor_instance_id)
           LEFT JOIN interceptor_teardowns t USING (interceptor_instance_id)
          WHERE i.case_run_id = ? ORDER BY i.started_at_ms, i.interceptor_instance_id`,
        caseRunId,
      );
      const v4 = this.journal.schemaVersion >= 4;
      const boundaryObservations = all(
        db,
        `SELECT o.*, f.effect_type, f.interceptor_profile_digest, f.callsite_inventory_digest, f.frame_digest,
                ${v4 ? 'q.session_sequence' : 'NULL AS session_sequence'}
           FROM effect_boundary_observations o JOIN boundary_observation_frames f USING (observation_id)
           ${v4 ? 'LEFT JOIN boundary_observation_order q USING (observation_id)' : ''}
          WHERE o.case_run_id = ? ORDER BY o.interceptor_instance_id, o.sequence`,
        caseRunId,
      );
      const attestationIds = new Set<string>();
      for (const id of [
        strOrNull(gateRun, 'build_attestation_id'),
        strOrNull(session, 'case_launch_attestation_id'),
        policy ? strOrNull(policy, 'selected_attestation_id') : null,
        inventory ? strOrNull(inventory, 'attestation_id') : null,
        ...interceptors.map((i) => strOrNull(i, 'attestation_id')),
      ]) {
        if (id !== null) attestationIds.add(id);
      }
      const attestations = [...attestationIds].sort().flatMap((id) => {
        const a = one(
          db,
          `SELECT a.*, p.enabled AS principal_enabled, p.revocation_epoch AS principal_current_revocation_epoch,
                  p.policy_digest AS principal_current_policy_digest
             FROM subject_attestations a JOIN attester_principals p USING (principal_id) WHERE a.attestation_id = ?`,
          id,
        );
        return a ? [a] : [];
      });
      const runOperations = all(
        db,
        'SELECT * FROM run_operations WHERE case_run_id = ? ORDER BY created_sequence',
        caseRunId,
      );
      const opIds = runOperations.map((o) => str(o, 'run_operation_id'));
      const byOps = (sql: string): Row[] => opIds.flatMap((id) => all(db, sql, id));
      return {
        caseRun,
        session,
        gateRun,
        scenario,
        policy,
        manifest,
        manifestHooks,
        inventory,
        attestations,
        interceptors,
        boundaryObservations,
        coverageFindings: v4
          ? all(
              db,
              'SELECT * FROM effect_coverage_findings WHERE case_run_id = ? ORDER BY session_sequence',
              caseRunId,
            )
          : [],
        releaseAuthorizations: v4
          ? all(
              db,
              'SELECT * FROM effect_release_authorizations WHERE case_run_id = ? ORDER BY session_sequence',
              caseRunId,
            )
          : [],
        subjectReports: all(
          db,
          'SELECT * FROM protected_effect_observations WHERE case_run_id = ? ORDER BY sequence',
          caseRunId,
        ),
        runOperations,
        lineage: byOps(
          `SELECT * FROM run_operation_lineage WHERE from_run_operation_id = ?1 OR to_run_operation_id = ?1
            ORDER BY relation, from_run_operation_id, to_run_operation_id`,
        ),
        quoteFinalizations: byOps('SELECT * FROM quote_finalizations WHERE run_operation_id = ?'),
        commitBindings: byOps('SELECT * FROM commit_bindings WHERE run_operation_id = ?'),
        attempts: all(
          db,
          'SELECT * FROM attempts WHERE session_id = ? ORDER BY run_operation_id, attempt_ordinal',
          sessionId,
        ),
        exchanges: all(db, 'SELECT * FROM proxy_exchanges WHERE session_id = ? ORDER BY sequence', sessionId),
        events: all(db, 'SELECT * FROM lifecycle_events WHERE session_id = ? ORDER BY sequence', sessionId),
        conflicts: all(
          db,
          'SELECT * FROM operation_conflicts WHERE session_id = ? ORDER BY created_at_ms, conflict_id',
          sessionId,
        ),
        tokens: all(
          db,
          `SELECT t.purpose, t.fencing_epoch, t.client_instance_digest, t.issued_at_ms, t.expires_at_ms,
                  r.reason_code AS revocation_reason, r.revoked_at_epoch
             FROM case_tokens t LEFT JOIN token_revocations r USING (token_digest)
            WHERE t.case_run_id = ? ORDER BY t.fencing_epoch, t.purpose`,
          caseRunId,
        ),
        evidence: all(
          db,
          `SELECT e.*, ${v4 || this.journal.schemaVersion >= 3 ? 'r.recipient_digest' : 'NULL AS recipient_digest'}
             FROM evidence_items e
             ${this.journal.schemaVersion >= 3 ? 'LEFT JOIN evidence_recipients r USING (evidence_id)' : ''}
            WHERE e.case_run_id = ? ORDER BY e.sequence`,
          caseRunId,
        ),
        consumptions: byOps(
          'SELECT * FROM evidence_consumptions WHERE run_operation_id = ? ORDER BY consumption_id',
        ),
        allocations: all(
          db,
          `SELECT a.*, p.run_operation_id AS part_run_operation_id, p.amount AS part_amount
             FROM evidence_allocations a JOIN evidence_allocation_parts p USING (allocation_id)
             JOIN evidence_items e USING (evidence_id)
            WHERE e.case_run_id = ? ORDER BY a.allocation_id, p.run_operation_id`,
          caseRunId,
        ),
      };
    });
  }

  getInterceptorInstance(interceptorInstanceId: string): Row | undefined {
    return this.journal.read((db) =>
      one(
        db,
        `SELECT i.*, c.gate_run_id, c.policy_digest, c.manifest_digest, c.containment, c.peer_pid, t.reason AS teardown_reason
           FROM effect_interceptor_instances i JOIN interceptor_channels c USING (interceptor_instance_id)
           LEFT JOIN interceptor_teardowns t USING (interceptor_instance_id) WHERE i.interceptor_instance_id = ?`,
        interceptorInstanceId,
      ),
    );
  }

  listBoundaryObservations(caseRunId: string): Row[] {
    return this.journal.read((db) =>
      all(
        db,
        `SELECT o.*, f.effect_type, f.interceptor_profile_digest, f.callsite_inventory_digest, f.frame_digest
           FROM effect_boundary_observations o JOIN boundary_observation_frames f USING (observation_id)
          WHERE o.case_run_id = ? ORDER BY o.interceptor_instance_id, o.sequence`,
        caseRunId,
      ),
    );
  }

  listAuditEvents(actionCode: string): Row[] {
    return this.journal.read((db) =>
      all(
        db,
        'SELECT * FROM audit_events WHERE action_code = ? ORDER BY created_at_ms, audit_id',
        actionCode,
      ),
    );
  }

  getCaseRun(caseRunId: string): Row | undefined {
    return this.journal.read((db) => one(db, 'SELECT * FROM case_runs WHERE case_run_id = ?', caseRunId));
  }

  getSession(sessionId: string): Row | undefined {
    return this.journal.read((db) => one(db, 'SELECT * FROM sessions WHERE session_id = ?', sessionId));
  }

  getGateRun(gateRunId: string): Row | undefined {
    return this.journal.read((db) => one(db, 'SELECT * FROM gate_runs WHERE gate_run_id = ?', gateRunId));
  }

  getRunOperation(runOperationId: string): Row | undefined {
    return this.journal.read((db) =>
      one(db, 'SELECT * FROM run_operations WHERE run_operation_id = ?', runOperationId),
    );
  }

  getQuoteFinalization(runOperationId: string): Row | undefined {
    return this.journal.read((db) =>
      one(db, 'SELECT * FROM quote_finalizations WHERE run_operation_id = ?', runOperationId),
    );
  }

  getCommitBinding(runOperationId: string): Row | undefined {
    return this.journal.read((db) =>
      one(db, 'SELECT * FROM commit_bindings WHERE run_operation_id = ?', runOperationId),
    );
  }

  getCaseResult(caseRunId: string): Row | undefined {
    return this.journal.read((db) => one(db, 'SELECT * FROM case_results WHERE case_run_id = ?', caseRunId));
  }

  listRunOperations(caseRunId: string): Row[] {
    return this.journal.read((db) =>
      all(db, 'SELECT * FROM run_operations WHERE case_run_id = ? ORDER BY created_sequence', caseRunId),
    );
  }

  listAttempts(runOperationId: string): Row[] {
    return this.journal.read((db) =>
      all(db, 'SELECT * FROM attempts WHERE run_operation_id = ? ORDER BY attempt_ordinal', runOperationId),
    );
  }

  listExchanges(sessionId: string, limit = 200): Row[] {
    return this.journal.read((db) =>
      all(
        db,
        'SELECT * FROM proxy_exchanges WHERE session_id = ? ORDER BY sequence LIMIT ?',
        sessionId,
        Math.min(Math.max(limit, 1), 1000),
      ),
    );
  }

  listEvents(sessionId: string, limit = 200): Row[] {
    return this.journal.read((db) =>
      all(
        db,
        'SELECT * FROM lifecycle_events WHERE session_id = ? ORDER BY sequence LIMIT ?',
        sessionId,
        Math.min(Math.max(limit, 1), 1000),
      ),
    );
  }

  listConflicts(sessionId: string): Row[] {
    return this.journal.read((db) =>
      all(
        db,
        'SELECT * FROM operation_conflicts WHERE session_id = ? ORDER BY created_at_ms, conflict_id',
        sessionId,
      ),
    );
  }

  listInvariantResults(caseRunId: string): Row[] {
    return this.journal.read((db) =>
      all(db, 'SELECT * FROM invariant_results WHERE case_run_id = ? ORDER BY invariant_id', caseRunId),
    );
  }

  listMaintenance(): Row[] {
    return this.journal.read((db) =>
      this.journal.schemaVersion >= 2
        ? all(db, 'SELECT * FROM maintenance_events ORDER BY created_at_ms')
        : [],
    );
  }

  countRows(table: string): number {
    if (!/^[a-z_]+$/.test(table)) fail('RS_SCHEMA_INVALID', 'Invalid table name.');
    return this.journal.read((db) => num(one(db, `SELECT count(*) AS n FROM ${table}`) as Row, 'n'));
  }
}
