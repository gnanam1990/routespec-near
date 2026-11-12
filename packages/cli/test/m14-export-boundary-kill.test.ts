/**
 * M14 — termination at the export boundary (RP-04, with T-057 and T-053).
 *
 * A separately launched writer (real runner export code) is killed abruptly inside the journal
 * transaction that records an export write: the bundle file has been published, the journal
 * commit has not happened. After restart the decision and its digest are unchanged, artifact
 * readiness stays false (the write was never recorded), the unrecorded file is not silently
 * replaced (a retry needs the distinct overwrite confirmation), and a confirmed retry records
 * the write and a bundle that verifies in a clean location.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { RouteSpecStore } from '@routespec/store';
import { runCliProcess, runGateWithSubjects, setupJournal, tempDir } from './support/product.ts';

const CHILD = fileURLToPath(new URL('./support/export-child.ts', import.meta.url));
const t = tempDir('routespec-m14-export-');
afterAll(() => t.cleanup());

type Ev = Record<string, unknown>;

function writer(
  args: Record<string, unknown>,
): Promise<{ code: number | null; signal: string | null; events: Ev[] }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', CHILD, JSON.stringify(args)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('close', (code, signal) =>
      resolve({
        code,
        signal,
        events: out
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Ev),
      }),
    );
  });
}

function exportState(dataDir: string, exportId: string): { ready: number; digest: unknown; writes: Ev[] } {
  const store = RouteSpecStore.open({ path: join(dataDir, 'journal.db') });
  try {
    return store.journal.read((db) => {
      const m = db.prepare('SELECT * FROM artifact_manifests WHERE export_id = ?').get(exportId) as Ev;
      const writes = db
        .prepare(
          'SELECT outcome, failure_code FROM export_writes WHERE export_id = ? ORDER BY created_at_ms, rowid',
        )
        .all(exportId) as Ev[];
      return { ready: Number(m['artifact_ready']), digest: m['output_digest'], writes };
    });
  } finally {
    store.close();
  }
}

async function show(dataDir: string, gateEvaluationId: string): Promise<Ev> {
  const r = await runCliProcess(['gate', 'show', '--data', dataDir, '--gate-evaluation', gateEvaluationId]);
  return (r.json?.['report'] ?? {}) as Ev;
}

describe('M14 — termination at the export boundary (RP-04)', () => {
  it('a writer killed inside the export-write transaction leaves the decision unchanged and readiness false', async () => {
    const j = setupJournal(join(t.dir, 'journal'), {
      scenarios: ['happy-path'],
      build: 'reconciling-client',
      label: 'm14-export-kill',
    });
    const gate = await runGateWithSubjects(j);
    const report = gate.json?.['report'] as {
      decision: string;
      gateEvaluationId: string;
      decisionDigest: string;
    };
    expect(report.decision).toBe('PASS');
    const out = join(t.dir, 'out');
    mkdirSync(out, { recursive: true });
    const bundle = join(out, 'release.tar');

    const killed = await writer({
      dataDir: j.dataDir,
      gateEvaluationId: report.gateEvaluationId,
      outPath: bundle,
      killAt: 'export.write',
    });
    expect(killed.events.some((e) => e['event'] === 'KILLING')).toBe(true);
    expect(killed.events.some((e) => e['event'] === 'WRITTEN')).toBe(false);
    expect(killed.code === 0 && killed.signal === null).toBe(false);
    const exportId = String(killed.events.find((e) => e['event'] === 'PLANNED')?.['exportId']);

    // Restart: the uncommitted write left no record; the published file is unrecorded.
    const after = exportState(j.dataDir, exportId);
    expect(after).toMatchObject({ ready: 0, digest: null, writes: [] });
    expect(existsSync(bundle)).toBe(true);
    const shown = await show(j.dataDir, report.gateEvaluationId);
    expect(shown['decision']).toBe('PASS');
    expect(shown['decisionDigest']).toBe(report.decisionDigest);

    // A retry never silently replaces the unrecorded file.
    const refused = await writer({
      dataDir: j.dataDir,
      gateEvaluationId: report.gateEvaluationId,
      outPath: bundle,
      killAt: 'none',
    });
    expect(refused.code).not.toBe(0);
    expect(refused.events.some((e) => e['event'] === 'WRITTEN')).toBe(false);
    const refusedState = exportState(j.dataDir, exportId);
    expect(refusedState.ready).toBe(0);
    // Refused before anything is written: nothing to record.
    expect(refusedState.writes).toEqual([]);

    // A confirmed overwrite records the write; the decision is still the same evaluation.
    const confirmedRetry = await runCliProcess([
      'export',
      'write',
      '--data',
      j.dataDir,
      '--export',
      exportId,
      '--out',
      bundle,
      '--confirm',
      String(killed.events.find((e) => e['event'] === 'PLANNED')?.['planDigest']),
      '--overwrite',
    ]);
    expect(confirmedRetry.exitCode, confirmedRetry.stderr).toBe(0);
    const done = exportState(j.dataDir, exportId);
    expect(done.ready).toBe(1);
    expect(done.writes.map((w) => w['outcome'])).toEqual(['WRITTEN']);
    const final = await show(j.dataDir, report.gateEvaluationId);
    expect(final['decisionDigest']).toBe(report.decisionDigest);

    const verifyHome = join(t.dir, 'verify-home');
    mkdirSync(verifyHome, { recursive: true });
    const verify = await runCliProcess(
      ['export', 'verify', '--bundle', bundle, '--extract-to', join(t.dir, 'extracted')],
      {
        cwd: t.dir,
        env: { ...process.env, HOME: verifyHome, USERPROFILE: verifyHome, ROUTESPEC_DATA_DIR: '' },
      },
    );
    expect(verify.exitCode).toBe(0);
    expect(verify.json?.['verified']).toBe(true);
  });
});
