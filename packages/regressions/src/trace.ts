/**
 * Normalized trace document `routespec.trace/1` (FR-11, DATA-MODEL.md `imports`).
 *
 * The same closed schema describes an installed-artifact capture (derived by RouteSpec from
 * authoritative journal rows) and a user-supplied file. Every object is `.strict()`: unknown
 * fields — including any attempt to smuggle policy such as `autoPromote` or `verdict` — fail
 * the schema and reject the source. Free text exists only in `annotations` and is data.
 *
 * Exchanges reference run operations and logical jobs by opaque, order-derived refs
 * (`op-1`, `job-1`); exact source identities live only in `identity`, which an installed
 * capture binds and a user file may only claim.
 */
import {
  DigestString,
  ERROR_CODES,
  EVIDENCE_CLASSES,
  EVIDENCE_REASONS,
  EVIDENCE_SCOPES,
  EFFECT_ACTIONS,
  EFFECT_COVERAGE_BASES,
  IMPORT_ORIGINS,
  NORMALIZED_FACTS,
  OPERATION_PHASES,
  VERDICTS,
  z,
} from '@routespec/contracts';

export const TRACE_FORMAT = 'routespec.trace/1' as const;

const Ref = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-[0-9]{1,6}$`));
const Id = z.string().regex(/^[A-Za-z0-9._:@+-]{1,128}$/);
const Seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Token = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const Label = z.string().min(1).max(256);
const Amount = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const Text = z.string().max(8192);

export const TraceIdentity = z
  .object({
    projectId: Id,
    integrationRevisionId: Id,
    buildRevisionId: Id,
    artifactDigest: DigestString,
    gateRunId: Id,
    caseRunId: Id,
    sessionId: Id,
    scenarioRevisionId: Id,
    scenarioRevisionDigest: DigestString,
    effectManifestDigest: DigestString,
    effectCoveragePolicyDigest: DigestString,
    callsiteInventoryDigest: DigestString.nullable(),
    interceptorProfileDigest: DigestString.nullable(),
    adapterRevision: Id,
    fencingEpoch: z.number().int().min(0),
    caseVerdict: z.enum(VERDICTS).nullable(),
    coverageBasis: z.enum(EFFECT_COVERAGE_BASES),
  })
  .strict();
export type TraceIdentity = z.infer<typeof TraceIdentity>;

export const TraceOperation = z
  .object({
    ref: Ref('op'),
    logicalJobRef: Ref('job'),
    phase: z.enum(OPERATION_PHASES),
    depositAddress: Label.nullable(),
    committed: z.boolean(),
    acceptedTerminalStatus: Token.nullable(),
  })
  .strict();

export const TraceExchange = z
  .object({
    sequence: Seq,
    route: z.enum(['QUOTE', 'COMMIT', 'STATUS']),
    phase: z.enum(OPERATION_PHASES),
    operationRef: Ref('op').nullable(),
    fencingEpoch: z.number().int().min(0),
    outcome: z.enum(['RESPONDED', 'RESPONSE_LOST']),
    responseStatus: z.number().int().min(100).max(599).nullable(),
    errorCode: z.enum(ERROR_CODES).nullable(),
    observedRawStatus: Token.nullable(),
    material: z.record(z.string(), z.unknown()),
    virtualMs: z.number().int().min(0).nullable(),
  })
  .strict();
export type TraceExchange = z.infer<typeof TraceExchange>;

export const TraceEvent = z
  .object({
    sequence: Seq,
    kind: Token,
    rawStatus: Token.nullable(),
    normalizedFact: z.enum(NORMALIZED_FACTS).nullable(),
    operationRef: Ref('op').nullable(),
    virtualMs: z.number().int().min(0).nullable(),
  })
  .strict();

export const TraceEvidence = z
  .object({
    subject: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    evidenceClass: z.enum(EVIDENCE_CLASSES),
    evidenceScope: z.enum(EVIDENCE_SCOPES),
    reasons: z.array(z.enum(EVIDENCE_REASONS)).max(16),
    sourceKind: Token,
    operationRef: Ref('op').nullable(),
    assetId: Label.nullable(),
    amount: Amount.nullable(),
  })
  .strict();

export const TraceSubjectReport = z
  .object({
    sequence: Seq,
    hookId: Id,
    effectType: Token,
    action: z.enum(EFFECT_ACTIONS),
    operationRef: Ref('op').nullable(),
  })
  .strict();

export const TraceBoundaryObservation = z
  .object({
    sequence: Seq,
    sinkClass: Id,
    action: z.enum(EFFECT_ACTIONS),
    operationRef: Ref('op').nullable(),
  })
  .strict();

export const TraceDenial = z
  .object({
    route: z.enum(['QUOTE', 'COMMIT', 'STATUS', 'OTHER']),
    code: z.enum(ERROR_CODES),
    count: z.number().int().min(1).max(100_000),
  })
  .strict();

export const TraceDocument = z
  .object({
    format: z.literal(TRACE_FORMAT),
    origin: z.enum(IMPORT_ORIGINS),
    identity: TraceIdentity.nullable(),
    operations: z.array(TraceOperation).max(64),
    exchanges: z.array(TraceExchange),
    events: z.array(TraceEvent),
    evidence: z.array(TraceEvidence),
    subjectReports: z.array(TraceSubjectReport),
    boundaryObservations: z.array(TraceBoundaryObservation),
    denials: z.array(TraceDenial).max(64),
    annotations: z
      .object({
        title: Text.nullable(),
        notes: z.array(Text).max(64),
        disputed: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type TraceDocument = z.infer<typeof TraceDocument>;

export function traceRecordCount(t: {
  exchanges: unknown[];
  events: unknown[];
  evidence: unknown[];
  subjectReports: unknown[];
  boundaryObservations: unknown[];
  denials: unknown[];
}): number {
  return (
    t.exchanges.length +
    t.events.length +
    t.evidence.length +
    t.subjectReports.length +
    t.boundaryObservations.length +
    t.denials.length
  );
}
