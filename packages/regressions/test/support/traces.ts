/** Hand-written user trace documents (USER_FILE origin) for M05 tests. */
import { canonicalJson } from '@routespec/contracts';
import {
  REVIEW_CONFIRMATION,
  REVIEW_DECISIONS,
  importUserFile,
  promoteImport,
  proposeMapping,
  reviewImport,
  saveImportMapping,
  verifyReplay,
  type Mapping,
  type TraceDocument,
} from '../../src/index.ts';
import type { CompiledPlan } from '@routespec/scenario';
import { quoteBody, type Product } from './product.ts';

export function simpleUserTrace(tag = 'a'): TraceDocument {
  const deposit = `sim-deposit-user-${tag}`;
  return {
    format: 'routespec.trace/1',
    origin: 'USER_FILE',
    identity: null,
    operations: [
      {
        ref: 'op-1',
        logicalJobRef: 'job-1',
        phase: 'READ_ONLY_RECONCILIATION',
        depositAddress: deposit,
        committed: true,
        acceptedTerminalStatus: 'SUCCESS',
      },
    ],
    exchanges: [
      {
        sequence: 0,
        route: 'QUOTE',
        phase: 'QUOTE_REQUEST',
        operationRef: 'op-1',
        fencingEpoch: 0,
        outcome: 'RESPONDED',
        responseStatus: 200,
        errorCode: null,
        observedRawStatus: null,
        material: quoteBody(),
        virtualMs: 0,
      },
      {
        sequence: 2,
        route: 'COMMIT',
        phase: 'COMMIT_MUTATION',
        operationRef: 'op-1',
        fencingEpoch: 0,
        outcome: 'RESPONDED',
        responseStatus: 200,
        errorCode: null,
        observedRawStatus: null,
        material: { depositAddress: deposit, txHash: `sim-tx-user-${tag}` },
        virtualMs: 0,
      },
      {
        sequence: 3,
        route: 'STATUS',
        phase: 'READ_ONLY_RECONCILIATION',
        operationRef: 'op-1',
        fencingEpoch: 0,
        outcome: 'RESPONDED',
        responseStatus: 200,
        errorCode: null,
        observedRawStatus: 'SUCCESS',
        material: { depositAddress: deposit },
        virtualMs: 1000,
      },
    ],
    events: [
      {
        sequence: 1,
        kind: 'QUOTE_FINALIZED',
        rawStatus: null,
        normalizedFact: null,
        operationRef: 'op-1',
        virtualMs: 0,
      },
      {
        sequence: 3,
        kind: 'PROVIDER_STATUS',
        rawStatus: 'SUCCESS',
        normalizedFact: 'SUCCESS_REPORTED',
        operationRef: 'op-1',
        virtualMs: 1000,
      },
    ],
    evidence: [],
    subjectReports: [],
    boundaryObservations: [],
    denials: [],
    annotations: { title: `User trace ${tag}`, notes: [], disputed: false },
  };
}

export function traceBytes(trace: TraceDocument): Buffer {
  return Buffer.from(canonicalJson(trace), 'utf8');
}

const approve = Object.fromEntries(REVIEW_DECISIONS.map((d) => [d, true])) as Record<
  (typeof REVIEW_DECISIONS)[number],
  boolean
>;

/** Import -> map -> replay-verify -> review -> promote a user trace, returning the promotion. */
export async function promoteUserTrace(
  p: Product,
  input: {
    trace: TraceDocument;
    tag: string;
    sourcePlan: CompiledPlan;
    baseCorpusRevisionId: string | null;
    corpusLabel: string;
    requiredInvariants: readonly string[];
    edit?: (m: Mapping) => Mapping;
  },
): Promise<{ importId: string; mapping: Mapping; promotion: ReturnType<typeof promoteImport> }> {
  const out = await importUserFile(p.journal, {
    projectId: p.projectId,
    filename: `${input.tag}.json`,
    source: [traceBytes(input.trace)],
    idempotencyKey: `${input.tag}-import`,
  });
  let v = p.journal.getImport(out.importId);
  const proposal = proposeMapping({
    trace: v.sanitized as TraceDocument,
    sourcePlan: input.sourcePlan,
    requiredInvariants: input.requiredInvariants,
  });
  const mapping = (input.edit ?? ((m) => m))({
    ...proposal,
    scenario: { ...proposal.scenario, scenarioId: `regression-${input.tag}` },
    provenance: { class: 'CUSTOMER_PROVIDED_REDACTED', locator: null, notes: null },
  });
  const saved = saveImportMapping(p.journal, {
    importId: out.importId,
    expectedRevision: v.revision,
    mapping,
    idempotencyKey: `${input.tag}-map`,
  });
  const replay = await verifyReplay(p.journal, {
    importId: out.importId,
    expectedRevision: saved.revision,
    idempotencyKey: `${input.tag}-replay`,
    crossProcess: false,
  });
  if (!replay.verified)
    throw new Error(`replay not verified: ${JSON.stringify(replay.findings)} ${replay.fidelity}`);
  v = p.journal.getImport(out.importId);
  const review = reviewImport(p.journal, {
    importId: out.importId,
    expectedRevision: v.revision,
    reviewer: 'local-reviewer',
    decisions: approve,
    confirmation: REVIEW_CONFIRMATION,
    idempotencyKey: `${input.tag}-review`,
  });
  const promotion = promoteImport(p.journal, {
    importId: out.importId,
    expectedRevision: review.revision,
    reviewId: review.reviewId,
    baseCorpusRevisionId: input.baseCorpusRevisionId,
    corpusLabel: input.corpusLabel,
    severity: 'HIGH',
    gatePolicy: 'ADVISORY',
    idempotencyKey: `${input.tag}-promote`,
    // A user file is never independent release evidence (M16, RP-08).
    evidenceUse: 'DIAGNOSTIC_ONLY',
  });
  return { importId: out.importId, mapping, promotion };
}
