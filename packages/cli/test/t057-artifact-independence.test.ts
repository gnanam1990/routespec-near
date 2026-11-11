/**
 * T-057 — Gate decision is independent of artifact readiness. Covers FR-13, FR-18, NFR-05.
 *
 * Four real gate evaluations (PASS, FAIL, REVIEW, NOT_RUN) are produced through the CLI. For
 * each, export privacy-block, write failure, and write success are forced independently. The
 * decision, decision digest, and evaluation identity never change while `artifactReady` moves
 * false -> true -> false -> true; re-evaluating after any export returns the same evaluation;
 * and the bundle records readiness outside itself, so artifact generation cannot feed back
 * into the gate.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTar } from '@routespec/runner';
import {
  gateRunArgs,
  runCliProcess,
  runGateWithSubjects,
  setupJournal,
  tempDir,
  type Journal,
} from './support/product.ts';

interface Gate {
  readonly label: string;
  readonly expected: string;
  readonly journal: Journal;
  readonly dir: ReturnType<typeof tempDir>;
  gateRunId: string;
  gateEvaluationId: string;
  decisionDigest: string;
}

const gates: Gate[] = [];

async function make(
  label: string,
  expected: string,
  scenarios: string[],
  build: 'reconciling-client' | 'naive-client',
  planOnly = false,
): Promise<Gate> {
  const dir = tempDir();
  const journal = setupJournal(dir.dir, { scenarios, build, label });
  const r = planOnly
    ? await runCliProcess(gateRunArgs(journal, ['--plan-only']))
    : await runGateWithSubjects(journal);
  const rep = r.json?.['report'] as {
    decision: string;
    gateRunId: string;
    gateEvaluationId: string;
    decisionDigest: string;
  };
  expect(rep.decision, label).toBe(expected);
  return {
    label,
    expected,
    journal,
    dir,
    gateRunId: rep.gateRunId,
    gateEvaluationId: rep.gateEvaluationId,
    decisionDigest: rep.decisionDigest,
  };
}

beforeAll(async () => {
  gates.push(
    await make('t057-pass', 'PASS', ['happy-path'], 'reconciling-client'),
    await make('t057-fail', 'FAIL', ['refund-shortfall'], 'reconciling-client'),
    await make('t057-review', 'REVIEW', ['accepted-then-lost-response'], 'naive-client'),
    await make('t057-notrun', 'NOT_RUN', ['happy-path'], 'reconciling-client', true),
  );
});

afterAll(() => {
  for (const g of gates) g.dir.cleanup();
});

async function evaluate(g: Gate): Promise<{
  decision: string;
  decisionDigest: string;
  gateEvaluationId: string;
  artifact: { ready: boolean };
}> {
  const r = await runCliProcess([
    'gate',
    'show',
    '--data',
    g.journal.dataDir,
    '--gate-evaluation',
    g.gateEvaluationId,
  ]);
  return r.json?.['report'] as {
    decision: string;
    decisionDigest: string;
    gateEvaluationId: string;
    artifact: { ready: boolean };
  };
}

describe('T-057 — Gate decision is independent of artifact readiness', () => {
  it('privacy block, write failure, and write success never change any of the four decisions', async () => {
    for (const g of gates) {
      const data = g.journal.dataDir;
      const start = await evaluate(g);
      expect(start).toMatchObject({
        decision: g.expected,
        decisionDigest: g.decisionDigest,
        artifact: { ready: false },
      });

      // Forced privacy block: an attachment carrying a private key.
      const secret = join(data, 'key.txt');
      // Assembled at run time so the repository holds no key-shaped block.
      writeFileSync(secret, `${['-----BEGIN ', 'PRIVATE KEY-----'].join('')}\nMIIBt057canary\n`);
      const blocked = await runCliProcess([
        'export',
        'plan',
        '--data',
        data,
        '--gate-evaluation',
        g.gateEvaluationId,
        '--attach',
        secret,
      ]);
      expect(blocked.exitCode, g.label).toBe(6);
      expect(await evaluate(g), g.label).toMatchObject({
        decision: g.expected,
        decisionDigest: g.decisionDigest,
        artifact: { ready: false },
      });

      // Clean plan; forced write failure (the chosen directory does not exist).
      const plan = await runCliProcess([
        'export',
        'plan',
        '--data',
        data,
        '--gate-evaluation',
        g.gateEvaluationId,
      ]);
      expect(plan.exitCode, g.label).toBe(0);
      const exportId = String(plan.json?.['exportId']);
      const confirm = String(plan.json?.['confirm']);
      const fail1 = await runCliProcess([
        'export',
        'write',
        '--data',
        data,
        '--export',
        exportId,
        '--out',
        join(data, 'missing', 'b.tar'),
        '--confirm',
        confirm,
      ]);
      expect(fail1.exitCode, g.label).toBe(4);
      expect(await evaluate(g), g.label).toMatchObject({ decision: g.expected, artifact: { ready: false } });

      // Success.
      const out = join(data, 'bundle.tar');
      const ok = await runCliProcess([
        'export',
        'write',
        '--data',
        data,
        '--export',
        exportId,
        '--out',
        out,
        '--confirm',
        confirm,
      ]);
      expect(ok.exitCode, `${g.label} ${ok.stdout}`).toBe(0);
      expect(ok.json).toMatchObject({ artifactReady: true, decisionUnchanged: true });
      expect(await evaluate(g), g.label).toMatchObject({
        decision: g.expected,
        decisionDigest: g.decisionDigest,
        artifact: { ready: true },
      });

      // A later failed rewrite (overwrite refused without confirmation, then an unwritable target).
      const refused = await runCliProcess([
        'export',
        'write',
        '--data',
        data,
        '--export',
        exportId,
        '--out',
        out,
        '--confirm',
        confirm,
      ]);
      expect(refused.exitCode, g.label).toBe(6);
      expect((refused.json?.['error'] as { code: string }).code).toBe('RS_EXPORT_OVERWRITE_DENIED');
      const fail2 = await runCliProcess([
        'export',
        'write',
        '--data',
        data,
        '--export',
        exportId,
        '--out',
        join(data, 'nope', 'c.tar'),
        '--confirm',
        confirm,
      ]);
      expect(fail2.exitCode).toBe(4);
      expect(await evaluate(g), g.label).toMatchObject({
        decision: g.expected,
        decisionDigest: g.decisionDigest,
        artifact: { ready: false },
      });

      // Explicit overwrite confirmation succeeds again.
      const again = await runCliProcess([
        'export',
        'write',
        '--data',
        data,
        '--export',
        exportId,
        '--out',
        out,
        '--confirm',
        confirm,
        '--overwrite',
      ]);
      expect(again.exitCode, g.label).toBe(0);
      expect(again.json).toMatchObject({ overwrote: true, artifactReady: true });
      const final = await evaluate(g);
      expect(final).toMatchObject({
        decision: g.expected,
        decisionDigest: g.decisionDigest,
        gateEvaluationId: g.gateEvaluationId,
        artifact: { ready: true },
      });

      // Re-evaluating the gate run after exports returns the same immutable evaluation.
      const re = await runCliProcess(['gate', 'evaluate', '--data', data, '--gate-run', g.gateRunId]);
      expect(re.json?.['created'], g.label).toBe(false);
      expect((re.json?.['report'] as { decisionDigest: string }).decisionDigest).toBe(g.decisionDigest);

      // The bundle does not depend on its own readiness.
      const manifest = JSON.parse(
        readTar(readFileSync(out))
          .find((e) => e.path === 'manifest.json')!
          .content.toString('utf8'),
      ) as Record<string, unknown>;
      expect(manifest['artifactReadiness']).toBe('RECORDED_OUTSIDE_BUNDLE');
      expect(manifest['decisionDigest']).toBe(g.decisionDigest);
    }
  });

  it('a wrong confirmation digest is a policy denial and leaves readiness unchanged', async () => {
    const g = gates[0]!;
    const plan = await runCliProcess([
      'export',
      'plan',
      '--data',
      g.journal.dataDir,
      '--gate-evaluation',
      g.gateEvaluationId,
    ]);
    const r = await runCliProcess([
      'export',
      'write',
      '--data',
      g.journal.dataDir,
      '--export',
      String(plan.json?.['exportId']),
      '--out',
      join(g.journal.dataDir, 'x.tar'),
      '--confirm',
      `sha256:${'1'.repeat(64)}`,
    ]);
    expect(r.exitCode).toBe(6);
    expect((r.json?.['error'] as { code: string }).code).toBe('RS_EXPORT_CONFIRMATION_REQUIRED');
    expect((await evaluate(g)).decisionDigest).toBe(g.decisionDigest);
  });
});
