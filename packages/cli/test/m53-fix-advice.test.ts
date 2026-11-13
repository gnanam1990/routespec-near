/**
 * M53 — on FAIL or REVIEW the gate report links the violated invariant to a concrete code
 * pattern, with the SDK usage found and a suggested diff against it.
 *
 * Real product surfaces only: the `routespec` CLI through the reviewed launcher, separately
 * launched subject processes on the pinned official SDK, and the kernel over the journal.
 * Nothing is seeded. Each suggested diff is applied with `git apply` (independently of the
 * rewriter) to make a new build, and that build is gated again: the verdict of the patched build
 * comes from a fresh real gate run, not from the advice.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixAdvice } from '@routespec/fix-patterns';
import type { GateReport } from '@routespec/runner';
import { SLOW_COMMIT_ANSWER_SOURCE } from './support/slow-commit-answer.ts';
import {
  runCliProcess,
  runGateWithSubjects,
  setupJournal,
  subjectScript,
  tempDir,
  type SubjectBuild,
} from './support/product.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

let tmp: ReturnType<typeof tempDir>;
const patchedFiles: string[] = [];

beforeAll(() => {
  tmp = tempDir('routespec-m53-');
});
afterAll(() => {
  for (const f of patchedFiles) rmSync(f, { force: true });
  tmp?.cleanup();
});

function linesOf(text: string, needle: string): number[] {
  return text.split('\n').flatMap((l, i) => (l.includes(needle) ? [i + 1] : []));
}

/** Apply the advice diff with `git apply` and install the result as build `m53-patched-<name>`. */
function installPatched(advice: FixAdvice, from: SubjectBuild): SubjectBuild {
  const diff = advice.diff?.unified ?? '';
  expect(diff.length).toBeGreaterThan(0);
  const path = advice.source?.path as string;
  const work = mkdtempSync(join(tmp.dir, 'apply-'));
  mkdirSync(join(work, dirname(path)), { recursive: true });
  writeFileSync(join(work, path), readFileSync(subjectScript(from)));
  writeFileSync(join(work, 'fix.diff'), diff);
  execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', 'fix.diff'], { cwd: work, stdio: 'pipe' });
  const build = `m53-patched-${from}` as SubjectBuild;
  const target = subjectScript(build);
  writeFileSync(target, readFileSync(join(work, path)));
  patchedFiles.push(target);
  return build;
}

async function gate(
  label: string,
  build: SubjectBuild,
  scenarios: string[],
  requiredInvariants?: string[],
): Promise<{
  exitCode: number | null;
  report: GateReport;
  advice: FixAdvice;
  files: { fix: string; md: string; sarif: string };
}> {
  const dir = join(tmp.dir, label);
  const j = setupJournal(dir, {
    scenarios,
    build,
    label,
    ...(requiredInvariants ? { requiredInvariants } : {}),
  });
  const files = {
    fix: join(dir, 'fix.json'),
    md: join(dir, 'fix.md'),
    sarif: join(dir, 'gate.sarif'),
  };
  const r = await runGateWithSubjects(j, {
    extraArgs: [
      '--fix-out',
      files.fix,
      '--fix-md',
      files.md,
      '--sarif',
      files.sarif,
      '--source',
      relative(process.cwd(), subjectScript(build)),
    ],
  });
  const report = r.json?.['report'] as GateReport;
  const advice = JSON.parse(readFileSync(files.fix, 'utf8')) as FixAdvice;
  expect(r.json?.['fixAdvice']).toEqual(advice);
  return { exitCode: r.exitCode, report, advice, files };
}

describe('M53 — fix patterns on the gate report', () => {
  it('the CLI copy of the slow-commit scenario is the delivery scenario', () => {
    const delivery = readFileSync(join(ROOT, 'packages/delivery/src/scenarios.ts'), 'utf8');
    const compiled = SLOW_COMMIT_ANSWER_SOURCE.replace('${SLOW_COMMIT_ANSWER}', 'slow-commit-answer');
    expect(delivery.replace('${SLOW_COMMIT_ANSWER}', 'slow-commit-answer')).toContain(compiled);
  });

  it('hedging build FAILs INV-03; the advice links "no second order", finds the hedge, and the patched build PASSes', async () => {
    const failing = await gate('m53-hedging', 'hedging-client', ['slow-commit-answer']);
    expect(failing.exitCode).toBe(2);
    expect(failing.report.decision).toBe('FAIL');
    const { advice } = failing;
    expect(advice.advisory).toBe(true);
    expect(advice.gate).toMatchObject({ gateRunId: failing.report.gateRunId, decision: 'FAIL' });
    expect(advice.unreproduced).toEqual([]);
    const inv03 = advice.links.find((l) => l.invariantId === 'INV-03');
    expect(inv03).toMatchObject({
      verdict: 'FAIL',
      explanationCode: 'INV03_SECOND_MUTATION_UNDER_UNCERTAINTY',
      patternIds: ['NO_SECOND_ORDER_WHILE_UNANSWERED', 'RECONCILE_THROUGH_STATUS', 'IDEMPOTENCY_KEY'],
    });
    const text = readFileSync(subjectScript('hedging-client'), 'utf8');
    expect(advice.source?.path).toBe('packages/cli/test/support/subject/hedging-client.ts');
    expect(advice.source?.matchesArtifactDigest).toBe(false);
    const quotes = linesOf(text, '.getQuote(');
    const commits = linesOf(text, '.submitDepositTx(');
    const noSecond = advice.patterns.find((p) => p.id === 'NO_SECOND_ORDER_WHILE_UNANSWERED');
    expect(noSecond?.foundIn.map((f) => [f.shape, f.line])).toEqual(
      expect.arrayContaining([
        ['REPEATED_QUOTE_CALL', quotes[1]],
        ['REPEATED_COMMIT_CALL', commits[1]],
        ['ORDER_KEY_CHANGED', linesOf(text, 'setLogicalJob(')[0]],
      ]),
    );
    expect(advice.diff?.rewrites.map((r) => r.rule)).toEqual(['SINGLE_ORDER']);
    expect(advice.diff?.patchedParseErrors).toBe(0);

    // SARIF now carries real source locations, and only those.
    const sarif = JSON.parse(readFileSync(failing.files.sarif, 'utf8')) as {
      runs: Array<{
        results: Array<{
          ruleId: string;
          locations: Array<{
            physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } };
          }>;
        }>;
      }>;
    };
    const results = sarif.runs[0]?.results ?? [];
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      const loc = r.locations[0]?.physicalLocation;
      expect(loc?.artifactLocation.uri).toBe(advice.source?.path);
      expect(r.ruleId).toMatch(/^routespec\.fix\//);
      expect(text.split('\n')[(loc?.region.startLine ?? 0) - 1]?.trim().length).toBeGreaterThan(0);
    }
    const md = readFileSync(failing.files.md, 'utf8');
    expect(md).toContain('INV-03 FAIL');
    expect(md).toContain('## No second order while the first is unanswered');
    expect(md).toContain('```diff');
    for (const out of [md, readFileSync(failing.files.fix, 'utf8')]) {
      expect(out).not.toContain(ROOT.replace(/[\\/]$/, ''));
      expect(out).not.toContain(tmp.dir);
    }

    // slow-commit-answer only progresses after a second order, so a client that never places one
    // (the reconciling build included) cannot reach a terminal status there. The patched build is
    // gated on the variant in which the first order settles.
    const patched = installPatched(advice, 'hedging-client');
    const fixed = await gate('m53-hedging-patched', patched, ['slow-commit-settles']);
    expect(fixed.report.decision).toBe('PASS');
    expect(fixed.exitCode).toBe(0);
    expect(fixed.advice.links).toEqual([]);
    expect(fixed.advice.patterns).toEqual([]);
    expect(fixed.advice.diff).toBeNull();
    // The unpatched build does not PASS on the variant either: its hedge quote is refused there
    // and the case aborts (REVIEW). An aborted case has no invariant result, so no pattern links.
    const unpatched = await gate('m53-hedging-settles', 'hedging-client', ['slow-commit-settles']);
    expect(unpatched.report.decision).not.toBe('PASS');
    expect(unpatched.report.cases[0]?.findings).toContain('CASE_ABORTED');
    expect(unpatched.advice.links).toEqual([]);
    expect(unpatched.advice.unreproduced).toEqual([
      { ordinal: 0, caseRunId: unpatched.report.cases[0]?.caseRunId, reason: 'NO_CASE_RESULT' },
    ]);
  }, 180_000);

  it('naive build is REVIEW on INV-03; the advice links "reconcile through status" and the patched build PASSes', async () => {
    const review = await gate('m53-naive', 'naive-client', ['accepted-then-lost-response']);
    expect(review.exitCode).toBe(3);
    expect(review.report.decision).toBe('REVIEW');
    const inv03 = review.advice.links.find((l) => l.invariantId === 'INV-03');
    expect(inv03).toMatchObject({
      verdict: 'REVIEW',
      explanationCode: 'INV03_RECONCILIATION_INCOMPLETE',
      patternIds: ['RECONCILE_THROUGH_STATUS'],
    });
    const text = readFileSync(subjectScript('naive-client'), 'utf8');
    const reconcile = review.advice.patterns.find((p) => p.id === 'RECONCILE_THROUGH_STATUS');
    expect(reconcile?.foundIn.map((f) => [f.shape, f.line])).toEqual(
      expect.arrayContaining([
        ['COMMIT_RETRIED_IN_LOOP', linesOf(text, '.submitDepositTx(')[0]],
        ['STATUS_NOT_READ_AFTER_COMMIT_ERROR', linesOf(text, '} catch')[0]],
      ]),
    );
    expect(review.advice.diff?.rewrites.map((r) => r.rule)).toEqual(['RECONCILE_ON_UNKNOWN_COMMIT']);

    const patched = installPatched(review.advice, 'naive-client');
    const fixed = await gate('m53-naive-patched', patched, ['accepted-then-lost-response']);
    expect(fixed.report.decision).toBe('PASS');
    expect(fixed.exitCode).toBe(0);
    expect(fixed.advice.links).toEqual([]);
  }, 180_000);

  it('gate show and gate evaluate give the same advice for a stored evaluation; fix patterns/show list the catalogue', async () => {
    const dir = join(tmp.dir, 'm53-naive');
    const fix = JSON.parse(readFileSync(join(dir, 'fix.json'), 'utf8')) as FixAdvice;
    const source = relative(process.cwd(), subjectScript('naive-client'));
    const show = await runCliProcess([
      'gate',
      'show',
      '--data',
      dir,
      '--gate-evaluation',
      fix.gate?.gateEvaluationId as string,
      '--source',
      source,
    ]);
    expect(show.exitCode).toBe(3);
    expect((show.json?.['fixAdvice'] as FixAdvice).digest).toBe(fix.digest);
    const evaluate = await runCliProcess([
      'gate',
      'evaluate',
      '--data',
      dir,
      '--gate-run',
      fix.gate?.gateRunId as string,
      '--source',
      source,
    ]);
    expect(evaluate.exitCode).toBe(3);
    expect((evaluate.json?.['fixAdvice'] as FixAdvice).digest).toBe(fix.digest);
    const plain = await runCliProcess([
      'gate',
      'show',
      '--data',
      dir,
      '--gate-evaluation',
      fix.gate?.gateEvaluationId as string,
    ]);
    expect(plain.json?.['fixAdvice']).toBeUndefined();

    const list = await runCliProcess(['fix', 'patterns']);
    expect(list.exitCode).toBe(0);
    expect((list.json?.['patterns'] as Array<{ id: string }>).map((p) => p.id)).toEqual([
      'RECONCILE_THROUGH_STATUS',
      'IDEMPOTENCY_KEY',
      'NO_SECOND_ORDER_WHILE_UNANSWERED',
    ]);
    const one = await runCliProcess(['fix', 'show', '--pattern', 'idempotency-key']);
    expect(one.exitCode).toBe(0);
    expect((one.json?.['pattern'] as { title: string }).title).toBe('One idempotency key per order');
    expect(one.json?.['codes']).toContain('INV07_EVIDENCE_REUSED');
    const unknown = await runCliProcess(['fix', 'show', '--pattern', 'nope']);
    expect(unknown.exitCode).toBe(4);
  });
});
