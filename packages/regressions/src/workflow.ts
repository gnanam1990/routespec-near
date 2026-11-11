/**
 * Mapping, review, and promotion workflow (FR-11, FR-12; API-SPEC imports `mapping`,
 * `verify-replay`, `promote`; DATA-MODEL.md import transitions and transaction boundaries).
 *
 * - `saveImportMapping` validates a reviewer mapping against the sanitized trace and compiles
 *   it with the M03 compiler before it is stored; unresolved or contradictory claims refuse it.
 * - `reviewImport` records the immutable explicit local review: the reviewer confirms each
 *   decision class, and the review digest binds the sanitized content, scan, mapping, replay
 *   report, and produced scenario digest. Any later change invalidates it.
 * - `promoteImport` re-verifies everything inside one journal transaction — including a fresh
 *   re-derivation of an installed capture from its journal — and atomically creates a new
 *   immutable scenario revision and a new corpus revision. The base corpus is never touched.
 */
import { RouteSpecError, digestValue, type Digest, type ProvenanceClass } from '@routespec/contracts';
import type { ImportJournal, PromotionResult } from '@routespec/store';
import { compileMapping, validateMapping, type Mapping, type MappingIssue } from './mapping.ts';
import { verifyInstalledCapture } from './pipeline.ts';
import type { TraceDocument } from './trace.ts';

export const REVIEW_DECISIONS = Object.freeze([
  'REDACTIONS_APPROVED',
  'SOURCE_BINDING_APPROVED',
  'OPERATION_LINEAGE_APPROVED',
  'EXPECTED_TERMINAL_APPROVED',
  'FORBIDDEN_BEHAVIORS_APPROVED',
  'EVIDENCE_LIMITS_APPROVED',
  'EFFECT_COVERAGE_APPROVED',
  'PROVENANCE_APPROVED',
] as const);
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const REVIEW_CONFIRMATION = 'I reviewed this sanitized trace and its mapping locally.' as const;

export class MappingRejected extends RouteSpecError {
  readonly issues: readonly MappingIssue[];
  constructor(issues: readonly MappingIssue[]) {
    super('RS_IMPORT_MAPPING_INVALID', 'Mapping does not match the quarantined trace.', {
      details: { issues: issues.slice(0, 16).map((i) => `${i.code}@${i.path}`) },
    });
    this.issues = issues;
  }
}

function traceOf(
  journal: ImportJournal,
  importId: string,
): { trace: TraceDocument; view: ReturnType<ImportJournal['getImport']> } {
  const view = journal.getImport(importId);
  if (view.sanitized === null) {
    throw new RouteSpecError('RS_IMPORT_STATE_INVALID', 'Import has no sanitized trace.', {
      details: { state: view.state },
    });
  }
  return { trace: view.sanitized as TraceDocument, view };
}

export function saveImportMapping(
  journal: ImportJournal,
  input: { importId: string; expectedRevision: number; mapping: unknown; idempotencyKey: string },
): { mappingRevisionId: string; mappingDigest: Digest; revision: number; scenarioRevisionDigest: string } {
  const { trace, view } = traceOf(journal, input.importId);
  const { mapping, issues } = validateMapping(trace, view.origin, input.mapping);
  if (mapping === null || issues.length > 0) throw new MappingRejected(issues);
  let scenarioRevisionDigest: string;
  try {
    scenarioRevisionDigest = compileMapping(mapping, input.importId).revisionDigest;
  } catch (error) {
    if (error instanceof RouteSpecError) {
      throw new MappingRejected([{ code: `SCENARIO_${error.code}`, path: '$.scenario' }]);
    }
    throw error;
  }
  const saved = journal.saveMapping({
    importId: input.importId,
    expectedRevision: input.expectedRevision,
    mapping,
    provenanceClass: mapping.provenance.class as ProvenanceClass,
    idempotencyKey: input.idempotencyKey,
  });
  return { ...saved, scenarioRevisionDigest };
}

export interface ReviewInput {
  readonly importId: string;
  readonly expectedRevision: number;
  /** Local reviewer principal label; only its digest is stored. */
  readonly reviewer: string;
  readonly decisions: Readonly<Record<ReviewDecision, boolean>>;
  readonly confirmation: string;
  readonly idempotencyKey: string;
}

export function reviewDigestFor(input: {
  importId: string;
  sanitizedDigest: string;
  scanId: string;
  mappingDigest: string;
  replayReportDigest: string;
  scenarioRevisionDigest: string;
  reviewerDigest: string;
  decisions: Readonly<Record<string, boolean>>;
}): Digest {
  return digestValue('routespec.import-review/1', input);
}

export function reviewImport(
  journal: ImportJournal,
  input: ReviewInput,
): { reviewId: string; reviewDigest: Digest; revision: number } {
  if (input.confirmation !== REVIEW_CONFIRMATION) {
    throw new RouteSpecError('RS_IMPORT_REVIEW_INVALID', 'Explicit local review confirmation is required.');
  }
  const missing = REVIEW_DECISIONS.filter((d) => input.decisions[d] !== true);
  if (missing.length > 0) {
    throw new RouteSpecError(
      'RS_IMPORT_REVIEW_INVALID',
      'Every review decision must be explicitly approved.',
      {
        details: { missing: [...missing] },
      },
    );
  }
  const { view } = traceOf(journal, input.importId);
  const mapping = journal.latestMapping(input.importId);
  const report = journal.latestReplayReport(input.importId);
  if (!mapping || !report || view.scanId === null || view.sanitizedDigest === null) {
    throw new RouteSpecError('RS_IMPORT_REVIEW_INVALID', 'Review requires a mapping and a replay report.');
  }
  const reviewerDigest = digestValue('routespec.local-reviewer/1', input.reviewer);
  const decisions = Object.fromEntries(REVIEW_DECISIONS.map((d) => [d, true]));
  const reviewDigest = reviewDigestFor({
    importId: input.importId,
    sanitizedDigest: view.sanitizedDigest,
    scanId: view.scanId,
    mappingDigest: mapping.mappingDigest,
    replayReportDigest: String(report['report_digest']),
    scenarioRevisionDigest: String(report['scenario_revision_digest']),
    reviewerDigest,
    decisions,
  });
  const recorded = journal.recordReview({
    importId: input.importId,
    expectedRevision: input.expectedRevision,
    mappingRevisionId: mapping.mappingRevisionId,
    replayReportId: String(report['report_id']),
    scanId: view.scanId,
    reviewerDigest,
    decisions: { ...decisions, confirmation: 'EXPLICIT_LOCAL_CONFIRMATION' },
    reviewDigest,
    idempotencyKey: input.idempotencyKey,
  });
  return { ...recorded, reviewDigest };
}

export function promoteImport(
  journal: ImportJournal,
  input: {
    importId: string;
    expectedRevision: number;
    reviewId: string;
    baseCorpusRevisionId: string | null;
    corpusLabel: string;
    severity: string;
    gatePolicy: string;
    idempotencyKey: string;
  },
): PromotionResult {
  const { trace, view } = traceOf(journal, input.importId);
  const mappingRow = journal.latestMapping(input.importId);
  const review = journal.getReview(input.reviewId);
  if (!mappingRow || !review) {
    throw new RouteSpecError('RS_IMPORT_REVIEW_INVALID', 'Promotion requires an explicit review record.');
  }
  const { mapping, issues } = validateMapping(trace, view.origin, mappingRow.mapping);
  if (mapping === null || issues.length > 0) throw new MappingRejected(issues);
  const compiled = compileMapping(mapping as Mapping, input.importId);
  const report = journal.latestReplayReport(input.importId);
  if (!report || view.scanId === null || view.sanitizedDigest === null) {
    throw new RouteSpecError('RS_IMPORT_REVIEW_INVALID', 'Promotion requires a replay-verified import.');
  }
  const expectedReviewDigest = reviewDigestFor({
    importId: input.importId,
    sanitizedDigest: view.sanitizedDigest,
    scanId: view.scanId,
    mappingDigest: mappingRow.mappingDigest,
    replayReportDigest: String(report['report_digest']),
    scenarioRevisionDigest: compiled.revisionDigest,
    reviewerDigest: String(review['reviewer_digest']),
    decisions: Object.fromEntries(REVIEW_DECISIONS.map((d) => [d, true])),
  });
  if (review['review_digest'] !== expectedReviewDigest) {
    throw new RouteSpecError(
      'RS_IMPORT_REVIEW_INVALID',
      'Review digest does not match the current import content.',
    );
  }
  return journal.promote({
    importId: input.importId,
    expectedRevision: input.expectedRevision,
    reviewId: input.reviewId,
    idempotencyKey: input.idempotencyKey,
    scenario: {
      revisionInput: compiled.revisionInput,
      revisionDigest: compiled.revisionDigest,
      sourceLocator: `routespec-import:${input.importId}`,
    },
    corpus: {
      label: input.corpusLabel,
      baseCorpusRevisionId: input.baseCorpusRevisionId,
      newCase: {
        requiredInvariants: [...mapping.requiredInvariants].sort(),
        severity: input.severity,
        gatePolicy: input.gatePolicy,
      },
    },
    verifyInTransaction: () => verifyInstalledCapture(journal, input.importId),
  });
}
