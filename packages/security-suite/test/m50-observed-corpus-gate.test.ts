/**
 * M50: the gate can run an observed-incident corpus.
 *
 * The corpus is built by the real importer from the documented-shape recording (hand-authored
 * from the public Intents Explorer API document; not mainnet data), written to a directory,
 * verified, and registered in a real journal. The real `routespec gate run` then executes every
 * case through the reviewed launcher against a separately launched client running the pinned
 * official SDK. Verdicts come only from the invariant kernel over the journal; nothing is seeded.
 *
 * Still pending: the same run over a corpus imported from the real service (owner's key needed).
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADAPTER_REVISION } from '@routespec/contracts';
import {
  RecordingSource,
  buildCorpus,
  registerObservedCorpus,
  runImport,
  writeCorpusDir,
  type ExplorerRecording,
} from '@routespec/incident-corpus';
import { GateJournal, RouteSpecStore } from '@routespec/store';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  LIVE_INVARIANTS,
  d,
  runGateWithSubjects,
  subjectArtifactDigest,
  tempDir,
  type Journal,
  type SubjectBuild,
} from '../../cli/test/support/product.ts';

const RECORDING = fileURLToPath(
  new URL('../../incident-corpus/fixtures/explorer-documented-shape.json', import.meta.url),
);

let tmp: ReturnType<typeof tempDir>;
let corpusDir: string;
let templates: Array<{ scenarioId: string }>;

beforeAll(async () => {
  tmp = tempDir('routespec-m50-gate-');
  const recording = JSON.parse(readFileSync(RECORDING, 'utf8')) as ExplorerRecording;
  const summary = await runImport(new RecordingSource(recording), {
    window: { startTimestamp: '2026-11-01T00:00:00.000Z', endTimestamp: '2026-11-14T00:00:00.000Z' },
    stuckAfterSec: 900,
    recheckAfterSec: 3600,
  });
  const corpus = buildCorpus(summary, { label: 'explorer-shape-fixture' });
  corpusDir = join(tmp.dir, 'corpus');
  writeCorpusDir(corpusDir, corpus);
  templates = corpus.manifest.templates.map((t) => ({ scenarioId: t.scenarioId }));
});
afterAll(() => tmp?.cleanup());

/** Project, build, effect manifest and policy, the registered corpus, and a gate over it. */
function setup(dataDir: string, build: SubjectBuild): Journal & { cases: number } {
  mkdirSync(dataDir, { recursive: true });
  const store = RouteSpecStore.open({ path: join(dataDir, 'journal.db') });
  try {
    const { projectId } = store.createProject({ name: `m50 ${build}`, idempotencyKey: `m50-${build}` });
    const protocolProfileId = store.registerProtocolProfile();
    const { integrationRevisionId } = store.createIntegrationRevision({
      projectId,
      revisionLabel: 'r1',
      commitSha: null,
      configurationDigest: d('m50-config'),
      protocolProfileId,
    });
    const artifactDigest = subjectArtifactDigest(build);
    const { buildRevisionId } = store.registerBuild({
      projectId,
      integrationRevisionId,
      repositoryLocator: `git+file:subject/${build}`,
      commitSha: createHash('sha1').update(build).digest('hex'),
      dirtyTreeDigest: null,
      artifactDigest,
      toolchainDigest: d('toolchain-node22'),
      lockDigest: d('lock'),
      effectManifestDigest: d(`manifest-${build}`),
      ciWorkflowRunId: null,
      launchRecipeDigest: d(`recipe-${build}`),
    });
    const { manifestDigest } = store.createEffectManifest({
      buildRevisionId,
      artifactDigest,
      adapterRevision: ADAPTER_REVISION,
      hooks: [
        {
          hookId: 'fulfilment',
          hookRevision: '1',
          effectType: 'DELIVER_GOODS',
          sinkClass: 'fulfilment-webhook',
          sourceLocatorDigest: null,
          mechanism: 'subject-hook',
          scenarioSelectors: ['*'],
          coverageExpectation: 'REQUIRED',
        },
      ],
    });
    const registered = registerObservedCorpus(store, corpusDir, {
      requiredInvariants: LIVE_INVARIANTS,
      severity: 'HIGH',
    });
    const scenarioRevisionIds = registered.cases.map((c) => c.scenarioRevisionId);
    const { policyDigest } = store.createEffectCoveragePolicy({
      buildRevisionId,
      artifactDigest,
      selectedAttestationId: null,
      scenarioRevisionId: scenarioRevisionIds[0] as string,
      manifestDigest,
      requiredSinkClasses: ['fulfilment-webhook'],
      interceptorProfileDigest: null,
      callsiteInventoryDigest: null,
      basis: 'DECLARED_HOOKS_ONLY',
    });
    const { gateId } = new GateJournal(store).createGateDefinition({
      projectId,
      name: 'observed incidents',
      corpusRevisionId: registered.corpusRevisionId,
      enforcementMode: 'LOCAL_ADVISORY',
      buildAttestationPolicy: 'ALLOW_USER_ASSERTED',
    });
    return {
      dataDir,
      projectId,
      integrationRevisionId,
      buildRevisionId,
      artifactDigest,
      manifestDigest,
      policyDigest,
      scenarioRevisionIds,
      corpusRevisionId: registered.corpusRevisionId,
      gateId,
      build,
      cases: registered.cases.length,
    };
  } finally {
    store.close();
  }
}

interface ReportCase {
  ordinal: number;
  required: boolean;
  lifecycle: string;
  caseVerdict: string;
  contribution: string;
  findings: string[];
}

async function runCorpus(build: SubjectBuild) {
  const j = setup(join(tmp.dir, build), build);
  const run = await runGateWithSubjects(j);
  expect(run.json, run.stdout + run.stderr).not.toBeNull();
  const report = run.json?.['report'] as { decision: string; cases: ReportCase[] };
  const byScenario = Object.fromEntries(
    report.cases.map((c) => [templates[c.ordinal]?.scenarioId ?? String(c.ordinal), c]),
  );
  return { j, run, report, byScenario };
}

const SCENARIOS = [
  'shape-failed-deposit-seen',
  'shape-failed-no-deposit-seen',
  'shape-late-success-proc-ge-30m',
  'shape-refund-amount-less-than-min-amount-out',
  'shape-refund-intent-submit-failed-proc-ge-15m',
  'shape-refund-no-liquidity',
  'shape-refund-none-reported',
  'shape-refund-partial-deposit',
  'shape-stuck-incd-ge-3h',
  'shape-stuck-proc-ge-3h',
];

describe('M50: the gate runs the observed-incident corpus', () => {
  it('runs all ten cases against a client that keeps reading status: PASS', async () => {
    const { j, run, report, byScenario } = await runCorpus('reconciling-client');
    expect(templates.map((t) => t.scenarioId)).toEqual(SCENARIOS);
    expect(j.cases).toBe(10);
    expect(run.handoffs).toBe(10);
    expect(report.cases).toHaveLength(10);
    for (const id of SCENARIOS) {
      expect(byScenario[id], id).toMatchObject({
        required: true,
        lifecycle: 'COMPLETED',
        caseVerdict: 'PASS',
      });
    }
    expect(report.decision).toBe('PASS');
    expect(run.exitCode).toBe(0);
  });

  it('a client that stops reading status early never sees the late success: REVIEW on that case only', async () => {
    const { run, report, byScenario } = await runCorpus('impatient-client');
    expect(run.handoffs).toBe(10);
    for (const id of SCENARIOS) expect(byScenario[id]?.lifecycle, id).toBe('COMPLETED');
    const late = byScenario['shape-late-success-proc-ge-30m'] as ReportCase;
    expect(late.caseVerdict).toBe('REVIEW');
    expect(late.findings).toContain('INVARIANT_REVIEW:INV-06');
    expect(late.findings).toContain('MISSING:INV-06:ACCEPTED_TERMINAL_STATUS');
    for (const id of SCENARIOS.filter((s) => s !== 'shape-late-success-proc-ge-30m')) {
      expect(byScenario[id]?.caseVerdict, id).toBe('PASS');
    }
    expect(report.decision).toBe('REVIEW');
    expect(run.exitCode).toBe(3);
  });
});
