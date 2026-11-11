/**
 * T-058 — Fork CI isolates secrets and unsafe artifacts.
 * Covers FR-14, FR-17, NFR-03, NFR-11.
 *
 * A trusted-branch, untrusted-branch, same-repository pull-request, fork pull-request, and
 * pull_request_target matrix runs the real `routespec-ci` entry point as its own process, with a
 * provider secret and CI runtime credentials planted in the runner environment as canaries. Each
 * job runs the full gate (real CLI, launcher, proxy, kernel, journal, and an installed subject per
 * case). The action withholds every credential from itself, the CLI child, the client module, and
 * the subject; untrusted jobs cannot start the live-dry adapter and can stage only the generated
 * reports; no job stages a database, raw trace, token, or secret-bearing file; and every job keeps
 * its truthful CI_CHECK result.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ROOT,
  baseConfig,
  filesUnder,
  fixture,
  githubEnv,
  leaksIn,
  outputs,
  runAction,
  stagedReport,
  writeConfig,
  type Fixture,
  type GithubEvent,
} from './support/harness.ts';

type J = Record<string, unknown>;

const PROVIDER = `rs-canary-provider-${randomBytes(12).toString('hex')}`;
const ID_TOKEN = `rs-canary-id-token-${randomBytes(12).toString('hex')}`;
const RUNTIME = `rs-canary-runtime-${randomBytes(12).toString('hex')}`;
const GH_TOKEN = `rs-canary-gh-${randomBytes(12).toString('hex')}`;
const CANARIES = [PROVIDER, ID_TOKEN, RUNTIME, GH_TOKEN];
const PLANTED = {
  ROUTESPEC_PROVIDER_JWT: PROVIDER,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: ID_TOKEN,
  ACTIONS_ID_TOKEN_REQUEST_URL: `https://token.actions.example/${ID_TOKEN}`,
  ACTIONS_RUNTIME_TOKEN: RUNTIME,
  GITHUB_TOKEN: GH_TOKEN,
};

interface JobRun {
  readonly label: string;
  readonly expectedTrust: string;
  readonly trusted: boolean;
  readonly f: Fixture;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly result: J;
  readonly files: { output: string; summary: string; envReport: string };
}

const MATRIX: Array<{ label: string; event: GithubEvent; trust: string; trusted: boolean }> = [
  {
    label: 'trusted branch push',
    event: { kind: 'push', ref: 'refs/heads/main' },
    trust: 'TRUSTED',
    trusted: true,
  },
  {
    label: 'untrusted branch push',
    event: { kind: 'push', ref: 'refs/heads/feature/x' },
    trust: 'UNTRUSTED',
    trusted: false,
  },
  {
    label: 'same-repository pull request',
    event: { kind: 'pull_request', fork: false },
    trust: 'PULL_REQUEST',
    trusted: false,
  },
  { label: 'fork pull request', event: { kind: 'pull_request', fork: true }, trust: 'FORK', trusted: false },
  {
    label: 'pull_request_target',
    event: { kind: 'pull_request_target', headRepo: 'someone/routespec-subject' },
    trust: 'FORK',
    trusted: false,
  },
];

const fixtures: Fixture[] = [];
const OUTSIDE = join(ROOT, '..', 'outside-the-workspace.txt');
afterAll(() => {
  fixtures.forEach((f) => f.cleanup());
  rmSync(OUTSIDE, { force: true });
});

function unsafeFiles(f: Fixture): string[] {
  const extra = join(f.dir, 'extra');
  mkdirSync(extra, { recursive: true });
  // A copy of a journal (SQLite header), a raw trace, a log that leaked the provider secret, a
  // JWT-shaped credential, a case token, a benign note, and a path that leaves the workspace.
  writeFileSync(
    join(extra, 'journal-copy.db'),
    Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), randomBytes(64)]),
  );
  writeFileSync(
    join(extra, 'renamed-db.bin'),
    Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), randomBytes(64)]),
  );
  writeFileSync(
    join(extra, 'capture.trace.json'),
    JSON.stringify({ schema: 'routespec.trace/1', exchanges: [] }),
  );
  writeFileSync(join(extra, 'client-trace-notes.json'), JSON.stringify({ schema: 'routespec.trace/1' }));
  writeFileSync(join(extra, 'results.json'), JSON.stringify({ kind: 'routespec.trace/1', steps: 3 }));
  writeFileSync(join(extra, 'client.log'), `connecting with provider credential ${PROVIDER}\n`);
  // A JWT-shaped placeholder, assembled at run time so the repository secret scan stays clean.
  const jwtShaped = [
    Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from('{"sub":"routespec-test"}').toString('base64url'),
    Buffer.from('signature-placeholder').toString('base64url'),
  ].join('.');
  writeFileSync(join(extra, 'debug.log'), `auth ${jwtShaped}\n`);
  writeFileSync(join(extra, 'handoff.txt'), `token rsct_${'A'.repeat(32)}\n`);
  writeFileSync(join(extra, 'notes.txt'), 'release notes for the subject build\n');
  return [
    `${f.rel}/extra/journal-copy.db`,
    `${f.rel}/extra/renamed-db.bin`,
    `${f.rel}/extra/capture.trace.json`,
    `${f.rel}/extra/client-trace-notes.json`,
    `${f.rel}/extra/results.json`,
    `${f.rel}/extra/client.log`,
    `${f.rel}/extra/debug.log`,
    `${f.rel}/extra/handoff.txt`,
    `${f.rel}/extra/notes.txt`,
    '../outside-the-workspace.txt',
  ];
}

const runs: JobRun[] = [];

beforeAll(async () => {
  writeFileSync(join(ROOT, '..', 'outside-the-workspace.txt'), 'outside\n');
  await Promise.all(
    MATRIX.map(async (m) => {
      const f = fixture('t058');
      fixtures.push(f);
      const extraPaths = unsafeFiles(f);
      const cfg = writeConfig(
        f,
        baseConfig(f, {
          uploads: {
            include: ['gate-report-json', 'junit', 'sarif', 'evidence-bundle'],
            extraPaths,
            retentionDays: 30,
          },
          liveDry: { requested: m.trusted },
        }),
      );
      const { env, files } = githubEnv(f, m.event, PLANTED);
      const r = await runAction(f, cfg, env);
      runs.push({
        label: m.label,
        expectedTrust: m.trust,
        trusted: m.trusted,
        f,
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        result: (r.json ?? {}) as J,
        files,
      });
    }),
  );
}, 240_000);

describe('T-058 — Fork CI isolates secrets and unsafe artifacts', () => {
  it('every job in the matrix keeps its truthful advisory/check result', () => {
    expect(runs).toHaveLength(MATRIX.length);
    for (const run of runs) {
      expect(run.exitCode, `${run.label}: ${run.stderr.slice(-400)}`).toBe(0);
      expect(run.result['context'], run.label).toMatchObject({ trust: run.expectedTrust });
      expect(run.result['decision'], run.label).toBe('PASS');
      expect(run.result['conclusion'], run.label).toBe('success');
      expect(run.result['enforcement'], run.label).toMatchObject({
        mode: 'CI_CHECK',
        verified: false,
        blocking: false,
      });
      expect(stagedReport(run.result)['decision'], run.label).toBe('PASS');
      expect(outputs(run.files.output)['trust'], run.label).toBe(run.expectedTrust);
    }
    const prt = runs.find((r) => r.label === 'pull_request_target') as JobRun;
    expect(prt.result['findings']).toContain('PULL_REQUEST_TARGET_UNTRUSTED');
    const fork = runs.find((r) => r.label === 'fork pull request') as JobRun;
    expect(fork.result['findings']).toContain('PULL_REQUEST_FROM_FORK');
    expect(fork.result['findings']).toContain('SCENARIOS_UNREVIEWED_UNTRUSTED_CONTEXT');
  });

  it('no job hands provider secrets or CI credentials to anything it starts or loads', () => {
    for (const run of runs) {
      expect(run.result['withheldEnvironment'], run.label).toEqual(
        expect.arrayContaining(Object.keys(PLANTED)),
      );
      expect(run.result['findings'], run.label).toContain(
        run.trusted ? 'PROVIDER_SECRET_WITHHELD' : 'PROVIDER_SECRET_PRESENT_IN_UNTRUSTED_JOB',
      );
      // What the client module and the subject process could see: names only, none credential-shaped.
      const seen = readFileSync(run.files.envReport, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { where: string; names: string[] });
      expect(
        seen.map((s) => s.where),
        run.label,
      ).toEqual(expect.arrayContaining(['client-module', 'subject']));
      for (const s of seen) expect(s.names, `${run.label} ${s.where}`).toEqual([]);
      // No canary in the job's stdout, stderr, step outputs, summary, staged uploads, or journal
      // (the journal, reports, and staging directory all live under the work directory).
      const journal = filesUnder(join(run.f.work, 'work')).filter((p) => /journal\.db/.test(p));
      expect(journal.length, run.label).toBeGreaterThan(0);
      for (const c of CANARIES) {
        expect(run.stdout.includes(c) || run.stderr.includes(c), run.label).toBe(false);
        expect(readFileSync(run.files.output, 'utf8').includes(c), run.label).toBe(false);
        expect(readFileSync(run.files.summary, 'utf8').includes(c), run.label).toBe(false);
        expect(leaksIn(join(run.f.work, 'work'), c), run.label).toEqual([]);
      }
    }
  });

  it('untrusted jobs stage only the generated reports; trusted jobs add reviewed, scanned files', () => {
    for (const run of runs) {
      const manifest = run.result['uploads'] as {
        staged: Array<{ kind: string; name: string }>;
        refused: Array<{ kind: string; name: string; reason: string }>;
        retentionDays: number;
      };
      const staged = manifest.staged.map((s) => s.name).sort();
      const reason = (name: string) => manifest.refused.find((r) => r.name === name)?.reason;
      expect(manifest.retentionDays, run.label).toBe(30);
      const onDisk = readdirSync(String(run.result['uploadDirectory'])).sort();
      expect(onDisk, run.label).toEqual([...staged, 'upload-manifest.json'].sort());
      expect(
        onDisk.some((n) => /\.(db|sqlite)$|-(wal|shm)$/.test(n)),
        run.label,
      ).toBe(false);
      if (run.trusted) {
        expect(staged, run.label).toEqual(
          ['evidence-bundle.tar', 'gate-report.json', 'junit.xml', 'notes.txt', 'routespec.sarif'].sort(),
        );
        expect(run.result['artifactReady'], run.label).toBe(true);
        expect(reason('journal-copy.db')).toBe('DATABASE_FILE');
        expect(reason('renamed-db.bin')).toBe('DATABASE_FILE');
        expect(reason('capture.trace.json')).toBe('RAW_TRACE');
        expect(reason('client-trace-notes.json')).toBe('RAW_TRACE');
        expect(reason('results.json')).toBe('RAW_TRACE');
        expect(reason('client.log')).toBe('SECRET_BEARING');
        expect(reason('debug.log')).toBe('SECRET_BEARING');
        expect(reason('handoff.txt')).toBe('LOCAL_TOKEN');
        expect(reason('outside-the-workspace.txt')).toBe('PATH_OUTSIDE_ALLOWED_ROOTS');
      } else {
        expect(staged, run.label).toEqual(['gate-report.json', 'junit.xml', 'routespec.sarif'].sort());
        expect(reason('evidence-bundle.tar'), run.label).toBe('UNTRUSTED_CONTEXT');
        for (const r of manifest.refused.filter((x) => x.kind === 'extra')) {
          expect(r.reason, `${run.label} ${r.name}`).toBe('UNTRUSTED_CONTEXT');
        }
        expect(run.result['artifactReady'], run.label).toBe(false);
      }
    }
  });

  it('untrusted jobs cannot start the live-dry adapter; trusted jobs are only eligible for the separate probe', async () => {
    const trusted = runs.find((r) => r.trusted) as JobRun;
    expect(trusted.result['liveDry']).toBe('ELIGIBLE_NOT_RUN');
    expect(outputs(trusted.files.output)['live-dry']).toBe('ELIGIBLE_NOT_RUN');
    for (const event of [
      { kind: 'pull_request', fork: true },
      { kind: 'pull_request', fork: false },
      { kind: 'pull_request_target', headRepo: 'someone/routespec-subject' },
      { kind: 'push', ref: 'refs/heads/feature/x' },
      { kind: 'workflow_run' },
    ] as GithubEvent[]) {
      const f = fixture('t058-live');
      fixtures.push(f);
      const cfg = writeConfig(f, baseConfig(f, { liveDry: { requested: true } }));
      const { env, files } = githubEnv(f, event, PLANTED);
      const r = await runAction(f, cfg, env);
      expect(r.exitCode, event.kind).toBe(6);
      expect(r.json, event.kind).toMatchObject({
        conclusion: 'policy_denied',
        liveDry: 'DENIED_UNTRUSTED_CONTEXT',
        error: { code: 'RS_MODE_POLICY_DENIED' },
        gateRunId: null,
      });
      expect(outputs(files.output)['live-dry']).toBe('DENIED_UNTRUSTED_CONTEXT');
      expect(filesUnder(join(f.work, 'work')).filter((p) => /journal\.db/.test(p))).toEqual([]);
      for (const c of CANARIES) expect(r.stdout.includes(c) || r.stderr.includes(c)).toBe(false);
    }
  });

  it('a pull-request payload that cannot prove its head repository is treated as a fork', async () => {
    const f = fixture('t058-payload');
    fixtures.push(f);
    const cfg = writeConfig(
      f,
      baseConfig(f, { uploads: { include: ['gate-report-json', 'evidence-bundle'] } }),
    );
    const { env } = githubEnv(f, { kind: 'pull_request', fork: false });
    writeFileSync(env['GITHUB_EVENT_PATH'] as string, '{"pull_request":{}}');
    const r = await runAction(f, cfg, env);
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ context: { trust: 'FORK' } });
    expect((r.json as J)['findings']).toContain('PULL_REQUEST_HEAD_UNPROVEN');
    expect(((r.json as J)['uploads'] as { refused: Array<{ reason: string }> }).refused).toEqual([
      expect.objectContaining({ kind: 'evidence-bundle', reason: 'UNTRUSTED_CONTEXT' }),
    ]);
  });

  it('retention above the bound is refused by the configuration schema', async () => {
    const f = fixture('t058-retention');
    fixtures.push(f);
    const cfg = writeConfig(f, baseConfig(f, { uploads: { retentionDays: 90 } }));
    const r = await runAction(f, cfg, {});
    expect(r.exitCode).toBe(4);
    expect(r.json).toMatchObject({
      error: { code: 'RS_SCHEMA_INVALID', details: { path: 'uploads.retentionDays' } },
    });
  });
});
