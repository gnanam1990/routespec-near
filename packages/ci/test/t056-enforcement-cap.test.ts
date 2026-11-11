/**
 * T-056 — Enforcement is capped at required-check-unverified.
 * Covers FR-13, NFR-12, INV-12.
 *
 * The real `routespec-ci` entry point runs as its own process against this checkout with a
 * crafted GitHub runner environment; it drives the real CLI, launcher, proxy, kernel, and journal,
 * and the sample client starts the installed subject for each case. The three supported modes are
 * produced and labelled unverified and non-blocking on every surface the action emits (result
 * document, step outputs, job summary, JSON/JUnit/SARIF reports, evidence bundle). Caller-supplied
 * branch-protection JSON, screenshots, and verified/blocking flags are refused before anything runs;
 * stale workflow metadata and changed repository/workflow/commit/artifact identity are refused or
 * invalidate the conclusion; REVIEW is never converted to success. No external configuration is
 * performed: the test has no network path and no remote write.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RouteSpecError } from '@routespec/contracts';
import { runCli } from '@routespec/cli';
import { GateJournal, RouteSpecStore } from '@routespec/store';
import {
  REPO,
  baseConfig,
  filesUnder,
  fixture,
  githubEnv,
  outputs,
  runAction,
  stagedReport,
  writeConfig,
  type Fixture,
} from './support/harness.ts';

const fixtures: Fixture[] = [];
function fx(label: string): Fixture {
  const f = fixture(label);
  fixtures.push(f);
  return f;
}
afterAll(() => fixtures.forEach((f) => f.cleanup()));

type J = Record<string, unknown>;

function expectUnverified(result: J): void {
  const e = result['enforcement'] as J;
  expect(e['verified']).toBe(false);
  expect(e['blocking']).toBe(false);
  expect(result['buildAttestation']).toBe('USER_ASSERTED_LOCAL');
}

function noGateRan(result: J, f: Fixture): void {
  expect(result['gateRunId']).toBeNull();
  expect(result['uploads']).toBeNull();
  // No journal was ever created for this invocation.
  expect(filesUnder(join(f.work, 'work')).filter((p) => /journal\.db/.test(p))).toEqual([]);
}

describe('T-056 — Enforcement is capped at required-check-unverified', () => {
  let ciCheck: J;
  let ciFiles: { output: string; summary: string };

  beforeAll(async () => {
    const f = fx('t056-ci');
    const cfg = writeConfig(
      f,
      baseConfig(f, { uploads: { include: ['gate-report-json', 'junit', 'sarif', 'evidence-bundle'] } }),
    );
    const { env, files } = githubEnv(f, { kind: 'push', ref: 'refs/heads/main' });
    const r = await runAction(f, cfg, env);
    expect(r.exitCode, r.stderr).toBe(0);
    ciCheck = r.json as J;
    ciFiles = files;
  });

  it('LOCAL_ADVISORY outside CI; a stronger request is downgraded, never elevated', async () => {
    const f = fx('t056-local');
    const cfg = writeConfig(
      f,
      baseConfig(f, { gate: { name: 'local gate', enforcement: 'required-check-unverified' } }),
    );
    const r = await runAction(f, cfg, {});
    expect(r.exitCode, r.stderr).toBe(0);
    const result = r.json as J;
    expect(result['context']).toMatchObject({ provider: 'LOCAL', trust: 'LOCAL' });
    expect(result['enforcement']).toMatchObject({ mode: 'LOCAL_ADVISORY' });
    expect(result['findings']).toContain('ENFORCEMENT_DOWNGRADED_OUTSIDE_CI');
    expect(result['attestation']).toEqual({ status: 'NOT_APPLICABLE', reason: 'NOT_IN_CI' });
    expectUnverified(result);
    expect(stagedReport(result)['enforcement']).toMatchObject({
      mode: 'LOCAL_ADVISORY',
      verified: false,
      blocking: false,
    });
  });

  it('CI_CHECK in CI: every emitted surface says unverified and non-blocking', () => {
    expect(ciCheck['decision']).toBe('PASS');
    expect(ciCheck['conclusion']).toBe('success');
    expect(ciCheck['enforcement']).toMatchObject({ mode: 'CI_CHECK' });
    expectUnverified(ciCheck);
    expect(ciCheck['attestation']).toMatchObject({
      status: 'UNAVAILABLE',
      reason: 'HOSTED_ISSUER_CANNOT_BIND_NONCE',
      tokenRequested: false,
    });
    const out = outputs(ciFiles.output);
    expect(out).toMatchObject({
      'enforcement-mode': 'CI_CHECK',
      'enforcement-verified': 'false',
      blocking: 'false',
      decision: 'PASS',
      conclusion: 'success',
      'build-attestation': 'USER_ASSERTED_LOCAL',
    });
    const summary = readFileSync(ciFiles.summary, 'utf8');
    expect(summary).toContain('CI_CHECK (unverified; never blocking)');
    expect(summary).not.toMatch(/blocks release|branch protection verified|required check verified/i);

    const upload = String(ciCheck['uploadDirectory']);
    const report = stagedReport(ciCheck);
    expect(report['enforcement']).toMatchObject({ mode: 'CI_CHECK', verified: false, blocking: false });
    expect(report['labels']).toContain(
      'ENFORCEMENT_UNVERIFIED: no repository-settings verification; never blocking',
    );
    const junit = readFileSync(join(upload, 'junit.xml'), 'utf8');
    expect(junit).toContain('name="routespec.enforcementVerified" value="false"');
    const sarif = JSON.parse(readFileSync(join(upload, 'routespec.sarif'), 'utf8')) as J;
    expect(JSON.stringify(sarif)).toContain('"routespec.enforcementVerified":false');
    const bundle = readFileSync(join(upload, 'evidence-bundle.tar')).toString('latin1');
    expect(bundle).toContain('CI_CHECK');
    expect(bundle).not.toMatch(/"(?:verified|blocking)"\s*:\s*true/);
    expect(ciCheck['artifactReady']).toBe(true);
  });

  it('REQUIRED_CHECK_UNVERIFIED is the ceiling and is labelled unverified', async () => {
    const f = fx('t056-required');
    const cfg = writeConfig(
      f,
      baseConfig(f, { gate: { name: 'required gate', enforcement: 'REQUIRED_CHECK_UNVERIFIED' } }),
    );
    const { env, files } = githubEnv(f, { kind: 'push', ref: 'refs/heads/main' });
    const r = await runAction(f, cfg, env);
    expect(r.exitCode, r.stderr).toBe(0);
    const result = r.json as J;
    expect(result['enforcement']).toMatchObject({ mode: 'REQUIRED_CHECK_UNVERIFIED' });
    expect(result['findings']).toContain('REQUIRED_CHECK_STATE_UNVERIFIED');
    expectUnverified(result);
    expect(outputs(files.output)).toMatchObject({
      'enforcement-mode': 'REQUIRED_CHECK_UNVERIFIED',
      'enforcement-verified': 'false',
      blocking: 'false',
    });
    expect(stagedReport(result)['enforcement']).toMatchObject({
      mode: 'REQUIRED_CHECK_UNVERIFIED',
      verified: false,
      blocking: false,
    });
  });

  describe('caller-supplied protection state is refused before anything runs', () => {
    const githubProtectionJson = {
      url: `https://api.github.example/repos/${REPO}/branches/main/protection`,
      required_status_checks: { strict: true, contexts: ['routespec-gate'] },
      enforce_admins: { enabled: true },
    };
    const cases: Array<[string, (f: Fixture) => J]> = [
      ['branch-protection JSON', (f) => baseConfig(f, { branchProtection: githubProtectionJson })],
      ['blocking flag in gate', (f) => baseConfig(f, { gate: { name: 'g', blocking: true } })],
      [
        'required-check verified flag',
        (f) => baseConfig(f, { gate: { name: 'g', requiredCheckVerified: true } }),
      ],
      [
        'protection screenshot',
        (f) => baseConfig(f, { evidence: { protectionScreenshot: 'protection.png' } }),
      ],
      [
        'ruleset nested under uploads',
        (f) => baseConfig(f, { uploads: { rulesets: [{ enforcement: 'active' }] } }),
      ],
      [
        'verified enforcement mode',
        (f) => baseConfig(f, { gate: { name: 'g', enforcement: 'VERIFIED_REQUIRED_CHECK' } }),
      ],
      ['blocking enforcement mode', (f) => baseConfig(f, { gate: { name: 'g', enforcement: 'BLOCKING' } })],
    ];
    for (const [label, make] of cases) {
      it(label, async () => {
        const f = fx('t056-claim');
        const cfg = writeConfig(f, make(f));
        const { env, files } = githubEnv(f, { kind: 'push', ref: 'refs/heads/main' });
        const r = await runAction(f, cfg, env);
        expect(r.exitCode, r.stdout).toBe(6);
        const result = r.json as J;
        expect(result['conclusion']).toBe('policy_denied');
        expect(result['error']).toMatchObject({ code: 'RS_ENFORCEMENT_CLAIM_REJECTED' });
        noGateRan(result, f);
        expect(outputs(files.output)).toMatchObject({ 'enforcement-verified': 'false', blocking: 'false' });
      });
    }

    it('action inputs claiming verification or blocking', async () => {
      const f = fx('t056-flags');
      const cfg = writeConfig(f, baseConfig(f));
      writeFileSync(join(f.dir, 'protection.json'), JSON.stringify(githubProtectionJson));
      for (const extra of [
        ['--branch-protection', `${f.rel}/protection.json`],
        ['--required-check-verified'],
        ['--blocking', 'true'],
      ]) {
        const { env } = githubEnv(f, { kind: 'push', ref: 'refs/heads/main' });
        const r = await runAction(f, cfg, env, extra);
        expect(r.exitCode, extra.join(' ')).toBe(6);
        expect((r.json as J)['error']).toMatchObject({ code: 'RS_ENFORCEMENT_CLAIM_REJECTED' });
        noGateRan(r.json as J, f);
      }
    });

    it('the CLI and the journal that backs the control API refuse the same claims', async () => {
      const f = fx('t056-surfaces');
      const io = { stdout: () => undefined, stderr: () => undefined, env: {} };
      const data = join(f.work, 'cli-data');
      for (const flag of [['--blocking'], ['--required-check-verified'], ['--branch-protection', 'on']]) {
        const code = await runCli(
          [
            'gate',
            'create',
            '--data',
            data,
            '--project',
            '00000000-0000-4000-8000-000000000000',
            '--name',
            'g',
            '--corpus',
            '00000000-0000-4000-8000-000000000000',
            ...flag,
          ],
          io,
        );
        expect(code, flag[0]).toBe(6);
      }
      const bad = await runCli(
        [
          'gate',
          'create',
          '--data',
          data,
          '--project',
          '00000000-0000-4000-8000-000000000000',
          '--name',
          'g',
          '--corpus',
          '00000000-0000-4000-8000-000000000000',
          '--enforcement',
          'verified',
        ],
        io,
      );
      expect(bad).toBe(6);
      const store = RouteSpecStore.open({ path: join(f.work, 'journal.db') });
      try {
        const { projectId } = store.createProject({ name: 'p', idempotencyKey: 'p-key-t056' });
        expect(() =>
          new GateJournal(store).createGateDefinition({
            projectId,
            name: 'g',
            corpusRevisionId: '00000000-0000-4000-8000-000000000000',
            enforcementMode: 'BRANCH_PROTECTION_VERIFIED' as 'CI_CHECK',
            buildAttestationPolicy: 'ALLOW_USER_ASSERTED',
          }),
        ).toThrow(RouteSpecError);
      } finally {
        store.close();
      }
    });
  });

  describe('changed or stale identity never yields a success conclusion', () => {
    it('stale workflow metadata: the runner commit is not the checked-out commit', async () => {
      const f = fx('t056-stale');
      const cfg = writeConfig(f, baseConfig(f));
      const { env } = githubEnv(f, { kind: 'push', ref: 'refs/heads/main' }, { GITHUB_SHA: 'f'.repeat(40) });
      const r = await runAction(f, cfg, env);
      expect(r.exitCode).toBe(4);
      expect(r.json).toMatchObject({
        conclusion: 'identity_mismatch',
        error: { code: 'RS_IDENTITY_MISMATCH', details: { reason: 'STALE_WORKFLOW_METADATA' } },
      });
      noGateRan(r.json as J, f);
    });

    it('incomplete run identity', async () => {
      const f = fx('t056-incomplete');
      const cfg = writeConfig(f, baseConfig(f));
      const { env } = githubEnv(f, { kind: 'push', ref: 'refs/heads/main' }, { GITHUB_RUN_ID: '' });
      const r = await runAction(f, cfg, env);
      expect(r.exitCode).toBe(4);
      expect(r.json).toMatchObject({
        error: { details: { reason: 'CI_IDENTITY_INCOMPLETE', field: 'runId' } },
      });
    });

    const pins: Array<[string, J]> = [
      ['repository', { repository: 'example/other-repo' }],
      ['repository id', { repositoryId: '1' }],
      ['workflow', { workflowRef: `${REPO}/.github/workflows/other.yml@refs/heads/main` }],
    ];
    for (const [label, pinnedIdentity] of pins) {
      it(`changed ${label} identity`, async () => {
        const f = fx('t056-pin');
        const cfg = writeConfig(f, baseConfig(f, { pinnedIdentity }));
        const { env } = githubEnv(f, { kind: 'push', ref: 'refs/heads/main' });
        const r = await runAction(f, cfg, env);
        expect(r.exitCode).toBe(4);
        expect(r.json).toMatchObject({
          conclusion: 'identity_mismatch',
          error: { details: { reason: 'PINNED_IDENTITY_MISMATCH' } },
        });
        noGateRan(r.json as J, f);
      });
    }

    it('changed artifact: pinned digest differs from the measured bytes', async () => {
      const f = fx('t056-artifact');
      const config = baseConfig(f);
      (config['subject'] as J)['expectedArtifactDigest'] = `sha256:${'0'.repeat(64)}`;
      const cfg = writeConfig(f, config);
      const { env } = githubEnv(f, { kind: 'push', ref: 'refs/heads/main' });
      const r = await runAction(f, cfg, env);
      expect(r.exitCode).toBe(4);
      expect(r.json).toMatchObject({ error: { details: { reason: 'ARTIFACT_DIGEST_MISMATCH' } } });
      noGateRan(r.json as J, f);
    });

    it('artifact swapped while the gate runs: the PASS decision no longer applies', async () => {
      const f = fx('t056-swap');
      const cfg = writeConfig(f, baseConfig(f));
      const { env, files } = githubEnv(
        f,
        { kind: 'push', ref: 'refs/heads/main' },
        { ROUTESPEC_CI_TEST_SWAP_FILE: f.stamp },
      );
      const r = await runAction(f, cfg, env);
      expect(r.exitCode, r.stderr).toBe(4);
      const result = r.json as J;
      // The persisted decision is reported as is, but the CI conclusion is not success.
      expect(result['decision']).toBe('PASS');
      expect(result['conclusion']).toBe('identity_mismatch');
      expect(result['findings']).toContain('ARTIFACT_CHANGED_DURING_RUN');
      expect(outputs(files.output)).toMatchObject({ conclusion: 'identity_mismatch', 'exit-code': '4' });
    });
  });

  it('REVIEW is not converted to success (attested build required; CI attestation unavailable)', async () => {
    const f = fx('t056-review');
    const cfg = writeConfig(
      f,
      baseConfig(f, { gate: { name: 'attested gate', requireAttestedBuild: true } }),
    );
    const { env, files } = githubEnv(f, { kind: 'push', ref: 'refs/heads/main' });
    const r = await runAction(f, cfg, env);
    expect(r.exitCode, r.stderr).toBe(3);
    const result = r.json as J;
    expect(result['decision']).toBe('REVIEW');
    expect(result['conclusion']).toBe('review_required');
    expect(stagedReport(result)['findings']).toContain('BUILD_UNATTESTED');
    expect(outputs(files.output)).toMatchObject({
      conclusion: 'review_required',
      'exit-code': '3',
      blocking: 'false',
    });
  });
});
