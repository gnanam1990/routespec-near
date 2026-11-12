/**
 * T-012 — Gate identity changes invalidate prior decision. Covers FR-13, INV-12.
 *
 * A real PASS gate run is produced through the CLI, launcher, proxy, journal, kernel, and the
 * separately launched official-SDK subject. Then each bound identity is changed one at a time:
 * project revision/configuration, subject build/artifact, gate definition, corpus/scenario,
 * effect manifest/policy, adapter/evaluator/proxy revisions, and fencing epoch. A changed
 * identity is a new immutable GateRun whose decision is computed only from its own cases: the
 * prior PASS, its evidence, and its case results are never reused. A stale runtime evaluator
 * cannot re-confirm the prior PASS, and a gate that requires a trusted build attestation keeps
 * a user-asserted build REVIEW.
 *
 * Not covered here (no attester enrollment or OIDC verification API exists yet, M08/M11): user
 * self-completion, unenrolled key, bad signature, OIDC claim/JWK/nonce checks, revoked
 * principal, unavailable peer binding, swapped interceptor, replay, and concurrent completion
 * of attestations. Those sub-cases are NOT_RUN in this module.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RouteSpecError, computeCanonicalResultDigest } from '@routespec/contracts';
import { EVALUATOR_REVISION } from '@routespec/kernel';
import { GateService, aggregateGate, buildGateReport } from '@routespec/runner';
import { GateJournal, RouteSpecStore } from '@routespec/store';
import { canonical, gateInput, identity } from './support/gate-fixture.ts';
import {
  addBuildAndGate,
  d,
  gateRunArgs,
  runCliProcess,
  runGateWithSubjects,
  setupJournal,
  tempDir,
  type Journal,
} from './support/product.ts';

let tmp: ReturnType<typeof tempDir>;
let base: Journal;
let prior: { gateRunId: string; decisionDigest: string; identityDigest: string; resultDigests: string[] };

function report(json: Record<string, unknown> | null): ReturnType<typeof buildGateReport> {
  return json?.['report'] as ReturnType<typeof buildGateReport>;
}

beforeAll(async () => {
  tmp = tempDir();
  base = setupJournal(tmp.dir, {
    scenarios: ['happy-path', 'accepted-then-lost-response'],
    build: 'reconciling-client',
    label: 't012',
  });
  const r = await runGateWithSubjects(base);
  expect(r.exitCode).toBe(0);
  const rep = report(r.json);
  expect(rep.decision).toBe('PASS');
  prior = {
    gateRunId: rep.gateRunId,
    decisionDigest: rep.decisionDigest,
    identityDigest: rep.identityDigest,
    resultDigests: rep.cases.map((c) => c.resultDigest as string),
  };
});

afterAll(() => tmp?.cleanup());

function withStore<T>(fn: (store: RouteSpecStore) => T): T {
  const store = RouteSpecStore.open({ path: join(tmp.dir, 'journal.db') });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** A changed identity gets its own gate run; without running its own cases it cannot PASS. */
async function planOnly(j: Journal): Promise<ReturnType<typeof buildGateReport>> {
  const r = await runCliProcess(gateRunArgs(j, ['--plan-only']));
  expect(r.exitCode, r.stderr).toBe(3);
  return report(r.json);
}

function expectNotReused(rep: ReturnType<typeof buildGateReport>): void {
  expect(rep.gateRunId).not.toBe(prior.gateRunId);
  expect(rep.decision).toBe('NOT_RUN');
  expect(rep.identityDigest).not.toBe(prior.identityDigest);
  expect(rep.decisionDigest).not.toBe(prior.decisionDigest);
  expect(rep.cases.every((c) => c.resultDigest === null)).toBe(true);
}

describe('T-012 — Gate identity changes invalidate prior decision', () => {
  it('re-evaluating the unchanged gate run returns the same immutable decision', async () => {
    const r = await runCliProcess(['gate', 'evaluate', '--data', tmp.dir, '--gate-run', prior.gateRunId]);
    expect(r.exitCode).toBe(0);
    expect(r.json?.['created']).toBe(false);
    expect(report(r.json).decisionDigest).toBe(prior.decisionDigest);
  });

  it('a changed subject build/artifact, effect manifest/policy, corpus/scenario, or gate definition is a new gate run that reuses nothing', async () => {
    const changes: Journal[] = withStore((store) => {
      const ids = { projectId: base.projectId, integrationRevisionId: base.integrationRevisionId };
      return [
        // subject build/artifact (+ its manifest/policy, which bind the artifact)
        addBuildAndGate(store, tmp.dir, ids, {
          scenarios: ['happy-path', 'accepted-then-lost-response'],
          build: 'naive-client',
          label: 't012-build',
        }),
        // corpus/scenario: one case removed
        addBuildAndGate(store, tmp.dir, ids, {
          scenarios: ['happy-path'],
          build: 'reconciling-client',
          label: 't012-corpus',
        }),
        // required invariant policy changes the corpus identity
        addBuildAndGate(store, tmp.dir, ids, {
          scenarios: ['happy-path', 'accepted-then-lost-response'],
          build: 'reconciling-client',
          label: 't012-invariants',
          requiredInvariants: ['INV-01', 'INV-03'],
        }),
        // gate definition (enforcement mode) on the identical corpus
        addBuildAndGate(store, tmp.dir, ids, {
          scenarios: ['happy-path', 'accepted-then-lost-response'],
          build: 'reconciling-client',
          label: 't012',
          enforcementMode: 'CI_CHECK',
        }),
      ];
    });
    for (const j of changes) expectNotReused(await planOnly(j));
    // The gate-definition change kept build/corpus identical, yet the identity still differs.
    expect(changes[3]?.corpusRevisionId).toBe(base.corpusRevisionId);
  });

  it('a changed project revision/configuration digest produces its own evaluation from its own cases', async () => {
    const changed = withStore((store) => {
      const { integrationRevisionId } = store.createIntegrationRevision({
        projectId: base.projectId,
        revisionLabel: 'r2',
        commitSha: null,
        configurationDigest: d('config-r2'),
        protocolProfileId: store.registerProtocolProfile(),
      });
      return addBuildAndGate(
        store,
        tmp.dir,
        { projectId: base.projectId, integrationRevisionId },
        {
          scenarios: ['happy-path', 'accepted-then-lost-response'],
          build: 'reconciling-client',
          label: 't012-config',
        },
      );
    });
    expectNotReused(await planOnly(changed));
    const r = await runGateWithSubjects(changed);
    const rep = report(r.json);
    expect(rep.decision).toBe('PASS');
    expect(rep.identity['configurationDigest']).toBe(d('config-r2'));
    expect(rep.identityDigest).not.toBe(prior.identityDigest);
    // Its case results were produced for the new identity; none is a prior result.
    for (const digest of rep.cases.map((c) => c.resultDigest))
      expect(prior.resultDigests).not.toContain(digest);
  });

  it('pinned adapter, evaluator, and proxy revisions the runtime does not provide fail validation and never PASS', () => {
    withStore((store) => {
      const service = new GateService(store);
      const gate = new GateJournal(store).latestGateDefinition(base.gateId);
      for (const pin of [
        { evaluatorRevision: 'routespec-kernel@9.9.9' },
        { proxyRevision: 'routespec-proxy@9.9.9' },
        { adapterRevision: 'routespec-adapter@9.9.9' },
      ]) {
        const created = service.createGateRun({
          gate,
          buildRevisionId: base.buildRevisionId,
          artifactDigest: base.artifactDigest,
          corpusRevisionId: base.corpusRevisionId,
          effectManifestDigest: base.manifestDigest,
          effectCoveragePolicyDigest: base.policyDigest,
          mode: 'SIMULATE',
          maxParallelCases: 1,
          ...pin,
        });
        const v = service.validateGateRun(created.gateRunId);
        expect(v.ready).toBe(false);
        expect(v.findings.some((f) => f.blocking)).toBe(true);
        const { decision } = service.evaluateGate(created.gateRunId);
        expect(decision.decision).toBe('NOT_RUN');
        expect(decision.identityDigest).not.toBe(prior.identityDigest);
      }
    });
  });

  it('a stale runtime evaluator or proxy cannot re-confirm the prior PASS', () => {
    withStore((store) => {
      for (const runtime of [
        { evaluatorRevision: 'routespec-kernel@2.0.0', proxyRevision: 'routespec-proxy@1.0.0' },
        { evaluatorRevision: EVALUATOR_REVISION, proxyRevision: 'routespec-proxy@2.0.0' },
      ]) {
        const service = new GateService(store, { runtime });
        const { decision } = service.evaluateGate(prior.gateRunId);
        expect(decision.decision).toBe('REVIEW');
        expect(decision.decisionDigest).not.toBe(prior.decisionDigest);
      }
      // The original decision row is still the immutable PASS for the original runtime.
      const evaluations = new GateJournal(store).listGateEvaluations(prior.gateRunId);
      expect(evaluations.find((e) => e.decisionDigest === prior.decisionDigest)?.decision).toBe('PASS');
    });
  });

  it('every canonical identity field and the fencing epoch must match the gate run, one at a time', () => {
    const fields: Record<string, unknown> = {
      projectId: '30000000-0000-4000-8000-000000000001',
      integrationRevisionId: '30000000-0000-4000-8000-000000000002',
      buildRevisionId: '30000000-0000-4000-8000-000000000003',
      artifactDigest: d('other-artifact'),
      buildAttestationClass: 'CI_ATTESTED',
      gateRunId: '30000000-0000-4000-8000-000000000004',
      caseRunId: '30000000-0000-4000-8000-000000000005',
      sessionId: '30000000-0000-4000-8000-000000000006',
      corpusRevisionId: '30000000-0000-4000-8000-000000000007',
      scenarioRevisionId: '30000000-0000-4000-8000-000000000008',
      protocolProfileId: 'oneclick-v0@2.0.0',
      adapterRevision: 'routespec-adapter@2.0.0',
      evaluatorRevision: 'routespec-kernel@1.0.1',
      configurationDigest: d('other-config'),
      effectCoveragePolicyDigest: d('other-policy'),
      effectManifestDigest: d('other-manifest'),
      callsiteInventoryDigest: d('other-inventory'),
      fencingEpoch: 7,
    };
    for (const [field, value] of Object.entries(fields)) {
      const input = gateInput(['PASS']);
      const c = input.cases[0]!;
      const run = c.caseRun!;
      const tampered = canonical(
        identity(),
        {
          caseRunId: run.caseRunId,
          sessionId: run.sessionId!,
          scenarioRevisionId: run.scenarioRevisionId,
          fencingEpoch: 1,
        },
        'PASS',
        { overrides: { [field]: value } },
      );
      // A self-consistent result (digest recomputed and stored) produced for another identity.
      const digest = computeCanonicalResultDigest(tampered);
      const result = { ...c.result!, canonical: tampered, storedDigest: digest, recomputedDigest: digest };
      const out = aggregateGate({
        ...input,
        cases: [{ ...c, caseRun: { ...run, terminalResultDigest: digest }, result }],
      });
      expect(out.decision, field).toBe('REVIEW');
      expect(out.cases[0]?.findings, field).toContain(`IDENTITY_MISMATCH:${field}`);
    }
  });

  it('a gate that requires a trusted build keeps a user-asserted build REVIEW even when every case passes', async () => {
    const strict = withStore((store) =>
      addBuildAndGate(
        store,
        tmp.dir,
        { projectId: base.projectId, integrationRevisionId: base.integrationRevisionId },
        {
          scenarios: ['happy-path'],
          build: 'reconciling-client',
          label: 't012-strict',
          buildAttestationPolicy: 'REQUIRE_TRUSTED',
        },
      ),
    );
    const r = await runGateWithSubjects(strict);
    expect(r.exitCode).toBe(3);
    const rep = report(r.json);
    expect(rep.cases.map((c) => c.contribution)).toEqual(['PASS']);
    expect(rep.decision).toBe('REVIEW');
    expect(rep.findings).toContain('BUILD_UNATTESTED');
    expect(rep.identity['buildAttestationClass']).toBe('USER_ASSERTED_LOCAL');
  });

  it('an existing GateRun identity is immutable: the journal refuses in-place identity edits', () => {
    withStore((store) => {
      expect(() =>
        store.journal.transact('test.tamper', (db) =>
          db
            .prepare('UPDATE gate_runs SET artifact_digest = ? WHERE gate_run_id = ?')
            .run(d('swapped'), prior.gateRunId),
        ),
      ).toThrow(RouteSpecError);
      expect(store.getGateRun(prior.gateRunId)?.['artifact_digest']).toBe(base.artifactDigest);
    });
  });
});
