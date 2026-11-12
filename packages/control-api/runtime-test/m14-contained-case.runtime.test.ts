/**
 * M14 contained subject cases through the real control service (T-004 live complete-effect,
 * T-012 attestation sub-cases, T-059 operation-bound observation; RP-01, RP-02, RP-03, RP-06).
 *
 * A real `ControlServer` with containment and the reviewed attesting launcher configured runs the
 * pinned official client build inside a container on a real engine. Skipped as
 * `NOT_RUN: <reason>` (for example CONTAINER_RUNTIME_ABSENT) when no engine or image is present.
 *
 * - the corrected build in the accepted-then-lost-response schedule: every launch attested by the
 *   enrolled launcher, containment PROCESS_TREE_ENFORCED, the effect independently observed and
 *   released only after accepted completion, INV-04 PASS, and no token ever returned over HTTP;
 * - a build whose artifact on disk differs from its registration: the launcher refuses to attest
 *   it, and the service refuses to launch it;
 * - a revoked launcher principal: the launches run unattested and INV-04 is REVIEW.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import {
  containerToolchainDigest,
  detectContainerRuntime,
  launcherArtifactDigest,
  interceptorArtifactDigest,
  type RuntimeStatus,
} from '@routespec/containment';
import { CORE_SCENARIO_SOURCES } from '@routespec/scenario';
import { fileDigest } from '../src/index.ts';
import {
  errorCode,
  expectOk,
  launcherKeyFile,
  quoteBody,
  startHarness,
  tempDir,
  type Harness,
} from '../test/support/fixture.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SUBJECTS = join(ROOT, 'packages', 'regressions', 'test', 'support', 'subject');
const LAUNCHER = join(ROOT, 'packages', 'containment', 'src', 'attesting-launcher.ts');
const INTERCEPTOR = join(ROOT, 'packages', 'proxy', 'src', 'interceptor', 'canary-interceptor.ts');
const SINK = 'fulfilment-canary';
const INVARIANTS = ['INV-01', 'INV-02', 'INV-03', 'INV-04'];

type J = Record<string, unknown>;
let runtime: RuntimeStatus;
let h: Harness | null = null;
const keys = tempDir('routespec-m14-keys-');
let projectId = '';
let principalId = '';
let profileDigest = '';
let scenarioRevisionId = '';
let corpusRevisionId = '';
let trustedGateId = '';

function needRuntime(ctx: TestContext): Harness {
  if (runtime.status !== 'AVAILABLE' || h === null) {
    const reason = runtime.status === 'AVAILABLE' ? 'HARNESS_UNAVAILABLE' : runtime.reason;
    ctx.skip(`NOT_RUN: ${reason}`);
    throw new Error('unreachable');
  }
  return h;
}

async function confirmed(path: string, body: J, status = 201): Promise<J> {
  const hh = h as Harness;
  const first = expectOk(await hh.api('POST', path, body), 202);
  const notice = hh.confirmations.find((n) => n.confirmationId === first['confirmationId']);
  if (!notice) throw new Error('no local confirmation');
  return expectOk(
    await hh.api('POST', path, {
      ...body,
      confirmation: { confirmationId: notice.confirmationId, code: notice.code },
    }),
    status,
  );
}

async function registerBuild(file: string, artifactDigest = fileDigest(join(SUBJECTS, file))) {
  const hh = h as Harness;
  const rt = runtime as Extract<RuntimeStatus, { status: 'AVAILABLE' }>;
  const rev = expectOk(
    await hh.api('POST', `/projects/${projectId}/revisions`, {
      revisionLabel: `r-${file}-${artifactDigest.slice(7, 15)}`,
      commitSha: 'b'.repeat(40),
      configurationDigest: fileDigest(join(ROOT, 'package.json')),
      protocolProfileId: 'oneclick-v0@1.0.0',
      metadata: {},
    }),
    201,
  );
  const effects = join(SUBJECTS, file.replace(/\.ts$/, '.effects.json'));
  const build = expectOk(
    await hh.api('POST', `/projects/${projectId}/builds`, {
      integrationRevisionId: rev['integrationRevisionId'],
      repositoryLocator: `git+file:packages/regressions/test/support/subject/${file}`,
      commitSha: 'b'.repeat(40),
      dirtyTreeDigest: null,
      artifactDigest,
      toolchainDigest: containerToolchainDigest(rt.imageId),
      lockDigest: fileDigest(join(ROOT, 'pnpm-lock.yaml')),
      effectManifestDigest: fileDigest(effects),
      launchRecipeDigest: fileDigest(LAUNCHER),
      ciWorkflowRunId: null,
    }),
    201,
  );
  const buildRevisionId = String(build['buildRevisionId']);
  const manifest = expectOk(
    await hh.api('POST', '/effect-manifests', {
      projectId,
      buildRevisionId,
      artifactDigest,
      adapterRevision: 'routespec-adapter@1.0.0',
      hooks: (JSON.parse(readFileSync(effects, 'utf8')) as J)['hooks'],
    }),
    201,
  );
  return { buildRevisionId, artifactDigest, manifestDigest: String(manifest['manifestDigest']) };
}

async function attestBuild(buildRevisionId: string) {
  return (h as Harness).api('POST', '/launcher-challenges', {
    scope: 'BUILD_REGISTRATION',
    projectId,
    principalId,
    buildRevisionId,
  });
}

async function policy(
  b: { buildRevisionId: string; artifactDigest: string; manifestDigest: string },
  att: string | null,
) {
  return String(
    expectOk(
      await (h as Harness).api('POST', '/effect-coverage-policies', {
        projectId,
        buildRevisionId: b.buildRevisionId,
        artifactDigest: b.artifactDigest,
        selectedAttestationId: att,
        scenarioRevisionId,
        manifestDigest: b.manifestDigest,
        requiredSinkClasses: [SINK],
        interceptorProfileDigest: profileDigest,
        callsiteInventoryDigest: null,
        basis: att === null ? 'DECLARED_HOOKS_ONLY' : 'INDEPENDENT_BOUNDARY_INTERCEPT',
      }),
      201,
    )['policyDigest'],
  );
}

async function gateRun(
  gateId: string,
  b: { buildRevisionId: string; artifactDigest: string; manifestDigest: string },
  policyDigest: string,
  att: string | null,
): Promise<string> {
  const hh = h as Harness;
  const g = expectOk(
    await hh.api('POST', '/gate-runs', {
      projectId,
      gateId,
      buildRevisionId: b.buildRevisionId,
      artifactDigest: b.artifactDigest,
      corpusRevisionId,
      effectManifestDigest: b.manifestDigest,
      effectCoveragePolicyDigest: policyDigest,
      callsiteInventoryDigest: null,
      interceptorProfileDigest: profileDigest,
      buildAttestation: att === null ? { class: 'USER_ASSERTED_LOCAL' } : { subjectAttestationId: att },
      mode: 'SIMULATE',
      maxParallelCases: 1,
    }),
    201,
  );
  const id = String(g['gateRunId']);
  const v = expectOk(
    await hh.api('POST', `/gate-runs/${id}/validate`, {}, { ifMatch: Number(g['revision']) }),
    200,
  );
  expectOk(
    await hh.api('POST', `/gate-runs/${id}/start`, {}, { ifMatch: Number((v['gateRun'] as J)['revision']) }),
    200,
  );
  const cases = expectOk(await hh.api('GET', `/gate-runs/${id}/cases`), 200)['items'] as J[];
  return String((cases[0] as J)['caseRunId']);
}

async function runContained(caseRunId: string, job: string): Promise<{ start: J; live: J; after: J }> {
  const hh = h as Harness;
  const start = expectOk(
    await hh.api('POST', `/case-runs/${caseRunId}/contained-start`, {
      attesterPrincipalId: principalId,
      job: { logicalJob: job, quote: quoteBody(), txHash: `sim-tx-${job}` },
    }),
    201,
  );
  let live = start['live'] as J;
  const deadline = Date.now() + 180_000;
  while ((live['job'] === 'RUNNING' || live['job'] === 'STARTING') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    live = expectOk(await hh.api('GET', `/case-runs/${caseRunId}/containment`), 200)['live'] as J;
  }
  expectOk(await hh.api('POST', `/case-runs/${caseRunId}/finish-input`, {}), 200);
  const after = expectOk(await hh.api('GET', `/case-runs/${caseRunId}/containment`), 200);
  return { start, live, after };
}

function inv04(caseRunId: string): J {
  return (h as Harness).store.journal.read(
    (db) =>
      db
        .prepare(
          "SELECT verdict, missing_predicates_json FROM invariant_results WHERE case_run_id = ? AND invariant_id = 'INV-04'",
        )
        .get(caseRunId) as J,
  );
}

beforeAll(async () => {
  runtime = await detectContainerRuntime();
  if (runtime.status !== 'AVAILABLE') return;
  const key = launcherKeyFile(keys.dir, 'operator-launcher');
  h = await startHarness({
    containment: { cli: runtime.cli, imageRef: runtime.imageRef, subjectRoot: ROOT },
    launcher: {
      script: LAUNCHER,
      args: [key.path, ROOT, JSON.stringify(runtime.cli.argv), runtime.imageRef],
    },
  });
  projectId = String(
    expectOk(await h.api('POST', '/projects', { name: 'm14 contained cases' }), 201)['projectId'],
  );
  principalId = String(
    (
      await confirmed('/attester-principals', {
        projectId,
        label: 'operator launcher',
        policy: {
          kind: 'LOCAL_LAUNCHER_KEY',
          publicKeyJwk: key.publicJwk,
          launcherArtifactDigest: launcherArtifactDigest(LAUNCHER),
          peerBinding: 'INHERITED_IPC_CHILD',
          validFromMs: Date.now() - 60_000,
          validUntilMs: Date.now() + 3_600_000,
          maxFreshnessMs: 3_600_000,
        },
      })
    )['principalId'],
  );
  profileDigest = String(
    expectOk(
      await h.api('POST', '/interceptor-profiles', {
        projectId,
        interceptorArtifactDigest: interceptorArtifactDigest(INTERCEPTOR),
        containment: 'PROCESS_TREE_ENFORCED',
        processTreeScope: 'linux-container:network-none:read-only-root:cap-drop-all',
        supportedSinks: [SINK],
        denialMechanism: 'CANARY_REDIRECT',
      }),
      201,
    )['profileDigest'],
  );
  scenarioRevisionId = String(
    expectOk(
      await h.api('POST', '/scenarios', {
        projectId,
        source: CORE_SCENARIO_SOURCES['accepted-then-lost-response'],
      }),
      201,
    )['scenarioRevisionId'],
  );
  corpusRevisionId = String(
    expectOk(
      await h.api('POST', '/corpora', {
        projectId,
        label: 'm14-corpus',
        cases: [
          { scenarioRevisionId, requiredInvariants: INVARIANTS, severity: 'HIGH', gatePolicy: 'REQUIRED' },
        ],
      }),
      201,
    )['corpusRevisionId'],
  );
  trustedGateId = String(
    expectOk(
      await h.api('POST', '/gates', {
        projectId,
        name: 'trusted gate',
        corpusRevisionId,
        enforcementMode: 'LOCAL_ADVISORY',
        buildAttestationPolicy: 'REQUIRE_TRUSTED',
      }),
      201,
    )['gateId'],
  );
}, 300_000);

afterAll(async () => {
  await h?.close();
  keys.cleanup();
});

describe('M14 contained subject cases through the control service', () => {
  it('the corrected build runs confined with attested launches and passes complete-effect coverage', async (ctx) => {
    const hh = needRuntime(ctx);
    const b = await registerBuild('corrected-client.ts');
    const a = expectOk(await attestBuild(b.buildRevisionId), 201);
    expect(a).toMatchObject({
      outcome: 'ATTESTED',
      attestationClass: 'TRUSTED_LAUNCHER',
      channel: 'PRIVATE_IPC',
    });
    const att = String(a['attestationId']);
    const caseRunId = await gateRun(trustedGateId, b, await policy(b, att), att);
    const { start, live, after } = await runContained(caseRunId, 'order-m14-corrected');
    expect(start['token']).toBeNull();
    expect(start['tokenDelivery']).toBe('CONTAINED_SUBJECT');
    expect(JSON.stringify(start)).not.toMatch(/rsct_/);
    expect(live['job']).toBe('DONE');
    expect(live['subjectOutcome']).toMatchObject({
      result: 'RECONCILED',
      statuses: ['PROCESSING', 'SUCCESS'],
    });
    expect(live['attestations']).toEqual({
      CASE_LAUNCH: { outcome: 'ATTESTED', reasonCode: null },
      EFFECT_INTERCEPTOR_LAUNCH: { outcome: 'ATTESTED', reasonCode: null },
    });
    expect(live['credentialPurposes']).toEqual(['EXECUTION', 'RECONCILIATION_ONLY']);
    const record = (after['records'] as J[])[0] as J;
    expect(record).toMatchObject({
      containment: 'PROCESS_TREE_ENFORCED',
      findings: [],
      containerRemoved: true,
    });
    expect(record['caseLaunchAttestationId']).toEqual(expect.any(String));
    expect(record['interceptorAttestationId']).toEqual(expect.any(String));
    const frames = (record['teardown'] as J)['frames'] as J;
    expect(frames['attempted']).toBeGreaterThanOrEqual(1);
    expect(frames['released']).toBe(1);
    const rows = hh.store.journal.read((db) => ({
      observations: db
        .prepare(
          `SELECT o.action, b.session_sequence FROM effect_boundary_observations o
             JOIN boundary_observation_order b USING (observation_id) WHERE o.case_run_id = ? ORDER BY b.session_sequence`,
        )
        .all(caseRunId) as J[],
      authorizations: db
        .prepare('SELECT session_sequence FROM effect_release_authorizations WHERE case_run_id = ?')
        .all(caseRunId) as J[],
      channels: db
        .prepare(
          `SELECT c.containment, i.attestation_id, i.sandbox_scope_digest FROM interceptor_channels c
             JOIN effect_interceptor_instances i USING (interceptor_instance_id) WHERE i.case_run_id = ?`,
        )
        .all(caseRunId) as J[],
    }));
    expect(rows.channels).toHaveLength(1);
    expect(rows.channels[0]).toMatchObject({ containment: 'PROCESS_TREE_ENFORCED' });
    expect(rows.channels[0]?.['sandbox_scope_digest']).toBe(record['sandboxScopeDigest']);
    const authSeq = Number(rows.authorizations[0]?.['session_sequence']);
    const released = rows.observations.filter((o) => o['action'] === 'RELEASED');
    expect(released).toHaveLength(1);
    expect(Number(released[0]?.['session_sequence'])).toBeGreaterThan(authSeq);
    expect(inv04(caseRunId)).toMatchObject({ verdict: 'PASS' });
    const view = expectOk(await hh.api('GET', `/gate-runs/${String(start['gateRunId'])}/cases`), 200)[
      'items'
    ] as J[];
    expect(view[0]).toMatchObject({ verdict: 'PASS' });
    expect((view[0] as J)['effectCoverage']).toMatchObject({
      basis: 'INDEPENDENT_BOUNDARY_INTERCEPT',
      finding: 'COMPLETE',
      interceptorFreshness: 'FRESH',
    });
    const idem = JSON.stringify(
      hh.store.journal.read((db) => db.prepare('SELECT * FROM control_idempotency').all()),
    );
    expect(idem).not.toMatch(/rsct_/);
  });

  it('a build whose artifact on disk differs from its registration is neither attested nor launched', async (ctx) => {
    const hh = needRuntime(ctx);
    // Registered with the baseline build's digest, but the locator names the corrected file.
    const swapped = await registerBuild(
      'corrected-client.ts',
      fileDigest(join(SUBJECTS, 'baseline-client.ts')),
    );
    const a = await attestBuild(swapped.buildRevisionId);
    expect(a.status).toBe(403);
    expect(errorCode(a)).toBe('RS_ATTESTATION_REJECTED');
    expect(JSON.stringify(a.json)).toContain('OBSERVED_ARTIFACT_DIGEST_MISMATCH');
    const gate = expectOk(
      await hh.api('POST', '/gates', {
        projectId,
        name: 'user-asserted gate',
        corpusRevisionId,
        enforcementMode: 'LOCAL_ADVISORY',
        buildAttestationPolicy: 'ALLOW_USER_ASSERTED',
      }),
      201,
    );
    const caseRunId = await gateRun(String(gate['gateId']), swapped, await policy(swapped, null), null);
    const r = await hh.api('POST', `/case-runs/${caseRunId}/contained-start`, {
      attesterPrincipalId: principalId,
      job: { logicalJob: 'order-m14-swapped', quote: quoteBody(), txHash: 'sim-tx-swapped' },
    });
    expect(r.status).toBe(403);
    expect(errorCode(r)).toBe('RS_IDENTITY_MISMATCH');
    expect(hh.store.getCaseRun(caseRunId)?.['execution_lifecycle']).toBe('READY');
    expect(hh.store.listSubjectContainments(caseRunId)).toEqual([]);
  });

  it('after the launcher principal is revoked, launches run unattested and complete-effect coverage is REVIEW', async (ctx) => {
    needRuntime(ctx);
    const b = await registerBuild('corrected-client.ts');
    const att = String(expectOk(await attestBuild(b.buildRevisionId), 201)['attestationId']);
    const caseRunId = await gateRun(trustedGateId, b, await policy(b, att), att);
    await confirmed(`/attester-principals/${principalId}/revoke`, { reasonCode: 'KEY_COMPROMISED' }, 200);
    const { live, after } = await runContained(caseRunId, 'order-m14-revoked');
    expect(live['attestations']).toMatchObject({
      CASE_LAUNCH: { outcome: 'NOT_ATTESTED', reasonCode: 'RS_PEER_BINDING_UNAVAILABLE' },
      EFFECT_INTERCEPTOR_LAUNCH: { outcome: 'NOT_ATTESTED', reasonCode: 'RS_PEER_BINDING_UNAVAILABLE' },
    });
    const record = (after['records'] as J[])[0] as J;
    expect(record).toMatchObject({ containment: 'PROCESS_TREE_ENFORCED', caseLaunchAttestationId: null });
    const r = inv04(caseRunId);
    expect(r['verdict']).toBe('REVIEW');
    const missing = JSON.parse(String(r['missing_predicates_json'])) as string[];
    expect(missing).toEqual(expect.arrayContaining(['BUILD_ATTESTER_REVOKED', 'INTERCEPTOR_UNATTESTED']));
  });
});
