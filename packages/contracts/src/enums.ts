/**
 * Closed RouteSpec enumerations (API-SPEC.md section 2, DATA-MODEL.md).
 *
 * Every enumeration is a frozen tuple plus a derived union type. TypeScript `enum` is not
 * used so the sources remain erasable (Node.js native type stripping). Each axis is a
 * separate type: lifecycle, verdict, evidence class, evidence scope, evidence reason,
 * attestation class, coverage basis, artifact readiness, enforcement mode, and official
 * compatibility are never merged into one status field.
 */

function closed<const T extends readonly string[]>(values: T): T {
  return Object.freeze([...values]) as unknown as T;
}

export function isMember<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export const EXECUTION_LIFECYCLES = closed([
  'PENDING',
  'DRAFT',
  'VALIDATING',
  'READY',
  'RUNNING',
  'RECOVERY_REQUIRED',
  'EVALUATING',
  'COMPLETED',
  'ABORTED',
  'ERROR',
] as const);
export type ExecutionLifecycle = (typeof EXECUTION_LIFECYCLES)[number];

export const VERDICTS = closed(['NOT_RUN', 'PASS', 'FAIL', 'REVIEW', 'UNSUPPORTED'] as const);
export type Verdict = (typeof VERDICTS)[number];

export const EVIDENCE_CLASSES = closed([
  'PROVEN',
  'REPORTED',
  'INFERRED',
  'UNKNOWN',
  'UNSUPPORTED',
  'STALE',
] as const);
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export const EVIDENCE_SCOPES = closed([
  'SIMULATED_GROUND_TRUTH',
  'PUBLIC_CHAIN_OBSERVATION',
  'PROVIDER_REPORTED',
  'SUBJECT_REPORTED',
  'PRIVATE_NOT_VISIBLE',
] as const);
export type EvidenceScope = (typeof EVIDENCE_SCOPES)[number];

export const EVIDENCE_REASONS = closed([
  'NOT_VISIBLE',
  'MISSING',
  'CONTRADICTORY',
  'PRIVATE',
  'STALE',
  'UNSUPPORTED',
  'NONCANONICAL_TIMER',
  'UNATTESTED_BUILD',
  'IDENTITY_MISMATCH',
  'EFFECT_COVERAGE_MISSING',
] as const);
export type EvidenceReason = (typeof EVIDENCE_REASONS)[number];

export const SUBJECT_ATTESTATION_CLASSES = closed([
  'USER_ASSERTED_LOCAL',
  'TRUSTED_LAUNCHER',
  'CI_ATTESTED',
] as const);
export type SubjectAttestationClass = (typeof SUBJECT_ATTESTATION_CLASSES)[number];

/** The permanent registration claim of every build row. A build row never upgrades. */
export const BUILD_REGISTRATION_CLAIM = 'USER_ASSERTED_LOCAL' as const;

export const OPERATION_PHASES = closed([
  'QUOTE_REQUEST',
  'QUOTE_FINALIZATION',
  'COMMIT_MUTATION',
  'READ_ONLY_RECONCILIATION',
] as const);
export type OperationPhase = (typeof OPERATION_PHASES)[number];

export const TOKEN_PURPOSES = closed(['EXECUTION', 'RECONCILIATION_ONLY'] as const);
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

/** Phases each token purpose may exercise. A reconciliation token can never finalize or commit. */
export const TOKEN_PURPOSE_PHASES: Readonly<Record<TokenPurpose, readonly OperationPhase[]>> = Object.freeze({
  EXECUTION: Object.freeze([
    'QUOTE_REQUEST',
    'QUOTE_FINALIZATION',
    'COMMIT_MUTATION',
    'READ_ONLY_RECONCILIATION',
  ] as const),
  RECONCILIATION_ONLY: Object.freeze(['READ_ONLY_RECONCILIATION'] as const),
});

export const EFFECT_COVERAGE_BASES = closed([
  'INDEPENDENT_BOUNDARY_INTERCEPT',
  'TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT',
  'DECLARED_HOOKS_ONLY',
] as const);
export type EffectCoverageBasis = (typeof EFFECT_COVERAGE_BASES)[number];

/** RouteSpec v2 caps enforcement at REQUIRED_CHECK_UNVERIFIED; there is no blocking mode. */
export const ENFORCEMENT_MODES = closed(['LOCAL_ADVISORY', 'CI_CHECK', 'REQUIRED_CHECK_UNVERIFIED'] as const);
export type EnforcementMode = (typeof ENFORCEMENT_MODES)[number];

export const PROVIDER_TOKEN_STATES = closed([
  'NOT_REQUIRED',
  'OPTIONAL_ABSENT',
  'PRESENT_IN_MEMORY',
  'EXPIRED',
] as const);
export type ProviderTokenState = (typeof PROVIDER_TOKEN_STATES)[number];

export const MODES = closed(['SIMULATE', 'REPLAY', 'LIVE_DRY_PROBE'] as const);
export type Mode = (typeof MODES)[number];

export const OFFICIAL_COMPATIBILITY = closed([
  'DOCUMENTED_ONLY',
  'OFFICIAL_ENDPOINT_COMPATIBLE',
  'INCOMPATIBLE',
  'UNKNOWN',
] as const);
export type OfficialCompatibility = (typeof OFFICIAL_COMPATIBILITY)[number];

export const ATTEMPT_OUTCOMES = closed([
  'NOT_SENT',
  'REJECTED_LOCALLY',
  'SENT_RESPONSE_RECEIVED',
  'SENT_OUTCOME_UNKNOWN',
  'RECONCILED',
] as const);
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** The seven raw statuses enumerated by the pinned official SDK (GetExecutionStatusResponse.status). */
export const RAW_PROVIDER_STATUSES = closed([
  'PENDING_DEPOSIT',
  'KNOWN_DEPOSIT_TX',
  'PROCESSING',
  'SUCCESS',
  'INCOMPLETE_DEPOSIT',
  'REFUNDED',
  'FAILED',
] as const);
export type RawProviderStatus = (typeof RAW_PROVIDER_STATUSES)[number];

export const NORMALIZED_FACTS = closed([
  'AWAITING_DEPOSIT',
  'DEPOSIT_OBSERVED',
  'PROCESSING',
  'SUCCESS_REPORTED',
  'SUCCESS_PROVEN',
  'INCOMPLETE_REPORTED',
  'REFUND_REPORTED',
  'REFUND_PROVEN',
  'FAILED_REPORTED',
  'CONTRADICTORY',
  'UNKNOWN',
  'NOT_VISIBLE',
] as const);
export type NormalizedFact = (typeof NORMALIZED_FACTS)[number];

export const LINEAGE_RELATIONS = closed([
  'BASELINE_OF',
  'CORRECTION_OF',
  'REPLAY_OF',
  'PROMOTED_FROM',
] as const);
export type LineageRelation = (typeof LINEAGE_RELATIONS)[number];

export const CASE_LINEAGE_ROLES = closed(['BASELINE', 'CORRECTED', 'REPLAY', 'PROMOTED_REGRESSION'] as const);
export type CaseLineageRole = (typeof CASE_LINEAGE_ROLES)[number];

export const EFFECT_ACTIONS = closed(['ATTEMPTED', 'BLOCKED', 'RELEASED'] as const);
export type EffectAction = (typeof EFFECT_ACTIONS)[number];

export const ATTESTER_KINDS = closed(['LOCAL_LAUNCHER_KEY', 'CI_OIDC'] as const);
export type AttesterKind = (typeof ATTESTER_KINDS)[number];

export const CHALLENGE_SCOPES = closed([
  'BUILD_REGISTRATION',
  'CASE_LAUNCH',
  'EFFECT_INVENTORY',
  'EFFECT_INTERCEPTOR_LAUNCH',
] as const);
export type ChallengeScope = (typeof CHALLENGE_SCOPES)[number];

export const PROVENANCE_CLASSES = closed([
  'SYNTHETIC',
  'OFFICIAL_SPEC_DERIVED',
  'ISSUE_DERIVED_NOT_REPRODUCED',
  'INDEPENDENTLY_REPRODUCED',
  'CUSTOMER_PROVIDED_REDACTED',
  'DISPUTED_AMBIGUITY_CASE',
] as const);
export type ProvenanceClass = (typeof PROVENANCE_CLASSES)[number];

export const IMPORT_STATES = closed([
  'CAPTURED_UNTRUSTED',
  'QUARANTINED',
  'SANITIZED',
  'MAPPED',
  'REPLAY_VERIFIED',
  'REVIEWED',
  'PROMOTED',
  'REJECTED',
  'PURGED',
] as const);
export type ImportState = (typeof IMPORT_STATES)[number];

export const IMPORT_ORIGINS = closed(['INSTALLED_ARTIFACT_CAPTURE', 'USER_FILE'] as const);
export type ImportOrigin = (typeof IMPORT_ORIGINS)[number];

export const MATERIAL_FIELD_CLASSES = closed([
  'QUOTE_REQUEST_KNOWN',
  'QUOTE_RESPONSE_ASSIGNED',
  'QUOTE_RESPONSE_DISPLAY',
  'COMMIT_MATERIAL',
  'RECONCILIATION_ONLY',
  'PROHIBITED_IN_REQUEST',
] as const);
export type MaterialFieldClass = (typeof MATERIAL_FIELD_CLASSES)[number];

export const SINK_OBSERVATION_SOURCES = closed(['SUBJECT_REPORTED', 'INDEPENDENT_BOUNDARY'] as const);
export type SinkObservationSource = (typeof SINK_OBSERVATION_SOURCES)[number];
