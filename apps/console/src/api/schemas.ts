/**
 * Response contracts the console expects from the loopback control API (API-SPEC.md section 4).
 *
 * Closed enumerations come from @routespec/contracts so the console, CLI, and API share one
 * vocabulary (NFR-12). Response objects strip unknown additive fields (API minor versions may
 * add fields) but every enumerated axis is closed: an unknown lifecycle, verdict, evidence, or
 * coverage value fails validation and the page renders an "unsupported schema" state instead of
 * guessing. Cross-field contradictions that would mislead a reader (for example declared hooks
 * presented as complete coverage) are rejected the same way. Nothing here derives a verdict.
 */
import { z } from 'zod';
import {
  CASE_LINEAGE_ROLES,
  EFFECT_ACTIONS,
  EFFECT_COVERAGE_BASES,
  ENFORCEMENT_MODES,
  EVIDENCE_CLASSES,
  EVIDENCE_REASONS,
  EVIDENCE_SCOPES,
  EXECUTION_LIFECYCLES,
  IMPORT_ORIGINS,
  IMPORT_STATES,
  NORMALIZED_FACTS,
  OFFICIAL_COMPATIBILITY,
  OPERATION_PHASES,
  PROVENANCE_CLASSES,
  PROVIDER_TOKEN_STATES,
  RAW_PROVIDER_STATUSES,
  SUBJECT_ATTESTATION_CLASSES,
  TOKEN_PURPOSES,
  VERDICTS,
  LINEAGE_RELATIONS,
  SINK_OBSERVATION_SOURCES,
} from '@routespec/contracts/enums';

const zEnum = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values);
const asTuple = <T extends readonly string[]>(values: T) =>
  values as unknown as readonly [T[number], ...T[number][]];

export const zLifecycle = zEnum(asTuple(EXECUTION_LIFECYCLES));
/** M16: effective interceptor profile review state and declared bundle/promotion use. */
export const zProfileReviewState = z.enum([
  'DECLARED_UNREVIEWED',
  'REVIEWED',
  'REVIEW_REJECTED',
  'REVIEW_REVOKED',
]);
export const zEvidenceUse = z.enum(['RELEASE_EVIDENCE', 'DIAGNOSTIC_ONLY']);
export const zVerdict = zEnum(asTuple(VERDICTS));
export const zEvidenceClass = zEnum(asTuple(EVIDENCE_CLASSES));
export const zEvidenceScope = zEnum(asTuple(EVIDENCE_SCOPES));
export const zEvidenceReason = zEnum(asTuple(EVIDENCE_REASONS));
export const zAttestationClass = zEnum(asTuple(SUBJECT_ATTESTATION_CLASSES));
export const zCoverageBasis = zEnum(asTuple(EFFECT_COVERAGE_BASES));
export const zEnforcement = zEnum(asTuple(ENFORCEMENT_MODES));
export const zProviderTokenState = zEnum(asTuple(PROVIDER_TOKEN_STATES));
export const zPhase = zEnum(asTuple(OPERATION_PHASES));
export const zTokenPurpose = zEnum(asTuple(TOKEN_PURPOSES));
export const zLineageRole = zEnum(asTuple(CASE_LINEAGE_ROLES));
export const zLineageRelation = zEnum(asTuple(LINEAGE_RELATIONS));
export const zImportState = zEnum(asTuple(IMPORT_STATES));
export const zImportOrigin = zEnum(asTuple(IMPORT_ORIGINS));
export const zProvenance = zEnum(asTuple(PROVENANCE_CLASSES));
export const zRawStatus = zEnum(asTuple(RAW_PROVIDER_STATUSES));
export const zNormalizedFact = zEnum(asTuple(NORMALIZED_FACTS));
export const zEffectAction = zEnum(asTuple(EFFECT_ACTIONS));
export const zSinkSource = zEnum(asTuple(SINK_OBSERVATION_SOURCES));
/** Official-endpoint compatibility record status; NOT_RUN means no probe record exists. */
export const zCompatibilityStatus = z.enum(['NOT_RUN', ...asTuple(OFFICIAL_COMPATIBILITY)]);
/** Gate runs accept only the networkless modes; LIVE_DRY_PROBE is a separate compatibility probe. */
export const zGateMode = z.enum(['SIMULATE', 'REPLAY']);

export const COVERAGE_FINDINGS = ['COMPLETE', 'INCOMPLETE', 'NOT_EVALUATED'] as const;
export const zCoverageFinding = z.enum(COVERAGE_FINDINGS);
export const FRESHNESS = ['FRESH', 'STALE', 'REVOKED', 'NOT_APPLICABLE'] as const;
export const zFreshness = z.enum(FRESHNESS);
export const TOKEN_STATES = ['NOT_ISSUED', 'ACTIVE', 'EXPIRED', 'REVOKED', 'REUSE_REJECTED'] as const;
export const CLIENT_STATES = [
  'NOT_STARTED',
  'CONNECTED',
  'TORN_DOWN',
  'TEARDOWN_INCOMPLETE',
  'CONCURRENT_CLIENT_REJECTED',
] as const;
export const RESET_STATES = ['PENDING', 'COMPLETE', 'INCOMPLETE'] as const;
export const FINDING_LEVELS = ['FAIL', 'REVIEW', 'INFO'] as const;
export const EVENT_KINDS = [
  'CLIENT_REQUEST',
  'PROXY_RESPONSE',
  'PROXY_DROP',
  'CONNECTION_BARRIER',
  'PHASE_BINDING',
  'PROVIDER_OBSERVATION',
  'REQUIRED_SINK',
  'SUBJECT_REPORT',
  'BOUNDARY_OBSERVATION',
  'TOKEN_LIFECYCLE',
  'GROUND_TRUTH',
  'EVIDENCE',
  'INVARIANT',
  'SAFETY_DENIAL',
] as const;
export const LINEAGE_STAGES = [
  'CAPTURE',
  'QUARANTINE',
  'SANITIZE',
  'MAP',
  'REPLAY_VERIFICATION',
  'REVIEW',
  'PROMOTED_SCENARIO',
  'NEW_CORPUS',
  'CORRECTED_RERUN',
] as const;
export const STAGE_STATES = ['DONE', 'PENDING', 'BLOCKED'] as const;

const id = z.string().min(1).max(160);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'expected sha256 digest');
const time = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();
const safeText = z.string().max(2000);

export const zEvidenceSummary = z.object({
  class: zEvidenceClass,
  scope: zEvidenceScope.nullable(),
  reasons: z.array(zEvidenceReason).max(16),
});

export const zAttestationRef = z.object({
  class: zAttestationClass,
  attestationId: id.nullable(),
  observedAt: time.nullable(),
  freshness: zFreshness,
});

export const zEffectCoverage = z
  .object({
    basis: zCoverageBasis.nullable(),
    finding: zCoverageFinding,
    missing: z.array(safeText).max(64),
    interceptorProfileId: id.nullable(),
    interceptorFreshness: zFreshness,
    processTreeScope: safeText.nullable(),
    interceptorReviewState: zProfileReviewState.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    // Declared hooks only can never be presented as complete coverage (UI-SPEC 3.1, NFR-12).
    if (value.basis === 'DECLARED_HOOKS_ONLY' && value.finding === 'COMPLETE') {
      ctx.addIssue({ code: 'custom', message: 'DECLARED_HOOKS_ONLY cannot be COMPLETE' });
    }
    if (value.basis === null && value.finding === 'COMPLETE') {
      ctx.addIssue({ code: 'custom', message: 'coverage without basis cannot be COMPLETE' });
    }
  });

export const zCompatibilityRef = z.object({
  status: zCompatibilityStatus,
  recordId: id.nullable(),
  observedAt: time.nullable(),
});

export const zCounts = z.object({
  total: count,
  passed: count,
  failed: count,
  review: count,
  unsupportedRequired: count,
  notRun: count,
});

export const zFinding = z.object({
  code: z.string().regex(/^RS_[A-Z0-9_]+$/),
  level: z.enum(FINDING_LEVELS),
  message: safeText,
  caseRunId: id.nullable(),
});

export const zGateIdentity = z.object({
  repository: safeText.nullable(),
  commitSha: z.string().max(64).nullable(),
  dirtyTreeDigest: digest.nullable(),
  buildRevisionId: id,
  artifactDigest: digest,
  effectPolicyDigest: digest.nullable(),
  effectManifestDigest: digest.nullable(),
  callSiteInventoryDigest: digest.nullable(),
  interceptorProfileDigest: digest.nullable(),
  corpusRevisionId: id,
  corpusDigest: digest,
  evaluatorRevision: safeText,
  adapterRevision: safeText,
  protocolProfileId: safeText,
  configurationDigest: digest,
  workflowRunId: safeText.nullable(),
  appRevision: safeText,
});

/** The eight separately named status axes (UI-SPEC 6.2). Every page renders these from API values. */
export const zStatusAxes = z.object({
  lifecycle: zLifecycle,
  verdict: zVerdict,
  verdictReason: safeText.nullable(),
  evidence: zEvidenceSummary,
  attestation: zAttestationRef,
  effectCoverage: zEffectCoverage,
  artifactReady: z.boolean().nullable(),
  enforcementMode: zEnforcement,
  officialCompatibility: zCompatibilityRef,
  evaluatedAt: time.nullable(),
  evidenceObservedAt: time.nullable(),
});

export const zProject = z.object({
  projectId: id,
  name: safeText,
  description: safeText.nullable(),
  settingsRevision: count,
});

export const zMatrixRow = zStatusAxes.extend({
  revisionId: id,
  revisionLabel: safeText,
  commitSha: z.string().max(64).nullable(),
  buildRevisionId: id,
  artifactDigest: digest,
  corpusRevisionId: id,
  corpusDigest: digest,
  caseCount: count,
  gateRunId: id.nullable(),
  counts: zCounts,
});

export const zMatrix = z.object({
  projectId: id,
  projectName: safeText,
  rows: z.array(zMatrixRow).max(200),
  nextCursor: z.string().max(512).nullable(),
});

export const zGateRun = zStatusAxes.extend({
  gateRunId: id,
  projectId: id,
  revisionId: id,
  mode: zGateMode,
  identity: zGateIdentity,
  interceptorAttestation: zAttestationRef.nullable(),
  parallelism: z.object({ declared: z.number().int().min(1).max(64), running: count, queued: count }),
  counts: zCounts,
  findings: z.array(zFinding).max(200),
  revision: count,
  /** Gate definition this run was created for; evaluation is offered only when present. */
  gateId: id.nullable().optional(),
  /** The latest persisted gate evaluation (export planning starts from it). */
  gateEvaluationId: id.nullable().optional(),
});

export const zTokenRef = z.object({
  state: z.enum(TOKEN_STATES),
  purpose: zTokenPurpose.nullable(),
  expiresAt: time.nullable(),
});

export const zRecovery = z.object({
  available: z.boolean(),
  /** The only recovery the API offers is read-only reconciliation; anything else is rejected. */
  action: z.literal('RECONCILE_EXISTING_OPERATION'),
  readOnly: z.literal(true),
  reasonCode: z.string().regex(/^RS_[A-Z0-9_]+$/),
});

export const zCaseRun = z.object({
  caseRunId: id,
  gateRunId: id,
  ordinal: count,
  scenarioRevisionId: id,
  scenarioName: safeText,
  lineageRole: zLineageRole,
  logicalJobLabel: safeText,
  lifecycle: zLifecycle,
  verdict: zVerdict,
  verdictReason: safeText.nullable(),
  evidence: zEvidenceSummary,
  clientState: z.enum(CLIENT_STATES),
  resetState: z.enum(RESET_STATES),
  token: zTokenRef,
  fencingEpoch: count,
  effectCoverage: zEffectCoverage,
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).nullable(),
  requiredInvariants: z.array(z.string().regex(/^INV-\d{2}$/)).max(32),
  queuePosition: count.nullable(),
  recovery: zRecovery.nullable(),
  sessionId: id.nullable(),
  runOperationIds: z.array(id).max(64),
  provenance: zProvenance.nullable(),
});

export const zPage = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item).max(200), nextCursor: z.string().max(512).nullable(), total: count });

export const zCaseRunPage = zPage(zCaseRun);

export const zOneTimeToken = z.object({
  value: z.string().min(16).max(512),
  purpose: zTokenPurpose,
  expiresAt: time,
});

export const zCaseStart = z.object({
  caseRunId: id,
  sessionId: id,
  clientInstanceId: id,
  proxyBaseUrl: z.url(),
  fencingEpoch: count,
  headers: z.object({
    session: id,
    caseRun: id,
    logicalJob: safeText,
    adapter: safeText,
    fencingEpoch: safeText,
  }),
  token: zOneTimeToken.refine((t) => t.purpose === 'EXECUTION', 'case start issues an EXECUTION token'),
});

export const zRecoveryResult = z.object({
  caseRunId: id,
  previousEpoch: count,
  fencingEpoch: count,
  revokedTokenPurpose: zTokenPurpose,
  lifecycle: zLifecycle,
  clientInstanceId: id.nullable().optional(),
  token: zOneTimeToken.refine(
    (t) => t.purpose === 'RECONCILIATION_ONLY',
    'recovery must issue a RECONCILIATION_ONLY token',
  ),
});

export const zTimelineEvent = z.object({
  sequence: count,
  kind: z.enum(EVENT_KINDS),
  eventCode: z.string().regex(/^[A-Z0-9_.-]{1,64}$/),
  phase: zPhase.nullable(),
  runOperationId: id.nullable(),
  source: z.enum([
    'CLIENT',
    'PROXY',
    'PROVIDER',
    'SCENARIO',
    'SUBJECT',
    'INTERCEPTOR',
    'EVALUATOR',
    'CONTROL',
  ]),
  evidenceClass: zEvidenceClass.nullable(),
  evidenceScope: zEvidenceScope.nullable(),
  evidenceReasons: z.array(zEvidenceReason).max(16),
  virtualMs: count.nullable(),
  wallTime: time,
  timerCanonical: z.boolean(),
  summary: safeText,
});

export const zEventPage = zPage(zTimelineEvent);

export const zSession = z.object({
  sessionId: id,
  gateRunId: id,
  caseRunId: id,
  mode: zGateMode,
  lifecycle: zLifecycle,
  fencingEpoch: count,
  buildRevisionId: id,
  artifactDigest: digest,
  adapterRevision: safeText,
  effectManifestDigest: digest.nullable(),
  eventCount: count,
  lastSequence: count,
});

const zPhaseBinding = z.object({
  state: z.enum(['BOUND', 'ABSENT', 'REJECTED_CONFLICT']),
  digest: digest.nullable(),
  boundAt: time.nullable(),
  fields: z.array(z.object({ name: safeText, value: safeText, masked: z.boolean() })).max(64),
});

export const zEvidence = z.object({
  evidenceId: id,
  class: zEvidenceClass,
  scope: zEvidenceScope,
  reasons: z.array(zEvidenceReason).max(16),
  provenance: safeText,
  subject: safeText,
  observedAt: time.nullable(),
  collectedAt: time,
  freshness: zFreshness,
  digest,
  redacted: z.boolean(),
});

export const zInvariantResult = z.object({
  invariantId: z.string().regex(/^INV-\d{2}$/),
  title: safeText,
  status: zVerdict,
  applicable: z.boolean(),
  facts: z.array(safeText).max(64),
  evidenceIds: z.array(id).max(64),
  missingPredicates: z.array(safeText).max(64),
  remediationCode: z
    .string()
    .regex(/^RS_[A-Z0-9_]+$/)
    .nullable(),
});

export const zSinkObservation = z.object({
  observationId: id,
  source: zSinkSource,
  hookId: safeText.nullable(),
  sinkClass: safeText,
  effectType: safeText,
  action: zEffectAction,
  sequence: count,
  interceptorProfileId: id.nullable(),
  processTreeScope: safeText.nullable(),
  freshness: zFreshness,
});

export const zRunOperation = z.object({
  runOperationId: id,
  logicalJobDigest: digest,
  logicalJobLabel: safeText,
  bindingDigest: digest.nullable(),
  lineage: z.array(z.object({ relation: zLineageRelation, runOperationId: id })).max(16),
  identity: z.object({
    projectId: id,
    buildRevisionId: id,
    artifactDigest: digest,
    gateRunId: id,
    caseRunId: id,
    sessionId: id,
    adapterRevision: safeText,
    effectPolicyDigest: digest.nullable(),
    effectManifestDigest: digest.nullable(),
    callSiteInventoryDigest: digest.nullable(),
    interceptorProfileDigest: digest.nullable(),
    fencingEpoch: count,
  }),
  currentPhase: zPhase,
  phases: z.object({
    quoteRequest: zPhaseBinding,
    quoteFinalization: zPhaseBinding,
    commitBinding: zPhaseBinding,
    reconciliation: z.object({ observations: count, lastObservedAt: time.nullable() }),
  }),
  conflicts: z
    .array(
      z.object({
        code: z.string().regex(/^RS_[A-Z0-9_]+$/),
        phase: zPhase,
        message: safeText,
        observedAt: time,
      }),
    )
    .max(64),
  providerReported: z.object({
    rawStatus: z.union([zRawStatus, z.string().max(64)]).nullable(),
    rawStatusKnown: z.boolean(),
    normalizedFact: zNormalizedFact.nullable(),
    observedAt: time.nullable(),
  }),
  evaluatedOutcome: z.object({ verdict: zVerdict, fact: zNormalizedFact.nullable() }),
  attempts: z.object({ count, uncertainty: z.enum(['NONE', 'OUTCOME_UNKNOWN']) }),
  effectCoverage: zEffectCoverage,
  sinkObservations: z.array(zSinkObservation).max(500),
  evidence: z.array(zEvidence).max(500),
  invariants: z.array(zInvariantResult).max(64),
});

export const zImportRow = z.object({
  importId: id,
  origin: zImportOrigin,
  source: z.object({ buildRevisionId: id, gateRunId: id, caseRunId: id, sessionId: id }).nullable(),
  sanitizedName: safeText,
  digest,
  sizeBytes: count,
  state: zImportState,
  /** Optimistic revision for If-Match on import mutations. */
  revision: count,
  findings: z.object({ secret: count, nondeterminism: count, unresolved: count }),
  expiresAt: time.nullable(),
  /** Server-authoritative: the console never decides on its own that promotion is allowed. */
  promotable: z.boolean(),
  blockers: z
    .array(z.object({ field: safeText, code: z.string().regex(/^RS_[A-Z0-9_]+$/), message: safeText }))
    .max(64),
});

export const zImportPage = zPage(zImportRow);

export const zImportDetail = zImportRow.extend({
  lineage: z
    .array(
      z.object({
        stage: z.enum(LINEAGE_STAGES),
        state: z.enum(STAGE_STATES),
        recordId: id.nullable(),
        digest: digest.nullable(),
      }),
    )
    .max(16),
  sourceEvents: z.array(z.object({ sequence: count, summary: safeText })).max(500),
  proposedEvents: z
    .array(z.object({ sequence: count, phase: zPhase.nullable(), summary: safeText }))
    .max(500),
  replayOnlyPass: z.boolean(),
  regressionStatus: z
    .enum([
      'IN_QUARANTINE',
      'REJECTED',
      'PROMOTED_AWAITING_CORRECTED_RUN',
      'CORRECTED_RUN_NOT_PASSING',
      'CORRECTED_RUN_PASSED',
    ])
    .optional(),
  promotion: z
    .object({
      scenarioRevisionId: id,
      corpusRevisionId: id,
      baseCorpusRevisionId: id.nullable(),
      evidenceUse: z.enum(['RELEASE_EVIDENCE', 'DIAGNOSTIC_ONLY', 'UNCLASSIFIED']).optional(),
      refusalReasons: z.array(safeText).max(16).optional(),
    })
    .nullable()
    .optional(),
  /** Server-derived (M16): whether this capture may be promoted as release evidence. */
  releaseEvidence: z
    .object({
      releaseEvidence: z.boolean(),
      refusalReasons: z.array(safeText).max(16),
      promotableAs: z.array(zEvidenceUse).min(1).max(2),
    })
    .nullable()
    .optional(),
  correctedRuns: z
    .array(
      z.object({
        gateRunId: id,
        caseRunId: id,
        buildRevisionId: id,
        lineageRole: zLineageRole,
        lifecycle: zLifecycle,
        verdict: zVerdict.nullable(),
      }),
    )
    .max(64)
    .optional(),
  mapping: z.object({ mappingRevisionId: id, mappingDigest: digest }).nullable().optional(),
  replayReport: z
    .object({ reportId: id, stable: z.boolean(), trials: count, reportDigest: digest })
    .nullable()
    .optional(),
  /** Review requirements published by the service; the console renders them, never invents them. */
  review: z
    .object({
      decisions: z.array(z.string().regex(/^[A-Z_]{3,64}$/)).max(16),
      confirmationPhrase: safeText,
      latestReviewId: id.nullable(),
    })
    .optional(),
});

// ---------------------------------------------------------------- mutation results
// Mutation replies are acknowledgements; the console re-reads the authoritative record after
// each one instead of treating the reply as the record.

export const zValidateResult = z.object({
  ready: z.boolean(),
  findings: z.array(z.unknown()).max(200),
  gateRun: zGateRun,
});
export const zStartResult = z.object({ proxyBaseUrl: z.url(), gateRun: zGateRun });
export const zCaptureResult = z.object({ importId: id, state: zImportState, revision: count });
export const zImportAck = z.object({ state: zImportState });
export const zReviewResult = z.object({ reviewId: id, revision: count, state: zImportState });
export const zPromoteResult = z.object({
  scenarioRevisionId: id,
  corpusRevisionId: id,
  baseCorpusMutated: z.literal(false),
  evidenceUse: zEvidenceUse.optional(),
});
export const zProposedMapping = z.object({
  importId: id,
  revision: count,
  mapping: z.record(z.string(), z.unknown()),
  derivedFrom: z.enum(['SOURCE_SCENARIO', 'OBSERVED_TRACE']),
  proposal: z.literal('UNREVIEWED_DRAFT'),
});
export const zGateEvaluation = z.object({
  gateEvaluationId: id,
  gateRunId: id,
  decision: zVerdict,
  enforcementMode: zEnforcement,
  artifactReady: z.boolean().nullable(),
  /** v2 never claims release blocking; anything else is an unsupported record. */
  blocksRelease: z.literal(false),
});
export const zExportPlan = z.object({
  exportId: id,
  blocked: z.boolean(),
  planDigest: digest,
  bundleDigest: digest.nullable(),
  bundleBytes: count.nullable(),
  privacyScanResult: z.enum(['CLEAN', 'ADDRESSES_ACKNOWLEDGED', 'BLOCKED']),
  exclusions: z.array(safeText).max(64),
  entries: z.array(z.object({ path: safeText, digest, bytes: count, kind: safeText })).max(500),
  written: z.literal(false),
  evidenceUse: zEvidenceUse.optional(),
});

export const zSettings = z.object({
  bindAddress: z.enum(['127.0.0.1', '::1']),
  port: z.number().int().min(1).max(65535),
  modes: z
    .array(
      z.object({
        mode: z.enum(['SIMULATE', 'REPLAY', 'LIVE_DRY_PROBE', 'COMMITTED_LIVE']),
        supported: z.boolean(),
        runtime: z.enum(['NETWORKLESS_SCENARIO', 'LIVE_DRY_ADAPTER', 'NONE']),
      }),
    )
    .max(8)
    .refine(
      (modes) => modes.every((m) => m.mode !== 'COMMITTED_LIVE' || !m.supported),
      'committed live mode is never supported',
    ),
  providerTokenState: zProviderTokenState,
  upstreamOrigin: safeText.nullable(),
  allowlistedRoutes: z.array(safeText).max(32),
  retention: z.object({ days: count, storageBytes: count }),
  exportPolicy: safeText,
  versions: z.object({
    app: safeText,
    protocolProfile: safeText,
    evaluator: safeText,
    sdk: safeText,
  }),
  compatibilityRecords: z
    .array(
      z.object({
        recordId: id,
        status: zCompatibilityStatus,
        buildRevisionId: id,
        profileId: safeText,
        observedAt: time,
      }),
    )
    .max(64),
  dryProbe: z.object({ authorized: z.boolean(), expiresAt: time.nullable() }),
});

export const zErrorEnvelope = z.object({
  error: z.object({
    code: z.string().max(80),
    message: safeText,
    requestId: z.string().max(80).optional(),
    recoverable: z.boolean().optional(),
    details: z
      .object({
        fields: z
          .array(z.object({ field: z.string().max(120), code: z.string().max(80), message: safeText }))
          .max(64)
          .optional(),
      })
      .loose()
      .optional(),
  }),
});

export type EvidenceSummary = z.infer<typeof zEvidenceSummary>;
export type AttestationRef = z.infer<typeof zAttestationRef>;
export type EffectCoverage = z.infer<typeof zEffectCoverage>;
export type CompatibilityRef = z.infer<typeof zCompatibilityRef>;
export type StatusAxes = z.infer<typeof zStatusAxes>;
export type Project = z.infer<typeof zProject>;
export type Matrix = z.infer<typeof zMatrix>;
export type MatrixRow = z.infer<typeof zMatrixRow>;
export type GateRun = z.infer<typeof zGateRun>;
export type CaseRun = z.infer<typeof zCaseRun>;
export type CaseStart = z.infer<typeof zCaseStart>;
export type RecoveryResult = z.infer<typeof zRecoveryResult>;
export type TimelineEvent = z.infer<typeof zTimelineEvent>;
export type EventPage = z.infer<typeof zEventPage>;
export type Session = z.infer<typeof zSession>;
export type RunOperation = z.infer<typeof zRunOperation>;
export type Evidence = z.infer<typeof zEvidence>;
export type InvariantResult = z.infer<typeof zInvariantResult>;
export type ImportRow = z.infer<typeof zImportRow>;
export type ImportDetail = z.infer<typeof zImportDetail>;
export type Settings = z.infer<typeof zSettings>;
export type ProposedMapping = z.infer<typeof zProposedMapping>;
export type GateEvaluation = z.infer<typeof zGateEvaluation>;
export type ExportPlan = z.infer<typeof zExportPlan>;
export type ErrorEnvelope = z.infer<typeof zErrorEnvelope>;
export type Page<T> = { items: T[]; nextCursor: string | null; total: number };
