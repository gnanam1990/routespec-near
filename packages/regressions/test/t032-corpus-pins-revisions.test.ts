/**
 * T-032 — Corpus revision pins exact scenario revisions. Covers FR-12.
 *
 * After a corpus is created, a scenario is revised and a regression is promoted. The existing
 * corpus and every gate run bound to it stay exactly as they were; the explicit revision and
 * the promotion each create a new corpus identity with typed lineage, and a gate run created
 * for the corrected client binds that new identity and its exact scenario revisions. Corpus
 * rows cannot be rewritten, and an existing identity is never silently reused as a "revision".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRouteSpecError } from '@routespec/contracts';
import { CORE_SCENARIO_SOURCES, compileScenario } from '@routespec/scenario';
import { diffCorpora } from '../src/index.ts';
import { LIVE_INVARIANTS, Product, tempDir } from './support/product.ts';
import { promoteUserTrace, simpleUserTrace } from './support/traces.ts';

let tmp: ReturnType<typeof tempDir>;
let p: Product;

beforeAll(async () => {
  tmp = tempDir();
  p = await Product.open(tmp.dir, 't032');
});
afterAll(async () => {
  await p?.close();
  tmp?.cleanup();
});

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return isRouteSpecError(error) ? error.code : 'UNTYPED';
  }
}

describe('T-032 — Corpus revision pins exact scenario revisions', () => {
  it('revision and promotion after corpus creation leave the existing corpus and its gate runs unchanged', async () => {
    const happy = compileScenario(CORE_SCENARIO_SOURCES['happy-path'] as string);
    const dup = compileScenario(CORE_SCENARIO_SOURCES['duplicate-retry'] as string);
    const s1 = p.store.createScenarioRevision({ ...happy.revisionInput, reviewStatus: 'REVIEWED' });
    const s2 = p.store.createScenarioRevision({ ...dup.revisionInput, reviewStatus: 'REVIEWED' });
    const c1 = p.store.createCorpusRevision({
      label: 'release',
      cases: [
        {
          scenarioRevisionId: s1.scenarioRevisionId,
          requiredInvariants: LIVE_INVARIANTS,
          severity: 'HIGH',
          gatePolicy: 'REQUIRED',
        },
        {
          scenarioRevisionId: s2.scenarioRevisionId,
          requiredInvariants: LIVE_INVARIANTS,
          severity: 'HIGH',
          gatePolicy: 'REQUIRED',
        },
      ],
    });
    const build = p.registerBuild('baseline-client');
    const g1 = p.createGateRun(build, c1.corpusRevisionId, [
      {
        compiled: happy,
        scenarioRevisionId: s1.scenarioRevisionId,
        lineageRole: 'BASELINE',
        requiredInvariants: LIVE_INVARIANTS,
      },
      {
        compiled: dup,
        scenarioRevisionId: s2.scenarioRevisionId,
        lineageRole: 'BASELINE',
        requiredInvariants: LIVE_INVARIANTS,
      },
    ]);
    const snapshotC1 = p.journal.getCorpus(c1.corpusRevisionId);
    const snapshotG1 = p.store.getGateRun(g1.gateRunId);
    const g1Cases = g1.caseRunIds.map((id) => p.store.getCaseRun(id)?.['scenario_revision_id']);

    // Revise scenario S1 -> S1' (a new immutable revision; S1 itself is untouched).
    const revised = compileScenario(
      (CORE_SCENARIO_SOURCES['happy-path'] as string).replace('revisionLabel: r1', 'revisionLabel: r2'),
    );
    const s1b = p.store.createScenarioRevision({ ...revised.revisionInput, reviewStatus: 'REVIEWED' });
    expect(s1b.scenarioRevisionId).not.toBe(s1.scenarioRevisionId);
    expect(p.journal.getCorpus(c1.corpusRevisionId)).toEqual(snapshotC1);

    // An explicit corpus revision is a new identity with REVISION_OF lineage; C1 is unchanged.
    const c2 = p.journal.reviseCorpus({
      baseCorpusRevisionId: c1.corpusRevisionId,
      label: 'release',
      cases: [
        {
          scenarioRevisionId: s1b.scenarioRevisionId,
          requiredInvariants: LIVE_INVARIANTS,
          severity: 'HIGH',
          gatePolicy: 'REQUIRED',
        },
        {
          scenarioRevisionId: s2.scenarioRevisionId,
          requiredInvariants: LIVE_INVARIANTS,
          severity: 'HIGH',
          gatePolicy: 'REQUIRED',
        },
      ],
      idempotencyKey: 't032-revise-1',
    });
    expect(c2.corpusRevisionId).not.toBe(c1.corpusRevisionId);
    expect(c2.corpusDigest).not.toBe(snapshotC1.corpusDigest);
    expect(p.journal.getCorpus(c2.corpusRevisionId).parent).toMatchObject({
      relation: 'REVISION_OF',
      parent_corpus_revision_id: c1.corpusRevisionId,
    });
    expect(diffCorpora(p.journal, c1.corpusRevisionId, c2.corpusRevisionId).changes).toEqual([
      {
        kind: 'SCENARIO_REVISION_CHANGED',
        scenarioStableId: 'happy-path',
        from: s1.scenarioRevisionId,
        to: s1b.scenarioRevisionId,
      },
    ]);

    // Promotion that explicitly targets C1 creates C3; C1 still pins exactly S1 and S2.
    const { promotion } = await promoteUserTrace(p, {
      trace: simpleUserTrace('t032'),
      tag: 't032-user',
      sourcePlan: happy.plan,
      baseCorpusRevisionId: c1.corpusRevisionId,
      corpusLabel: 'release',
      requiredInvariants: LIVE_INVARIANTS,
      // The user trace saw SUCCESS on its first status read: drop the scripted PROCESSING step.
      edit: (m) => ({
        ...m,
        scenario: { ...m.scenario, steps: m.scenario.steps.filter((s) => s.id !== 'processing') },
      }),
    });
    expect(promotion.baseCorpusRevisionId).toBe(c1.corpusRevisionId);
    expect(new Set([c1.corpusRevisionId, c2.corpusRevisionId, promotion.corpusRevisionId]).size).toBe(3);
    const c3 = p.journal.getCorpus(promotion.corpusRevisionId);
    expect(c3.cases.map((c) => c.scenarioRevisionId)).toEqual([
      s1.scenarioRevisionId,
      s2.scenarioRevisionId,
      promotion.scenarioRevisionId,
    ]);
    expect(c3.parent).toMatchObject({
      relation: 'PROMOTION_INTO',
      parent_corpus_revision_id: c1.corpusRevisionId,
    });
    expect(p.journal.getCorpus(c1.corpusRevisionId)).toEqual(snapshotC1);
    expect(p.store.getGateRun(g1.gateRunId)).toEqual(snapshotG1);
    expect(g1.caseRunIds.map((id) => p.store.getCaseRun(id)?.['scenario_revision_id'])).toEqual(g1Cases);

    // The corrected-client gate run binds the new identity and its exact pinned revisions.
    const corrected = p.registerBuild('corrected-client');
    const g3 = p.createGateRun(
      corrected,
      promotion.corpusRevisionId,
      c3.cases.map((c, i) => ({
        compiled: happy,
        scenarioRevisionId: c.scenarioRevisionId,
        lineageRole: i === 2 ? ('PROMOTED_REGRESSION' as const) : ('CORRECTED' as const),
        requiredInvariants: c.requiredInvariants,
      })),
    );
    const g3Row = p.store.getGateRun(g3.gateRunId) as Record<string, unknown>;
    expect(g3Row['corpus_revision_id']).toBe(promotion.corpusRevisionId);
    expect(g3Row['identity_digest']).not.toBe(snapshotG1?.['identity_digest']);
    expect(g3.caseRunIds.map((id) => p.store.getCaseRun(id)?.['scenario_revision_id'])).toEqual(
      c3.cases.map((c) => c.scenarioRevisionId),
    );
    // A gate run's corpus binding is frozen.
    expect(
      codeOf(() =>
        p.store.journal.transact('tamper', (db) =>
          db
            .prepare('UPDATE gate_runs SET corpus_revision_id = ? WHERE gate_run_id = ?')
            .run(c2.corpusRevisionId, g1.gateRunId),
        ),
      ),
    ).toBe('RS_IMMUTABLE_RECORD');
  });

  it('corpus membership rows are immutable and an existing identity is never reused as a revision', () => {
    const anyCorpus = p.store.journal.read((db) =>
      db.prepare('SELECT corpus_revision_id FROM corpus_revisions LIMIT 1').get(),
    ) as {
      corpus_revision_id: string;
    };
    const c = p.journal.getCorpus(anyCorpus.corpus_revision_id);
    for (const sql of [
      "UPDATE corpus_cases SET severity = 'LOW' WHERE corpus_revision_id = ?",
      'DELETE FROM corpus_cases WHERE corpus_revision_id = ?',
      "UPDATE corpus_revisions SET label = 'x' WHERE corpus_revision_id = ?",
    ]) {
      expect(
        codeOf(() => p.store.journal.transact('tamper', (db) => db.prepare(sql).run(c.corpusRevisionId))),
        sql,
      ).toBe('RS_IMMUTABLE_RECORD');
    }
    expect(
      codeOf(() =>
        p.journal.reviseCorpus({
          baseCorpusRevisionId: c.corpusRevisionId,
          label: c.label,
          cases: c.cases,
          idempotencyKey: 't032-revise-same',
        }),
      ),
    ).toBe('RS_DUPLICATE');
    expect(p.journal.getCorpus(c.corpusRevisionId)).toEqual(c);
  });
});
