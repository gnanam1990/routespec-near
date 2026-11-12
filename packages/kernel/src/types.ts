/**
 * Kernel input and output model (TDD.md section 11).
 *
 * Every record is a plain, validated, immutable value. The kernel never reads a database, a
 * clock, the network, randomness, or a model: `snapshotFromJournal` maps journal rows into this
 * shape and `evaluateCase` is a pure function of it.
 */
import type {
  AttemptOutcome,
  EffectAction,
  EffectCoverageBasis,
  EvidenceClass,
  EvidenceReason,
  EvidenceScope,
  ExecutionLifecycle,
  LineageRelation,
  NormalizedFact,
  OperationPhase,
  ProfileReviewFact,
  SubjectAttestationClass,
  TokenPurpose,
  Verdict,
} from '@routespec/contracts';

/** The mandatory identity every result binds (FR-09). */
export interface KernelIdentity {
  readonly projectId: string;
  readonly integrationRevisionId: string;
  readonly buildRevisionId: string;
  readonly artifactDigest: string;
  readonly buildAttestationClass: SubjectAttestationClass;
  readonly buildAttestationId: string | null;
  readonly caseLaunchAttestationId: string | null;
  readonly gateRunId: string;
  readonly caseRunId: string;
  readonly sessionId: string;
  readonly corpusRevisionId: string;
  readonly scenarioRevisionId: string;
  readonly scenarioRevisionDigest: string;
  readonly seed: string;
  readonly protocolProfileId: string;
  readonly adapterRevision: string;
  /** The evaluator revision the gate run pinned; the kernel refuses to evaluate under another. */
  readonly evaluatorRevision: string;
  readonly configurationDigest: string;
  readonly effectCoveragePolicyDigest: string;
  readonly effectManifestDigest: string;
  readonly callsiteInventoryDigest: string | null;
  readonly interceptorProfileDigest: string | null;
  readonly interceptorInstanceId: string | null;
  readonly fencingEpoch: number;
}

export interface CaseState {
  readonly lifecycle: ExecutionLifecycle;
  /** Client input was closed (tokens revoked, teardown journaled) before evaluation. */
  readonly inputClosed: boolean;
  readonly requiredInvariants: readonly string[];
  /** Journal time at which input closed; the only "now" the kernel knows (attestation expiry). */
  readonly asOfMs: number | null;
}

/** A scenario-declared evidence requirement (compiled `requiredEvidence`). */
export interface RequiredEvidence {
  readonly predicate: string;
  readonly classes: readonly EvidenceClass[];
  readonly scopes: readonly EvidenceScope[];
}

export interface EvidenceRecord {
  readonly evidenceId: string;
  readonly sequence: number;
  readonly integrationRevisionId: string;
  readonly buildRevisionId: string;
  readonly artifactDigest: string;
  readonly gateRunId: string;
  readonly caseRunId: string;
  readonly sessionId: string;
  readonly scenarioRevisionId: string;
  readonly effectCoveragePolicyDigest: string;
  readonly effectManifestDigest: string;
  readonly fencingEpoch: number;
  readonly runOperationId: string | null;
  readonly evidenceClass: EvidenceClass;
  readonly evidenceScope: EvidenceScope;
  readonly reasons: readonly EvidenceReason[];
  readonly subject: string;
  readonly sourceKind: string;
  readonly assetId: string | null;
  readonly amount: string | null;
  readonly recipientDigest: string | null;
  readonly singleUse: boolean;
  readonly payloadDigest: string;
}

export interface QuoteObligation {
  readonly swapType: string;
  readonly originAsset: string;
  readonly destinationAsset: string;
  readonly requestedAmount: string;
  readonly recipientDigest: string | null;
  readonly refundToDigest: string | null;
  /** From the finalized quote; null until finalization. */
  readonly amountIn: string | null;
  readonly amountOut: string | null;
  readonly minAmountOut: string | null;
}

export interface RunOperationRecord {
  readonly runOperationId: string;
  readonly logicalJobId: string;
  readonly integrationRevisionId: string;
  readonly buildRevisionId: string;
  readonly gateRunId: string;
  readonly caseRunId: string;
  readonly sessionId: string;
  readonly createdFencingEpoch: number;
  readonly currentPhase: OperationPhase;
  readonly quoteRequestDigest: string;
  readonly quoteFinalizationDigest: string | null;
  readonly commitBindingDigest: string | null;
  readonly acceptedTerminalStatus: string | null;
  readonly normalizedOutcome: NormalizedFact | null;
  readonly createdSequence: number;
  readonly committedSequence: number | null;
  readonly quote: QuoteObligation;
}

export interface LineageRecord {
  readonly fromRunOperationId: string;
  readonly toRunOperationId: string;
  readonly relation: LineageRelation;
}

export interface QuoteFinalizationRecord {
  readonly runOperationId: string;
  readonly finalizationDigest: string;
  readonly sequence: number;
  readonly fencingEpoch: number;
}

export interface CommitBindingRecord {
  readonly runOperationId: string;
  readonly bindingDigest: string;
  readonly firstAttemptId: string;
  readonly sequence: number;
  readonly fencingEpoch: number;
}

export interface AttemptRecord {
  readonly attemptId: string;
  readonly runOperationId: string;
  readonly fencingEpoch: number;
  readonly ordinal: number;
  readonly transportRequestId: string;
  readonly phase: OperationPhase;
  readonly outcome: AttemptOutcome;
}

export interface ExchangeRecord {
  readonly exchangeId: string;
  readonly sequence: number;
  readonly runOperationId: string | null;
  readonly attemptId: string | null;
  readonly fencingEpoch: number;
  readonly phase: OperationPhase;
  readonly method: string;
  readonly routeTemplate: string;
  readonly transportRequestId: string;
  readonly requestDigest: string;
  readonly responseStatus: number | null;
  readonly responseDigest: string | null;
  readonly errorCode: string | null;
}

export interface EventRecord {
  readonly eventId: string;
  readonly sequence: number;
  readonly runOperationId: string | null;
  readonly exchangeId: string | null;
  readonly fencingEpoch: number;
  readonly kind: string;
  /** Verbatim raw provider status text; never rewritten. */
  readonly rawStatus: string | null;
  readonly normalizedFact: string | null;
  readonly sourceKind: string;
  readonly payloadDigest: string | null;
}

export interface ConflictRecord {
  readonly runOperationId: string | null;
  readonly phase: OperationPhase;
  readonly errorCode: string;
  readonly fencingEpoch: number;
}

export interface TokenRecord {
  readonly purpose: TokenPurpose;
  readonly fencingEpoch: number;
  readonly revoked: boolean;
  readonly revocationReason: string | null;
  readonly revokedAtEpoch: number | null;
}

export interface ConsumptionRecord {
  readonly evidenceId: string;
  readonly runOperationId: string;
  readonly predicate: string;
  readonly allocationId: string | null;
}

export interface AllocationRecord {
  readonly allocationId: string;
  readonly evidenceId: string;
  readonly assetId: string;
  readonly totalAmount: string;
  readonly parts: ReadonlyArray<{ readonly runOperationId: string; readonly amount: string }>;
}

export interface ManifestHookRecord {
  readonly hookId: string;
  readonly hookRevision: string;
  readonly effectType: string;
  readonly sinkClass: string;
  readonly mechanism: string;
  readonly coverageExpectation: 'REQUIRED' | 'OPTIONAL';
}

export interface EffectManifestRecord {
  readonly manifestDigest: string;
  readonly buildRevisionId: string;
  readonly artifactDigest: string;
  readonly adapterRevision: string;
  readonly hooks: readonly ManifestHookRecord[];
}

export interface EffectPolicyRecord {
  readonly policyDigest: string;
  readonly buildRevisionId: string;
  readonly artifactDigest: string;
  readonly selectedAttestationId: string | null;
  readonly scenarioRevisionId: string;
  readonly manifestDigest: string;
  readonly requiredSinkClasses: readonly string[];
  readonly interceptorProfileDigest: string | null;
  readonly callsiteInventoryDigest: string | null;
  readonly basis: EffectCoverageBasis;
}

export interface CallsiteInventoryRecord {
  readonly inventoryDigest: string;
  readonly buildRevisionId: string;
  readonly manifestDigest: string;
  readonly analyzerDigest: string;
  readonly attestationId: string | null;
  readonly unsupportedFindings: number;
  readonly callsites: ReadonlyArray<{
    readonly callsiteId: string;
    readonly sinkClass: string;
    readonly hookId: string | null;
    readonly dynamic: boolean;
  }>;
}

export type Containment = 'PROCESS_TREE_ENFORCED' | 'DECLARED_HOOKS_ONLY';

export interface InterceptorInstanceRecord {
  readonly interceptorInstanceId: string;
  readonly interceptorProfileDigest: string;
  readonly artifactDigest: string;
  readonly supportedSinks: readonly string[];
  readonly buildRevisionId: string;
  readonly gateRunId: string;
  readonly caseRunId: string;
  readonly sessionId: string;
  readonly policyDigest: string;
  readonly manifestDigest: string;
  readonly fencingEpoch: number;
  readonly attestationId: string | null;
  readonly containment: Containment;
  readonly teardownReason: 'TEARDOWN' | 'CHANNEL_LOST' | 'CASE_TERMINAL' | null;
}

export interface BoundaryObservationRecord {
  readonly observationId: string;
  readonly interceptorInstanceId: string;
  readonly buildRevisionId: string;
  readonly artifactDigest: string;
  readonly gateRunId: string;
  readonly caseRunId: string;
  readonly sessionId: string;
  readonly scenarioRevisionId: string;
  readonly policyDigest: string;
  readonly manifestDigest: string;
  readonly interceptorProfileDigest: string;
  readonly runOperationId: string | null;
  readonly sinkClass: string;
  readonly effectId: string;
  readonly effectType: string;
  readonly action: EffectAction;
  readonly fencingEpoch: number;
  /** Per-interceptor frame sequence. */
  readonly frameSequence: number;
  /** Position in the case journal order; null for journals older than schema version 4. */
  readonly sessionSequence: number | null;
}

export interface SubjectReportRecord {
  readonly observationId: string;
  readonly buildRevisionId: string;
  readonly gateRunId: string;
  readonly caseRunId: string;
  readonly sessionId: string;
  readonly runOperationId: string | null;
  readonly policyDigest: string;
  readonly manifestDigest: string;
  readonly hookId: string;
  readonly hookRevision: string;
  readonly effectId: string;
  readonly effectType: string;
  readonly action: EffectAction;
  readonly fencingEpoch: number;
  readonly sequence: number;
  /** Always SUBJECT_REPORTED: correlation only. */
  readonly coverageClassification: 'SUBJECT_REPORTED';
}

export interface CoverageFindingRecord {
  readonly interceptorInstanceId: string;
  readonly kind: 'PROCESS_TREE_ESCAPE' | 'UNSUPPORTED_DYNAMIC_CALL' | 'SINK_BYPASS';
  readonly sinkClass: string | null;
  readonly fencingEpoch: number;
  readonly sessionSequence: number;
}

export interface ReleaseAuthorizationRecord {
  readonly authorizationId: string;
  readonly interceptorInstanceId: string | null;
  readonly fencingEpoch: number;
  readonly sessionSequence: number;
  readonly completionEvidenceIds: readonly string[];
}

export interface AttestationRecord {
  readonly attestationId: string;
  readonly attestationClass: 'TRUSTED_LAUNCHER' | 'CI_ATTESTED';
  readonly scope: string;
  readonly buildRevisionId: string | null;
  readonly observedDigests: readonly string[];
  readonly expiresAtMs: number;
  readonly principalEnabled: boolean;
  readonly principalRevocationEpochAtIssue: number;
  readonly principalCurrentRevocationEpoch: number;
  readonly principalPolicyDigestAtIssue: string;
  readonly principalCurrentPolicyDigest: string;
}

/** A live-probe compatibility result (M07). Kept separate: no predicate ever consumes it. */
export interface ProbeResultRecord {
  readonly probeId: string;
  readonly compatibility: string;
  readonly resultDigest: string;
}

export interface KernelInput {
  readonly identity: KernelIdentity;
  readonly caseState: CaseState;
  readonly requiredEvidence: readonly RequiredEvidence[];
  readonly runOperations: readonly RunOperationRecord[];
  readonly lineage: readonly LineageRecord[];
  readonly quoteFinalizations: readonly QuoteFinalizationRecord[];
  readonly commitBindings: readonly CommitBindingRecord[];
  readonly attempts: readonly AttemptRecord[];
  readonly exchanges: readonly ExchangeRecord[];
  readonly events: readonly EventRecord[];
  readonly conflicts: readonly ConflictRecord[];
  readonly tokens: readonly TokenRecord[];
  readonly evidence: readonly EvidenceRecord[];
  readonly consumptions: readonly ConsumptionRecord[];
  readonly allocations: readonly AllocationRecord[];
  readonly effectPolicy: EffectPolicyRecord | null;
  readonly effectManifest: EffectManifestRecord | null;
  readonly callsiteInventory: CallsiteInventoryRecord | null;
  readonly interceptors: readonly InterceptorInstanceRecord[];
  readonly boundaryObservations: readonly BoundaryObservationRecord[];
  readonly subjectReports: readonly SubjectReportRecord[];
  readonly coverageFindings: readonly CoverageFindingRecord[];
  readonly releaseAuthorizations: readonly ReleaseAuthorizationRecord[];
  readonly attestations: readonly AttestationRecord[];
  readonly probeResults: readonly ProbeResultRecord[];
  /**
   * Reviews of the policy's pinned interceptor profile (M16), with their current revocation
   * state. Absent or empty: the profile is unreviewed, so complete-effect coverage stays REVIEW.
   */
  readonly interceptorProfileReviews?: readonly ProfileReviewFact[];
}

/** One invariant evaluated for one run operation (or the whole case when `runOperationId` is null). */
export interface InvariantResult {
  readonly invariantId: string;
  readonly runOperationId: string | null;
  readonly verdict: Verdict;
  readonly explanationCode: string;
  readonly remediationCode: string | null;
  readonly factIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly missingPredicates: readonly string[];
  readonly reasons: readonly EvidenceReason[];
  /** Deterministic, ordered observations behind the verdict (codes and identifiers only). */
  readonly findings: readonly string[];
}
