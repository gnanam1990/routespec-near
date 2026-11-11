/**
 * Journal-backed fixtures for kernel tests. They drive only real APIs: the M01 store
 * repositories, the M03 compiler/runtime, and the M02 proxy, supervisor, and interceptor host.
 * No journal row is written directly and no verdict is seeded: verdicts come from the kernel.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADAPTER_HEADERS,
  ADAPTER_REVISION,
  digestValue,
  type EffectCoverageBasis,
} from '@routespec/contracts';
import { CaseSupervisor, ScenarioProxy, type LaunchCredentials } from '@routespec/proxy';
import { CORE_SCENARIO_SOURCES, compileScenario, type CompiledScenario } from '@routespec/scenario';
import { RouteSpecStore, type StoreOptions } from '@routespec/store';
import {
  evaluateCase,
  snapshotFromJournal,
  toPersistableEvaluation,
  type CaseEvaluation,
  type KernelInput,
} from '../../src/index.ts';

export const ALL_M04_INVARIANTS = [
  'INV-01',
  'INV-02',
  'INV-03',
  'INV-04',
  'INV-05',
  'INV-06',
  'INV-07',
  'INV-08',
];

export function d(label: string): `sha256:${string}` {
  return digestValue('routespec.test.digest/1', label);
}

export function tempDir(prefix = 'routespec-kernel-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

export function openStore(dir: string, options: Partial<StoreOptions> = {}): RouteSpecStore {
  return RouteSpecStore.open({ path: join(dir, 'journal.db'), ...options });
}

export function compileCore(id: string): CompiledScenario {
  return compileScenario(CORE_SCENARIO_SOURCES[id] as string);
}

export interface GateOptions {
  label?: string;
  cases?: number;
  requiredInvariants?: string[];
  basis?: EffectCoverageBasis;
  requiredSinks?: string[];
  interceptorProfileDigest?: string | null;
  callsiteInventory?: {
    callsites: Array<{ callsiteId: string; sinkClass: string; hookId: string | null; dynamic: boolean }>;
    unsupportedFindings: number;
  };
  maxParallelCases?: number;
}

export interface Gate {
  readonly projectId: string;
  readonly gateRunId: string;
  readonly caseRunIds: string[];
  readonly buildRevisionId: string;
  readonly artifactDigest: string;
  readonly manifestDigest: string;
  readonly policyDigest: string;
  readonly scenarioRevisionId: string;
  readonly inventoryDigest: string | null;
}

/** Register project/build/manifest/scenario/corpus/policy and a RUNNING gate with READY cases. */
export function createGate(
  store: RouteSpecStore,
  compiled: CompiledScenario,
  options: GateOptions = {},
): Gate {
  const label = options.label ?? 'kernel';
  const { projectId } = store.createProject({
    name: `project ${label}`,
    idempotencyKey: `project-${label}-key`,
  });
  const profileId = store.registerProtocolProfile();
  const { integrationRevisionId } = store.createIntegrationRevision({
    projectId,
    revisionLabel: 'r1',
    commitSha: null,
    configurationDigest: d('config'),
    protocolProfileId: profileId,
  });
  const artifactDigest = d(`artifact-${label}`);
  const { buildRevisionId } = store.registerBuild({
    projectId,
    integrationRevisionId,
    repositoryLocator: 'git+file:subject-client',
    commitSha: 'c'.repeat(40),
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
    adapterRevision: ADAPTER_REVISION,
    hooks: [
      {
        hookId: 'fulfilment',
        hookRevision: '1',
        effectType: 'DELIVER_GOODS',
        sinkClass: 'fulfilment-webhook',
        sourceLocatorDigest: null,
        mechanism: 'subject-hook',
        scenarioSelectors: ['*'],
        coverageExpectation: 'REQUIRED',
      },
    ],
  });
  const { scenarioRevisionId } = store.createScenarioRevision(compiled.revisionInput);
  const required = options.requiredInvariants ?? ALL_M04_INVARIANTS;
  const { corpusRevisionId } = store.createCorpusRevision({
    label: `corpus-${label}`,
    cases: [{ scenarioRevisionId, requiredInvariants: required, severity: 'HIGH', gatePolicy: 'REQUIRED' }],
  });
  const inventory = options.callsiteInventory
    ? store.registerCallsiteInventory({
        buildRevisionId,
        manifestDigest,
        analyzerDigest: d('analyzer'),
        attestationId: null,
        callsites: options.callsiteInventory.callsites,
        unsupportedFindings: options.callsiteInventory.unsupportedFindings,
      })
    : null;
  const basis = options.basis ?? 'DECLARED_HOOKS_ONLY';
  const interceptorProfileDigest = options.interceptorProfileDigest ?? null;
  const { policyDigest } = store.createEffectCoveragePolicy({
    buildRevisionId,
    artifactDigest,
    selectedAttestationId: null,
    scenarioRevisionId,
    manifestDigest,
    requiredSinkClasses: options.requiredSinks ?? ['fulfilment-webhook'],
    interceptorProfileDigest,
    callsiteInventoryDigest: inventory?.inventoryDigest ?? null,
    basis,
  });
  const { gateRunId, caseRunIds } = store.createGateRun({
    projectId,
    integrationRevisionId,
    buildRevisionId,
    artifactDigest,
    buildAttestation: { attestationClass: 'USER_ASSERTED_LOCAL', attestationId: null },
    corpusRevisionId,
    protocolProfileId: profileId,
    adapterRevision: ADAPTER_REVISION,
    evaluatorRevision: 'routespec-kernel@1.0.0',
    proxyRevision: 'routespec-proxy@1.0.0',
    configurationDigest: d('config'),
    effectManifestDigest: manifestDigest,
    effectCoveragePolicyDigest: policyDigest,
    callsiteInventoryDigest: inventory?.inventoryDigest ?? null,
    interceptorProfileDigest,
    maxParallelCases: options.maxParallelCases ?? 8,
    cases: Array.from({ length: options.cases ?? 1 }, () => ({
      scenarioRevisionId,
      lineageRole: 'BASELINE' as const,
      requiredInvariants: required,
    })),
  });
  store.transitionGateRun(gateRunId, 'DRAFT', 'VALIDATING');
  for (const id of caseRunIds) {
    store.transitionCaseRun(id, 'PENDING', 'VALIDATING');
    store.transitionCaseRun(id, 'VALIDATING', 'READY');
  }
  store.transitionGateRun(gateRunId, 'VALIDATING', 'READY');
  store.transitionGateRun(gateRunId, 'READY', 'RUNNING');
  return {
    projectId,
    gateRunId,
    caseRunIds,
    buildRevisionId,
    artifactDigest,
    manifestDigest,
    policyDigest,
    scenarioRevisionId,
    inventoryDigest: inventory?.inventoryDigest ?? null,
  };
}

/** A networkless proxy and supervisor bound to one journal, with credential handoff captured. */
export class Harness {
  readonly store: RouteSpecStore;
  readonly supervisor: CaseSupervisor;
  readonly credentials = new Map<string, LaunchCredentials>();
  proxy!: ScenarioProxy;

  private constructor(store: RouteSpecStore) {
    this.store = store;
    this.supervisor = new CaseSupervisor(store, {
      ownerLabel: 'kernel-test-runner',
      onCredentials: (caseRunId, creds) => this.credentials.set(caseRunId, creds),
    });
  }

  static async start(store: RouteSpecStore): Promise<Harness> {
    const h = new Harness(store);
    h.proxy = await ScenarioProxy.start({ store, mode: 'SIMULATE', cases: h.supervisor });
    return h;
  }

  startCase(caseRunId: string, compiled: CompiledScenario): LaunchCredentials {
    const creds = this.supervisor.startCase({ caseRunId, compiled, mode: 'SIMULATE' });
    this.credentials.set(caseRunId, creds);
    return creds;
  }

  creds(caseRunId: string): LaunchCredentials {
    return this.credentials.get(caseRunId) as LaunchCredentials;
  }

  async close(): Promise<void> {
    await this.proxy.close();
  }
}

export function adapterHeaders(
  creds: LaunchCredentials,
  extra: { requestId: string; logicalJob?: string; runOperationId?: string },
): Record<string, string> {
  const h: Record<string, string> = {
    [ADAPTER_HEADERS.session]: creds.sessionId,
    [ADAPTER_HEADERS.caseRun]: creds.caseRunId,
    [ADAPTER_HEADERS.adapter]: creds.adapterRevision,
    [ADAPTER_HEADERS.fencingEpoch]: String(creds.fencingEpoch),
    [ADAPTER_HEADERS.clientInstance]: creds.clientInstanceId,
    [ADAPTER_HEADERS.caseToken]: creds.token,
    [ADAPTER_HEADERS.requestId]: extra.requestId,
  };
  if (extra.logicalJob !== undefined) h[ADAPTER_HEADERS.logicalJob] = extra.logicalJob;
  if (extra.runOperationId !== undefined) h[ADAPTER_HEADERS.runOperation] = extra.runOperationId;
  return h;
}

export interface RawResponse {
  readonly status: number | null;
  readonly reset: boolean;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: unknown;
  readonly code: string | null;
}

/** Raw HTTP/1.1 request to the loopback proxy (no SDK). */
export function send(
  port: number,
  input: { method: string; path: string; headers?: Record<string, string>; body?: unknown },
): Promise<RawResponse> {
  return new Promise((resolve) => {
    const payload = input.body === undefined ? undefined : JSON.stringify(input.body);
    const headers: Record<string, string> = {
      host: `127.0.0.1:${port}`,
      ...(payload !== undefined
        ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
        : {}),
      ...(input.headers ?? {}),
    };
    const req = request({
      host: '127.0.0.1',
      port,
      method: input.method,
      path: input.path,
      headers,
      setHost: false,
    });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // non-JSON body stays text
        }
        const code = (body as { error?: { code?: string } } | null)?.error?.code ?? null;
        resolve({ status: res.statusCode ?? null, reset: false, headers: res.headers, body, code });
      });
      res.on('error', () => resolve({ status: null, reset: true, headers: {}, body: null, code: null }));
    });
    req.on('error', () => resolve({ status: null, reset: true, headers: {}, body: null, code: null }));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function quoteBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dry: false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: 'nep141:origin.sim',
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: 'nep141:destination.sim',
    amount: '1000000',
    refundTo: 'refund.sim',
    refundType: 'ORIGIN_CHAIN',
    recipient: 'recipient.sim',
    recipientType: 'DESTINATION_CHAIN',
    deadline: '2026-11-11T12:00:00Z',
    ...overrides,
  };
}

/** Drive quote then commit through the proxy; returns the run operation and deposit address. */
export async function quoteAndCommit(
  h: Harness,
  caseRunId: string,
  tag: string,
): Promise<{ runOperationId: string; depositAddress: string; commit: RawResponse }> {
  const creds = h.creds(caseRunId);
  const quote = await send(h.proxy.port, {
    method: 'POST',
    path: '/v0/quote',
    headers: adapterHeaders(creds, { requestId: `${tag}-q`, logicalJob: `${tag}-job` }),
    body: quoteBody(),
  });
  if (quote.status !== 200) throw new Error(`quote failed: ${JSON.stringify(quote.body)}`);
  const runOperationId = String(quote.headers['x-routespec-run-operation']);
  const depositAddress = String((quote.body as { quote: { depositAddress: string } }).quote.depositAddress);
  const commit = await send(h.proxy.port, {
    method: 'POST',
    path: '/v0/deposit/submit',
    headers: adapterHeaders(creds, { requestId: `${tag}-c`, runOperationId }),
    body: { txHash: `${tag}-tx`, depositAddress },
  });
  return { runOperationId, depositAddress, commit };
}

export async function pollStatus(
  h: Harness,
  caseRunId: string,
  op: { runOperationId: string; depositAddress: string },
  requestId: string,
): Promise<RawResponse> {
  const creds = h.creds(caseRunId);
  return send(h.proxy.port, {
    method: 'GET',
    path: `/v0/status?depositAddress=${encodeURIComponent(op.depositAddress)}`,
    headers: adapterHeaders(creds, { requestId, runOperationId: op.runOperationId }),
  });
}

/** Read the consistent journal snapshot and evaluate it with the pure kernel. */
export function evaluateFromJournal(
  store: RouteSpecStore,
  caseRunId: string,
): { input: KernelInput; evaluation: CaseEvaluation } {
  const input = snapshotFromJournal(store.readEvaluationSnapshot(caseRunId));
  return { input, evaluation: evaluateCase(input) };
}

/** Persist a kernel evaluation through the fenced journal transaction. */
export function persistEvaluation(
  store: RouteSpecStore,
  fence: { caseRunId: string; leaseOwnerDigest: string; fencingEpoch: number },
  input: KernelInput,
  evaluation: CaseEvaluation,
): { resultDigest: string } {
  const p = toPersistableEvaluation(input, evaluation);
  return store.persistCaseEvaluation(fence, {
    verdict: p.verdict,
    evaluatorRevision: p.evaluatorRevision,
    invariantResults: p.invariantResults,
    canonical: p.canonical,
    envelope: {
      schemaVersion: '1.0',
      wallClockStartedAt: new Date(0).toISOString(),
      wallClockEndedAt: null,
      hostName: 'kernel-test-host',
      platform: process.platform,
      arch: process.arch,
      runtimeVersion: process.version,
      dataDirectory: 'kernel-test-data',
      workingDirectory: 'kernel-test-cwd',
      artifactPaths: [],
      displayLabels: {},
    },
  });
}
