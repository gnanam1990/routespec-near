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
import { readFileSync } from 'node:fs';
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
let templates: Array<{ scenarioId: string; gatePolicy: string }>;

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
  templates = corpus.manifest.templates.map((t) => ({ scenarioId: t.scenarioId, gatePolicy: t.gatePolicy }));
});
afterAll(() => tmp?.cleanup());

/** Project, build, effect manifest and policy, the registered corpus, and a gate over it. */
function setup(dataDir: string, build: SubjectBuild): Journal & { cases: number } {
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
  scenarioStableId: string;
  executionLifecycle: string;
  verdict: string;
  gatePolicy: string;
}

describe('M50: the gate runs the observed-incident corpus', () => {
  it('executes every case of the corpus against the reconciling client and decides from the kernel', async () => {
    const j = setup(join(tmp.dir, 'reconciling'), 'reconciling-client');
    expect(j.cases).toBe(10);
    const run = await runGateWithSubjects(j);
    expect(run.json, run.stdout + run.stderr).not.toBeNull();
    expect(run.handoffs).toBe(10);
    const report = run.json?.['report'] as {
      decision: string;
      corpusRevisionId: string;
      cases: ReportCase[];
    };
    expect(report.corpusRevisionId).toBe(j.corpusRevisionId);
    expect(report.cases).toHaveLength(10);
    expect(report.cases.map((c) => c.scenarioStableId)).toEqual(templates.map((t) => t.scenarioId));
    for (const c of report.cases) expect(c.executionLifecycle, c.scenarioStableId).toBe('COMPLETED');
    const verdicts = Object.fromEntries(report.cases.map((c) => [c.scenarioStableId, c.verdict]));
    expect(verdicts).toMatchSnapshot('reconciling-client verdicts');
    expect(report.decision).toMatchSnapshot('reconciling-client decision');
    expect(run.exitCode).toMatchSnapshot('reconciling-client exit code');
    // No case of this client is a FAIL: it never resubmits and releases nothing early.
    expect(Object.values(verdicts)).not.toContain('FAIL');
  });
});
