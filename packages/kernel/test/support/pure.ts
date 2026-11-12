/**
 * Pure kernel input builder for unit and property tests. It constructs one internally
 * consistent case snapshot (one committed, delivered swap with complete attested independent
 * effect coverage) that tests then mutate into counterexamples. It is input data for a pure
 * function, not a fake service: journal-backed tests use the real store, proxy, and runtime.
 */
import { digestValue } from '@routespec/contracts';
import {
  EVALUATOR_REVISION,
  recipientDigest,
  type EvidenceRecord,
  type KernelInput,
} from '../../src/index.ts';

export function d(label: string): string {
  return digestValue('routespec.test.digest/1', label);
}

/** Deterministic RFC-4122-shaped identifiers (version 4, variant 8). */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export const IDS = Object.freeze({
  project: uuid(1),
  integration: uuid(2),
  build: uuid(3),
  gate: uuid(4),
  case: uuid(5),
  session: uuid(6),
  corpus: uuid(7),
  scenario: uuid(8),
  op: uuid(9),
  job: uuid(10),
  buildAttestation: uuid(11),
  interceptorAttestation: uuid(12),
  inventoryAttestation: uuid(13),
  interceptor: uuid(14),
  profileReview: uuid(15),
});

export const ASSETS = Object.freeze({ origin: 'nep141:origin.sim', destination: 'nep141:destination.sim' });

export function evidence(
  overrides: Partial<EvidenceRecord> & { subject: string; sequence: number },
): EvidenceRecord {
  return {
    evidenceId: uuid(1000 + overrides.sequence),
    integrationRevisionId: IDS.integration,
    buildRevisionId: IDS.build,
    artifactDigest: d('artifact'),
    gateRunId: IDS.gate,
    caseRunId: IDS.case,
    sessionId: IDS.session,
    scenarioRevisionId: IDS.scenario,
    effectCoveragePolicyDigest: d('policy'),
    effectManifestDigest: d('manifest'),
    fencingEpoch: 1,
    runOperationId: IDS.op,
    evidenceClass: 'PROVEN',
    evidenceScope: 'SIMULATED_GROUND_TRUTH',
    reasons: [],
    sourceKind: 'SCENARIO_GROUND_TRUTH',
    assetId: null,
    amount: null,
    recipientDigest: null,
    singleUse: true,
    payloadDigest: d(`payload-${overrides.subject}-${overrides.sequence}`),
    ...overrides,
  };
}

/** A complete, internally consistent case that the kernel passes on every implemented invariant. */
export function baseInput(): KernelInput {
  const artifact = d('artifact');
  const profile = d('interceptor-profile');
  const interceptorArtifact = d('interceptor-artifact');
  const debit = evidence({
    subject: 'origin_debit',
    sequence: 20,
    assetId: ASSETS.origin,
    amount: '1000000',
  });
  const credit = evidence({
    subject: 'destination_credit',
    sequence: 21,
    assetId: ASSETS.destination,
    amount: '999000',
    recipientDigest: recipientDigest('recipient.sim'),
  });
  const obs = (
    seq: number,
    sessionSequence: number,
    action: 'ATTEMPTED' | 'BLOCKED' | 'RELEASED',
    effectId: string,
  ) => ({
    observationId: uuid(2000 + seq),
    interceptorInstanceId: IDS.interceptor,
    buildRevisionId: IDS.build,
    artifactDigest: artifact,
    gateRunId: IDS.gate,
    caseRunId: IDS.case,
    sessionId: IDS.session,
    scenarioRevisionId: IDS.scenario,
    policyDigest: d('policy'),
    manifestDigest: d('manifest'),
    interceptorProfileDigest: profile,
    runOperationId: null,
    sinkClass: 'fulfilment-webhook',
    effectId,
    effectType: 'DELIVER_GOODS',
    action,
    fencingEpoch: 1,
    frameSequence: seq,
    sessionSequence,
  });
  const attestation = (attestationId: string, scope: string, digests: string[], build: string | null) => ({
    attestationId,
    attestationClass: 'CI_ATTESTED' as const,
    scope,
    buildRevisionId: build,
    observedDigests: digests,
    expiresAtMs: 2_000_000_000_000,
    principalEnabled: true,
    principalRevocationEpochAtIssue: 0,
    principalCurrentRevocationEpoch: 0,
    principalPolicyDigestAtIssue: d('principal-policy'),
    principalCurrentPolicyDigest: d('principal-policy'),
  });
  return {
    identity: {
      projectId: IDS.project,
      integrationRevisionId: IDS.integration,
      buildRevisionId: IDS.build,
      artifactDigest: artifact,
      buildAttestationClass: 'CI_ATTESTED',
      buildAttestationId: IDS.buildAttestation,
      caseLaunchAttestationId: null,
      gateRunId: IDS.gate,
      caseRunId: IDS.case,
      sessionId: IDS.session,
      corpusRevisionId: IDS.corpus,
      scenarioRevisionId: IDS.scenario,
      scenarioRevisionDigest: d('scenario'),
      seed: 'seed-1',
      protocolProfileId: 'oneclick-v0@1.0.0',
      adapterRevision: 'routespec-adapter@1.0.0',
      evaluatorRevision: EVALUATOR_REVISION,
      configurationDigest: d('config'),
      effectCoveragePolicyDigest: d('policy'),
      effectManifestDigest: d('manifest'),
      callsiteInventoryDigest: null,
      interceptorProfileDigest: profile,
      interceptorInstanceId: IDS.interceptor,
      fencingEpoch: 1,
    },
    caseState: {
      lifecycle: 'RUNNING',
      inputClosed: true,
      requiredInvariants: ['INV-01', 'INV-02', 'INV-03', 'INV-04', 'INV-05', 'INV-06', 'INV-07', 'INV-08'],
      asOfMs: 1_900_000_000_000,
    },
    requiredEvidence: [
      {
        predicate: 'DESTINATION_CREDIT',
        classes: ['PROVEN'],
        scopes: ['PUBLIC_CHAIN_OBSERVATION', 'SIMULATED_GROUND_TRUTH'],
      },
      {
        predicate: 'ORIGIN_DEBIT',
        classes: ['PROVEN'],
        scopes: ['PUBLIC_CHAIN_OBSERVATION', 'SIMULATED_GROUND_TRUTH'],
      },
    ],
    runOperations: [
      {
        runOperationId: IDS.op,
        logicalJobId: IDS.job,
        integrationRevisionId: IDS.integration,
        buildRevisionId: IDS.build,
        gateRunId: IDS.gate,
        caseRunId: IDS.case,
        sessionId: IDS.session,
        createdFencingEpoch: 1,
        currentPhase: 'READ_ONLY_RECONCILIATION',
        quoteRequestDigest: d('quote-request'),
        quoteFinalizationDigest: d('finalization'),
        commitBindingDigest: d('commit-binding'),
        acceptedTerminalStatus: 'SUCCESS',
        normalizedOutcome: 'SUCCESS_REPORTED',
        createdSequence: 0,
        committedSequence: 1,
        quote: {
          swapType: 'EXACT_INPUT',
          originAsset: ASSETS.origin,
          destinationAsset: ASSETS.destination,
          requestedAmount: '1000000',
          recipientDigest: recipientDigest('recipient.sim'),
          refundToDigest: recipientDigest('refund.sim'),
          amountIn: '1000000',
          amountOut: '999000',
          minAmountOut: '989010',
        },
      },
    ],
    lineage: [],
    quoteFinalizations: [
      { runOperationId: IDS.op, finalizationDigest: d('finalization'), sequence: 0, fencingEpoch: 1 },
    ],
    commitBindings: [
      {
        runOperationId: IDS.op,
        bindingDigest: d('commit-binding'),
        firstAttemptId: uuid(301),
        sequence: 1,
        fencingEpoch: 1,
      },
    ],
    attempts: [
      {
        attemptId: uuid(300),
        runOperationId: IDS.op,
        fencingEpoch: 1,
        ordinal: 1,
        transportRequestId: 'q1',
        phase: 'QUOTE_REQUEST',
        outcome: 'SENT_RESPONSE_RECEIVED',
      },
      {
        attemptId: uuid(301),
        runOperationId: IDS.op,
        fencingEpoch: 1,
        ordinal: 2,
        transportRequestId: 'c1',
        phase: 'COMMIT_MUTATION',
        outcome: 'SENT_RESPONSE_RECEIVED',
      },
      {
        attemptId: uuid(302),
        runOperationId: IDS.op,
        fencingEpoch: 1,
        ordinal: 3,
        transportRequestId: 's1',
        phase: 'READ_ONLY_RECONCILIATION',
        outcome: 'SENT_RESPONSE_RECEIVED',
      },
      {
        attemptId: uuid(303),
        runOperationId: IDS.op,
        fencingEpoch: 1,
        ordinal: 4,
        transportRequestId: 's2',
        phase: 'READ_ONLY_RECONCILIATION',
        outcome: 'SENT_RESPONSE_RECEIVED',
      },
    ],
    exchanges: [
      {
        exchangeId: uuid(400),
        sequence: 0,
        runOperationId: IDS.op,
        attemptId: uuid(300),
        fencingEpoch: 1,
        phase: 'QUOTE_REQUEST',
        method: 'POST',
        routeTemplate: '/v0/quote',
        transportRequestId: 'q1',
        requestDigest: d('q1'),
        responseStatus: 200,
        responseDigest: d('r-q1'),
        errorCode: null,
      },
      {
        exchangeId: uuid(401),
        sequence: 1,
        runOperationId: IDS.op,
        attemptId: uuid(301),
        fencingEpoch: 1,
        phase: 'COMMIT_MUTATION',
        method: 'POST',
        routeTemplate: '/v0/deposit/submit',
        transportRequestId: 'c1',
        requestDigest: d('c1'),
        responseStatus: 200,
        responseDigest: d('r-c1'),
        errorCode: null,
      },
      {
        exchangeId: uuid(402),
        sequence: 2,
        runOperationId: IDS.op,
        attemptId: uuid(302),
        fencingEpoch: 1,
        phase: 'READ_ONLY_RECONCILIATION',
        method: 'GET',
        routeTemplate: '/v0/status',
        transportRequestId: 's1',
        requestDigest: d('s1'),
        responseStatus: 200,
        responseDigest: d('r-s1'),
        errorCode: null,
      },
      {
        exchangeId: uuid(403),
        sequence: 3,
        runOperationId: IDS.op,
        attemptId: uuid(303),
        fencingEpoch: 1,
        phase: 'READ_ONLY_RECONCILIATION',
        method: 'GET',
        routeTemplate: '/v0/status',
        transportRequestId: 's2',
        requestDigest: d('s2'),
        responseStatus: 200,
        responseDigest: d('r-s2'),
        errorCode: null,
      },
    ],
    events: [
      {
        eventId: uuid(500),
        sequence: 0,
        runOperationId: IDS.op,
        exchangeId: uuid(400),
        fencingEpoch: 1,
        kind: 'QUOTE_FINALIZED',
        rawStatus: null,
        normalizedFact: null,
        sourceKind: 'PROXY',
        payloadDigest: null,
      },
      {
        eventId: uuid(501),
        sequence: 1,
        runOperationId: IDS.op,
        exchangeId: uuid(401),
        fencingEpoch: 1,
        kind: 'COMMIT_ACCEPTED',
        rawStatus: null,
        normalizedFact: null,
        sourceKind: 'PROXY',
        payloadDigest: null,
      },
      {
        eventId: uuid(502),
        sequence: 2,
        runOperationId: IDS.op,
        exchangeId: uuid(402),
        fencingEpoch: 1,
        kind: 'PROVIDER_STATUS',
        rawStatus: 'PROCESSING',
        normalizedFact: 'PROCESSING',
        sourceKind: 'PROXY',
        payloadDigest: null,
      },
      {
        eventId: uuid(503),
        sequence: 3,
        runOperationId: IDS.op,
        exchangeId: uuid(403),
        fencingEpoch: 1,
        kind: 'PROVIDER_STATUS',
        rawStatus: 'SUCCESS',
        normalizedFact: 'SUCCESS_REPORTED',
        sourceKind: 'PROXY',
        payloadDigest: null,
      },
    ],
    conflicts: [],
    tokens: [
      {
        purpose: 'EXECUTION',
        fencingEpoch: 1,
        revoked: true,
        revocationReason: 'CASE_INPUT_CLOSED',
        revokedAtEpoch: 1,
      },
    ],
    evidence: [debit, credit],
    consumptions: [],
    allocations: [],
    effectPolicy: {
      policyDigest: d('policy'),
      buildRevisionId: IDS.build,
      artifactDigest: artifact,
      selectedAttestationId: IDS.buildAttestation,
      scenarioRevisionId: IDS.scenario,
      manifestDigest: d('manifest'),
      requiredSinkClasses: ['fulfilment-webhook'],
      interceptorProfileDigest: profile,
      callsiteInventoryDigest: null,
      basis: 'INDEPENDENT_BOUNDARY_INTERCEPT',
    },
    effectManifest: {
      manifestDigest: d('manifest'),
      buildRevisionId: IDS.build,
      artifactDigest: artifact,
      adapterRevision: 'routespec-adapter@1.0.0',
      hooks: [
        {
          hookId: 'fulfilment',
          hookRevision: '1',
          effectType: 'DELIVER_GOODS',
          sinkClass: 'fulfilment-webhook',
          mechanism: 'subject-hook',
          coverageExpectation: 'REQUIRED',
        },
      ],
    },
    callsiteInventory: null,
    interceptors: [
      {
        interceptorInstanceId: IDS.interceptor,
        interceptorProfileDigest: profile,
        artifactDigest: interceptorArtifact,
        supportedSinks: ['fulfilment-webhook'],
        buildRevisionId: IDS.build,
        gateRunId: IDS.gate,
        caseRunId: IDS.case,
        sessionId: IDS.session,
        policyDigest: d('policy'),
        manifestDigest: d('manifest'),
        fencingEpoch: 1,
        attestationId: IDS.interceptorAttestation,
        containment: 'PROCESS_TREE_ENFORCED',
        teardownReason: 'TEARDOWN',
      },
    ],
    boundaryObservations: [
      obs(1, 10, 'ATTEMPTED', 'order-1'),
      obs(2, 11, 'BLOCKED', 'order-1'),
      obs(3, 30, 'ATTEMPTED', 'order-2'),
      obs(4, 31, 'RELEASED', 'order-2'),
    ],
    subjectReports: [],
    coverageFindings: [],
    releaseAuthorizations: [
      {
        authorizationId: uuid(600),
        interceptorInstanceId: IDS.interceptor,
        fencingEpoch: 1,
        sessionSequence: 25,
        completionEvidenceIds: [credit.evidenceId],
      },
    ],
    attestations: [
      attestation(IDS.buildAttestation, 'BUILD_REGISTRATION', [artifact], IDS.build),
      attestation(
        IDS.interceptorAttestation,
        'EFFECT_INTERCEPTOR_LAUNCH',
        [interceptorArtifact, profile],
        null,
      ),
      attestation(IDS.inventoryAttestation, 'EFFECT_INVENTORY', [], IDS.build),
    ],
    probeResults: [],
    // The pinned interceptor profile carries one effective signed review (M16).
    interceptorProfileReviews: [
      {
        reviewId: IDS.profileReview,
        profileDigest: profile,
        decision: 'APPROVED',
        reviewedAtMs: 1_899_999_000_000,
        reviewDigest: d('interceptor-profile-review'),
        reviewRevoked: false,
        reviewerRevoked: false,
        reviewerValidFromMs: 1_800_000_000_000,
        reviewerValidUntilMs: 2_000_000_000_000,
      },
    ],
  };
}

/** Structured clone with a mutation applied (inputs are plain data). */
export function mutate(input: KernelInput, fn: (draft: Mutable<KernelInput>) => void): KernelInput {
  const draft = structuredClone(input) as Mutable<KernelInput>;
  fn(draft);
  return draft;
}

export type Mutable<T> =
  T extends ReadonlyArray<infer U>
    ? Mutable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;
