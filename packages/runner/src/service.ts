/**
 * Gate runner (M06 deliverables 1, 2, 7, 8): immutable GateRun creation/validation/start,
 * isolated CaseRun scheduling under bounded parallelism, per-case token/client/reset lifecycle,
 * cancel, fenced recovery after interruption, case evaluation through the M04 kernel, and gate
 * aggregation persisted as one immutable evaluation.
 *
 * The runner orchestrates; it owns no verdict. Case verdicts come from the kernel over a fenced
 * journal snapshot, and the gate decision from the pure aggregator over a consistent gate
 * snapshot. It never invokes package scripts or project binaries: clients are reached only
 * through a `CaseDriver` (reviewed launcher channel).
 */
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import {
  ADAPTER_REVISION,
  RouteSpecError,
  digestValue,
  type ExecutionLifecycle,
  type SubjectAttestationClass,
  type Verdict,
  type CaseLineageRole,
} from '@routespec/contracts';
import {
  EVALUATOR_REVISION,
  evaluateCase,
  snapshotFromJournal,
  toPersistableEvaluation,
} from '@routespec/kernel';
import { CaseSupervisor, PROXY_REVISION, ScenarioProxy, type LaunchCredentials } from '@routespec/proxy';
import type { CompiledScenario } from '@routespec/scenario';
import {
  GateJournal,
  type ExecutionFence,
  type GateDefinitionView,
  type GateEvaluationView,
  type RouteSpecStore,
} from '@routespec/store';
import { aggregateGate, type GateDecision } from './aggregate.ts';
import type { CaseDriver, CaseDriverOutcome, CaseHandoff } from './driver.ts';
import { LAUNCHER_PROTOCOL } from './driver.ts';
import { expectedStates, gateInputFromSnapshot, type RuntimeRevisions } from './gate-snapshot.ts';
import { Logger } from './log.ts';
import { compiledFromRevision } from './scenarios.ts';

type Row = Record<string, unknown>;

export const RUNNER_REVISION = 'routespec-runner@1.0.0' as const;
export const RUNTIME_REVISIONS: RuntimeRevisions = Object.freeze({
  evaluatorRevision: EVALUATOR_REVISION,
  proxyRevision: PROXY_REVISION,
});

export type RunnerMode = 'SIMULATE' | 'REPLAY';

export interface GateRunRequest {
  readonly gate: GateDefinitionView | null;
  readonly projectId?: string;
  readonly buildRevisionId: string;
  readonly artifactDigest: string;
  readonly corpusRevisionId: string;
  readonly effectManifestDigest: string;
  readonly effectCoveragePolicyDigest: string;
  readonly mode: string;
  readonly maxParallelCases: number;
  readonly buildAttestation?: { attestationClass: SubjectAttestationClass; attestationId: string | null };
  readonly callsiteInventoryDigest?: string | null;
  readonly interceptorProfileDigest?: string | null;
  readonly lineageRole?: CaseLineageRole;
  /** Pinned revisions; default to this runtime's. A different pin is recorded, never upgraded. */
  readonly adapterRevision?: string;
  readonly evaluatorRevision?: string;
  readonly proxyRevision?: string;
}

export interface ValidationFinding {
  readonly code: string;
  readonly blocking: boolean;
}

export interface CaseRunReport {
  readonly caseRunId: string;
  readonly ordinal: number;
  readonly outcome: CaseDriverOutcome['kind'] | 'NOT_STARTED' | 'START_FAILED' | 'EVALUATION_FAILED';
  readonly lifecycle: ExecutionLifecycle;
  readonly verdict: Verdict | null;
  readonly code: string | null;
}

export interface GateServiceOptions {
  readonly leaseTtlMs?: number;
  readonly tokenTtlMs?: number;
  readonly ownerLabel?: string;
  readonly logger?: Logger;
  readonly runtime?: RuntimeRevisions;
  /** Non-canonical run metadata for case envelopes (never exported). */
  readonly dataDirectory?: string;
  /** Additional sink for re-issued credentials (control API: one-time hand-off on recover). */
  readonly onCredentials?: (caseRunId: string, credentials: LaunchCredentials) => void;
}

/** What a control-API-driven launcher receives when it starts one case (no driver involved). */
export interface ExternalCaseStart {
  readonly handoff: CaseHandoff;
}

/** One-time reconciliation-only hand-off after fenced recovery. */
export interface ExternalRecovery {
  readonly caseRunId: string;
  readonly previousEpoch: number;
  readonly credentials: LaunchCredentials;
  readonly revokedTokens: number;
}

const MODES: readonly string[] = ['SIMULATE', 'REPLAY'];

function codeOf(error: unknown): string {
  return error instanceof RouteSpecError ? error.code : 'RS_INTERNAL';
}

export class GateService {
  readonly store: RouteSpecStore;
  readonly gates: GateJournal;
  readonly logger: Logger;
  readonly runtime: RuntimeRevisions;
  readonly supervisor: CaseSupervisor;
  readonly tokenTtlMs: number;
  readonly leaseTtlMs: number;
  private readonly owner: string;
  private readonly dataDirectory: string;
  private proxy: ScenarioProxy | null = null;
  private proxyMode: RunnerMode | null = null;
  private driver: CaseDriver | null = null;
  private readonly startedAt = new Map<string, number>();
  private readonly credentialSink: ((caseRunId: string, credentials: LaunchCredentials) => void) | null;

  constructor(store: RouteSpecStore, options: GateServiceOptions = {}) {
    this.store = store;
    this.gates = new GateJournal(store);
    this.logger = options.logger ?? new Logger();
    this.runtime = options.runtime ?? RUNTIME_REVISIONS;
    this.leaseTtlMs = options.leaseTtlMs ?? 300_000;
    this.tokenTtlMs = options.tokenTtlMs ?? 600_000;
    const ownerLabel = options.ownerLabel ?? `runner-${randomBytes(8).toString('hex')}`;
    this.owner = digestValue('routespec.runner-owner/1', ownerLabel);
    this.dataDirectory = options.dataDirectory ?? 'unspecified';
    this.credentialSink = options.onCredentials ?? null;
    this.supervisor = new CaseSupervisor(store, {
      ownerLabel,
      leaseTtlMs: this.leaseTtlMs,
      tokenTtlMs: this.tokenTtlMs,
      onCredentials: (caseRunId, credentials) => this.onCredentials(caseRunId, credentials),
    });
  }

  private onCredentials(caseRunId: string, credentials: LaunchCredentials): void {
    this.logger.info('case.credentials-reissued', {
      caseRun: caseRunId,
      epoch: credentials.fencingEpoch,
      details: { purpose: credentials.purpose },
    });
    this.logger.metrics.increment('reconciliation_tokens_issued');
    this.driver?.pushCredentials(caseRunId, credentials);
    this.credentialSink?.(caseRunId, credentials);
  }

  // -------------------------------------------------------------------------------------------
  // GateRun creation and validation.

  /** Create the immutable GateRun (DRAFT) and its ordered CaseRuns (PENDING) in one transaction. */
  createGateRun(request: GateRunRequest): {
    gateRunId: string;
    caseRunIds: string[];
    identityDigest: string;
  } {
    if (!MODES.includes(request.mode)) {
      throw new RouteSpecError(
        'RS_MODE_POLICY_DENIED',
        'Gate runs execute only in the networkless SIMULATE or REPLAY modes; LIVE_DRY_PROBE is a separate compatibility probe.',
        { details: { mode: request.mode } },
      );
    }
    if (
      !Number.isInteger(request.maxParallelCases) ||
      request.maxParallelCases < 1 ||
      request.maxParallelCases > 64
    ) {
      throw new RouteSpecError('RS_SCHEMA_INVALID', 'Parallelism must be an integer between 1 and 64.');
    }
    if (request.gate !== null && request.gate.corpusRevisionId !== request.corpusRevisionId) {
      throw new RouteSpecError('RS_IDENTITY_MISMATCH', 'The gate pins a different corpus revision.', {
        details: { gateCorpus: request.gate.corpusRevisionId, requested: request.corpusRevisionId },
      });
    }
    const res = this.gates.readGateResolution({
      buildRevisionId: request.buildRevisionId,
      effectManifestDigest: request.effectManifestDigest,
      effectCoveragePolicyDigest: request.effectCoveragePolicyDigest,
      corpusRevisionId: request.corpusRevisionId,
      callsiteInventoryDigest: request.callsiteInventoryDigest ?? null,
    });
    if (!res.build || !res.integrationRevision)
      throw new RouteSpecError('RS_NOT_FOUND', 'Build revision not found.');
    if (res.build['artifact_digest'] !== request.artifactDigest) {
      throw new RouteSpecError(
        'RS_IDENTITY_MISMATCH',
        'The artifact digest is not the registered build artifact.',
      );
    }
    const projectId = String(res.build['project_id']);
    if (request.projectId !== undefined && request.projectId !== projectId) {
      throw new RouteSpecError('RS_IDENTITY_MISMATCH', 'Build belongs to another project.');
    }
    if (request.gate !== null && request.gate.projectId !== projectId) {
      throw new RouteSpecError('RS_IDENTITY_MISMATCH', 'Gate belongs to another project.');
    }
    if (res.corpusCases.length === 0)
      throw new RouteSpecError('RS_NOT_FOUND', 'Corpus revision has no cases.');
    if (!res.manifest) throw new RouteSpecError('RS_NOT_FOUND', 'Effect manifest not found.');
    if (!res.policy) throw new RouteSpecError('RS_NOT_FOUND', 'Effect coverage policy not found.');
    const attestation = request.buildAttestation ?? {
      attestationClass: 'USER_ASSERTED_LOCAL',
      attestationId: null,
    };
    const created = this.store.createGateRun({
      projectId,
      integrationRevisionId: String(res.build['integration_revision_id']),
      buildRevisionId: request.buildRevisionId,
      artifactDigest: request.artifactDigest,
      buildAttestation: attestation,
      corpusRevisionId: request.corpusRevisionId,
      protocolProfileId: String(res.integrationRevision['protocol_profile_id']),
      adapterRevision: request.adapterRevision ?? ADAPTER_REVISION,
      evaluatorRevision: request.evaluatorRevision ?? this.runtime.evaluatorRevision,
      proxyRevision: request.proxyRevision ?? this.runtime.proxyRevision,
      configurationDigest: String(res.integrationRevision['configuration_digest']),
      effectManifestDigest: request.effectManifestDigest,
      effectCoveragePolicyDigest: request.effectCoveragePolicyDigest,
      callsiteInventoryDigest: request.callsiteInventoryDigest ?? null,
      interceptorProfileDigest: request.interceptorProfileDigest ?? null,
      maxParallelCases: request.maxParallelCases,
      cases: res.corpusCases.map((c) => ({
        scenarioRevisionId: String(c['scenario_revision_id']),
        lineageRole: request.lineageRole ?? 'BASELINE',
        requiredInvariants: JSON.parse(String(c['required_invariants_json'])) as string[],
      })),
      ...(request.gate !== null ? { gateDefinitionRevisionId: request.gate.gateDefinitionRevisionId } : {}),
    });
    this.logger.metrics.increment('gate_runs_created');
    this.logger.info('gate.created', {
      gateRun: created.gateRunId,
      details: { cases: created.caseRunIds.length },
    });
    return created;
  }

  /**
   * DRAFT -> VALIDATING -> READY (cases PENDING -> VALIDATING -> READY), or ERROR with the
   * blocking findings. Non-blocking findings are honest limitations (for example a
   * declared-hooks-only policy that can only yield REVIEW for complete-effect predicates).
   */
  validateGateRun(gateRunId: string): { ready: boolean; findings: ValidationFinding[] } {
    const gate = this.mustGate(gateRunId);
    this.store.transitionGateRun(gateRunId, 'DRAFT', 'VALIDATING');
    const findings: ValidationFinding[] = [];
    const block = (code: string) => findings.push({ code, blocking: true });
    const note = (code: string) => findings.push({ code, blocking: false });
    const res = this.gates.readGateResolution({
      buildRevisionId: String(gate['build_revision_id']),
      effectManifestDigest: String(gate['effect_manifest_digest']),
      effectCoveragePolicyDigest: String(gate['effect_coverage_policy_digest']),
      corpusRevisionId: String(gate['corpus_revision_id']),
      callsiteInventoryDigest: (gate['callsite_inventory_digest'] as string | null) ?? null,
    });
    const m = res.manifest;
    const p = res.policy;
    if (!m) block('EFFECT_MANIFEST_NOT_FOUND');
    else {
      if (
        m['build_revision_id'] !== gate['build_revision_id'] ||
        m['artifact_digest'] !== gate['artifact_digest']
      ) {
        block('EFFECT_MANIFEST_BUILD_MISMATCH');
      }
      if (m['adapter_revision'] !== gate['adapter_revision']) block('EFFECT_MANIFEST_ADAPTER_MISMATCH');
    }
    if (!p) block('EFFECT_POLICY_NOT_FOUND');
    else {
      if (
        p['build_revision_id'] !== gate['build_revision_id'] ||
        p['artifact_digest'] !== gate['artifact_digest'] ||
        p['manifest_digest'] !== gate['effect_manifest_digest']
      ) {
        block('EFFECT_POLICY_IDENTITY_MISMATCH');
      }
      if ((p['callsite_inventory_digest'] ?? null) !== (gate['callsite_inventory_digest'] ?? null)) {
        block('EFFECT_POLICY_INVENTORY_MISMATCH');
      }
      if ((p['interceptor_profile_digest'] ?? null) !== (gate['interceptor_profile_digest'] ?? null)) {
        block('EFFECT_POLICY_INTERCEPTOR_MISMATCH');
      }
      if (p['basis'] === 'DECLARED_HOOKS_ONLY') note('DECLARED_HOOKS_ONLY_COMPLETE_EFFECT_REVIEW');
      if (p['interceptor_profile_digest'] === null) note('NO_INDEPENDENT_INTERCEPTOR');
    }
    if (gate['callsite_inventory_digest'] !== null && !res.inventory) block('CALLSITE_INVENTORY_NOT_FOUND');
    if (gate['adapter_revision'] !== ADAPTER_REVISION) block('ADAPTER_REVISION_UNSUPPORTED');
    if (gate['evaluator_revision'] !== this.runtime.evaluatorRevision)
      block('EVALUATOR_REVISION_UNAVAILABLE');
    if (gate['proxy_revision'] !== this.runtime.proxyRevision) block('PROXY_REVISION_UNAVAILABLE');
    if (!res.profiles.some((r) => r['profile_id'] === gate['protocol_profile_id']))
      block('PROTOCOL_PROFILE_NOT_FOUND');
    if (gate['build_attestation_class'] === 'USER_ASSERTED_LOCAL') note('BUILD_USER_ASSERTED_LOCAL');
    for (const c of this.caseRows(gateRunId)) {
      try {
        this.compiledFor(String(c['case_run_id']));
      } catch (error) {
        block(`SCENARIO_UNLOADABLE:${codeOf(error)}`);
      }
    }
    const ready = !findings.some((f) => f.blocking);
    for (const c of this.caseRows(gateRunId)) {
      const id = String(c['case_run_id']);
      this.store.transitionCaseRun(id, 'PENDING', 'VALIDATING');
      this.store.transitionCaseRun(id, 'VALIDATING', ready ? 'READY' : 'ERROR');
    }
    this.store.transitionGateRun(gateRunId, 'VALIDATING', ready ? 'READY' : 'ERROR');
    this.logger.info(ready ? 'gate.validated' : 'gate.validation-failed', {
      gateRun: gateRunId,
      details: { blocking: findings.filter((f) => f.blocking).length },
    });
    return { ready, findings };
  }

  startGateRun(gateRunId: string): void {
    this.store.transitionGateRun(gateRunId, 'READY', 'RUNNING');
    this.logger.info('gate.started', { gateRun: gateRunId });
  }

  /** Abandon a validated gate run before any case starts (READY cases -> ABORTED). */
  abortBeforeStart(gateRunId: string): void {
    const gate = this.mustGate(gateRunId);
    for (const c of this.caseRows(gateRunId)) {
      if (c['execution_lifecycle'] === 'READY') {
        this.store.transitionCaseRun(String(c['case_run_id']), 'READY', 'ABORTED');
      }
    }
    const from = String(gate['execution_lifecycle']) as ExecutionLifecycle;
    if (from === 'READY' || from === 'RUNNING') this.store.transitionGateRun(gateRunId, from, 'ABORTED');
  }

  // -------------------------------------------------------------------------------------------
  // Case execution.

  private async ensureProxy(mode: RunnerMode): Promise<ScenarioProxy> {
    if (this.proxy !== null) {
      if (this.proxyMode !== mode)
        throw new RouteSpecError('RS_MODE_POLICY_DENIED', 'Proxy mode cannot change.');
      return this.proxy;
    }
    this.proxy = await ScenarioProxy.start({
      store: this.store,
      mode,
      cases: this.supervisor,
      log: (e) => {
        this.logger.metrics.increment(`proxy_${e.code.toLowerCase()}`);
      },
    });
    this.proxyMode = mode;
    return this.proxy;
  }

  get proxyOrigin(): string | null {
    return this.proxy?.origin ?? null;
  }

  /**
   * Run every READY case of a RUNNING gate under bounded parallelism. Each case gets a fresh
   * session, client instance, and one-time token; the driver hands it to the reviewed launcher
   * and resolves when client input is closed. An aborted signal stops scheduling new cases and
   * cancels in-flight ones; unstarted cases become ABORTED (never silently PASS).
   */
  async executeCases(
    gateRunId: string,
    driver: CaseDriver,
    options: { mode?: RunnerMode; signal?: AbortSignal; parallelism?: number } = {},
  ): Promise<CaseRunReport[]> {
    const gate = this.mustGate(gateRunId);
    if (gate['execution_lifecycle'] !== 'RUNNING') {
      throw new RouteSpecError('RS_LIFECYCLE_TRANSITION_INVALID', 'Gate run is not RUNNING.');
    }
    const mode = options.mode ?? 'SIMULATE';
    const proxy = await this.ensureProxy(mode);
    this.driver = driver;
    const limit = Math.max(1, Math.min(Number(gate['max_parallel_cases']), options.parallelism ?? 64));
    const queue = this.caseRows(gateRunId).filter((c) => c['execution_lifecycle'] === 'READY');
    const reports: CaseRunReport[] = [];
    let active = 0;
    let first = true;
    const inFlight = new Set<string>();
    const onAbort = () => {
      for (const id of inFlight) driver.cancel(id, 'RUNNER_CANCELLED');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const worker = async (): Promise<void> => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        const caseRunId = String(next['case_run_id']);
        const ordinal = Number(next['case_ordinal']);
        if (options.signal?.aborted) {
          this.store.transitionCaseRun(caseRunId, 'READY', 'ABORTED');
          reports.push({
            caseRunId,
            ordinal,
            outcome: 'NOT_STARTED',
            lifecycle: 'ABORTED',
            verdict: null,
            code: null,
          });
          continue;
        }
        active++;
        this.logger.metrics.gaugeMax('parallel_cases_peak', active);
        inFlight.add(caseRunId);
        const firstCase = first;
        first = false;
        try {
          reports.push(await this.runOneCase(caseRunId, ordinal, mode, proxy.origin, driver, firstCase));
        } finally {
          inFlight.delete(caseRunId);
          active--;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, queue.length)) }, () => worker()));
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
    if (options.signal?.aborted) {
      const g = this.mustGate(gateRunId);
      if (g['execution_lifecycle'] === 'RUNNING')
        this.store.transitionGateRun(gateRunId, 'RUNNING', 'ABORTED');
    }
    return reports.sort((a, b) => a.ordinal - b.ordinal);
  }

  private async runOneCase(
    caseRunId: string,
    ordinal: number,
    mode: RunnerMode,
    origin: string,
    driver: CaseDriver,
    firstCase: boolean,
  ): Promise<CaseRunReport> {
    const gate = this.mustGate(String(this.mustCase(caseRunId)['gate_run_id']));
    let compiled: CompiledScenario;
    let credentials: LaunchCredentials;
    try {
      compiled = this.compiledFor(caseRunId);
      credentials = this.supervisor.startCase({ caseRunId, compiled, mode });
    } catch (error) {
      this.logger.error('case.start-failed', { caseRun: caseRunId, details: { code: codeOf(error) } });
      const c = this.mustCase(caseRunId);
      if (c['execution_lifecycle'] === 'READY') this.store.transitionCaseRun(caseRunId, 'READY', 'ERROR');
      return this.report(caseRunId, ordinal, 'START_FAILED', codeOf(error));
    }
    this.startedAt.set(caseRunId, Date.now());
    this.logger.metrics.increment('cases_started');
    this.logger.info('case.started', {
      gateRun: String(gate['gate_run_id']),
      caseRun: caseRunId,
      session: credentials.sessionId,
      epoch: credentials.fencingEpoch,
    });
    const handoff: CaseHandoff = {
      protocol: LAUNCHER_PROTOCOL,
      gateRunId: String(gate['gate_run_id']),
      caseRunId,
      ordinal,
      scenarioRevisionId: String(this.mustCase(caseRunId)['scenario_revision_id']),
      scenarioStableId: compiled.revisionInput.scenarioStableId,
      mode,
      proxyOrigin: origin,
      credentials,
      tokenTtlMs: this.tokenTtlMs,
      buildAttestationClass: String(gate['build_attestation_class']),
      firstCase,
    };
    let outcome: CaseDriverOutcome;
    try {
      outcome = await driver.runCase(handoff);
    } catch (error) {
      outcome = { kind: 'CLIENT_FAILED', code: codeOf(error) };
    }
    if (outcome.kind !== 'INPUT_CLOSED') {
      try {
        this.supervisor.abort(caseRunId, outcome.kind === 'CANCELLED' ? 'RUNNER_CANCELLED' : 'CLIENT_FAILED');
      } catch (error) {
        this.logger.error('case.abort-failed', { caseRun: caseRunId, details: { code: codeOf(error) } });
      }
      this.logger.metrics.increment('cases_aborted');
      this.logger.warn('case.aborted', { caseRun: caseRunId, details: { outcome: outcome.kind } });
      return this.report(
        caseRunId,
        ordinal,
        outcome.kind,
        outcome.kind === 'CLIENT_FAILED' ? outcome.code : outcome.reason,
      );
    }
    try {
      this.evaluateSupervisedCase(caseRunId);
      return this.report(caseRunId, ordinal, 'INPUT_CLOSED', null);
    } catch (error) {
      this.logger.error('case.evaluation-failed', { caseRun: caseRunId, details: { code: codeOf(error) } });
      return this.report(caseRunId, ordinal, 'EVALUATION_FAILED', codeOf(error));
    }
  }

  private report(
    caseRunId: string,
    ordinal: number,
    outcome: CaseRunReport['outcome'],
    code: string | null,
  ): CaseRunReport {
    const c = this.mustCase(caseRunId);
    return {
      caseRunId,
      ordinal,
      outcome,
      lifecycle: String(c['execution_lifecycle']) as ExecutionLifecycle,
      verdict: (c['verdict'] as Verdict | null) ?? null,
      code,
    };
  }

  private envelope(caseRunId: string): Record<string, unknown> {
    const started = this.startedAt.get(caseRunId);
    return {
      schemaVersion: '1.0',
      wallClockStartedAt: new Date(started ?? Date.now()).toISOString(),
      wallClockEndedAt: new Date().toISOString(),
      hostName: hostname().slice(0, 256),
      platform: process.platform,
      arch: process.arch,
      runtimeVersion: process.version,
      dataDirectory: this.dataDirectory.slice(0, 4096),
      workingDirectory: process.cwd().slice(0, 4096),
      artifactPaths: [],
      displayLabels: { runner: RUNNER_REVISION },
    };
  }

  /** Kernel evaluation from the fenced journal snapshot and one fenced persistence transaction. */
  private evaluateWithFence(caseRunId: string, fence: ExecutionFence): Verdict {
    const t0 = performance.now();
    const input = snapshotFromJournal(this.store.readEvaluationSnapshot(caseRunId));
    const evaluation = evaluateCase(input);
    const p = toPersistableEvaluation(input, evaluation);
    this.store.persistCaseEvaluation(fence, {
      verdict: p.verdict,
      evaluatorRevision: p.evaluatorRevision,
      invariantResults: p.invariantResults,
      canonical: p.canonical,
      envelope: this.envelope(caseRunId),
    });
    this.logger.metrics.increment('evaluator_runs');
    this.logger.metrics.increment('evaluator_ms_total', Math.round(performance.now() - t0));
    this.logger.metrics.increment(`cases_${p.verdict.toLowerCase()}`);
    this.logger.info('case.evaluated', {
      caseRun: caseRunId,
      epoch: fence.fencingEpoch,
      details: { verdict: p.verdict },
    });
    return p.verdict;
  }

  /** Teardown (close client input, revoke tokens), then evaluate a case this runner supervises. */
  evaluateSupervisedCase(caseRunId: string): Verdict {
    this.supervisor.teardown(caseRunId);
    return this.evaluateWithFence(caseRunId, this.supervisor.fenceFor(caseRunId));
  }

  /**
   * Restart recovery (TDD section 15): expired RUNNING/EVALUATING leases become
   * RECOVERY_REQUIRED; each interrupted case of this gate is recorded as interrupted, recovered
   * through compare-and-set (exactly one reconciliation-only token, never handed to a client
   * here), its input closed, and deterministically re-evaluated from the fenced snapshot. An
   * interrupted case never contributes PASS to the gate. A case whose lease is still held is
   * left alone (its runner may still be alive).
   */
  recoverInterruptedCases(
    gateRunId: string,
  ): Array<{ caseRunId: string; verdict: Verdict | null; code: string | null }> {
    this.store.recoverExpiredLeases();
    const out: Array<{ caseRunId: string; verdict: Verdict | null; code: string | null }> = [];
    for (const c of this.caseRows(gateRunId)) {
      if (String(c['execution_lifecycle']) !== 'RECOVERY_REQUIRED') continue;
      out.push(this.recoverOne(c));
    }
    return out;
  }

  recoverCase(caseRunId: string): { caseRunId: string; verdict: Verdict | null; code: string | null } {
    this.store.recoverExpiredLeases();
    const c = this.mustCase(caseRunId);
    if (c['execution_lifecycle'] !== 'RECOVERY_REQUIRED') {
      const lifecycle = String(c['execution_lifecycle']);
      if (lifecycle === 'RUNNING' || lifecycle === 'EVALUATING') {
        throw new RouteSpecError('RS_LEASE_HELD', 'Case lease is still held; recovery is not permitted yet.');
      }
      throw new RouteSpecError('RS_RECOVERY_NOT_REQUIRED', 'Case run is not in a recoverable state.', {
        details: { lifecycle },
      });
    }
    return this.recoverOne(c);
  }

  private recoverOne(c: Row): { caseRunId: string; verdict: Verdict | null; code: string | null } {
    const caseRunId = String(c['case_run_id']);
    const epoch = Number(c['fencing_epoch']);
    try {
      this.gates.recordCaseInterruption({ caseRunId, fencingEpoch: epoch, kind: 'LEASE_EXPIRED' });
      const recovered = this.store.recoverCase({
        caseRunId,
        recoveryOwnerDigest: this.owner,
        clientInstanceDigest: String(c['client_instance_digest']),
        expectedFencingEpoch: epoch,
        leaseTtlMs: this.leaseTtlMs,
        tokenTtlMs: this.tokenTtlMs,
      });
      const fence: ExecutionFence = {
        caseRunId,
        leaseOwnerDigest: this.owner,
        fencingEpoch: recovered.fencingEpoch,
      };
      this.logger.warn('case.recovered', { caseRun: caseRunId, epoch: recovered.fencingEpoch });
      this.store.closeCaseInput(fence);
      return { caseRunId, verdict: this.evaluateWithFence(caseRunId, fence), code: null };
    } catch (error) {
      this.logger.error('case.recovery-failed', { caseRun: caseRunId, details: { code: codeOf(error) } });
      return { caseRunId, verdict: null, code: codeOf(error) };
    }
  }

  // -------------------------------------------------------------------------------------------
  // Control-API-driven cases: the caller is the reviewed launcher and receives the hand-off
  // directly; the runner still owns the fence, teardown, and kernel evaluation.

  /** Start (or reuse) the networkless proxy for this service and return its origin. */
  async openProxy(mode: RunnerMode): Promise<string> {
    return (await this.ensureProxy(mode)).origin;
  }

  /** Start one READY case of a RUNNING gate and return its one-time hand-off. */
  startExternalCase(caseRunId: string, mode: RunnerMode): ExternalCaseStart {
    if (this.proxy === null || this.proxyMode !== mode) {
      throw new RouteSpecError('RS_MODE_POLICY_DENIED', 'The proxy for this mode is not running.');
    }
    const c = this.mustCase(caseRunId);
    const gate = this.mustGate(String(c['gate_run_id']));
    const compiled = this.compiledFor(caseRunId);
    const firstCase = !this.caseRows(String(gate['gate_run_id'])).some(
      (r) => r['case_run_id'] !== caseRunId && r['session_id'] !== null && r['session_id'] !== undefined,
    );
    const credentials = this.supervisor.startCase({ caseRunId, compiled, mode });
    this.startedAt.set(caseRunId, Date.now());
    this.logger.metrics.increment('cases_started');
    return {
      handoff: {
        protocol: LAUNCHER_PROTOCOL,
        gateRunId: String(gate['gate_run_id']),
        caseRunId,
        ordinal: Number(c['case_ordinal']),
        scenarioRevisionId: String(c['scenario_revision_id']),
        scenarioStableId: compiled.revisionInput.scenarioStableId,
        mode,
        proxyOrigin: this.proxy.origin,
        credentials,
        tokenTtlMs: this.tokenTtlMs,
        buildAttestationClass: String(gate['build_attestation_class']),
        firstCase,
      },
    };
  }

  /** Client input is closed: teardown (revoke tokens, record runtime evidence) and evaluate. */
  finishExternalCase(caseRunId: string): Verdict {
    if (this.supervisor.supervises(caseRunId)) return this.evaluateSupervisedCase(caseRunId);
    const c = this.mustCase(caseRunId);
    const fence: ExecutionFence = {
      caseRunId,
      leaseOwnerDigest: this.owner,
      fencingEpoch: Number(c['fencing_epoch']),
    };
    this.store.closeCaseInput(fence);
    return this.evaluateWithFence(caseRunId, fence);
  }

  /** Cancel a started case: revoke tokens, stop new exchanges, record ABORTED. */
  abortExternalCase(caseRunId: string, reason: string): void {
    if (this.supervisor.supervises(caseRunId)) {
      this.supervisor.abort(caseRunId, reason);
      return;
    }
    const c = this.mustCase(caseRunId);
    this.store.abortCase(
      { caseRunId, leaseOwnerDigest: this.owner, fencingEpoch: Number(c['fencing_epoch']) },
      reason,
    );
  }

  /**
   * Fenced recovery for an external launcher: an expired lease (or RECOVERY_REQUIRED) is
   * recorded as an interruption, the stale token is revoked, the epoch advances, and exactly
   * one RECONCILIATION_ONLY token bound to the case's original client instance is returned.
   */
  recoverForReconciliation(caseRunId: string): ExternalRecovery {
    const prior = this.mustCase(caseRunId);
    // Fencing advances the epoch by one; the revoked authority belonged to the epoch before it.
    const previousEpoch =
      String(prior['execution_lifecycle']) === 'RECOVERY_REQUIRED'
        ? Number(prior['fencing_epoch']) - 1
        : Number(prior['fencing_epoch']);
    this.store.recoverExpiredLeases();
    const c = this.mustCase(caseRunId);
    const lifecycle = String(c['execution_lifecycle']);
    const epoch = Number(c['fencing_epoch']);
    if (lifecycle !== 'RECOVERY_REQUIRED') {
      if (lifecycle === 'RUNNING' || lifecycle === 'EVALUATING') {
        throw new RouteSpecError('RS_LEASE_HELD', 'Case lease is still held; recovery is not permitted yet.');
      }
      throw new RouteSpecError('RS_RECOVERY_NOT_REQUIRED', 'Case run is not in a recoverable state.', {
        details: { lifecycle },
      });
    }
    this.gates.recordCaseInterruption({ caseRunId, fencingEpoch: epoch, kind: 'LEASE_EXPIRED' });
    const recovered = this.store.recoverCase({
      caseRunId,
      recoveryOwnerDigest: this.owner,
      clientInstanceDigest: String(c['client_instance_digest']),
      expectedFencingEpoch: epoch,
      leaseTtlMs: this.leaseTtlMs,
      tokenTtlMs: this.tokenTtlMs,
    });
    this.supervisor.adoptFence(caseRunId, recovered.fencingEpoch);
    this.logger.warn('case.recovered', { caseRun: caseRunId, epoch: recovered.fencingEpoch });
    return {
      caseRunId,
      previousEpoch,
      revokedTokens: recovered.revokedTokens,
      credentials: {
        purpose: 'RECONCILIATION_ONLY',
        token: recovered.token,
        sessionId: recovered.auth.sessionId,
        caseRunId,
        adapterRevision: recovered.auth.adapterRevision,
        fencingEpoch: recovered.fencingEpoch,
        clientInstanceId: this.supervisor.clientInstanceOf(caseRunId) ?? '',
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Gate evaluation.

  /** Compute the gate decision from one consistent snapshot (no write). */
  computeDecision(gateRunId: string): GateDecision {
    return aggregateGate(gateInputFromSnapshot(this.gates.readGateSnapshot(gateRunId), this.runtime));
  }

  /**
   * Persist a new immutable gate evaluation (or return the identical existing one). A RUNNING
   * gate whose cases are all terminal is closed COMPLETED with the decision as its verdict in
   * the same transaction. Artifact readiness is not an input.
   */
  evaluateGate(gateRunId: string): {
    evaluation: GateEvaluationView;
    decision: GateDecision;
    created: boolean;
  } {
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = this.gates.readGateSnapshot(gateRunId);
      const decision = aggregateGate(gateInputFromSnapshot(rows, this.runtime));
      const terminal = rows.caseRuns.every((c) =>
        ['COMPLETED', 'ABORTED', 'ERROR'].includes(String(c['execution_lifecycle'])),
      );
      try {
        const { gateEvaluationId, created } = this.gates.persistGateEvaluation({
          gateRunId,
          gateDefinitionRevisionId: decision.identity.gateDefinitionRevisionId,
          identity: decision.identity,
          identityDigest: decision.identityDigest,
          caseResultDigests: decision.caseResultDigests,
          decision: decision.decision,
          findings: decision.findings,
          decisionDigest: decision.decisionDigest,
          enforcementMode: decision.enforcement.mode,
          enforcementDigest: decision.enforcement.digest,
          aggregatorRevision: decision.aggregatorRevision,
          runtime: this.runtime,
          cases: decision.cases.map((c) => ({
            ordinal: c.ordinal,
            caseRunId: c.caseRunId,
            required: c.required,
            lifecycle: c.lifecycle,
            caseVerdict: c.caseVerdict,
            resultDigest: c.resultDigest,
            fencingEpoch: c.fencingEpoch,
            contribution: c.contribution,
            findings: c.findings,
          })),
          expected: expectedStates(rows),
          closeGateRun: terminal,
        });
        this.logger.info('gate.evaluated', {
          gateRun: gateRunId,
          details: { decision: decision.decision, created },
        });
        return { evaluation: this.gates.getGateEvaluation(gateEvaluationId), decision, created };
      } catch (error) {
        if (error instanceof RouteSpecError && error.code === 'RS_REVISION_CONFLICT' && attempt < 2) continue;
        throw error;
      }
    }
    throw new RouteSpecError('RS_REVISION_CONFLICT', 'Gate state kept changing during evaluation.');
  }

  async close(): Promise<void> {
    this.driver = null;
    if (this.proxy) await this.proxy.close();
    this.proxy = null;
  }

  // -------------------------------------------------------------------------------------------

  private mustGate(gateRunId: string): Row {
    const g = this.store.getGateRun(gateRunId);
    if (!g) throw new RouteSpecError('RS_NOT_FOUND', 'Gate run not found.');
    return g;
  }

  private mustCase(caseRunId: string): Row {
    const c = this.store.getCaseRun(caseRunId);
    if (!c) throw new RouteSpecError('RS_NOT_FOUND', 'Case run not found.');
    return c;
  }

  caseRows(gateRunId: string): Row[] {
    return [...this.gates.readGateSnapshot(gateRunId).caseRuns] as Row[];
  }

  private compiledFor(caseRunId: string): CompiledScenario {
    const c = this.mustCase(caseRunId);
    const row = this.store.getScenarioRevision(String(c['scenario_revision_id']));
    if (!row) throw new RouteSpecError('RS_NOT_FOUND', 'Scenario revision not found.');
    return compiledFromRevision(row);
  }
}
