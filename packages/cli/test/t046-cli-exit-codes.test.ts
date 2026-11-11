/**
 * T-046 — CLI exit codes distinguish pass, fail, review, config, internal, and policy denial.
 * Covers FR-14.
 *
 * Every documented exit code is produced by the real `routespec` process: 0 (PASS), 2 (FAIL),
 * 3 (REVIEW and NOT_RUN), 4 (user/configuration/schema error), 5 (internal error or corrupted
 * state), 6 (safety policy denied an action). For every invocation stdout is exactly one
 * parseable JSON document whose `exitCode` equals the process exit code, and human diagnostics
 * and structured logs go only to stderr. The project/build/scenario/corpus/gate setup for the
 * PASS run is itself done through the CLI.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@routespec/contracts';
import { RouteSpecStore } from '@routespec/store';
import { ERROR_EXIT_CODES, EXIT } from '../src/index.ts';
import { runWithLauncher } from '../src/launcher.ts';
import {
  d,
  gateRunArgs,
  quoteBody,
  runCliProcess,
  runGateWithSubjects,
  scenarioSource,
  setupJournal,
  Subject,
  subjectArtifactDigest,
  tempDir,
  type Journal,
} from './support/product.ts';

let tmp: ReturnType<typeof tempDir>;
const seen = new Map<number, string[]>();

function record(code: number | null, label: string): void {
  const k = code ?? -1;
  seen.set(k, [...(seen.get(k) ?? []), label]);
}

/** stdout carries exactly one JSON document whose exitCode matches the process; logs go to stderr. */
function assertStreams(
  r: { exitCode: number | null; stdout: string; stderr: string; json: Record<string, unknown> | null },
  label: string,
): void {
  expect(r.json, `${label}: ${r.stdout}`).not.toBeNull();
  expect(r.stdout.trim().split('\n'), label).toHaveLength(1);
  expect(r.json?.['exitCode'], label).toBe(r.exitCode);
  expect(r.json?.['ok'], label).toBe(r.exitCode === 0);
  expect(r.stdout, label).not.toMatch(/"level":"(info|warn|error)"/);
  record(r.exitCode, label);
}

async function cli(
  args: string[],
  label: string,
  options: { env?: Record<string, string | undefined> } = {},
) {
  const r = await runCliProcess(args, options);
  assertStreams(r, label);
  return r;
}

beforeAll(() => {
  tmp = tempDir();
});
afterAll(() => tmp?.cleanup());

describe('T-046 — CLI exit codes distinguish pass, fail, review, config, internal, and policy denial', () => {
  it('0: a PASS gate set up entirely through the CLI', async () => {
    const data = join(tmp.dir, 'pass');
    const id = (r: { json: Record<string, unknown> | null }, k: string) => String(r.json?.[k]);
    const project = await cli(
      ['project', 'create', '--data', data, '--name', 'cli project'],
      'project create',
    );
    expect(project.exitCode).toBe(0);
    const rev = await cli(
      [
        'revision',
        'register',
        '--data',
        data,
        '--project',
        id(project, 'projectId'),
        '--label',
        'r1',
        '--config-digest',
        d('cli-config'),
      ],
      'revision',
    );
    const artifact = subjectArtifactDigest('reconciling-client');
    const build = await cli(
      [
        'build',
        'register',
        '--data',
        data,
        '--project',
        id(project, 'projectId'),
        '--revision',
        id(rev, 'integrationRevisionId'),
        '--artifact',
        artifact,
        '--repository',
        'git+file:subject/reconciling-client',
        '--commit',
        'a'.repeat(40),
        '--toolchain-digest',
        d('toolchain'),
        '--lock-digest',
        d('lock'),
        '--declared-manifest-digest',
        d('declared'),
        '--launch-recipe-digest',
        d('recipe'),
      ],
      'build register',
    );
    expect(build.json?.['attestation']).toBe('USER_ASSERTED_LOCAL');
    const hooks = join(tmp.dir, 'hooks.json');
    writeFileSync(
      hooks,
      JSON.stringify({
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
      }),
    );
    const manifest = await cli(
      ['effect', 'manifest', '--data', data, '--build', id(build, 'buildRevisionId'), '--file', hooks],
      'effect manifest',
    );
    const scen = join(tmp.dir, 'happy.yaml');
    writeFileSync(scen, scenarioSource('happy-path'));
    const validated = await cli(['scenario', 'validate', scen], 'scenario validate');
    expect(validated.json?.['valid']).toBe(true);
    const scenario = await cli(['scenario', 'add', '--data', data, scen, '--reviewed'], 'scenario add');
    const policy = await cli(
      [
        'effect',
        'policy',
        '--data',
        data,
        '--build',
        id(build, 'buildRevisionId'),
        '--scenario',
        id(scenario, 'scenarioRevisionId'),
        '--manifest',
        id(manifest, 'manifestDigest'),
        '--sink',
        'fulfilment-webhook',
      ],
      'effect policy',
    );
    const corpus = await cli(
      [
        'corpus',
        'create',
        '--data',
        data,
        '--name',
        'release',
        '--scenario',
        id(scenario, 'scenarioRevisionId'),
        '--scenario',
        id(scenario, 'scenarioRevisionId'),
        '--require',
        'INV-01,INV-02,INV-03,INV-05,INV-06,INV-07,INV-08',
      ],
      'corpus create',
    );
    const gate = await cli(
      [
        'gate',
        'create',
        '--data',
        data,
        '--project',
        id(project, 'projectId'),
        '--name',
        'release gate',
        '--corpus',
        id(corpus, 'corpusRevisionId'),
        '--enforcement',
        'ci-check',
      ],
      'gate create',
    );
    expect(gate.json).toMatchObject({
      enforcementMode: 'CI_CHECK',
      enforcementVerified: false,
      blocking: false,
    });
    for (const r of [project, rev, build, manifest, scenario, policy, corpus, gate])
      expect(r.exitCode).toBe(0);
    const j: Journal = {
      dataDir: data,
      projectId: id(project, 'projectId'),
      integrationRevisionId: id(rev, 'integrationRevisionId'),
      buildRevisionId: id(build, 'buildRevisionId'),
      artifactDigest: artifact,
      manifestDigest: id(manifest, 'manifestDigest'),
      policyDigest: id(policy, 'policyDigest'),
      scenarioRevisionIds: [id(scenario, 'scenarioRevisionId')],
      corpusRevisionId: id(corpus, 'corpusRevisionId'),
      gateId: id(gate, 'gateId'),
      build: 'reconciling-client',
    };
    const run = await runGateWithSubjects(j, { extraArgs: ['--parallelism', '2'] });
    assertStreams(run, 'gate run PASS');
    expect(run.exitCode).toBe(EXIT.PASS);
    expect(run.handoffs).toBe(2);
    expect(
      run.json?.['report'] as {
        decision: string;
        enforcement: { mode: string; verified: boolean; blocking: boolean };
      },
    ).toMatchObject({
      decision: 'PASS',
      enforcement: { mode: 'CI_CHECK', verified: false, blocking: false },
    });
    // Structured logs went to stderr, and no clear token was printed anywhere.
    expect(run.stderr).toMatch(/"code":"case\.evaluated"/);
    expect(run.stdout + run.stderr).not.toMatch(/rsct_[A-Za-z0-9_-]{20,}/);
    // Two cases ran concurrently (bounded parallelism 2), each with its own session and client.
    const sessions = new Set(run.handoffSnapshots.map((h) => h.credentials.sessionId));
    const clients = new Set(run.handoffSnapshots.map((h) => h.credentials.clientInstanceId));
    expect(sessions.size).toBe(2);
    expect(clients.size).toBe(2);
    const metrics = run.json?.['metrics'] as Record<string, number>;
    expect(metrics['parallel_cases_peak']).toBe(2);
    const show = await cli(
      [
        'gate',
        'show',
        '--data',
        data,
        '--gate-evaluation',
        String((run.json?.['report'] as { gateEvaluationId: string }).gateEvaluationId),
      ],
      'gate show',
    );
    expect(show.exitCode).toBe(EXIT.PASS);
  });

  it('2: FAIL and 3: REVIEW / NOT_RUN', async () => {
    const fail = setupJournal(join(tmp.dir, 'fail'), {
      scenarios: ['refund-shortfall'],
      build: 'reconciling-client',
      label: 't046-fail',
    });
    const f = await runGateWithSubjects(fail);
    assertStreams(f, 'gate run FAIL');
    expect(f.exitCode).toBe(EXIT.FAIL);
    const review = setupJournal(join(tmp.dir, 'review'), {
      scenarios: ['accepted-then-lost-response'],
      build: 'naive-client',
      label: 't046-review',
    });
    const r = await runGateWithSubjects(review);
    assertStreams(r, 'gate run REVIEW');
    expect(r.exitCode).toBe(EXIT.REVIEW);
    expect((r.json?.['report'] as { decision: string }).decision).toBe('REVIEW');
    const p = await cli(gateRunArgs(review, ['--plan-only']), 'gate run NOT_RUN');
    expect(p.exitCode).toBe(EXIT.REVIEW);
    expect((p.json?.['report'] as { decision: string }).decision).toBe('NOT_RUN');
    const e = await cli(
      [
        'gate',
        'evaluate',
        '--data',
        review.dataDir,
        '--gate-run',
        String((r.json?.['report'] as { gateRunId: string }).gateRunId),
      ],
      'gate evaluate REVIEW',
    );
    expect(e.exitCode).toBe(EXIT.REVIEW);
  });

  it('4: usage, configuration, and schema errors', async () => {
    const j = setupJournal(join(tmp.dir, 'config'), {
      scenarios: ['happy-path'],
      build: 'reconciling-client',
      label: 't046-config',
    });
    const bad = join(tmp.dir, 'bad.yaml');
    writeFileSync(
      bad,
      'schemaVersion: "1.0"\nscenarioId: bad\nsteps: [ { id: x, type: shell, run: "rm -rf /" } ]\n',
    );
    const cases: Array<[string[], string]> = [
      [['nonsense'], 'RS_CLI_USAGE'],
      [['gate', 'evaluate', '--data', j.dataDir], 'RS_CLI_USAGE'],
      [['gate', 'evaluate', '--data', j.dataDir, '--gate-run', 'x', '--unknown-flag', '1'], 'RS_CLI_USAGE'],
      [['gate', 'evaluate', '--data', j.dataDir, '--gate-run', 'not-a-uuid'], 'RS_CLI_USAGE'],
      [
        ['gate', 'evaluate', '--data', j.dataDir, '--gate-run', '00000000-0000-4000-8000-000000000000'],
        'RS_NOT_FOUND',
      ],
      [['scenario', 'validate', bad], 'RS_SCENARIO_UNSAFE_CONSTRUCT'],
      [['scenario', 'validate', join(tmp.dir, 'missing.yaml')], 'RS_CLI_USAGE'],
      [gateRunArgs(j), 'RS_LAUNCHER_UNAVAILABLE'],
      [gateRunArgs({ ...j, artifactDigest: d('wrong-artifact') }, ['--plan-only']), 'RS_IDENTITY_MISMATCH'],
      [['project', 'create', '--name', 'no data dir'], 'RS_CLI_USAGE'],
    ];
    for (const [args, code] of cases) {
      const r = await cli(args, `config:${code}`, { env: { ...process.env, ROUTESPEC_DATA_DIR: undefined } });
      expect(r.exitCode, `${args.join(' ')} -> ${r.stdout}`).toBe(EXIT.CONFIG);
      expect((r.json?.['error'] as { code: string }).code, args.join(' ')).toBe(code);
      expect(r.stderr).toMatch(/^routespec: /m);
    }
  });

  it('5: internal error or corrupted state', async () => {
    const data = join(tmp.dir, 'corrupt');
    const j = setupJournal(data, {
      scenarios: ['happy-path'],
      build: 'reconciling-client',
      label: 't046-corrupt',
    });
    writeFileSync(join(data, 'journal.db'), Buffer.alloc(8192, 0x5a));
    const r = await cli(
      ['gate', 'evaluate', '--data', data, '--gate-run', '00000000-0000-4000-8000-000000000000'],
      'corrupt journal',
    );
    expect(r.exitCode).toBe(EXIT.INTERNAL);
    expect((r.json?.['error'] as { code: string }).code).toBe('RS_STORAGE_CORRUPT');
    expect(j.dataDir).toBe(data);
  });

  it('6: safety policy denials', async () => {
    const j = setupJournal(join(tmp.dir, 'policy'), {
      scenarios: ['happy-path'],
      build: 'reconciling-client',
      label: 't046-policy',
    });
    const project = j.projectId;
    const cases: Array<[string[], string]> = [
      [
        gateRunArgs(j, ['--plan-only']).map((a) => (a === 'simulate' ? 'live-dry' : a)),
        'RS_MODE_POLICY_DENIED',
      ],
      [['probe', 'dry', '--revision', j.integrationRevisionId], 'RS_MODE_POLICY_DENIED'],
      [
        [
          'gate',
          'create',
          '--data',
          j.dataDir,
          '--project',
          project,
          '--name',
          'x',
          '--corpus',
          j.corpusRevisionId,
          '--enforcement',
          'blocking',
        ],
        'RS_ENFORCEMENT_CLAIM_REJECTED',
      ],
      [
        [
          'gate',
          'create',
          '--data',
          j.dataDir,
          '--project',
          project,
          '--name',
          'x',
          '--corpus',
          j.corpusRevisionId,
          '--enforcement',
          'REQUIRED_CHECK_VERIFIED',
        ],
        'RS_ENFORCEMENT_CLAIM_REJECTED',
      ],
      [
        [
          'gate',
          'create',
          '--data',
          j.dataDir,
          '--project',
          project,
          '--name',
          'x',
          '--corpus',
          j.corpusRevisionId,
          '--branch-protection',
          'protection.json',
        ],
        'RS_ENFORCEMENT_CLAIM_REJECTED',
      ],
      [[...gateRunArgs(j, ['--plan-only', '--required-check-verified'])], 'RS_ENFORCEMENT_CLAIM_REJECTED'],
    ];
    for (const [args, code] of cases) {
      const r = await cli(args, `policy:${code}`);
      expect(r.exitCode, `${args.join(' ')} -> ${r.stdout}`).toBe(EXIT.POLICY_DENIED);
      expect((r.json?.['error'] as { code: string }).code).toBe(code);
    }
    // Every denied request was refused before any gate run existed.
    const s = RouteSpecStore.open({ path: join(j.dataDir, 'journal.db') });
    try {
      expect(s.countRows('gate_runs')).toBe(0);
    } finally {
      s.close();
    }
  });

  it('every error code maps to exactly one documented exit class, and every class was observed', () => {
    for (const code of ERROR_CODES)
      expect([EXIT.CONFIG, EXIT.INTERNAL, EXIT.POLICY_DENIED]).toContain(ERROR_EXIT_CODES[code]);
    for (const code of [0, 2, 3, 4, 5, 6]) expect(seen.has(code), `exit ${code} observed`).toBe(true);
    expect([...seen.keys()].every((k) => [0, 2, 3, 4, 5, 6].includes(k))).toBe(true);
  });

  it('the reviewed launcher relays a reconciliation-only token after an unknown outcome', async () => {
    const j = setupJournal(join(tmp.dir, 'relay'), {
      scenarios: ['accepted-then-lost-response'],
      build: 'reconciling-client',
      label: 't046-relay',
    });
    const purposes: string[] = [];
    const r = await runWithLauncher({
      args: gateRunArgs(j),
      onCase: async (handoff, control) => {
        purposes.push(handoff.credentials.purpose);
        const subject = await Subject.launch('reconciling-client');
        control.onCredentials((c) => {
          purposes.push(c.purpose);
          subject.push(c);
        });
        try {
          await subject.send({
            type: 'attach',
            origin: handoff.proxyOrigin,
            credentials: handoff.credentials,
          });
          await subject.send({
            type: 'run',
            request: { logicalJob: 'order-1', quote: quoteBody(), txHash: 'tx-1' },
          });
        } finally {
          await subject.close();
        }
        return 'INPUT_CLOSED';
      },
    });
    assertStreams(r, 'launcher relay');
    expect(r.exitCode).toBe(EXIT.PASS);
    expect(purposes).toEqual(['EXECUTION', 'RECONCILIATION_ONLY']);
  });
});
