/**
 * T-030 — Disputed incident promotes only as ambiguity case. Covers FR-10, FR-11.
 *
 * An issue-384-shaped user trace carries contradictory visibility: a public origin debit, a
 * provider-reported SUCCESS, a destination credit that is not visible, and a reporter's
 * contradictory claim. Every mapping that would declare loss or success ground truth, upgrade
 * the private leg to visible proof, weaken evidence limits, or claim independent reproduction
 * is refused. Only a disputed ambiguity case that expects REVIEW is accepted, replay-verified,
 * reviewed, and promoted. Running it through the full installed-client product path, the
 * kernel returns REVIEW with `PRIVATE_NOT_VISIBLE` scope and the `NOT_VISIBLE` reason, which is
 * never a verdict. The encoded source-derived issue-384 scenario behaves the same way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VERDICTS, canonicalJson } from '@routespec/contracts';
import {
  MappingRejected,
  REVIEW_CONFIRMATION,
  REVIEW_DECISIONS,
  compileIncident,
  compileMapping,
  importUserFile,
  promoteImport,
  proposeMapping,
  reviewImport,
  saveImportMapping,
  verifyReplay,
  type Mapping,
  type TraceDocument,
} from '../src/index.ts';
import { LIVE_INVARIANTS, Product, Subject, quoteBody, tempDir } from './support/product.ts';

const approve = Object.fromEntries(REVIEW_DECISIONS.map((d) => [d, true])) as Record<
  (typeof REVIEW_DECISIONS)[number],
  boolean
>;

function disputedTrace(): TraceDocument {
  const deposit = 'sim-deposit-disputed-0001';
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
      // Raw transaction hash as a reporter would paste it; the quarantine replaces it by its digest.
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
        material: { depositAddress: deposit, txHash: 'sim-tx-disputed-0001' },
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
        sequence: 0,
        kind: 'QUOTE_REQUEST_CREATED',
        rawStatus: null,
        normalizedFact: null,
        operationRef: 'op-1',
        virtualMs: 0,
      },
      {
        sequence: 1,
        kind: 'QUOTE_FINALIZED',
        rawStatus: null,
        normalizedFact: null,
        operationRef: 'op-1',
        virtualMs: 0,
      },
      {
        sequence: 2,
        kind: 'COMMIT_ACCEPTED',
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
    evidence: [
      {
        subject: 'origin_debit',
        evidenceClass: 'PROVEN',
        evidenceScope: 'PUBLIC_CHAIN_OBSERVATION',
        reasons: [],
        sourceKind: 'PUBLIC_EXPLORER',
        operationRef: 'op-1',
        assetId: 'nep141:origin.sim',
        amount: '1000000',
      },
      {
        subject: 'destination_credit',
        evidenceClass: 'REPORTED',
        evidenceScope: 'PROVIDER_REPORTED',
        reasons: [],
        sourceKind: 'PROVIDER_STATUS',
        operationRef: 'op-1',
        assetId: null,
        amount: null,
      },
      {
        subject: 'destination_credit',
        evidenceClass: 'UNKNOWN',
        evidenceScope: 'PRIVATE_NOT_VISIBLE',
        reasons: ['NOT_VISIBLE'],
        sourceKind: 'PRIVATE_SHIELD_STEP',
        operationRef: 'op-1',
        assetId: null,
        amount: null,
      },
      {
        subject: 'destination_credit',
        evidenceClass: 'REPORTED',
        evidenceScope: 'SUBJECT_REPORTED',
        reasons: ['CONTRADICTORY'],
        sourceKind: 'REPORTER_CLAIM',
        operationRef: 'op-1',
        assetId: null,
        amount: null,
      },
    ],
    subjectReports: [],
    boundaryObservations: [],
    denials: [],
    annotations: {
      title: 'Disputed: public treasury movement, destination credit not visible',
      notes: [
        'Reporter alleges missing destination credit; later analysis says the public movement is consistent with a private step.',
      ],
      disputed: true,
    },
  };
}

let tmp: ReturnType<typeof tempDir>;
let p: Product;
let importId = '';
let accepted: Mapping;

beforeAll(async () => {
  tmp = tempDir();
  p = await Product.open(tmp.dir, 't030');
  const out = await importUserFile(p.journal, {
    projectId: p.projectId,
    filename: 'issue-384-report.json',
    source: [Buffer.from(canonicalJson(disputedTrace()), 'utf8')],
    idempotencyKey: 't030-import',
  });
  importId = out.importId;
});

afterAll(async () => {
  await p?.close();
  tmp?.cleanup();
});

function rejectedCodes(mapping: unknown, key: string): string[] {
  const v = p.journal.getImport(importId);
  try {
    saveImportMapping(p.journal, { importId, expectedRevision: v.revision, mapping, idempotencyKey: key });
    return [];
  } catch (error) {
    if (error instanceof MappingRejected) return [...new Set(error.issues.map((i) => i.code))].sort();
    throw error;
  }
}

describe('T-030 — Disputed incident promotes only as ambiguity case', () => {
  it('the disputed user trace is quarantined as a sanitized user file; signed material is digested', () => {
    const v = p.journal.getImport(importId);
    expect(v.state).toBe('SANITIZED');
    expect(v.origin).toBe('USER_FILE');
    expect(v.blockingCount).toBe(0);
    expect(v.findings.map((f) => f.category)).toContain('SIGNED_MATERIAL_DIGESTED');
    const commit = (v.sanitized as TraceDocument).exchanges[1]?.material ?? {};
    expect(commit['txHash']).toBeUndefined();
    expect(String(commit['transactionDigest'])).toMatch(/^sha256:/);
  });

  it('mappings that declare loss or success ground truth, or upgrade evidence, are refused', () => {
    const trace = p.journal.getImport(importId).sanitized as TraceDocument;
    accepted = proposeMapping({
      trace,
      sourcePlan: compileIncident('issue-384-disputed-private-credit').plan,
      requiredInvariants: LIVE_INVARIANTS,
    });
    expect(accepted.provenance.class).toBe('DISPUTED_AMBIGUITY_CASE');
    const visible = accepted.scenario.groundTruthEvents.map((e) => ({
      ...e,
      visibility: 'VISIBLE' as const,
    }));
    expect(
      rejectedCodes(
        { ...accepted, provenance: { ...accepted.provenance, class: 'CUSTOMER_PROVIDED_REDACTED' } },
        't030-m1',
      ),
    ).toContain('DISPUTE_REQUIRES_AMBIGUITY_CASE');
    expect(
      rejectedCodes(
        { ...accepted, scenario: { ...accepted.scenario, groundTruthEvents: visible } },
        't030-m2',
      ),
    ).toEqual(['DISPUTED_GROUND_TRUTH_ASSERTED', 'VISIBILITY_UPGRADE']);
    expect(
      rejectedCodes(
        { ...accepted, expected: { ...accepted.expected, invariants: { 'INV-05': 'FAIL' } } },
        't030-m3',
      ),
    ).toEqual(['DISPUTED_VERDICT_ASSERTED']);
    expect(
      rejectedCodes(
        { ...accepted, expected: { ...accepted.expected, invariants: { 'INV-05': 'PASS' } } },
        't030-m4',
      ),
    ).toEqual(['DISPUTED_VERDICT_ASSERTED']);
    expect(
      rejectedCodes(
        { ...accepted, expected: { ...accepted.expected, normalizedOutcome: 'SUCCESS_PROVEN' } },
        't030-m5',
      ),
    ).toEqual(['DISPUTED_GROUND_TRUTH_ASSERTED']);
    expect(
      rejectedCodes(
        {
          ...accepted,
          requiredEvidence: [
            {
              predicate: 'DESTINATION_CREDIT',
              classes: ['PROVEN', 'REPORTED'],
              scopes: ['PROVIDER_REPORTED'],
            },
          ],
        },
        't030-m6',
      ),
    ).toEqual(['EVIDENCE_LIMIT_WEAKENED']);
    expect(
      rejectedCodes(
        { ...accepted, provenance: { ...accepted.provenance, class: 'INDEPENDENTLY_REPRODUCED' } },
        't030-m7',
      ),
    ).toEqual(['DISPUTE_REQUIRES_AMBIGUITY_CASE', 'REPRODUCTION_CLAIM_UNSUPPORTED']);
    expect(
      rejectedCodes(
        {
          ...accepted,
          effectCoverage: { ...accepted.effectCoverage, basis: 'INDEPENDENT_BOUNDARY_INTERCEPT' },
        },
        't030-m8',
      ),
    ).toContain('COVERAGE_UPGRADE');
    expect(
      rejectedCodes(
        {
          ...accepted,
          effectCoverage: {
            ...accepted.effectCoverage,
            limitations: accepted.effectCoverage.limitations.filter((l) => l !== 'DISPUTED_GROUND_TRUTH'),
          },
        },
        't030-m9',
      ),
    ).toEqual(['LIMITATION_MISSING']);
    expect(p.journal.getImport(importId).state).toBe('SANITIZED');
  });

  it('only the ambiguity case is accepted, replay-verified, reviewed, and promoted with its provenance', async () => {
    let v = p.journal.getImport(importId);
    const saved = saveImportMapping(p.journal, {
      importId,
      expectedRevision: v.revision,
      mapping: accepted,
      idempotencyKey: 't030-accepted',
    });
    const replay = await verifyReplay(p.journal, {
      importId,
      expectedRevision: saved.revision,
      idempotencyKey: 't030-replay',
    });
    expect(replay.verified).toBe(true);
    v = p.journal.getImport(importId);
    const review = reviewImport(p.journal, {
      importId,
      expectedRevision: v.revision,
      reviewer: 'local-reviewer',
      decisions: approve,
      confirmation: REVIEW_CONFIRMATION,
      idempotencyKey: 't030-review',
    });
    const promoted = promoteImport(p.journal, {
      importId,
      expectedRevision: review.revision,
      reviewId: review.reviewId,
      baseCorpusRevisionId: null,
      corpusLabel: 'ambiguity-corpus',
      severity: 'MEDIUM',
      gatePolicy: 'ADVISORY',
      idempotencyKey: 't030-promote',
      // A user file is never independent release evidence (M16, RP-08).
      evidenceUse: 'DIAGNOSTIC_ONLY',
    });
    expect(promoted.refusalReasons).toEqual(['DECLARED_HOOKS_ONLY', 'NOT_INSTALLED_CAPTURE']);
    const scenario = p.store.getScenarioRevision(promoted.scenarioRevisionId) as Record<string, unknown>;
    expect(scenario['provenance_class']).toBe('DISPUTED_AMBIGUITY_CASE');
    const plan = JSON.parse(String(scenario['compiled_json'])) as {
      groundTruthEvents: Array<{ fact: string; visibility: string }>;
      expectedOutcomes: { invariants: Record<string, string> };
    };
    expect(plan.groundTruthEvents.find((e) => e.fact === 'DESTINATION_CREDIT')?.visibility).toBe('PRIVATE');
    expect(Object.values(plan.expectedOutcomes.invariants).every((x) => x === 'REVIEW')).toBe(true);

    // Full product path: the installed corrected client runs the promoted ambiguity case.
    const build = p.registerBuild('corrected-client');
    const compiled = compileMapping(accepted, importId);
    const promotedCase = {
      compiled,
      scenarioRevisionId: promoted.scenarioRevisionId,
      lineageRole: 'PROMOTED_REGRESSION' as const,
      requiredInvariants: LIVE_INVARIANTS,
    };
    // The encoded source-derived issue-384 scenario, run the same way.
    const incident = compileIncident('issue-384-disputed-private-credit');
    const { scenarioRevisionId: incidentRevisionId } = p.store.createScenarioRevision({
      ...incident.revisionInput,
      reviewStatus: 'REVIEWED',
    });
    const { corpusRevisionId: incidentCorpus } = p.store.createCorpusRevision({
      label: 'incident-384',
      cases: [
        {
          scenarioRevisionId: incidentRevisionId,
          requiredInvariants: LIVE_INVARIANTS,
          severity: 'MEDIUM',
          gatePolicy: 'REQUIRED',
        },
      ],
    });
    const gate = p.createGateRun(build, promoted.corpusRevisionId, [promotedCase]);
    const incidentGate = p.createGateRun(build, incidentCorpus, [
      {
        compiled: incident,
        scenarioRevisionId: incidentRevisionId,
        lineageRole: 'BASELINE',
        requiredInvariants: LIVE_INVARIANTS,
      },
    ]);
    const subject = await Subject.launch('corrected-client');
    try {
      const runs: Array<[string, typeof compiled]> = [
        [gate.caseRunIds[0] as string, compiled],
        [incidentGate.caseRunIds[0] as string, incident],
      ];
      for (let i = 0; i < runs.length; i++) {
        const [caseRunId, c] = runs[i] as [string, typeof compiled];
        const outcome = await p.runCase(
          subject,
          caseRunId,
          c,
          { logicalJob: `disputed-${i}`, txHash: `sim-tx-disputed-${i}` },
          i === 0 ? 'attach' : 'reset',
        );
        expect((outcome['statuses'] as string[]).at(-1)).toBe('SUCCESS');
        const { evaluation, input } = p.evaluate(caseRunId);
        expect(evaluation.verdict).toBe('REVIEW');
        expect(evaluation.invariantResults.some((r) => r.verdict === 'FAIL')).toBe(false);
        const inv05 = evaluation.invariantResults.filter((r) => r.invariantId === 'INV-05');
        expect(inv05.map((r) => r.verdict)).toEqual(['REVIEW']);
        expect(inv05[0]?.explanationCode).toBe('INV05_LEG_NOT_VISIBLE');
        expect(inv05[0]?.reasons).toContain('NOT_VISIBLE');
        const credit = input.evidence.filter((e) => e.subject === 'destination_credit');
        expect(credit.map((e) => [e.evidenceClass, e.evidenceScope])).toEqual([
          ['UNKNOWN', 'PRIVATE_NOT_VISIBLE'],
        ]);
        // NOT_VISIBLE is an evidence reason, never a verdict.
        expect((VERDICTS as readonly string[]).includes('NOT_VISIBLE')).toBe(false);
        expect(
          evaluation.invariantResults.every((r) => (VERDICTS as readonly string[]).includes(r.verdict)),
        ).toBe(true);
      }
    } finally {
      await subject.close();
    }
  });
});
