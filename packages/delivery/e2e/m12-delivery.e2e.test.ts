/**
 * M12 delivery verification: T-054 and T-055, run from a clean clone of the exact commit.
 *
 * beforeAll (real, nothing simulated except the provider behaviour of the networkless SIMULATE
 * runtime, which is the product design):
 *  1. clone HEAD into an empty directory, install the frozen lockfile offline with every proxy
 *     variable pointing at a closed port, build the project references and the console;
 *  2. run the full product journey (`packages/delivery/src/journey.ts`) from that install, as its
 *     own process, against the install's own built artifacts and a fresh data directory;
 *  3. run the CLI, CI, replay, recovery, and security regression tests from that install;
 *  4. uninstall (remove every node_modules and build output), check the user data, reinstall
 *     offline, and restart the control service on the same data directory.
 *
 * Run with `pnpm run test:delivery` (several minutes). Uncommitted changes are not part of the
 * clone, so the evidence is for the committed HEAD only.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanTree } from '@routespec/hardening';
import { cleanInstall, offlineEnv, type InstallRecord } from '../src/clean-install.ts';
import { ControlProcess, type J } from '../src/control.ts';
import { fileDigest, run, type CommandRecord } from '../src/identity.ts';

const SOURCE = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const COMMIT = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SOURCE, encoding: 'utf8' }).trim();
const KEEP = process.env['ROUTESPEC_DELIVERY_KEEP'] === '1';
const EVIDENCE = process.env['ROUTESPEC_DELIVERY_EVIDENCE'];
const isWin = process.platform === 'win32';

const REGRESSIONS = [
  'packages/kernel/test/t003-unknown-outcome.test.ts',
  'packages/store/test/t022-t023-crash.test.ts',
  'packages/cli/test/t025-interrupted-evaluation.test.ts',
  'packages/regressions/test/t031-promoted-replay-digest.test.ts',
  'packages/regressions/test/m12-core-scenario-capture.test.ts',
  'packages/cli/test/t046-cli-exit-codes.test.ts',
  'packages/cli/test/t053-bundle-verify.test.ts',
  'packages/ci/test/t056-enforcement-cap.test.ts',
  'packages/ci/test/t058-fork-isolation.test.ts',
  'packages/control-api/test/t037-browser-attacks.test.ts',
  'packages/security-suite/test/t011-canary-persistence.test.ts',
];

let tmp = '';
let install: InstallRecord;
let clone = '';
let work = '';
let journey: J;
let journeyRun: CommandRecord;
let regressions: CommandRecord;
const uninstall: J = {};

type Case = {
  caseRunId: string;
  lineageRole: string;
  scenarioName: string;
  verdict: string;
  lifecycle: string;
  clientInstanceId: string;
  subjectPid: number;
  runOperationIds: string[];
  recovery: J | null;
  jobOutcome: J;
  invariants: Array<{ invariantId: string; status: string; facts: string[]; missingPredicates: string[] }>;
};
type Gate = {
  gateRunId: string;
  gateEvaluationId: string;
  decision: string;
  apiGateRunVerdict: string;
  cases: Case[];
};

const inv = (c: Case, id: string) => c.invariants.find((i) => i.invariantId === id);
const notPassing = (c: Case) => c.invariants.filter((i) => i.status !== 'PASS').map((i) => i.invariantId);

function nodeModulesDirs(root: string): string[] {
  const dirs = [join(root, 'node_modules')];
  for (const group of ['packages', 'apps']) {
    for (const p of readdirSync(join(root, group))) {
      for (const sub of ['node_modules', 'dist']) {
        const d = join(root, group, p, sub);
        if (existsSync(d)) dirs.push(d);
      }
    }
  }
  return dirs;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'routespec-m12-'));
  clone = join(tmp, 'install');
  work = join(tmp, 'work');
  install = await cleanInstall({ source: SOURCE, commit: COMMIT, dir: clone, authorPaths: [SOURCE] });
  // A configured control-service port (ROUTESPEC_DELIVERY_PORT) is carried into the clean
  // clone; offlineEnv strips every other ROUTESPEC_ variable. Without it the port is OS-assigned.
  const port = process.env['ROUTESPEC_DELIVERY_PORT'];
  const env = offlineEnv(
    port !== undefined && /^\d{4,5}$/.test(port) ? { ROUTESPEC_DELIVERY_PORT: port } : {},
  );

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
    ],
    { cwd: clone, env, timeoutMs: 10 * 60_000 },
  );
  if (journeyRun.exitCode !== 0) throw new Error(`journey failed: ${journeyRun.stderrTail}`);
  journey = JSON.parse(readFileSync(out, 'utf8')) as J;

  regressions = await run('pnpm', ['exec', 'vitest', 'run', ...REGRESSIONS], {
    cwd: clone,
    env,
    shell: isWin,
    timeoutMs: 15 * 60_000,
  });

  // Uninstall: remove every installed dependency tree and build output of the product.
  const data = join(work, 'data');
  const removed = nodeModulesDirs(clone);
  for (const d of removed) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  uninstall['removedDirectories'] = removed.length;
  uninstall['productRemoved'] = !existsSync(join(clone, 'node_modules'));
  uninstall['dataFiles'] = readdirSync(data).sort();
  uninstall['journalDigestBefore'] = fileDigest(join(data, 'journal.db'));
  const reinstall = await run('pnpm', ['install', '--frozen-lockfile', '--offline'], {
    cwd: clone,
    env,
    shell: isWin,
  });
  const rebuild = await run('pnpm', ['run', 'build:console'], { cwd: clone, env, shell: isWin });
  uninstall['reinstall'] = { exitCode: reinstall.exitCode, durationMs: reinstall.durationMs };
  uninstall['rebuildConsole'] = { exitCode: rebuild.exitCode };
  uninstall['journalDigestAfterReinstall'] = fileDigest(join(data, 'journal.db'));
  const control = await ControlProcess.start({ root: clone, data, console: true, env });
  try {
    const baselineRun = journey['baselineRun'] as Gate;
    const correctedRun = journey['correctedRun'] as Gate;
    uninstall['restart'] = {
      bind: new URL(control.origin).hostname,
      baselineVerdict: (await control.api('GET', `/gate-runs/${baselineRun.gateRunId}`))['verdict'],
      correctedVerdict: (await control.api('GET', `/gate-runs/${correctedRun.gateRunId}`))['verdict'],
      regressionStatus: (
        await control.api('GET', `/imports/${String((journey['regression'] as J)['importId'])}`)
      )['regressionStatus'],
    };
  } finally {
    uninstall['stopExitCode'] = await control.stop();
  }
  uninstall['dataScanAfterRestart'] = scanTree(data, []).files;

  if (EVIDENCE) {
    writeFileSync(
      EVIDENCE,
      `${JSON.stringify({ install, journey, journeyRun: { ...journeyRun, stdoutTail: '', stderrTail: journeyRun.stderrTail.slice(-400) }, regressions: { command: regressions.command, exitCode: regressions.exitCode, durationMs: regressions.durationMs, summary: regressions.stdoutTail.split('\n').filter((l) => /Test Files|Tests /.test(l)) }, uninstall }, null, 2)}\n`,
    );
  }
});

afterAll(() => {
  if (tmp && !KEEP) rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('T-054 — Clean install works offline for simulation and replay', () => {
  it('clones the exact commit, installs the frozen lockfile offline with no proxy route out, and builds', () => {
    expect(install.ok).toBe(true);
    expect(install.commit).toBe(COMMIT);
    expect(install.cleanTreeBeforeInstall).toBe(true);
    expect(install.cleanTreeAfterBuild).toBe(true);
    for (const c of install.commands) expect(c.exitCode, c.command).toBe(0);
    expect(install.commands.map((c) => c.command)).toEqual(
      expect.arrayContaining([
        'pnpm install --frozen-lockfile --offline',
        'pnpm run build',
        'pnpm run build:console',
      ]),
    );
    expect(install.lockDigest).toBe(fileDigest(join(SOURCE, 'pnpm-lock.yaml')));
    expect(install.artifacts.productSource.files).toBeGreaterThan(50);
    expect(install.artifacts.consoleDist.files).toBeGreaterThan(0);
    expect(install.toolchain.node).toBe(process.version);
  });

  it('built artifacts and the exported bundle carry no author-machine path', () => {
    expect(install.authorPathHits).toEqual([]);
    expect((journey['bundleVerify'] as J)['bundlePathHits']).toBe(0);
  });

  it('the installed product runs SIMULATE and REPLAY without provider network', () => {
    const surface = journey['surface'] as J;
    expect(surface['bind']).toBe('127.0.0.1');
    expect(surface['unauthenticatedStatus']).toBe(401);
    const replay = (journey['regression'] as J)['replay'] as J;
    expect(replay['fidelity']).toBe('MATCH');
    expect(replay['networkAccessed']).toBe(false);
    expect(replay['verified']).toBe(true);
    // Repeated trials (in this process and in a separately launched one) share one digest.
    const trials = replay['trialDigests'] as string[];
    expect(trials.length).toBeGreaterThanOrEqual(3);
    expect(new Set(trials).size).toBe(1);
    for (const g of ['baselineRun', 'baselineOnPromoted', 'correctedRun'] as const) {
      for (const c of (journey[g] as Gate).cases)
        expect(c.lifecycle, `${g} ${c.caseRunId}`).toBe('COMPLETED');
    }
  });

  it('CLI, CI, replay, recovery, and security regressions pass from the clean install', () => {
    expect(regressions.exitCode, regressions.stdoutTail.slice(-1500)).toBe(0);
    expect(regressions.stdoutTail).toMatch(/Test Files\s+.*11 passed/);
  });

  it('launcher and interceptor trust fall back honestly to user-asserted, declared-hooks-only REVIEW', () => {
    for (const g of ['baselineRun', 'correctedRun'] as const) {
      for (const c of (journey[g] as Gate).cases) {
        const i4 = inv(c, 'INV-04');
        expect(i4?.status).toBe('REVIEW');
        expect(i4?.missingPredicates).toEqual(
          expect.arrayContaining(['BUILD_UNATTESTED', 'DECLARED_HOOKS_ONLY']),
        );
      }
    }
  });

  it('uninstall keeps the user data; an offline reinstall restarts on it without exposure', () => {
    expect(uninstall['productRemoved']).toBe(true);
    expect(uninstall['dataFiles']).toEqual(expect.arrayContaining(['journal.db']));
    expect(uninstall['journalDigestAfterReinstall']).toBe(uninstall['journalDigestBefore']);
    expect((uninstall['reinstall'] as J)['exitCode']).toBe(0);
    expect((uninstall['rebuildConsole'] as J)['exitCode']).toBe(0);
    expect(uninstall['restart']).toMatchObject({
      bind: '127.0.0.1',
      baselineVerdict: (journey['baselineRun'] as Gate).decision,
      correctedVerdict: (journey['correctedRun'] as Gate).decision,
      regressionStatus: (journey['regression'] as J)['finalRegressionStatus'],
    });
    expect(uninstall['stopExitCode']).toBe(0);
    const canaries = journey['canaries'] as J;
    expect(canaries['dataFindings']).toEqual([]);
  });
});

describe('T-055 — Full local product journey captures and fixes a real client regression', () => {
  it('the baseline client resubmits after the accepted-then-lost commit and the kernel reports it', () => {
    const b = journey['baselineRun'] as Gate;
    const c = b.cases[0] as Case;
    expect(c.lineageRole).toBe('BASELINE');
    // Both of the client's commit attempts after the lost response were refused by the fence.
    expect(c.jobOutcome['result']).toBe('GAVE_UP');
    expect((c.jobOutcome['attempts'] as J[]).map((a) => a['code'])).toEqual([
      'RS_TOKEN_REVOKED',
      'RS_TOKEN_REVOKED',
    ]);
    expect(c.verdict).toBe('REVIEW');
    expect(inv(c, 'INV-03')).toMatchObject({
      status: 'REVIEW',
      missingPredicates: ['ACCEPTED_TERMINAL_STATUS'],
    });
    expect(inv(c, 'INV-01')?.status).toBe('PASS');
    expect(inv(c, 'INV-02')?.status).toBe('PASS');
    expect(b.decision).toBe('REVIEW');
  });

  it('a second naive build that hedges its unanswered deposit submission FAILs INV-03 from the journal', () => {
    const h = journey['hedgingRun'] as Gate;
    expect(h.cases).toHaveLength(1);
    const c = h.cases[0] as Case;
    expect(c.scenarioName).toBe('slow-commit-answer');
    // The client placed a second order (fresh quote, second deposit) while the first submission
    // was accepted but unanswered, then cancelled the first: two run operations.
    expect(c.jobOutcome['result']).toBe('HEDGED');
    expect(c.jobOutcome['hedgeDepositAddress']).not.toBe(c.jobOutcome['depositAddress']);
    expect(c.runOperationIds).toHaveLength(2);
    expect(c.invariants.filter((i) => i.invariantId === 'INV-03').map((i) => i.status)).toEqual(['FAIL']);
    expect(inv(c, 'INV-01')?.status).toBe('PASS');
    expect(inv(c, 'INV-02')?.status).toBe('PASS');
    expect(c.verdict).toBe('FAIL');
    expect(h.decision).toBe('FAIL');
    expect(h.apiGateRunVerdict).toBe('FAIL');
    expect((journey['identity'] as Record<string, J>)['hedging']?.['artifactDigest']).not.toBe(
      (journey['identity'] as Record<string, J>)['baseline']?.['artifactDigest'],
    );
  });

  it('fenced recovery revokes the stale token, increments the epoch, and denies a second mutation', () => {
    const r = journey['recoveryProof'] as Record<string, J>;
    expect(r['recover']).toMatchObject({
      previousEpoch: 1,
      fencingEpoch: 2,
      revokedTokenPurpose: 'EXECUTION',
      issuedTokenPurpose: 'RECONCILIATION_ONLY',
      allowedPhases: ['READ_ONLY_RECONCILIATION'],
    });
    expect(r['staleExecutionTokenStatusRead']).toMatchObject({
      ok: false,
      error: { code: 'RS_TOKEN_REVOKED' },
    });
    expect(r['staleExecutionTokenCommit']).toMatchObject({ ok: false, error: { code: 'RS_TOKEN_REVOKED' } });
    expect(r['secondMutationUnderReconciliationToken']).toMatchObject({
      ok: false,
      error: { code: 'RS_TOKEN_PHASE_DENIED' },
    });
    expect(r['quoteUnderReconciliationToken']).toMatchObject({
      ok: false,
      error: { code: 'RS_TOKEN_PHASE_DENIED' },
    });
    expect(r['readOnlyStatusUnderReconciliationToken']).toMatchObject({ ok: true });
  });

  it('the failing installed trace is captured, quarantined, mapped, replay-verified, reviewed, and promoted', () => {
    const g = journey['regression'] as J;
    expect(g['captureOrigin']).toBe('INSTALLED_ARTIFACT_CAPTURE');
    expect(g['captureState']).toBe('SANITIZED');
    expect(g['captureFindings']).toEqual([]);
    expect(g['proposalDerivedFrom']).toBe('SOURCE_SCENARIO');
    expect(g['mappingProvenance']).toBe('INDEPENDENTLY_REPRODUCED');
    expect(g['mappingProviderStatuses']).toEqual(['PROCESSING', 'SUCCESS']);
    expect(g['mappingRequiredInvariants']).toEqual(['INV-01', 'INV-02', 'INV-03', 'INV-04']);
    expect(g['mappingEffectCoverage']).toMatchObject({ basis: 'DECLARED_HOOKS_ONLY' });
    expect((g['review'] as J)['stateAfter']).toBe('REVIEWED');
    // M16 (RP-08): an uncontained, declared-hooks-only capture is refused as release evidence
    // with a stable code; it is kept only as an explicit diagnostic-only ADVISORY case.
    expect(g['releaseEvidence']).toMatchObject({ releaseEvidence: false, promotableAs: ['DIAGNOSTIC_ONLY'] });
    expect(g['promotionRefusal']).toMatchObject({ status: 422, code: 'RS_CAPTURE_NOT_RELEASE_EVIDENCE' });
    expect((g['promotionRefusal'] as J)['reasons']).toEqual(
      expect.arrayContaining([
        'DECLARED_HOOKS_ONLY',
        'PROCESS_TREE_NOT_CONFINED',
        'INTERCEPTOR_PROFILE_UNPINNED',
      ]),
    );
    expect((g['promotionRefusal'] as J)['reasons']).toEqual((g['releaseEvidence'] as J)['refusalReasons']);
    const p = g['promotion'] as J;
    expect(p['evidenceUse']).toBe('DIAGNOSTIC_ONLY');
    expect(p['baseCorpusMutated']).toBe(false);
    expect(p['corpusRevisionId']).not.toBe(p['baseCorpusRevisionId']);
    expect(p['lineageAfterPromotion']).toBe('PROMOTED_AWAITING_CORRECTED_RUN');
    expect(p['replayOnlyPass']).toBe(true);
  });

  it('the original build still fails the promoted corpus, labelled as a baseline re-run', () => {
    const b = journey['baselineOnPromoted'] as Gate;
    expect(b.cases.map((c) => c.lineageRole).sort()).toEqual(['BASELINE', 'PROMOTED_REGRESSION']);
    for (const c of b.cases) {
      expect(inv(c, 'INV-03')?.status, c.scenarioName).toBe('REVIEW');
      expect(c.verdict).not.toBe('PASS');
    }
  });

  it('the corrected build is a distinct artifact that reconciles read-only and passes every predicate it can on this host', () => {
    const identity = journey['identity'] as Record<string, J>;
    expect(identity['corrected']?.['artifactDigest']).not.toBe(identity['baseline']?.['artifactDigest']);
    expect(identity['corrected']?.['buildRevisionId']).not.toBe(identity['baseline']?.['buildRevisionId']);
    const c = journey['correctedRun'] as Gate;
    expect(c.cases.map((x) => x.lineageRole).sort()).toEqual(['CORRECTED', 'PROMOTED_REGRESSION']);
    const all = [
      journey['baselineRun'],
      journey['hedgingRun'],
      journey['baselineOnPromoted'],
      journey['correctedRun'],
    ].flatMap((g) => (g as Gate).cases);
    // No case, client instance, subject process, or run operation is shared across builds or cases.
    expect(new Set(all.map((x) => x.caseRunId)).size).toBe(all.length);
    expect(new Set(all.map((x) => x.clientInstanceId)).size).toBe(all.length);
    expect(new Set(all.map((x) => x.subjectPid)).size).toBe(all.length);
    expect(new Set(all.flatMap((x) => x.runOperationIds)).size).toBe(
      all.flatMap((x) => x.runOperationIds).length,
    );
    for (const x of c.cases) {
      expect(x.jobOutcome['result'], x.scenarioName).toBe('RECONCILED');
      expect(x.recovery).toMatchObject({
        revokedTokenPurpose: 'EXECUTION',
        token: { purpose: 'RECONCILIATION_ONLY' },
      });
      expect(inv(x, 'INV-03')?.status, x.scenarioName).toBe('PASS');
      // Complete-effect PASS is BLOCKED on this host: no process-tree sandbox, no interceptor,
      // no attested build. INV-04 is the only predicate left at REVIEW.
      expect(notPassing(x), x.scenarioName).toEqual(['INV-04']);
      expect(inv(x, 'INV-04')?.facts).toEqual(['EFFECT_COVERAGE_MISSING', 'UNATTESTED_BUILD']);
    }
    expect(c.decision).toBe('REVIEW');
    expect((journey['regression'] as J)['finalRegressionStatus']).toBe('CORRECTED_RUN_NOT_PASSING');
  });

  it('CLI, API, and console read the same persisted decision and enforcement', () => {
    const ui = journey['ui'] as Record<string, J>;
    const cli = journey['cli'] as Record<string, J>;
    expect(ui['ran']).toBe(true);
    const pairs: Array<[string, string]> = [
      ['baselineRun', 'baseline'],
      ['hedgingRun', 'hedging'],
      ['baselineOnPromoted', 'baselinePromoted'],
      ['correctedRun', 'corrected'],
    ];
    for (const [key, uiKey] of pairs) {
      const g = journey[key] as Gate;
      expect(g.apiGateRunVerdict, key).toBe(g.decision);
      expect(ui[uiKey]?.['verdict'], key).toBe(g.decision);
      expect(ui[uiKey]?.['enforcement'], key).toBe('LOCAL_ADVISORY');
      expect(ui[uiKey]?.['storage'], key).toEqual([]);
    }
    for (const [label, key, exitCode] of [
      ['baseline', 'baselineRun', 3],
      ['hedging', 'hedgingRun', 2],
      ['baseline-promoted', 'baselineOnPromoted', 3],
      ['corrected', 'correctedRun', 3],
    ] as const) {
      expect(cli[label]?.['decision'], label).toBe((journey[key] as Gate).decision);
      expect(cli[label]?.['exitCode'], label).toBe(exitCode);
      expect(cli[label]?.['enforcementMode'], label).toBe('LOCAL_ADVISORY');
    }
    expect(ui['domHoldsTokens']).toEqual([]);
  });

  it('a checksummed bundle verifies in a clean location and reproduces the decision; artifact readiness never changes it', () => {
    const e = journey['export'] as J;
    const v = journey['bundleVerify'] as J;
    const corrected = journey['correctedRun'] as Gate;
    // M16 (RP-08): the gate uses a diagnostic-only capture, so a release-evidence bundle is
    // refused and the bundle is an explicit DIAGNOSTIC_ONLY export.
    expect(e['refusal']).toMatchObject({ status: 422, code: 'RS_CAPTURE_NOT_RELEASE_EVIDENCE' });
    expect(e['refusal'] as J).toMatchObject({ reasons: ['CAPTURE_NOT_RELEASE_EVIDENCE:DIAGNOSTIC_ONLY'] });
    expect(e['evidenceUse']).toBe('DIAGNOSTIC_ONLY');
    expect(e['blocked']).toBe(false);
    expect(e['artifactReady']).toBe(true);
    expect(e['decisionAfterExport']).toBe(corrected.decision);
    expect(e['gateEvaluationIdAfterExport']).toBe(corrected.gateEvaluationId);
    expect(v['exitCode']).toBe(0);
    expect(v['verified']).toBe(true);
    expect(v['bundleDigest']).toBe(e['outputDigest']);
    expect(v['extracted']).toEqual(
      expect.arrayContaining(['manifest.json', 'checksums.sha256', 'reports/gate-report.json']),
    );
    expect(v['decisionInBundle']).toBe(corrected.decision);
    const checks = ((v['result'] as J)['checks'] as Array<{ name: string; ok: boolean }>) ?? [];
    expect(checks.find((x) => x.name === 'evidence-use-declared')?.ok).toBe(true);
    expect(checks.find((x) => x.name === 'release-evidence-consistent')?.ok).toBe(true);
    const c = journey['canaries'] as J;
    expect(c['exportFindings']).toEqual([]);
    expect(c['extractedFindings']).toEqual([]);
  });

  it('a crashed service restarts from the same data with a new token and the same records', () => {
    const r = journey['restart'] as J;
    expect(r['walPresentAfterCrash']).toBe(true);
    expect(r['oldControlTokenStatus']).toBe(401);
    expect(r['baselineVerdict']).toBe((journey['baselineRun'] as Gate).decision);
    expect(r['correctedVerdict']).toBe((journey['correctedRun'] as Gate).decision);
    expect((r['reEvaluation'] as J)['gateEvaluationId']).toBe(
      (journey['correctedRun'] as Gate).gateEvaluationId,
    );
    expect(r['stopExitCode']).toBe(0);
  });
});
