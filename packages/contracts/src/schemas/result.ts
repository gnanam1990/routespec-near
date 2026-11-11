/**
 * Canonical case result and the separately stored run envelope (INV-09, NFR-01, NFR-10, T-027).
 *
 * The canonical result digest is a pure function of the mandatory identity and the ordered
 * canonical facts. Wall-clock times, host name, platform, local file paths, and display labels
 * live only in the `RunEnvelope`, which is digested separately and can never influence the
 * canonical result digest. The canonical schema is strict, so envelope-like fields cannot be
 * smuggled into the canonical part.
 */
import { digestValue, type Digest } from '../canonical/digest.ts';
import {
  EVIDENCE_CLASSES,
  EVIDENCE_REASONS,
  EVIDENCE_SCOPES,
  LINEAGE_RELATIONS,
  NORMALIZED_FACTS,
  OPERATION_PHASES,
  SUBJECT_ATTESTATION_CLASSES,
  VERDICTS,
  type EvidenceReason,
} from '../enums.ts';
import { RouteSpecError } from '../errors.ts';
import { BoundedText, DigestString, FencingEpoch, RevisionId, Sequence, Uuid, z } from './common.ts';

export const CANONICAL_RESULT_SCHEMA_VERSION = '1.0' as const;
export const RESULT_DIGEST_DOMAIN = 'routespec.case-result/1';
export const RUN_ENVELOPE_DIGEST_DOMAIN = 'routespec.run-envelope/1';

const CanonicalExchange = z
  .object({
    sequence: Sequence,
    transportRequestId: BoundedText(128),
    phase: z.enum(OPERATION_PHASES),
    method: z.enum(['GET', 'POST']),
    routeTemplate: z.string().regex(/^\/[A-Za-z0-9/_{}.-]{0,255}$/),
    requestDigest: DigestString,
    responseDigest: DigestString.nullable(),
    runOperationId: Uuid.nullable(),
  })
  .strict();

const CanonicalFact = z
  .object({
    sequence: Sequence,
    factKind: z.enum(NORMALIZED_FACTS),
    evidenceId: Uuid,
    evidenceClass: z.enum(EVIDENCE_CLASSES),
    evidenceScope: z.enum(EVIDENCE_SCOPES),
    reasons: z.array(z.enum(EVIDENCE_REASONS)).max(EVIDENCE_REASONS.length),
    payloadDigest: DigestString,
  })
  .strict();

const CanonicalInvariantResult = z
  .object({
    invariantId: z.string().regex(/^INV-(0[1-9]|1[0-2])$/),
    verdict: z.enum(VERDICTS),
    evidenceIds: z.array(Uuid).max(10_000),
    missingPredicates: z.array(BoundedText(128)).max(256),
    reasons: z.array(z.enum(EVIDENCE_REASONS)).max(EVIDENCE_REASONS.length),
  })
  .strict();

const CanonicalRunOperation = z
  .object({
    runOperationId: Uuid,
    logicalJobId: Uuid,
    quoteRequestDigest: DigestString,
    quoteFinalizationDigest: DigestString.nullable(),
    commitBindingDigest: DigestString.nullable(),
    lineage: z
      .array(z.object({ relation: z.enum(LINEAGE_RELATIONS), runOperationId: Uuid }).strict())
      .max(64),
  })
  .strict();

export const CanonicalCaseResult = z
  .object({
    schemaVersion: z.literal(CANONICAL_RESULT_SCHEMA_VERSION),
    projectId: Uuid,
    integrationRevisionId: Uuid,
    buildRevisionId: Uuid,
    artifactDigest: DigestString,
    buildAttestationClass: z.enum(SUBJECT_ATTESTATION_CLASSES),
    buildAttestationId: Uuid.nullable(),
    caseLaunchAttestationId: Uuid.nullable(),
    gateRunId: Uuid,
    caseRunId: Uuid,
    sessionId: Uuid,
    corpusRevisionId: Uuid,
    scenarioRevisionId: Uuid,
    seed: BoundedText(128),
    protocolProfileId: RevisionId,
    adapterRevision: RevisionId,
    evaluatorRevision: RevisionId,
    configurationDigest: DigestString,
    effectCoveragePolicyDigest: DigestString,
    effectManifestDigest: DigestString,
    callsiteInventoryDigest: DigestString.nullable(),
    interceptorInstanceId: Uuid.nullable(),
    fencingEpoch: FencingEpoch,
    runOperations: z.array(CanonicalRunOperation).max(10_000),
    exchanges: z.array(CanonicalExchange).max(100_000),
    facts: z.array(CanonicalFact).max(100_000),
    invariantResults: z.array(CanonicalInvariantResult).max(12),
    verdict: z.enum(VERDICTS),
  })
  .strict();
export type CanonicalCaseResult = z.infer<typeof CanonicalCaseResult>;

/** Non-canonical run metadata. It may differ across hosts and runs without changing identity. */
export const RunEnvelope = z
  .object({
    schemaVersion: z.literal('1.0'),
    wallClockStartedAt: z.string().max(64),
    wallClockEndedAt: z.string().max(64).nullable(),
    hostName: z.string().max(256),
    platform: z.string().max(32),
    arch: z.string().max(32),
    runtimeVersion: z.string().max(64),
    dataDirectory: z.string().max(4096),
    workingDirectory: z.string().max(4096),
    artifactPaths: z.array(z.string().max(4096)).max(1024),
    displayLabels: z.record(z.string().max(64), z.string().max(256)),
  })
  .strict();
export type RunEnvelope = z.infer<typeof RunEnvelope>;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(cmp);
}

function bySequence<T extends { sequence: number }>(items: readonly T[], label: string): T[] {
  const sorted = [...items].sort((a, b) => a.sequence - b.sequence);
  for (let i = 1; i < sorted.length; i++) {
    if ((sorted[i] as T).sequence === (sorted[i - 1] as T).sequence) {
      throw new RouteSpecError('RS_CANONICAL_DUPLICATE_SEQUENCE', 'Duplicate sequence in canonical result.', {
        details: { collection: label, sequence: (sorted[i] as T).sequence },
      });
    }
  }
  return sorted;
}

/**
 * Normalize to the canonical form: ordered collections are ordered by their durable key
 * (journal sequence, invariant ID, run-operation ID); set-valued fields are sorted and
 * de-duplicated. Any platform-dependent enumeration order is therefore irrelevant.
 */
export function normalizeCanonicalResult(input: unknown): CanonicalCaseResult {
  const parsed = CanonicalCaseResult.safeParse(input);
  if (!parsed.success) {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'Canonical case result failed closed-schema validation.', {
      details: { issues: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`) },
    });
  }
  const r = parsed.data;
  return {
    ...r,
    runOperations: [...r.runOperations]
      .map((op) => ({
        ...op,
        // Code-unit comparison only: locale-aware collation differs across platforms.
        lineage: [...op.lineage].sort(
          (a, b) => cmp(a.relation, b.relation) || cmp(a.runOperationId, b.runOperationId),
        ),
      }))
      .sort((a, b) => cmp(a.runOperationId, b.runOperationId)),
    exchanges: bySequence(r.exchanges, 'exchanges'),
    facts: bySequence(r.facts, 'facts').map((f) => ({
      ...f,
      reasons: sortedUnique<EvidenceReason>(f.reasons),
    })),
    invariantResults: [...r.invariantResults]
      .sort((a, b) => cmp(a.invariantId, b.invariantId))
      .map((ir) => ({
        ...ir,
        evidenceIds: sortedUnique(ir.evidenceIds),
        missingPredicates: sortedUnique(ir.missingPredicates),
        reasons: sortedUnique<EvidenceReason>(ir.reasons),
      })),
  };
}

export function computeCanonicalResultDigest(canonical: unknown): Digest {
  return digestValue(RESULT_DIGEST_DOMAIN, normalizeCanonicalResult(canonical));
}

export function computeRunEnvelopeDigest(envelope: unknown): Digest {
  const parsed = RunEnvelope.safeParse(envelope);
  if (!parsed.success) {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'Run envelope failed closed-schema validation.');
  }
  return digestValue(RUN_ENVELOPE_DIGEST_DOMAIN, parsed.data);
}

export interface CaseResultRecord {
  readonly resultDigest: Digest;
  readonly canonical: CanonicalCaseResult;
  readonly envelopeDigest: Digest;
  readonly envelope: RunEnvelope;
}

/** Build a stored result: the canonical part and the envelope are kept and digested separately. */
export function buildCaseResultRecord(canonical: unknown, envelope: unknown): CaseResultRecord {
  const normalized = normalizeCanonicalResult(canonical);
  const env = RunEnvelope.parse(envelope);
  return {
    resultDigest: digestValue(RESULT_DIGEST_DOMAIN, normalized),
    canonical: normalized,
    envelopeDigest: digestValue(RUN_ENVELOPE_DIGEST_DOMAIN, env),
    envelope: env,
  };
}
