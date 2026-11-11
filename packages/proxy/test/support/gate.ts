/**
 * Proxy test fixtures. They drive only real APIs: the M01 store repositories and the M03
 * compiler; no row is written directly and no verdict is seeded.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADAPTER_HEADERS, ADAPTER_REVISION, digestValue } from '@routespec/contracts';
import { CORE_SCENARIO_SOURCES, compileScenario, type CompiledScenario } from '@routespec/scenario';
import { RouteSpecStore, type StoreOptions } from '@routespec/store';
import type { LaunchCredentials } from '../../src/index.ts';

export function d(label: string): `sha256:${string}` {
  return digestValue('routespec.test.digest/1', label);
}

export function tempDir(prefix = 'routespec-proxy-'): { dir: string; cleanup: () => void } {
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

export interface Gate {
  readonly gateRunId: string;
  readonly caseRunIds: string[];
  readonly buildRevisionId: string;
  readonly artifactDigest: string;
  readonly manifestDigest: string;
  readonly policyDigest: string;
}

/** Register project/build/manifest/scenario/corpus/policy and a RUNNING gate with READY cases. */
export function createGate(
  store: RouteSpecStore,
  compiled: CompiledScenario,
  options: { cases?: number; label?: string; adapterRevision?: string; maxParallelCases?: number } = {},
): Gate {
  const label = options.label ?? 'proxy';
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
    commitSha: 'b'.repeat(40),
    dirtyTreeDigest: null,
    artifactDigest,
    toolchainDigest: d('toolchain'),
    lockDigest: d('lock'),
    effectManifestDigest: d(`manifest-${label}`),
    ciWorkflowRunId: null,
    launchRecipeDigest: d('recipe'),
  });
  const adapterRevision = options.adapterRevision ?? ADAPTER_REVISION;
  const { manifestDigest } = store.createEffectManifest({
    buildRevisionId,
    artifactDigest,
    adapterRevision,
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
  const { corpusRevisionId } = store.createCorpusRevision({
    label: `corpus-${label}`,
    cases: [{ scenarioRevisionId, requiredInvariants: ['INV-03'], severity: 'HIGH', gatePolicy: 'REQUIRED' }],
  });
  const { policyDigest } = store.createEffectCoveragePolicy({
    buildRevisionId,
    artifactDigest,
    selectedAttestationId: null,
    scenarioRevisionId,
    manifestDigest,
    requiredSinkClasses: ['fulfilment-webhook'],
    interceptorProfileDigest: null,
    callsiteInventoryDigest: null,
    basis: 'DECLARED_HOOKS_ONLY',
  });
  const count = options.cases ?? 1;
  const { gateRunId, caseRunIds } = store.createGateRun({
    projectId,
    integrationRevisionId,
    buildRevisionId,
    artifactDigest,
    buildAttestation: { attestationClass: 'USER_ASSERTED_LOCAL', attestationId: null },
    corpusRevisionId,
    protocolProfileId: profileId,
    adapterRevision,
    evaluatorRevision: 'routespec-kernel@1.0.0',
    proxyRevision: 'routespec-proxy@1.0.0',
    configurationDigest: d('config'),
    effectManifestDigest: manifestDigest,
    effectCoveragePolicyDigest: policyDigest,
    callsiteInventoryDigest: null,
    interceptorProfileDigest: null,
    maxParallelCases: options.maxParallelCases ?? 4,
    cases: Array.from({ length: count }, () => ({
      scenarioRevisionId,
      lineageRole: 'BASELINE' as const,
      requiredInvariants: ['INV-03'],
    })),
  });
  store.transitionGateRun(gateRunId, 'DRAFT', 'VALIDATING');
  for (const id of caseRunIds) {
    store.transitionCaseRun(id, 'PENDING', 'VALIDATING');
    store.transitionCaseRun(id, 'VALIDATING', 'READY');
  }
  store.transitionGateRun(gateRunId, 'VALIDATING', 'READY');
  store.transitionGateRun(gateRunId, 'READY', 'RUNNING');
  return { gateRunId, caseRunIds, buildRevisionId, artifactDigest, manifestDigest, policyDigest };
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

/** Raw HTTP/1.1 request to 127.0.0.1 (no SDK). `rawTarget` lets tests send odd request targets. */
export function send(
  port: number,
  input: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
    rawBody?: string;
    host?: string;
  },
): Promise<RawResponse> {
  return new Promise((resolve) => {
    const payload = input.rawBody ?? (input.body === undefined ? undefined : JSON.stringify(input.body));
    const headers: Record<string, string> = {
      host: input.host ?? `127.0.0.1:${port}`,
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
