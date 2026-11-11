/**
 * T-033 — Removing a required case changes corpus identity. Covers FR-12, INV-12.
 *
 * Corpus variants that reorder, remove, add, or change a case's scenario revision, required
 * invariants, severity, gate policy, or label each get a distinct identity, and `diffCorpora`
 * makes every difference visible. Identical content maps to the same identity. Gate runs bound
 * to different corpora have different identities, and the kernel's evaluation identity binds the
 * corpus revision, so evidence from one corpus can never stand in for another.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_SCENARIO_SOURCES, compileScenario, type CompiledScenario } from '@routespec/scenario';
import { corpusRevisionDigest, type CorpusCaseInput } from '@routespec/store';
import { diffCorpora } from '../src/index.ts';
import { LIVE_INVARIANTS, Product, tempDir } from './support/product.ts';

let tmp: ReturnType<typeof tempDir>;
let p: Product;
const compiled: Record<string, CompiledScenario> = {};
const rev: Record<string, string> = {};

beforeAll(async () => {
  tmp = tempDir();
  p = await Product.open(tmp.dir, 't033');
  for (const id of ['happy-path', 'duplicate-retry', 'terminal-contradiction']) {
    compiled[id] = compileScenario(CORE_SCENARIO_SOURCES[id] as string);
    rev[id] = p.store.createScenarioRevision({
      ...(compiled[id] as CompiledScenario).revisionInput,
      reviewStatus: 'REVIEWED',
    }).scenarioRevisionId;
  }
  const r2 = compileScenario(
    (CORE_SCENARIO_SOURCES['happy-path'] as string).replace('revisionLabel: r1', 'revisionLabel: r2'),
  );
  rev['happy-path@r2'] = p.store.createScenarioRevision({
    ...r2.revisionInput,
    reviewStatus: 'REVIEWED',
  }).scenarioRevisionId;
});
afterAll(async () => {
  await p?.close();
  tmp?.cleanup();
});

const kase = (id: string, over: Partial<CorpusCaseInput> = {}): CorpusCaseInput => ({
  scenarioRevisionId: rev[id] as string,
  requiredInvariants: LIVE_INVARIANTS,
  severity: 'HIGH',
  gatePolicy: 'REQUIRED',
  ...over,
});

describe('T-033 — Removing a required case changes corpus identity', () => {
  it('every reordered, removed, added, revised, or re-policied variant has a distinct identity and a visible diff', () => {
    const base = [kase('happy-path'), kase('duplicate-retry'), kase('terminal-contradiction')];
    const variants: Record<string, { label: string; cases: CorpusCaseInput[] }> = {
      base: { label: 'release', cases: base },
      reordered: { label: 'release', cases: [base[1], base[0], base[2]] as CorpusCaseInput[] },
      removed: { label: 'release', cases: [base[0], base[1]] as CorpusCaseInput[] },
      added: { label: 'release', cases: [...base, kase('happy-path@r2')] },
      revised: { label: 'release', cases: [kase('happy-path@r2'), base[1], base[2]] as CorpusCaseInput[] },
      invariants: {
        label: 'release',
        cases: [
          kase('happy-path', { requiredInvariants: ['INV-01', 'INV-03'] }),
          base[1],
          base[2],
        ] as CorpusCaseInput[],
      },
      severity: {
        label: 'release',
        cases: [kase('happy-path', { severity: 'LOW' }), base[1], base[2]] as CorpusCaseInput[],
      },
      gatePolicy: {
        label: 'release',
        cases: [kase('happy-path', { gatePolicy: 'ADVISORY' }), base[1], base[2]] as CorpusCaseInput[],
      },
      label: { label: 'release-2', cases: base },
    };
    const ids: Record<string, string> = {};
    const digests: Record<string, string> = {};
    for (const [name, v] of Object.entries(variants)) {
      const c = p.store.createCorpusRevision(v);
      ids[name] = c.corpusRevisionId;
      digests[name] = c.corpusDigest;
      expect(c.corpusDigest, name).toBe(corpusRevisionDigest(v));
    }
    expect(new Set(Object.values(digests)).size).toBe(Object.keys(variants).length);
    expect(new Set(Object.values(ids)).size).toBe(Object.keys(variants).length);
    // Identical content is the same identity (content-derived, not "latest").
    expect(
      p.store.createCorpusRevision(variants['base'] as { label: string; cases: CorpusCaseInput[] })
        .corpusRevisionId,
    ).toBe(ids['base']);

    const kinds = (to: string) =>
      diffCorpora(p.journal, ids['base'] as string, ids[to] as string).changes.map((c) => c.kind);
    expect(kinds('removed')).toEqual(['CASE_REMOVED']);
    expect(diffCorpora(p.journal, ids['base'] as string, ids['removed'] as string).changes[0]).toMatchObject({
      kind: 'CASE_REMOVED',
      ordinal: 2,
      scenarioRevisionId: rev['terminal-contradiction'],
    });
    expect(kinds('reordered')).toContain('CASE_REORDERED');
    expect(kinds('added')).toEqual(['CASE_ADDED']);
    expect(kinds('revised')).toEqual(['SCENARIO_REVISION_CHANGED']);
    expect(diffCorpora(p.journal, ids['base'] as string, ids['invariants'] as string).changes).toEqual([
      { kind: 'POLICY_CHANGED', scenarioRevisionId: rev['happy-path'], field: 'requiredInvariants' },
    ]);
    expect(kinds('severity')).toEqual(['POLICY_CHANGED']);
    expect(kinds('gatePolicy')).toEqual(['POLICY_CHANGED']);
    expect(kinds('label')).toEqual(['LABEL_CHANGED']);
    expect(diffCorpora(p.journal, ids['base'] as string, ids['base'] as string)).toMatchObject({
      identical: true,
      changes: [],
    });

    // Gate runs bound to the full and the reduced corpus have different identities.
    const build = p.registerBuild('baseline-client');
    const spec = (id: string) => ({
      compiled: compiled[id] as CompiledScenario,
      scenarioRevisionId: rev[id] as string,
      lineageRole: 'BASELINE' as const,
      requiredInvariants: LIVE_INVARIANTS,
    });
    const full = p.createGateRun(build, ids['base'] as string, [
      spec('happy-path'),
      spec('duplicate-retry'),
      spec('terminal-contradiction'),
    ]);
    const reduced = p.createGateRun(build, ids['removed'] as string, [
      spec('happy-path'),
      spec('duplicate-retry'),
    ]);
    expect(full.identityDigest).not.toBe(reduced.identityDigest);
    expect(p.store.getGateRun(full.gateRunId)?.['corpus_revision_id']).toBe(ids['base']);
    expect(p.store.getGateRun(reduced.gateRunId)?.['corpus_revision_id']).toBe(ids['removed']);
  });

  it('the kernel evaluation identity binds the corpus revision (INV-12)', async () => {
    const { evaluateCase, snapshotFromJournal } = await import('@routespec/kernel');
    const { Subject } = await import('./support/product.ts');
    const build = p.registerBuild('corrected-client');
    const happy = compiled['happy-path'] as CompiledScenario;
    const a = p.store.createCorpusRevision({ label: 'kernel-a', cases: [kase('happy-path')] });
    const b = p.store.createCorpusRevision({
      label: 'kernel-b',
      cases: [kase('happy-path'), kase('duplicate-retry')],
    });
    const ga = p.createGateRun(build, a.corpusRevisionId, [
      {
        compiled: happy,
        scenarioRevisionId: rev['happy-path'] as string,
        lineageRole: 'BASELINE',
        requiredInvariants: LIVE_INVARIANTS,
      },
    ]);
    const subject = await Subject.launch('corrected-client');
    try {
      await p.runCase(
        subject,
        ga.caseRunIds[0] as string,
        happy,
        { logicalJob: 'kernel-a', txHash: 'sim-tx-kernel-a' },
        'attach',
      );
    } finally {
      await subject.close();
    }
    p.supervisor.teardown(ga.caseRunIds[0] as string);
    const input = snapshotFromJournal(p.store.readEvaluationSnapshot(ga.caseRunIds[0] as string));
    expect(input.identity.corpusRevisionId).toBe(a.corpusRevisionId);
    const original = evaluateCase(input);
    const swapped = evaluateCase({
      ...input,
      identity: { ...input.identity, corpusRevisionId: b.corpusRevisionId },
    });
    expect(swapped.inputDigest).not.toBe(original.inputDigest);
    expect(swapped.resultDigest).not.toBe(original.resultDigest);
  });
});
