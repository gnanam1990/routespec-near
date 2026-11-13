/**
 * M47 test support: a real evidence bundle for the certificate commands. A gate is run through
 * the reviewed launcher with installed subject processes, then exported with `export plan` and
 * `export write`. Nothing is seeded: the decision is whatever the gate evaluated.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImportJournal, RouteSpecStore } from '@routespec/store';
import { runCliProcess, runGateWithSubjects, setupJournal, type Journal } from './product.ts';

export interface CertifiableBundle {
  readonly journal: Journal;
  readonly dataDir: string;
  readonly bundlePath: string;
  readonly bundleDigest: string;
  readonly decision: string;
  readonly gateExitCode: number | null;
  readonly corpusDigest: string;
  readonly commit: string;
}

export async function makeBundle(
  dataDir: string,
  options: { scenarios: readonly string[]; label: string },
): Promise<CertifiableBundle> {
  const journal = setupJournal(dataDir, {
    scenarios: options.scenarios,
    build: 'reconciling-client',
    label: options.label,
  });
  const run = await runGateWithSubjects(journal);
  const report = run.json?.['report'] as { gateEvaluationId: string; decision: string };
  const plan = await runCliProcess([
    'export',
    'plan',
    '--data',
    dataDir,
    '--gate-evaluation',
    report.gateEvaluationId,
  ]);
  if (plan.exitCode !== 0) throw new Error(`export plan failed: ${plan.stderr}`);
  const bundlePath = join(dataDir, `evidence-${options.label}.tar`);
  const written = await runCliProcess([
    'export',
    'write',
    '--data',
    dataDir,
    '--export',
    String(plan.json?.['exportId']),
    '--out',
    bundlePath,
    '--confirm',
    String(plan.json?.['confirm']),
  ]);
  if (written.exitCode !== 0) throw new Error(`export write failed: ${written.stderr}`);
  const store = RouteSpecStore.open({ path: join(dataDir, 'journal.db') });
  let corpusDigest: string;
  try {
    corpusDigest = new ImportJournal(store).getCorpus(journal.corpusRevisionId).corpusDigest;
  } finally {
    store.close();
  }
  return {
    journal,
    dataDir,
    bundlePath,
    bundleDigest: `sha256:${createHash('sha256').update(readFileSync(bundlePath)).digest('hex')}`,
    decision: report.decision,
    gateExitCode: run.exitCode,
    corpusDigest,
    commit: createHash('sha1').update(journal.build).digest('hex'),
  };
}
