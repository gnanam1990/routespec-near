/**
 * M14 contained delivery: the RP-01..RP-06 and RP-08 journey from a clean clone with every
 * subject case confined in a Linux container (T-055 with containment, T-054 install, T-004 live
 * complete-effect, T-010 process-tree egress, RP-06 escape attempts).
 *
 * beforeAll: clone HEAD into an empty directory, install offline, build, then from that install
 * (1) run the containment runtime suite (real escape attempts) and (2) run the product journey
 * with `--contained`. Needs a reachable container engine and the pinned image; otherwise every
 * test is skipped as `NOT_RUN: <reason>` (for example CONTAINER_RUNTIME_ABSENT) and nothing is
 * installed. The engine command comes from `ROUTESPEC_CONTAINER_CLI`.
 *
 * Evidence is written to `ROUTESPEC_CONTAINMENT_EVIDENCE` when set.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { containerToolchainDigest, detectContainerRuntime, type RuntimeStatus } from '@routespec/containment';
import { cleanInstall, offlineEnv, type InstallRecord } from '../src/clean-install.ts';
import type { J } from '../src/control.ts';
import { run, type CommandRecord } from '../src/identity.ts';

const SOURCE = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const COMMIT = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SOURCE, encoding: 'utf8' }).trim();
const KEEP = process.env['ROUTESPEC_DELIVERY_KEEP'] === '1';
const EVIDENCE = process.env['ROUTESPEC_CONTAINMENT_EVIDENCE'];
const isWin = process.platform === 'win32';

type Inv = { invariantId: string; status: string; missingPredicates: string[] };
type Case = {
  caseRunId: string;
  lineageRole: string;
  verdict: string;
  lifecycle: string;
  jobOutcome: J;
  containment: J | null;
  effectCoverage: J;
  invariants: Inv[];
};
type Gate = {
  gateRunId: string;
  gateEvaluationId: string;
  decision: string;
  apiGateRunVerdict: string;
  cases: Case[];
};

let runtime: RuntimeStatus;
let tmp = '';
let install: InstallRecord | null = null;
let journey: J = {};
let journeyRun: CommandRecord | null = null;
let containmentSuite: CommandRecord | null = null;

function need(ctx: TestContext): void {
  if (runtime.status !== 'AVAILABLE') ctx.skip(`NOT_RUN: ${runtime.reason}`);
}

const gate = (k: string) => journey[k] as Gate;
const allCases = () => [
  ...gate('baselineRun').cases,
  ...gate('baselineOnPromoted').cases,
  ...gate('correctedRun').cases,
];
const inv = (c: Case, id: string) => c.invariants.find((i) => i.invariantId === id);
const record = (c: Case) => ((c.containment?.['records'] ?? []) as J[])[0] ?? {};

beforeAll(async () => {
  runtime = await detectContainerRuntime();
  if (runtime.status !== 'AVAILABLE') return;
  tmp = mkdtempSync(join(tmpdir(), 'routespec-m14-'));
  const clone = join(tmp, 'install');
  const work = join(tmp, 'work');
  install = await cleanInstall({ source: SOURCE, commit: COMMIT, dir: clone, authorPaths: [SOURCE] });
  const env = offlineEnv({ ROUTESPEC_CONTAINER_CLI: JSON.stringify(runtime.cli.argv) });
  containmentSuite = await run('pnpm', ['run', 'test:containment'], {
    cwd: clone,
    env,
    shell: isWin,
    timeoutMs: 15 * 60_000,
  });
  const out = join(tmp, 'journey.json');
  journeyRun = await run(
    process.execPath,
    [
      '--no-warnings',
      join(clone, 'packages', 'delivery', 'src', 'journey.ts'),
      '--work',
      work,
      '--out',
      out,
      '--commit',
      COMMIT,
      '--contained',
    ],
    { cwd: clone, env, timeoutMs: 15 * 60_000 },
  );
  if (journeyRun.exitCode !== 0) throw new Error(`contained journey failed: ${journeyRun.stderrTail}`);
  journey = JSON.parse(readFileSync(out, 'utf8')) as J;
}, 45 * 60_000);

afterAll(() => {
  if (EVIDENCE && runtime) {
    writeFileSync(
      EVIDENCE,
      `${JSON.stringify(
        {
          schema: 'routespec.delivery.contained/1',
          runtime:
            runtime.status === 'AVAILABLE'
              ? { status: runtime.status, serverVersion: runtime.serverVersion, imageId: runtime.imageId }
              : { status: runtime.status, reason: runtime.reason },
          install,
          containmentSuite: containmentSuite
            ? {
                exitCode: containmentSuite.exitCode,
                durationMs: containmentSuite.durationMs,
                tail: containmentSuite.stdoutTail.slice(-3000),
              }
            : null,
          journeyRun: journeyRun
            ? { exitCode: journeyRun.exitCode, durationMs: journeyRun.durationMs }
            : null,
          journey,
        },
        null,
        2,
      )}\n`,
    );
  }
  if (tmp && !KEEP) rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('M14 contained delivery from a clean clone', () => {
  it('RP-01: offline clean install, and the containment suite with real escape attempts passes from it', (ctx) => {
    need(ctx);
    expect(install?.ok).toBe(true);
    expect(install?.cleanTreeBeforeInstall).toBe(true);
    expect(install?.cleanTreeAfterBuild).toBe(true);
    expect(install?.authorPathHits).toEqual([]);
    expect(containmentSuite?.exitCode).toBe(0);
    // Every runtime test ran and passed (M14: 11; M16 adds the two profile-review contained
    // cases; M17 adds T-036 container-host access and the tunnel teardown test): none failed and
    // none was skipped as NOT_RUN.
    const totals = /Tests\s+(\d+) passed \((\d+)\)/.exec(containmentSuite?.stdoutTail ?? '');
    expect(totals, 'containment suite totals').not.toBeNull();
    expect(totals?.[1]).toBe(totals?.[2]);
    expect(Number(totals?.[1])).toBeGreaterThanOrEqual(19);
  });

  it('RP-01: trust-rooted identity - every build registration attested by the enrolled launcher', (ctx) => {
    need(ctx);
    const c = journey['containment'] as J;
    expect(c).toMatchObject({ mode: 'CONTAINED', enrollmentConfirmation: 'LOCAL_OPERATOR_CHANNEL' });
    const id = journey['identity'] as J;
    expect(id['toolchainDigest']).toBe(containerToolchainDigest(String(c['imageId'])));
    for (const b of ['baseline', 'corrected']) {
      expect((id[b] as J)['attestationId']).toEqual(expect.any(String));
    }
  });

  it('RP-02/RP-06: the interceptor profile is REVIEWED only through a signed review by a reviewer distinct from the launcher', (ctx) => {
    need(ctx);
    const review = (journey['containment'] as J)['profileReview'] as J;
    expect(review).toMatchObject({
      reviewer: 'LOCAL_TEST_REVIEWER',
      independentHumanReview: 'NOT_RUN',
      reviewerIndependentOfLaunchers: true,
      decision: 'APPROVED',
      stateAfterReview: 'REVIEWED',
      launcherKeyAsReviewer: { status: 409, code: 'RS_REVIEWER_NOT_INDEPENDENT' },
      challengeReplay: { status: 422, code: 'RS_PROFILE_REVIEW_INVALID' },
    });
    expect((journey['containment'] as J)['interceptorReviewStateAtRegistration']).toBe('DECLARED_UNREVIEWED');
    for (const c of allCases()) {
      expect(inv(c, 'INV-04')?.missingPredicates ?? [], c.caseRunId).not.toContain(
        'INTERCEPTOR_PROFILE_UNREVIEWED',
      );
    }
  });

  it('RP-02/RP-06: every subject case ran confined, attested, torn down, and never saw a token over HTTP', (ctx) => {
    need(ctx);
    const cases = allCases();
    expect(cases).toHaveLength(5);
    for (const c of cases) {
      const r = record(c);
      expect(c.containment?.['startTokenReturned'], c.caseRunId).toBe(false);
      expect(r['containment'], c.caseRunId).toBe('PROCESS_TREE_ENFORCED');
      expect(r['findings'], c.caseRunId).toEqual([]);
      expect(r['containerRemoved'], c.caseRunId).toBe(true);
      expect(r['caseLaunchAttestationId'], c.caseRunId).toEqual(expect.any(String));
      expect(r['interceptorAttestationId'], c.caseRunId).toEqual(expect.any(String));
      expect(((r['teardown'] as J)['frames'] as J)['attempted'], c.caseRunId).toBeGreaterThanOrEqual(1);
    }
  });

  it('RP-02: the original build still fails its required predicates on the identical scenario revisions', (ctx) => {
    need(ctx);
    for (const k of ['baselineRun', 'baselineOnPromoted']) {
      const g = gate(k);
      expect(g.decision).not.toBe('PASS');
      for (const c of g.cases) {
        expect(c.verdict).not.toBe('PASS');
        expect(inv(c, 'INV-03')?.status).toBe('REVIEW');
        expect(inv(c, 'INV-03')?.missingPredicates).toContain('ACCEPTED_TERMINAL_STATUS');
      }
    }
  });

  it('RP-03/RP-08: the corrected build passes every required predicate with complete independent coverage', (ctx) => {
    need(ctx);
    const g = gate('correctedRun');
    expect(g.decision).toBe('PASS');
    expect(g.apiGateRunVerdict).toBe('PASS');
    expect(g.cases.map((c) => c.lineageRole).sort()).toEqual(['CORRECTED', 'PROMOTED_REGRESSION']);
    for (const c of g.cases) {
      expect(c.verdict).toBe('PASS');
      expect(c.invariants.filter((i) => i.status !== 'PASS')).toEqual([]);
      expect(inv(c, 'INV-04')?.status).toBe('PASS');
      expect(c.effectCoverage).toMatchObject({
        basis: 'INDEPENDENT_BOUNDARY_INTERCEPT',
        finding: 'COMPLETE',
      });
      expect(c.jobOutcome).toMatchObject({ result: 'RECONCILED' });
    }
    const reg = journey['regression'] as J;
    expect(reg['finalRegressionStatus']).toBe('CORRECTED_RUN_PASSED');
    // M16 (RP-08): the confined, independently observed capture through the reviewed profile is
    // release evidence: promoted as a REQUIRED case without any refusal.
    expect(reg['releaseEvidence']).toMatchObject({ releaseEvidence: true, refusalReasons: [] });
    expect(reg['promotionRefusal']).toBeNull();
    expect(reg['promotion']).toMatchObject({ evidenceUse: 'RELEASE_EVIDENCE', refusalReasons: [] });
    expect((reg['mappingEffectCoverage'] as J)['limitations']).not.toContain('PROCESS_TREE_NOT_CONFINED');
    expect((reg['mappingEffectCoverage'] as J)['basis']).toBe('INDEPENDENT_BOUNDARY_INTERCEPT');
  });

  it('RP-04/RP-05/RP-08: recovery, surface parity, export, crash restart, and clean bundle verification', (ctx) => {
    need(ctx);
    const rp = journey['recoveryProof'] as J;
    expect((rp['recover'] as J)['issuedTokenPurpose']).toBe('RECONCILIATION_ONLY');
    expect((rp['secondMutationUnderReconciliationToken'] as J)['error']).toMatchObject({
      code: 'RS_TOKEN_PHASE_DENIED',
    });
    const cli = journey['cli'] as Record<string, J>;
    expect(cli['corrected']).toMatchObject({
      exitCode: 0,
      decision: 'PASS',
      enforcementMode: 'LOCAL_ADVISORY',
    });
    expect(cli['baseline']?.['exitCode']).toBe(3);
    const ui = journey['ui'] as J;
    if (ui['ran'] === true) expect((ui['corrected'] as J)['verdict']).toBe('PASS');
    const exp = journey['export'] as J;
    expect(exp).toMatchObject({
      blocked: false,
      artifactReady: true,
      decisionAfterExport: 'PASS',
      decisionChanged: false,
    });
    expect(exp).toMatchObject({ refusal: null, evidenceUse: 'RELEASE_EVIDENCE' });
    const bv = journey['bundleVerify'] as J;
    expect(bv).toMatchObject({ exitCode: 0, verified: true, decisionInBundle: 'PASS', bundlePathHits: 0 });
    const checks = ((bv['result'] as J)['checks'] as Array<{ name: string; ok: boolean }>) ?? [];
    for (const name of [
      'evidence-use-declared',
      'release-evidence-consistent',
      'profile-review-signatures',
    ]) {
      expect(checks.find((x) => x.name === name)?.ok, name).toBe(true);
    }
    const rs = journey['restart'] as J;
    expect(rs).toMatchObject({ oldControlTokenStatus: 401, correctedVerdict: 'PASS', stopExitCode: 0 });
    expect((rs['reEvaluation'] as J)['decision']).toBe('PASS');
    const can = journey['canaries'] as J;
    expect(can['dataFindings']).toEqual([]);
    expect(can['exportFindings']).toEqual([]);
    expect(can['extractedFindings']).toEqual([]);
  });
});
