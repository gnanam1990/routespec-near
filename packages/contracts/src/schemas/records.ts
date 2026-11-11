/**
 * Closed, versioned domain record contracts (DATA-MODEL.md section 2).
 *
 * Each record carries `schemaVersion`. Identity is always by opaque UUID/digest foreign key;
 * display labels never substitute for identity. A build record is permanently
 * `USER_ASSERTED_LOCAL`; trusted identity exists only in separate attestation records.
 * Execution lifecycle and verdict are separate fields; verdict is nullable until evaluation.
 */
import {
  ATTESTER_KINDS,
  BUILD_REGISTRATION_CLAIM,
  CASE_LINEAGE_ROLES,
  CHALLENGE_SCOPES,
  EFFECT_ACTIONS,
  EFFECT_COVERAGE_BASES,
  ENFORCEMENT_MODES,
  EVIDENCE_CLASSES,
  EVIDENCE_REASONS,
  EVIDENCE_SCOPES,
  EXECUTION_LIFECYCLES,
  LINEAGE_RELATIONS,
  MODES,
  NORMALIZED_FACTS,
  OFFICIAL_COMPATIBILITY,
  OPERATION_PHASES,
  PROVENANCE_CLASSES,
  SUBJECT_ATTESTATION_CLASSES,
  TOKEN_PURPOSES,
  VERDICTS,
  ATTEMPT_OUTCOMES,
} from '../enums.ts';
import {
  BaseUnitAmount,
  BoundedText,
  CommitSha,
  DigestString,
  FencingEpoch,
  NonNegativeInt,
  PositiveInt,
  RevisionId,
  Sequence,
  Uuid,
  VirtualMs,
  z,
} from './common.ts';

const lifecycle = z.enum(EXECUTION_LIFECYCLES);
const verdict = z.enum(VERDICTS);
const v1 = z.literal('1.0');
const wallMs = NonNegativeInt;

export const ProjectRecord = z
  .object({
    schemaVersion: v1,
    projectId: Uuid,
    name: BoundedText(200),
    description: z.string().max(2000).nullable(),
    revision: PositiveInt,
    createdAtMs: wallMs,
  })
  .strict();
export type ProjectRecord = z.infer<typeof ProjectRecord>;

export const IntegrationRevisionRecord = z
  .object({
    schemaVersion: v1,
    integrationRevisionId: Uuid,
    projectId: Uuid,
    revisionLabel: BoundedText(200),
    commitSha: CommitSha.nullable(),
    configurationDigest: DigestString,
    protocolProfileId: RevisionId,
    metadata: z.record(z.string().max(64), z.union([z.string().max(256), z.number().int(), z.boolean()])),
    identityDigest: DigestString,
  })
  .strict();
export type IntegrationRevisionRecord = z.infer<typeof IntegrationRevisionRecord>;

export const BuildRevisionRecord = z
  .object({
    schemaVersion: v1,
    buildRevisionId: Uuid,
    projectId: Uuid,
    integrationRevisionId: Uuid,
    repositoryLocator: BoundedText(512),
    commitSha: CommitSha,
    dirtyTreeDigest: DigestString.nullable(),
    artifactDigest: DigestString,
    toolchainDigest: DigestString,
    lockDigest: DigestString,
    effectManifestDigest: DigestString,
    ciWorkflowRunId: BoundedText(256).nullable(),
    launchRecipeDigest: DigestString,
    registrationClaim: z.literal(BUILD_REGISTRATION_CLAIM),
    identityDigest: DigestString,
  })
  .strict();
export type BuildRevisionRecord = z.infer<typeof BuildRevisionRecord>;

export const AttesterPrincipalRecord = z
  .object({
    schemaVersion: v1,
    principalId: Uuid,
    kind: z.enum(ATTESTER_KINDS),
    keyOrIssuerPolicyDigest: DigestString,
    audience: BoundedText(256).nullable(),
    claimPolicyDigest: DigestString,
    maxFreshnessMs: PositiveInt,
    policyDigest: DigestString,
    enabled: z.boolean(),
    revocationEpoch: NonNegativeInt,
    validFromMs: wallMs,
    validUntilMs: wallMs,
  })
  .strict();
export type AttesterPrincipalRecord = z.infer<typeof AttesterPrincipalRecord>;

export const LauncherChallengeRecord = z
  .object({
    schemaVersion: v1,
    challengeId: Uuid,
    scope: z.enum(CHALLENGE_SCOPES),
    principalId: Uuid,
    principalPolicyDigest: DigestString,
    principalRevocationEpoch: NonNegativeInt,
    nonceDigest: DigestString,
    bindingDigest: DigestString,
    issuedAtMs: wallMs,
    expiresAtMs: wallMs,
    consumed: z.boolean(),
  })
  .strict();
export type LauncherChallengeRecord = z.infer<typeof LauncherChallengeRecord>;

export const SubjectAttestationRecord = z
  .object({
    schemaVersion: v1,
    attestationId: Uuid,
    attestationClass: z.enum(SUBJECT_ATTESTATION_CLASSES).exclude([BUILD_REGISTRATION_CLAIM]),
    scope: z.enum(CHALLENGE_SCOPES),
    challengeId: Uuid,
    principalId: Uuid,
    principalPolicyDigest: DigestString,
    principalRevocationEpoch: NonNegativeInt,
    verifiedClaimsDigest: DigestString,
    observedDigests: z.record(z.string().max(64), DigestString),
    verifiedAtMs: wallMs,
    expiresAtMs: wallMs,
    attestationDigest: DigestString,
  })
  .strict();
export type SubjectAttestationRecord = z.infer<typeof SubjectAttestationRecord>;

export const EffectManifestHook = z
  .object({
    hookId: BoundedText(128),
    hookRevision: BoundedText(64),
    effectType: BoundedText(128),
    sinkClass: BoundedText(128),
    sourceLocatorDigest: DigestString.nullable(),
    mechanism: BoundedText(128),
    scenarioSelectors: z.array(BoundedText(128)).max(64),
    coverageExpectation: z.enum(['REQUIRED', 'OPTIONAL']),
  })
  .strict();

export const EffectManifestRecord = z
  .object({
    schemaVersion: v1,
    manifestId: Uuid,
    buildRevisionId: Uuid,
    artifactDigest: DigestString,
    adapterRevision: RevisionId,
    hooks: z.array(EffectManifestHook).max(512),
    manifestDigest: DigestString,
  })
  .strict();
export type EffectManifestRecord = z.infer<typeof EffectManifestRecord>;

export const EffectCoveragePolicyRecord = z
  .object({
    schemaVersion: v1,
    policyId: Uuid,
    buildRevisionId: Uuid,
    artifactDigest: DigestString,
    selectedAttestationId: Uuid.nullable(),
    scenarioRevisionId: Uuid,
    manifestDigest: DigestString,
    requiredSinkClasses: z.array(BoundedText(128)).max(128),
    interceptorProfileDigest: DigestString.nullable(),
    callsiteInventoryDigest: DigestString.nullable(),
    basis: z.enum(EFFECT_COVERAGE_BASES),
    policyDigest: DigestString,
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.basis !== 'DECLARED_HOOKS_ONLY' && p.interceptorProfileDigest === null) {
      ctx.addIssue({ code: 'custom', message: 'intercept bases require an interceptor profile' });
    }
    if (p.basis === 'TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT' && p.callsiteInventoryDigest === null) {
      ctx.addIssue({ code: 'custom', message: 'inventory basis requires a trusted call-site inventory' });
    }
  });
export type EffectCoveragePolicyRecord = z.infer<typeof EffectCoveragePolicyRecord>;

export const EffectBoundaryObservationRecord = z
  .object({
    schemaVersion: v1,
    observationId: Uuid,
    interceptorInstanceId: Uuid,
    buildRevisionId: Uuid,
    artifactDigest: DigestString,
    policyDigest: DigestString,
    manifestDigest: DigestString,
    gateRunId: Uuid,
    caseRunId: Uuid,
    sessionId: Uuid,
    runOperationId: Uuid.nullable(),
    scenarioRevisionId: Uuid,
    sinkClass: BoundedText(128),
    effectId: BoundedText(128),
    action: z.enum(EFFECT_ACTIONS),
    fencingEpoch: FencingEpoch,
    sequence: Sequence,
    virtualMs: VirtualMs.nullable(),
  })
  .strict();
export type EffectBoundaryObservationRecord = z.infer<typeof EffectBoundaryObservationRecord>;

export const GateRunRecord = z
  .object({
    schemaVersion: v1,
    gateRunId: Uuid,
    gateDefinitionRevisionId: Uuid.nullable(),
    projectId: Uuid,
    integrationRevisionId: Uuid,
    buildRevisionId: Uuid,
    artifactDigest: DigestString,
    buildAttestation: z
      .object({
        attestationClass: z.enum(SUBJECT_ATTESTATION_CLASSES),
        attestationId: Uuid.nullable(),
        attestationDigest: DigestString.nullable(),
      })
      .strict(),
    corpusRevisionId: Uuid,
    protocolProfileId: RevisionId,
    adapterRevision: RevisionId,
    evaluatorRevision: RevisionId,
    proxyRevision: RevisionId,
    configurationDigest: DigestString,
    effectManifestDigest: DigestString,
    effectCoveragePolicyDigest: DigestString,
    callsiteInventoryDigest: DigestString.nullable(),
    interceptorProfileDigest: DigestString.nullable(),
    maxParallelCases: z.number().int().min(1).max(64),
    executionLifecycle: lifecycle,
    verdict: verdict.nullable(),
  })
  .strict();
export type GateRunRecord = z.infer<typeof GateRunRecord>;

export const CaseRunRecord = z
  .object({
    schemaVersion: v1,
    caseRunId: Uuid,
    gateRunId: Uuid,
    caseOrdinal: NonNegativeInt,
    scenarioRevisionId: Uuid,
    lineageRole: z.enum(CASE_LINEAGE_ROLES),
    requiredInvariants: z.array(z.string().regex(/^INV-(0[1-9]|1[0-2])$/)).max(12),
    executionLifecycle: lifecycle,
    verdict: verdict.nullable(),
    fencingEpoch: FencingEpoch,
    clientInstanceDigest: DigestString.nullable(),
    sessionId: Uuid.nullable(),
    leaseOwnerDigest: DigestString.nullable(),
    leaseExpiresAtMs: wallMs.nullable(),
  })
  .strict();
export type CaseRunRecord = z.infer<typeof CaseRunRecord>;

export const SessionRecord = z
  .object({
    schemaVersion: v1,
    sessionId: Uuid,
    integrationRevisionId: Uuid,
    buildRevisionId: Uuid,
    artifactDigest: DigestString,
    gateRunId: Uuid,
    caseRunId: Uuid,
    scenarioRevisionId: Uuid,
    corpusRevisionId: Uuid,
    mode: z.enum(MODES),
    adapterRevision: RevisionId,
    evaluatorRevision: RevisionId,
    configurationDigest: DigestString,
    effectManifestDigest: DigestString,
    effectCoveragePolicyDigest: DigestString,
    executionLifecycle: lifecycle,
    verdict: verdict.nullable(),
    seed: BoundedText(128),
    nextSequence: Sequence,
    leaseFencingEpoch: FencingEpoch,
  })
  .strict();
export type SessionRecord = z.infer<typeof SessionRecord>;

export const CaseTokenRecord = z
  .object({
    schemaVersion: v1,
    tokenDigest: DigestString,
    purpose: z.enum(TOKEN_PURPOSES),
    buildRevisionId: Uuid,
    artifactDigest: DigestString,
    gateRunId: Uuid,
    caseRunId: Uuid,
    sessionId: Uuid,
    clientInstanceDigest: DigestString,
    adapterRevision: RevisionId,
    allowedPhases: z.array(z.enum(OPERATION_PHASES)).min(1),
    fencingEpoch: FencingEpoch,
    issuedAtMs: wallMs,
    expiresAtMs: wallMs,
  })
  .strict();
export type CaseTokenRecord = z.infer<typeof CaseTokenRecord>;

export const LogicalJobRecord = z
  .object({
    schemaVersion: v1,
    logicalJobId: Uuid,
    integrationRevisionId: Uuid,
    logicalJobKeyDigest: DigestString,
  })
  .strict();
export type LogicalJobRecord = z.infer<typeof LogicalJobRecord>;

export const RunOperationRecord = z
  .object({
    schemaVersion: v1,
    runOperationId: Uuid,
    integrationRevisionId: Uuid,
    buildRevisionId: Uuid,
    artifactDigest: DigestString,
    gateRunId: Uuid,
    caseRunId: Uuid,
    sessionId: Uuid,
    logicalJobId: Uuid,
    protocolProfileId: RevisionId,
    adapterRevision: RevisionId,
    effectCoveragePolicyDigest: DigestString,
    effectManifestDigest: DigestString,
    fencingEpoch: FencingEpoch,
    currentPhase: z.enum(OPERATION_PHASES),
    quoteRequestDigest: DigestString,
    quoteFinalizationDigest: DigestString.nullable(),
    commitBindingDigest: DigestString.nullable(),
    normalizedOutcome: z.enum(NORMALIZED_FACTS).nullable(),
  })
  .strict();
export type RunOperationRecord = z.infer<typeof RunOperationRecord>;

export const RunOperationLineageRecord = z
  .object({
    schemaVersion: v1,
    fromRunOperationId: Uuid,
    toRunOperationId: Uuid,
    relation: z.enum(LINEAGE_RELATIONS),
    lineageDigest: DigestString,
  })
  .strict()
  .refine((l) => l.fromRunOperationId !== l.toRunOperationId, 'lineage cannot self-link');
export type RunOperationLineageRecord = z.infer<typeof RunOperationLineageRecord>;

export const AttemptRecord = z
  .object({
    schemaVersion: v1,
    attemptId: Uuid,
    runOperationId: Uuid,
    sessionId: Uuid,
    fencingEpoch: FencingEpoch,
    attemptOrdinal: PositiveInt,
    transportRequestId: BoundedText(128),
    phase: z.enum(OPERATION_PHASES),
    outcome: z.enum(ATTEMPT_OUTCOMES),
    timerCanonical: z.boolean(),
  })
  .strict();
export type AttemptRecord = z.infer<typeof AttemptRecord>;

export const EvidenceItemRecord = z
  .object({
    schemaVersion: v1,
    evidenceId: Uuid,
    integrationRevisionId: Uuid,
    buildRevisionId: Uuid,
    artifactDigest: DigestString,
    buildAttestationClass: z.enum(SUBJECT_ATTESTATION_CLASSES),
    caseLaunchAttestationId: Uuid.nullable(),
    gateRunId: Uuid,
    caseRunId: Uuid,
    sessionId: Uuid,
    scenarioRevisionId: Uuid,
    effectCoveragePolicyDigest: DigestString,
    effectManifestDigest: DigestString,
    fencingEpoch: FencingEpoch,
    runOperationId: Uuid.nullable(),
    evidenceClass: z.enum(EVIDENCE_CLASSES),
    evidenceScope: z.enum(EVIDENCE_SCOPES),
    reasons: z.array(z.enum(EVIDENCE_REASONS)).max(EVIDENCE_REASONS.length),
    subject: BoundedText(128),
    assetId: BoundedText(256).nullable(),
    amount: BaseUnitAmount.nullable(),
    payloadDigest: DigestString,
  })
  .strict();
export type EvidenceItemRecord = z.infer<typeof EvidenceItemRecord>;

export const InvariantResultRecord = z
  .object({
    schemaVersion: v1,
    resultId: Uuid,
    gateRunId: Uuid,
    caseRunId: Uuid,
    sessionId: Uuid,
    runOperationId: Uuid.nullable(),
    invariantId: z.string().regex(/^INV-(0[1-9]|1[0-2])$/),
    verdict,
    evaluatorRevision: RevisionId,
    evidenceIds: z.array(Uuid).max(10_000),
    missingPredicates: z.array(BoundedText(128)).max(256),
    reasons: z.array(z.enum(EVIDENCE_REASONS)).max(EVIDENCE_REASONS.length),
    fencingEpoch: FencingEpoch,
    resultDigest: DigestString,
  })
  .strict();
export type InvariantResultRecord = z.infer<typeof InvariantResultRecord>;

/** Gate evaluation: decision, artifact readiness, enforcement mode, and compatibility stay separate. */
export const GateEvaluationRecord = z
  .object({
    schemaVersion: v1,
    gateEvaluationId: Uuid,
    gateRunId: Uuid,
    decision: verdict,
    decisionDigest: DigestString,
    artifactReady: z.boolean(),
    enforcementMode: z.enum(ENFORCEMENT_MODES),
    caseResultDigests: z.array(DigestString).max(10_000),
  })
  .strict();
export type GateEvaluationRecord = z.infer<typeof GateEvaluationRecord>;

export const CompatibilityProbeRecord = z
  .object({
    schemaVersion: v1,
    probeId: Uuid,
    protocolProfileId: RevisionId,
    compatibility: z.enum(OFFICIAL_COMPATIBILITY),
    responseShapeDigest: DigestString.nullable(),
    observedAtMs: wallMs,
  })
  .strict();
export type CompatibilityProbeRecord = z.infer<typeof CompatibilityProbeRecord>;

export const ScenarioRevisionRef = z
  .object({
    schemaVersion: v1,
    scenarioRevisionId: Uuid,
    scenarioStableId: BoundedText(128),
    provenance: z.enum(PROVENANCE_CLASSES),
    revisionDigest: DigestString,
  })
  .strict();
export type ScenarioRevisionRef = z.infer<typeof ScenarioRevisionRef>;
