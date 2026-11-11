/**
 * Test fixtures that drive the real repository API (no direct database mutation, no seeded
 * verdicts). They create a project, profile, integration revision, build, effect manifest,
 * scenario, corpus, coverage policy, and gate run, then start cases through `startCase`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestValue, type CaseLineageRole, type Mode } from '@routespec/contracts';
import { RouteSpecStore, type CaseAuth, type StoreOptions } from '../../src/index.ts';

export class ManualClock {
  private t: number;
  constructor(start = 1_800_000_000_000) {
    this.t = start;
  }
  nowMs(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export function tempDir(prefix = 'routespec-store-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function d(label: string): `sha256:${string}` {
  return digestValue('routespec.test.digest/1', label);
}

export function openStore(dir: string, options: Partial<StoreOptions> = {}): RouteSpecStore {
  return RouteSpecStore.open({ path: join(dir, 'journal.db'), ...options });
}

export interface GateFixture {
  readonly projectId: string;
  readonly integrationRevisionId: string;
  readonly buildRevisionId: string;
  readonly artifactDigest: string;
  readonly gateRunId: string;
  readonly caseRunIds: string[];
  readonly scenarioRevisionId: string;
}

export function createGate(
  store: RouteSpecStore,
  options: {
    label?: string;
    cases?: number;
    roles?: CaseLineageRole[];
    maxParallelCases?: number;
    artifact?: string;
    integrationRevisionId?: string;
    projectId?: string;
  } = {},
): GateFixture {
  const label = options.label ?? 'default';
  const projectId =
    options.projectId ??
    store.createProject({ name: `project ${label}`, idempotencyKey: `project-create-${label}` }).projectId;
  const profileId = store.registerProtocolProfile();
  const integrationRevisionId =
    options.integrationRevisionId ??
    store.createIntegrationRevision({
      projectId,
      revisionLabel: 'r1',
      commitSha: null,
      configurationDigest: d('config'),
      protocolProfileId: profileId,
    }).integrationRevisionId;
  const artifactDigest = d(options.artifact ?? `artifact-${label}`);
  const { buildRevisionId } = store.registerBuild({
    projectId,
    integrationRevisionId,
    repositoryLocator: 'git+file:subject-client',
    commitSha: 'a'.repeat(40),
    dirtyTreeDigest: null,
    artifactDigest,
    toolchainDigest: d('toolchain'),
    lockDigest: d('lock'),
    effectManifestDigest: d(`manifest-${label}`),
    ciWorkflowRunId: null,
    launchRecipeDigest: d('recipe'),
  });
  const { manifestDigest } = store.createEffectManifest({
    buildRevisionId,
    artifactDigest,
    adapterRevision: 'sdk-adapter@1.0.0',
    hooks: [
      {
        hookId: 'fulfilment',
        hookRevision: '1',
        effectType: 'DELIVER_GOODS',
        sinkClass: 'fulfilment',
        sourceLocatorDigest: null,
        mechanism: 'subject-hook',
        scenarioSelectors: ['*'],
        coverageExpectation: 'REQUIRED',
      },
    ],
  });
  const { scenarioRevisionId } = store.createScenarioRevision({
    scenarioStableId: 'accepted-then-lost-response',
    schemaVersion: '1.0',
    compiled: { steps: ['quote', 'finalize', 'commit', 'drop-response', 'status'] },
    seed: 'seed-1',
    resourceBudget: { maxEvents: 100 },
    provenanceClass: 'SYNTHETIC',
    compilerRevision: 'compiler@0.0.0',
  });
  const { corpusRevisionId } = store.createCorpusRevision({
    label: `corpus-${label}`,
    cases: [
      {
        scenarioRevisionId,
        requiredInvariants: ['INV-01', 'INV-02'],
        severity: 'HIGH',
        gatePolicy: 'REQUIRED',
      },
    ],
  });
  const { policyDigest } = store.createEffectCoveragePolicy({
    buildRevisionId,
    artifactDigest,
    selectedAttestationId: null,
    scenarioRevisionId,
    manifestDigest,
    requiredSinkClasses: ['fulfilment'],
    interceptorProfileDigest: null,
    callsiteInventoryDigest: null,
    basis: 'DECLARED_HOOKS_ONLY',
  });
  const caseCount = options.cases ?? 1;
  const roles = options.roles ?? Array.from({ length: caseCount }, () => 'BASELINE' as CaseLineageRole);
  const { gateRunId, caseRunIds } = store.createGateRun({
    projectId,
    integrationRevisionId,
    buildRevisionId,
    artifactDigest,
    buildAttestation: { attestationClass: 'USER_ASSERTED_LOCAL', attestationId: null },
    corpusRevisionId,
    protocolProfileId: profileId,
    adapterRevision: 'sdk-adapter@1.0.0',
    evaluatorRevision: 'kernel@0.0.0',
    proxyRevision: 'proxy@0.0.0',
    configurationDigest: d('config'),
    effectManifestDigest: manifestDigest,
    effectCoveragePolicyDigest: policyDigest,
    callsiteInventoryDigest: null,
    interceptorProfileDigest: null,
    maxParallelCases: options.maxParallelCases ?? 4,
    cases: roles.map((lineageRole) => ({
      scenarioRevisionId,
      lineageRole,
      requiredInvariants: ['INV-01', 'INV-02'],
    })),
  });
  store.transitionGateRun(gateRunId, 'DRAFT', 'VALIDATING');
  for (const caseRunId of caseRunIds) {
    store.transitionCaseRun(caseRunId, 'PENDING', 'VALIDATING');
    store.transitionCaseRun(caseRunId, 'VALIDATING', 'READY');
  }
  store.transitionGateRun(gateRunId, 'VALIDATING', 'READY');
  store.transitionGateRun(gateRunId, 'READY', 'RUNNING');
  return {
    projectId,
    integrationRevisionId,
    buildRevisionId,
    artifactDigest,
    gateRunId,
    caseRunIds,
    scenarioRevisionId,
  };
}

export const LEASE_TTL_MS = 60_000;
export const TOKEN_TTL_MS = 600_000;

export function startCase(
  store: RouteSpecStore,
  caseRunId: string,
  options: { client?: string; owner?: string; mode?: Mode } = {},
): {
  auth: CaseAuth;
  sessionId: string;
  fence: { caseRunId: string; leaseOwnerDigest: string; fencingEpoch: number };
} {
  const owner = d(options.owner ?? `runner-${caseRunId}`);
  const started = store.startCase({
    caseRunId,
    leaseOwnerDigest: owner,
    clientInstanceDigest: d(options.client ?? `client-${caseRunId}`),
    mode: options.mode ?? 'SIMULATE',
    seed: 'seed-1',
    leaseTtlMs: LEASE_TTL_MS,
    tokenTtlMs: TOKEN_TTL_MS,
  });
  return {
    auth: started.auth,
    sessionId: started.sessionId,
    fence: { caseRunId, leaseOwnerDigest: owner, fencingEpoch: started.fencingEpoch },
  };
}

export function quoteRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dry: false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: 'nep141:origin.test',
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: 'nep141:destination.test',
    amount: '1000000',
    refundTo: 'refund.test',
    refundType: 'ORIGIN_CHAIN',
    recipient: 'recipient.test',
    recipientType: 'DESTINATION_CHAIN',
    deadline: '2026-11-11T12:00:00Z',
    ...overrides,
  };
}

export function quoteResponse(
  request: Record<string, unknown>,
  quote: Record<string, unknown> = {},
  top: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    correlationId: 'corr-1',
    timestamp: '2026-11-11T11:00:00Z',
    signature: 'sig-opaque',
    quoteRequest: request,
    quote: {
      depositAddress: 'deposit.sim',
      amountIn: '1000000',
      amountInFormatted: '1.0',
      amountInUsd: '1.00',
      minAmountIn: '1000000',
      amountOut: '999000',
      amountOutFormatted: '0.999',
      amountOutUsd: '0.99',
      minAmountOut: '989010',
      deadline: '2026-11-11T12:00:00Z',
      timeEstimate: 30,
      ...quote,
    },
    ...top,
  };
}

/** Drive one operation through quote request + finalization; returns the run operation ID. */
export function quoteAndFinalize(
  store: RouteSpecStore,
  auth: CaseAuth,
  options: { job?: string; tx?: string; request?: Record<string, unknown> } = {},
): string {
  const request = options.request ?? quoteRequest();
  const tx = options.tx ?? `quote-${options.job ?? 'job-1'}`;
  const ack = store.recordQuoteRequest(auth, {
    transportRequestId: tx,
    logicalJobKey: options.job ?? 'job-1',
    material: request,
  });
  store.finalizeQuote(auth, {
    transportRequestId: tx,
    runOperationId: ack.runOperationId,
    response: quoteResponse(request),
  });
  return ack.runOperationId;
}

export function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'NO_ERROR';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

/**
 * Build a canonical case result from journal rows for persistence tests. The verdict is a test
 * input to the persistence layer (the deterministic kernel that computes verdicts is M04).
 */
export function canonicalFor(
  store: RouteSpecStore,
  caseRunId: string,
  verdict: 'REVIEW' | 'FAIL' | 'NOT_RUN' | 'PASS',
): {
  canonical: Record<string, unknown>;
  envelope: Record<string, unknown>;
} {
  const c = store.getCaseRun(caseRunId)!;
  const s = store.getSession(String(c['session_id']))!;
  const g = store.getGateRun(String(c['gate_run_id']))!;
  return {
    canonical: {
      schemaVersion: '1.0',
      projectId: g['project_id'],
      integrationRevisionId: g['integration_revision_id'],
      buildRevisionId: g['build_revision_id'],
      artifactDigest: g['artifact_digest'],
      buildAttestationClass: g['build_attestation_class'],
      buildAttestationId: g['build_attestation_id'],
      caseLaunchAttestationId: s['case_launch_attestation_id'],
      gateRunId: g['gate_run_id'],
      caseRunId,
      sessionId: s['session_id'],
      corpusRevisionId: g['corpus_revision_id'],
      scenarioRevisionId: c['scenario_revision_id'],
      seed: s['seed'],
      protocolProfileId: g['protocol_profile_id'],
      adapterRevision: g['adapter_revision'],
      evaluatorRevision: g['evaluator_revision'],
      configurationDigest: g['configuration_digest'],
      effectCoveragePolicyDigest: g['effect_coverage_policy_digest'],
      effectManifestDigest: g['effect_manifest_digest'],
      callsiteInventoryDigest: g['callsite_inventory_digest'],
      interceptorInstanceId: s['interceptor_instance_id'],
      fencingEpoch: c['fencing_epoch'],
      runOperations: [],
      exchanges: [],
      facts: [],
      invariantResults: [],
      verdict,
    },
    envelope: {
      schemaVersion: '1.0',
      wallClockStartedAt: new Date(0).toISOString(),
      wallClockEndedAt: null,
      hostName: 'test-host',
      platform: process.platform,
      arch: process.arch,
      runtimeVersion: process.version,
      dataDirectory: 'test-data',
      workingDirectory: 'test-cwd',
      artifactPaths: [],
      displayLabels: {},
    },
  };
}
