/**
 * T-031 — Promoted regression replays to the same digest. Covers FR-11, NFR-01.
 *
 * The sanitized capture of the installed baseline failure is replayed repeatedly — in this
 * process and in a separately launched process — before promotion; unstable digests, a
 * non-canonical client timer, or an unfaithful replay keep it out of REPLAY_VERIFIED. After
 * explicit review, promotion atomically creates a new immutable scenario revision and a new
 * corpus identity. Replay-only success is insufficient: the regression is complete only when
 * the corrected installed client (a different build) runs the promoted case from the new corpus
 * through the full adapter/proxy/journal/kernel path, every required case reaches PASS, and the
 * gate-level combination of those exact case verdicts is PASS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, digestValue, isRouteSpecError } from '@routespec/contracts';
import { combineVerdicts } from '@routespec/kernel';
import {
  REVIEW_CONFIRMATION,
  REVIEW_DECISIONS,
  captureInstalledCase,
  compileMapping,
  importUserFile,
  inProcessTrial,
  promoteImport,
  proposeMapping,
  regressionLineage,
  reviewImport,
  saveImportMapping,
  verifyReplay,
  type Mapping,
  type TraceDocument,
  type TrialRunner,
} from '../src/index.ts';
import { runBaselineIncident, type BaselineRun } from './support/flows.ts';
import { LIVE_INVARIANTS, Product, Subject, tempDir } from './support/product.ts';

const approve = Object.fromEntries(REVIEW_DECISIONS.map((d) => [d, true])) as Record<
  (typeof REVIEW_DECISIONS)[number],
  boolean
>;

let tmp: ReturnType<typeof tempDir>;
let p: Product;
let baseline: BaselineRun;
let importId = '';
let mapping: Mapping;
let firstDigests: readonly string[] = [];
let promotion: ReturnType<typeof promoteImport>;

beforeAll(async () => {
  tmp = tempDir();
  p = await Product.open(tmp.dir, 't031');
  baseline = await runBaselineIncident(p);
  const out = await captureInstalledCase(p.journal, {
    caseRunId: baseline.caseRunIds[0] as string,
    idempotencyKey: 't031-capture',
  });
  importId = out.importId;
  const view = p.journal.getImport(importId);
  mapping = proposeMapping({
    trace: view.sanitized as TraceDocument,
    sourcePlan: baseline.compiled.plan,
    requiredInvariants: LIVE_INVARIANTS,
    requiredSinkClasses: ['fulfilment-webhook'],
  });
});

afterAll(async () => {
  await p?.close();
  tmp?.cleanup();
});

describe('T-031 — Promoted regression replays to the same digest', () => {
  it('unstable trial digests block replay verification and therefore review', async () => {
    const view = p.journal.getImport(importId);
    const saved = saveImportMapping(p.journal, {
      importId,
      expectedRevision: view.revision,
      mapping,
      idempotencyKey: 't031-map-a',
    });
    // A trial runner whose evaluator output drifts between runs (an unpinned evaluator).
    let n = 0;
    const drifting: TrialRunner = async (input, trial) => {
      const r = await inProcessTrial(input, trial);
      n++;
      return { ...r, digest: digestValue('routespec.test.drift/1', `${r.digest}:${n}`) };
    };
    const report = await verifyReplay(p.journal, {
      importId,
      expectedRevision: saved.revision,
      idempotencyKey: 't031-replay-drift',
      trialRunners: [inProcessTrial, drifting],
    });
    expect(report.verified).toBe(false);
    expect(new Set(report.trialDigests).size).toBe(2);
    expect(report.findings.map((f) => f.category)).toContain('REPLAY_DIGEST_UNSTABLE');
    expect(p.journal.getImport(importId).state).toBe('MAPPED');
    expect(() =>
      reviewImport(p.journal, {
        importId,
        expectedRevision: saved.revision,
        reviewer: 'local-reviewer',
        decisions: approve,
        confirmation: REVIEW_CONFIRMATION,
        idempotencyKey: 't031-review-blocked',
      }),
    ).toThrow(expect.objectContaining({ code: 'RS_IMPORT_STATE_INVALID' }));
  });

  it('real nondeterminism (retry under a wall-clock timer) and an unfaithful replay are not verified', async () => {
    const trace = structuredClone(p.journal.getImport(importId).sanitized) as TraceDocument;
    // A user trace with an exact commit retry: under EXTERNAL_WALL the retry timing is not canonical.
    const commit = trace.exchanges[1] as TraceDocument['exchanges'][number];
    trace.exchanges.push({
      ...commit,
      sequence: commit.sequence + 10,
      outcome: 'RESPONDED',
      responseStatus: 200,
    });
    trace.identity = null;
    trace.origin = 'USER_FILE';
    const file = await importUserFile(p.journal, {
      projectId: p.projectId,
      filename: 'retry.json',
      source: [Buffer.from(canonicalJson(trace), 'utf8')],
      idempotencyKey: 't031-retry-file',
    });
    let v = p.journal.getImport(file.importId);
    expect(v.state).toBe('SANITIZED');
    const m = proposeMapping({
      trace: v.sanitized as TraceDocument,
      sourcePlan: null,
      requiredInvariants: LIVE_INVARIANTS,
    });
    const wall: Mapping = {
      ...m,
      scenario: { ...m.scenario, initialState: { clientClock: 'EXTERNAL_WALL' } },
    };
    let saved = saveImportMapping(p.journal, {
      importId: file.importId,
      expectedRevision: v.revision,
      mapping: wall,
      idempotencyKey: 't031-wall-map',
    });
    const wallReport = await verifyReplay(p.journal, {
      importId: file.importId,
      expectedRevision: saved.revision,
      idempotencyKey: 't031-wall-replay',
      crossProcess: false,
    });
    expect(wallReport.verified).toBe(false);
    expect(wallReport.findings.map((f) => f.category)).toContain('REPLAY_NONCANONICAL_TIMER');
    // Unfaithful: the trace observed SUCCESS on a status read; the mapped timeline serves FAILED.
    const observed = structuredClone(p.journal.getImport(importId).sanitized) as TraceDocument;
    const op = observed.operations[0] as TraceDocument['operations'][number];
    observed.identity = null;
    observed.origin = 'USER_FILE';
    observed.exchanges.push({
      sequence: 40,
      route: 'STATUS',
      phase: 'READ_ONLY_RECONCILIATION',
      operationRef: op.ref,
      fencingEpoch: 1,
      outcome: 'RESPONDED',
      responseStatus: 200,
      errorCode: null,
      observedRawStatus: 'SUCCESS',
      material: { depositAddress: op.depositAddress as string },
      virtualMs: (observed.exchanges.at(-1)?.virtualMs ?? 0) + 1000,
    });
    const statusFile = await importUserFile(p.journal, {
      projectId: p.projectId,
      filename: 'status.json',
      source: [Buffer.from(canonicalJson(observed), 'utf8')],
      idempotencyKey: 't031-status-file',
    });
    v = p.journal.getImport(statusFile.importId);
    expect(v.blockingCount).toBe(0);
    const sm = proposeMapping({
      trace: v.sanitized as TraceDocument,
      sourcePlan: null,
      requiredInvariants: LIVE_INVARIANTS,
    });
    const unfaithful: Mapping = {
      ...sm,
      scenario: {
        ...sm.scenario,
        steps: sm.scenario.steps.map((s) => (s.type === 'provider_status' ? { ...s, status: 'FAILED' } : s)),
      },
    };
    saved = saveImportMapping(p.journal, {
      importId: statusFile.importId,
      expectedRevision: v.revision,
      mapping: unfaithful,
      idempotencyKey: 't031-unfaithful-map',
    });
    const unfaithfulReport = await verifyReplay(p.journal, {
      importId: statusFile.importId,
      expectedRevision: saved.revision,
      idempotencyKey: 't031-unfaithful-replay',
      crossProcess: false,
    });
    expect(unfaithfulReport.fidelity).toBe('MISMATCH');
    expect(unfaithfulReport.verified).toBe(false);
    // The faithful mapping of the same trace verifies.
    v = p.journal.getImport(statusFile.importId);
    saved = saveImportMapping(p.journal, {
      importId: statusFile.importId,
      expectedRevision: v.revision,
      mapping: sm,
      idempotencyKey: 't031-faithful-map',
    });
    const faithful = await verifyReplay(p.journal, {
      importId: statusFile.importId,
      expectedRevision: saved.revision,
      idempotencyKey: 't031-faithful-replay',
      crossProcess: false,
    });
    expect(faithful.fidelity).toBe('MATCH');
    expect(faithful.verified).toBe(true);
  });

  it('repeated in-process and separate-process trials produce one canonical digest, twice over', async () => {
    let v = p.journal.getImport(importId);
    let saved = saveImportMapping(p.journal, {
      importId,
      expectedRevision: v.revision,
      mapping,
      idempotencyKey: 't031-map-b',
    });
    const first = await verifyReplay(p.journal, {
      importId,
      expectedRevision: saved.revision,
      idempotencyKey: 't031-replay-1',
      inProcessTrials: 3,
      crossProcess: true,
    });
    expect(first.verified).toBe(true);
    expect(first.trialDigests).toHaveLength(4);
    expect(new Set(first.trialDigests).size).toBe(1);
    expect(first.fidelity).toBe('MATCH');
    firstDigests = first.trialDigests;
    // Re-map (identical mapping) and verify again: the canonical digest is unchanged.
    v = p.journal.getImport(importId);
    saved = saveImportMapping(p.journal, {
      importId,
      expectedRevision: v.revision,
      mapping,
      idempotencyKey: 't031-map-c',
    });
    const again = await verifyReplay(p.journal, {
      importId,
      expectedRevision: saved.revision,
      idempotencyKey: 't031-replay-2',
      inProcessTrials: 2,
      crossProcess: true,
    });
    expect(again.verified).toBe(true);
    expect(new Set([...firstDigests, ...again.trialDigests]).size).toBe(1);
  });

  it('promotion after explicit review creates a new immutable scenario revision and a new corpus identity', () => {
    const v = p.journal.getImport(importId);
    expect(v.state).toBe('REPLAY_VERIFIED');
    const review = reviewImport(p.journal, {
      importId,
      expectedRevision: v.revision,
      reviewer: 'local-reviewer',
      decisions: approve,
      confirmation: REVIEW_CONFIRMATION,
      idempotencyKey: 't031-review',
    });
    const base = p.journal.getCorpus(baseline.corpusRevisionId);
    // M16 (RP-08): this capture ran without containment or a reviewed interceptor profile, so
    // it is refused as release evidence; nothing is created by the refused promotion.
    const scenariosBefore = p.store.countRows('scenario_revisions');
    let refused: { code: string; reasons: unknown } | null = null;
    try {
      promoteImport(p.journal, {
        importId,
        expectedRevision: review.revision,
        reviewId: review.reviewId,
        baseCorpusRevisionId: baseline.corpusRevisionId,
        corpusLabel: 'release-corpus',
        severity: 'HIGH',
        gatePolicy: 'REQUIRED',
        idempotencyKey: 't031-promote-release',
      });
    } catch (error) {
      refused = isRouteSpecError(error)
        ? { code: error.code, reasons: error.details['reasons'] }
        : { code: 'UNTYPED', reasons: null };
    }
    expect(refused?.code).toBe('RS_CAPTURE_NOT_RELEASE_EVIDENCE');
    expect(refused?.reasons).toEqual(
      expect.arrayContaining([
        'DECLARED_HOOKS_ONLY',
        'PROCESS_TREE_NOT_CONFINED',
        'INTERCEPTOR_PROFILE_UNPINNED',
      ]),
    );
    expect(p.store.countRows('scenario_revisions')).toBe(scenariosBefore);
    expect(p.journal.getImport(importId).state).toBe('REVIEWED');
    // A diagnostic-only promotion cannot add a required case either.
    expect(() =>
      promoteImport(p.journal, {
        importId,
        expectedRevision: review.revision,
        reviewId: review.reviewId,
        baseCorpusRevisionId: baseline.corpusRevisionId,
        corpusLabel: 'release-corpus',
        severity: 'HIGH',
        gatePolicy: 'REQUIRED',
        idempotencyKey: 't031-promote-diagnostic-required',
        evidenceUse: 'DIAGNOSTIC_ONLY',
      }),
    ).toThrow(/ADVISORY/);
    promotion = promoteImport(p.journal, {
      importId,
      expectedRevision: review.revision,
      reviewId: review.reviewId,
      baseCorpusRevisionId: baseline.corpusRevisionId,
      corpusLabel: 'release-corpus',
      severity: 'HIGH',
      gatePolicy: 'ADVISORY',
      idempotencyKey: 't031-promote',
      evidenceUse: 'DIAGNOSTIC_ONLY',
    });
    expect(promotion.evidenceUse).toBe('DIAGNOSTIC_ONLY');
    expect(promotion.refusalReasons).toEqual(refused?.reasons);
    expect(promotion.scenarioRevisionId).not.toBe(baseline.scenarioRevisionId);
    expect(promotion.corpusRevisionId).not.toBe(baseline.corpusRevisionId);
    expect(promotion.corpusDigest).not.toBe(base.corpusDigest);
    const scenario = p.store.getScenarioRevision(promotion.scenarioRevisionId) as Record<string, unknown>;
    expect(scenario).toMatchObject({
      review_status: 'REVIEWED',
      provenance_class: 'ISSUE_DERIVED_NOT_REPRODUCED',
      source_locator: `routespec-import:${importId}`,
    });
    // The base corpus is untouched; the new corpus pins the base cases plus the promoted case.
    expect(p.journal.getCorpus(baseline.corpusRevisionId)).toEqual(base);
    const created = p.journal.getCorpus(promotion.corpusRevisionId);
    expect(created.cases.map((c) => c.scenarioRevisionId)).toEqual([
      baseline.scenarioRevisionId,
      promotion.scenarioRevisionId,
    ]);
    expect(created.parent).toMatchObject({
      relation: 'PROMOTION_INTO',
      parent_corpus_revision_id: baseline.corpusRevisionId,
      import_id: importId,
    });
    expect(p.journal.getImport(importId).state).toBe('PROMOTED');
    // The promotion is idempotent under its key and cannot be repeated with another key.
    expect(
      promoteImport(p.journal, {
        importId,
        expectedRevision: review.revision,
        reviewId: review.reviewId,
        baseCorpusRevisionId: baseline.corpusRevisionId,
        corpusLabel: 'release-corpus',
        severity: 'HIGH',
        gatePolicy: 'ADVISORY',
        idempotencyKey: 't031-promote',
        evidenceUse: 'DIAGNOSTIC_ONLY',
      }).corpusRevisionId,
    ).toBe(promotion.corpusRevisionId);
    let second: string | null = null;
    try {
      promoteImport(p.journal, {
        importId,
        expectedRevision: review.revision + 1,
        reviewId: review.reviewId,
        baseCorpusRevisionId: baseline.corpusRevisionId,
        corpusLabel: 'release-corpus-2',
        severity: 'HIGH',
        gatePolicy: 'ADVISORY',
        idempotencyKey: 't031-promote-again',
        evidenceUse: 'DIAGNOSTIC_ONLY',
      });
    } catch (error) {
      second = isRouteSpecError(error) ? error.code : 'UNTYPED';
    }
    expect(second).toBe('RS_IMPORT_STATE_INVALID');
    // The promoted scenario recompiles from the stored mapping to the exact stored identity.
    expect(compileMapping(mapping, importId).revisionDigest).toBe(scenario['revision_digest']);
    // Promotion alone is replay-only evidence: the regression is not complete yet.
    expect(regressionLineage(p.journal, importId).status).toBe('PROMOTED_AWAITING_CORRECTED_RUN');
  });

  it('the corrected installed client passes the promoted case through the full product path; the baseline still does not', async () => {
    const compiledPromoted = compileMapping(mapping, importId);
    const corpus = p.journal.getCorpus(promotion.corpusRevisionId);
    const specs = corpus.cases.map((c, i) => ({
      compiled: i === 0 ? baseline.compiled : compiledPromoted,
      scenarioRevisionId: c.scenarioRevisionId,
      lineageRole: (i === 0 ? 'CORRECTED' : 'PROMOTED_REGRESSION') as 'CORRECTED' | 'PROMOTED_REGRESSION',
      requiredInvariants: c.requiredInvariants,
    }));

    // Baseline build against the new corpus: the promoted regression still catches it.
    const baselineGate = p.createGateRun(baseline.build, promotion.corpusRevisionId, specs);
    const naive = await Subject.launch('baseline-client');
    const naiveVerdicts: string[] = [];
    try {
      for (let i = 0; i < specs.length; i++) {
        const caseRunId = baselineGate.caseRunIds[i] as string;
        await p.runCase(
          naive,
          caseRunId,
          (specs[i] as (typeof specs)[number]).compiled,
          { logicalJob: `order-${i + 1}`, txHash: `sim-tx-naive-${i}` },
          i === 0 ? 'attach' : 'reset',
        );
        naiveVerdicts.push(p.evaluate(caseRunId).evaluation.verdict);
      }
    } finally {
      await naive.close();
    }
    expect(naiveVerdicts).toEqual(['REVIEW', 'REVIEW']);
    expect(combineVerdicts(naiveVerdicts as never)).toBe('REVIEW');

    // Corrected build (different artifact) in a new gate run bound to the new corpus identity.
    const corrected = p.registerBuild('corrected-client');
    expect(corrected.artifactDigest).not.toBe(baseline.build.artifactDigest);
    const gate = p.createGateRun(corrected, promotion.corpusRevisionId, specs);
    expect(p.store.getGateRun(gate.gateRunId)?.['corpus_revision_id']).toBe(promotion.corpusRevisionId);
    const subject = await Subject.launch('corrected-client');
    const verdicts: string[] = [];
    try {
      for (let i = 0; i < specs.length; i++) {
        const caseRunId = gate.caseRunIds[i] as string;
        const outcome = await p.runCase(
          subject,
          caseRunId,
          (specs[i] as (typeof specs)[number]).compiled,
          { logicalJob: `order-${i + 1}`, txHash: `sim-tx-fixed-${i}` },
          i === 0 ? 'attach' : 'reset',
        );
        expect(outcome['result']).toBe('RECONCILED');
        expect((outcome['statuses'] as string[]).at(-1)).toBe('REFUNDED');
        const { evaluation, input } = p.evaluate(caseRunId);
        expect(
          evaluation.invariantResults
            .filter((r) => r.verdict !== 'PASS' && evaluation.requiredInvariants.includes(r.invariantId))
            .map((r) => `${r.invariantId}:${r.explanationCode}`),
        ).toEqual([]);
        expect(evaluation.verdict).toBe('PASS');
        // PASS is safe refund handling, never settlement: no destination credit exists.
        expect(input.evidence.some((e) => e.subject === 'destination_credit')).toBe(false);
        expect(evaluation.invariantResults.find((r) => r.invariantId === 'INV-03')?.explanationCode).toBe(
          'INV03_RECONCILED_WITHOUT_SECOND_MUTATION',
        );
        verdicts.push(evaluation.verdict);
      }
    } finally {
      await subject.close();
    }
    // Gate-level combination of the exact required case verdicts (M04 combineVerdicts).
    expect(combineVerdicts(verdicts as never)).toBe('PASS');
    for (const id of gate.caseRunIds) {
      expect(p.store.getCaseRun(id)).toMatchObject({ execution_lifecycle: 'COMPLETED', verdict: 'PASS' });
    }
    // Typed lineage: captured baseline run operation -> corrected run operation of the promoted case.
    const capturedOp = String(
      p.store.listRunOperations(baseline.caseRunIds[0] as string)[0]?.['run_operation_id'],
    );
    const correctedOp = String(
      p.store.listRunOperations(gate.caseRunIds[1] as string)[0]?.['run_operation_id'],
    );
    expect(capturedOp).not.toBe(correctedOp);
    p.store.linkLineage({
      fromRunOperationId: capturedOp,
      toRunOperationId: correctedOp,
      relation: 'CORRECTION_OF',
    });
    const lineage = regressionLineage(p.journal, importId);
    expect(lineage.status).toBe('CORRECTED_RUN_PASSED');
    expect(lineage.correctedRuns.map((r) => [r.buildRevisionId, r.lineageRole, r.verdict])).toEqual([
      [corrected.buildRevisionId, 'PROMOTED_REGRESSION', 'PASS'],
    ]);
  });
});
