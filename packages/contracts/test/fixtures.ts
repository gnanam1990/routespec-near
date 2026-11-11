/**
 * Deterministic contract fixtures for tests. These are inputs, not results: nothing here
 * encodes an expected verdict that the product code merely echoes.
 */
import { digestValue } from '../src/index.ts';

/** Deterministic UUIDv4-shaped identifier from a label (test-only). */
export function uuidFor(label: string): string {
  const hex = digestValue('routespec.test.uuid/1', label).slice('sha256:'.length);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function digestFor(label: string): `sha256:${string}` {
  return digestValue('routespec.test.digest/1', label);
}

export function canonicalResultFixture(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    projectId: uuidFor('project'),
    integrationRevisionId: uuidFor('integration-revision'),
    buildRevisionId: uuidFor('build'),
    artifactDigest: digestFor('artifact'),
    buildAttestationClass: 'USER_ASSERTED_LOCAL',
    buildAttestationId: null,
    caseLaunchAttestationId: null,
    gateRunId: uuidFor('gate-run'),
    caseRunId: uuidFor('case-run'),
    sessionId: uuidFor('session'),
    corpusRevisionId: uuidFor('corpus'),
    scenarioRevisionId: uuidFor('scenario'),
    seed: 'seed-0001',
    protocolProfileId: 'oneclick-v0@1.0.0',
    adapterRevision: 'sdk-adapter@1.0.0',
    evaluatorRevision: 'kernel@1.0.0',
    configurationDigest: digestFor('configuration'),
    effectCoveragePolicyDigest: digestFor('effect-policy'),
    effectManifestDigest: digestFor('effect-manifest'),
    callsiteInventoryDigest: null,
    interceptorInstanceId: uuidFor('interceptor'),
    fencingEpoch: 2,
    runOperations: [
      {
        runOperationId: uuidFor('run-op-b'),
        logicalJobId: uuidFor('logical-job-2'),
        quoteRequestDigest: digestFor('qr-b'),
        quoteFinalizationDigest: null,
        commitBindingDigest: null,
        lineage: [],
      },
      {
        runOperationId: uuidFor('run-op-a'),
        logicalJobId: uuidFor('logical-job-1'),
        quoteRequestDigest: digestFor('qr-a'),
        quoteFinalizationDigest: digestFor('qf-a'),
        commitBindingDigest: digestFor('cb-a'),
        lineage: [
          { relation: 'REPLAY_OF', runOperationId: uuidFor('prior-op-2') },
          { relation: 'BASELINE_OF', runOperationId: uuidFor('prior-op-1') },
        ],
      },
    ],
    exchanges: [
      {
        sequence: 3,
        transportRequestId: 'req-3',
        phase: 'COMMIT_MUTATION',
        method: 'POST',
        routeTemplate: '/v0/deposit/submit',
        requestDigest: digestFor('ex3-req'),
        responseDigest: null,
        runOperationId: uuidFor('run-op-a'),
      },
      {
        sequence: 1,
        transportRequestId: 'req-1',
        phase: 'QUOTE_REQUEST',
        method: 'POST',
        routeTemplate: '/v0/quote',
        requestDigest: digestFor('ex1-req'),
        responseDigest: digestFor('ex1-res'),
        runOperationId: uuidFor('run-op-a'),
      },
    ],
    facts: [
      {
        sequence: 5,
        factKind: 'SUCCESS_REPORTED',
        evidenceId: uuidFor('evidence-2'),
        evidenceClass: 'REPORTED',
        evidenceScope: 'PROVIDER_REPORTED',
        reasons: ['NOT_VISIBLE', 'MISSING'],
        payloadDigest: digestFor('fact-5'),
      },
      {
        sequence: 4,
        factKind: 'DEPOSIT_OBSERVED',
        evidenceId: uuidFor('evidence-1'),
        evidenceClass: 'PROVEN',
        evidenceScope: 'SIMULATED_GROUND_TRUTH',
        reasons: [],
        payloadDigest: digestFor('fact-4'),
      },
    ],
    invariantResults: [
      {
        invariantId: 'INV-06',
        verdict: 'PASS',
        evidenceIds: [uuidFor('evidence-2'), uuidFor('evidence-1')],
        missingPredicates: [],
        reasons: [],
      },
      {
        invariantId: 'INV-05',
        verdict: 'REVIEW',
        evidenceIds: [uuidFor('evidence-1')],
        missingPredicates: ['destination_credit'],
        reasons: ['NOT_VISIBLE'],
      },
    ],
    verdict: 'REVIEW',
  };
}

export function windowsEnvelope(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    wallClockStartedAt: '2026-11-11T10:00:00.000Z',
    wallClockEndedAt: '2026-11-11T10:00:07.250Z',
    hostName: 'WIN-BUILD-07',
    platform: 'win32',
    arch: 'x64',
    runtimeVersion: 'v22.23.1',
    dataDirectory: 'C:\\Users\\dev\\AppData\\Local\\routespec\\data',
    workingDirectory: 'C:\\src\\client',
    artifactPaths: ['C:\\src\\client\\dist\\report.json'],
    displayLabels: { project: 'Wallet client', gate: 'release-candidate' },
  };
}

export function linuxEnvelope(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    wallClockStartedAt: '2027-01-02T23:59:59.999Z',
    wallClockEndedAt: null,
    hostName: 'ci-runner-4f2a',
    platform: 'linux',
    arch: 'arm64',
    runtimeVersion: 'v22.18.0',
    dataDirectory: '/home/runner/.local/share/routespec',
    workingDirectory: '/home/runner/work/client',
    artifactPaths: ['/home/runner/work/client/dist/report.json', '/tmp/routespec/junit.xml'],
    displayLabels: { project: 'wallet-client (CI)', gate: 'nightly' },
  };
}

export function darwinEnvelope(): Record<string, unknown> {
  return {
    ...linuxEnvelope(),
    hostName: 'MacBook-Pro.local',
    platform: 'darwin',
    dataDirectory: '/Users/dev/Library/Application Support/routespec',
    workingDirectory: '/Users/dev/src/client',
    artifactPaths: [],
  };
}

/** Deep copy with object keys re-inserted in reverse order (simulates platform enumeration order). */
export function reverseKeyOrder<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeyOrder) as T;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).reverse();
    return Object.fromEntries(entries.map(([k, v]) => [k, reverseKeyOrder(v)])) as T;
  }
  return value;
}

/** A valid oneclick-v0 quote-request material (synthetic values). */
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
  };
}
