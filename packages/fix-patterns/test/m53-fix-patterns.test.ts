/**
 * M53 — fix patterns, SDK usage found, and the suggested diff, over the real subject builds kept
 * in this repository (the naive, hedging, impatient, baseline builds and their fixed
 * counterparts). Expected line numbers are found by plain text search of those files, not
 * hard-coded; the diff is applied with `git apply`, independently of the rewriter.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { EXPLANATIONS } from '@routespec/kernel';
import {
  CODE_PATTERNS,
  FIX_ADVICE_SCHEMA,
  buildFixAdvice,
  fixAdviceSarifFindings,
  getFixPattern,
  listFixPatterns,
  parseErrorCount,
  parseSource,
  patternsForCode,
  renderFixAdviceMarkdown,
  scanSdkUsage,
  unifiedDiff,
  type InvariantViolation,
} from '../src/index.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SUBJECTS = {
  naive: 'packages/cli/test/support/subject/naive-client.ts',
  reconciling: 'packages/cli/test/support/subject/reconciling-client.ts',
  impatient: 'packages/cli/test/support/subject/impatient-client.ts',
  baseline: 'packages/regressions/test/support/subject/baseline-client.ts',
  corrected: 'packages/regressions/test/support/subject/corrected-client.ts',
  hedging: 'packages/regressions/test/support/subject/hedging-client.ts',
} as const;

function source(name: keyof typeof SUBJECTS): { path: string; text: string } {
  const path = SUBJECTS[name];
  return { path, text: readFileSync(join(ROOT, path), 'utf8') };
}

/** 1-based line numbers of every line containing `needle`. */
function linesOf(text: string, needle: string): number[] {
  return text.split('\n').flatMap((l, i) => (l.includes(needle) ? [i + 1] : []));
}

function violation(invariantId: string, explanationCode: string, verdict = 'FAIL'): InvariantViolation {
  return {
    ordinal: 0,
    caseRunId: 'case-1',
    required: true,
    invariantId,
    verdict,
    explanationCode,
    remediationCode: null,
  };
}

const tmp = mkdtempSync(join(tmpdir(), 'routespec-m53-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Apply a unified diff with `git apply` to a copy of the file; return the patched text. */
function gitApply(path: string, original: string, diff: string): string {
  const dir = mkdtempSync(join(tmp, 'apply-'));
  mkdirSync(join(dir, dirname(path)), { recursive: true });
  writeFileSync(join(dir, path), original);
  writeFileSync(join(dir, 'fix.diff'), diff);
  execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', '--check', 'fix.diff'], {
    cwd: dir,
    stdio: 'pipe',
  });
  execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', 'fix.diff'], { cwd: dir, stdio: 'pipe' });
  return readFileSync(join(dir, path), 'utf8');
}

describe('M53 — the closed fix-pattern catalogue', () => {
  it('names the three patterns with a rule, steps, and an example', () => {
    expect(listFixPatterns().map((p) => p.id)).toEqual([
      'RECONCILE_THROUGH_STATUS',
      'IDEMPOTENCY_KEY',
      'NO_SECOND_ORDER_WHILE_UNANSWERED',
    ]);
    for (const p of listFixPatterns()) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.rule.length).toBeGreaterThan(0);
      expect(p.steps.length).toBeGreaterThan(0);
      expect(parseErrorCount(parseSource('example.ts', p.example))).toBe(0);
    }
    expect(getFixPattern('IDEMPOTENCY_KEY')?.title).toBe('One idempotency key per order');
    expect(getFixPattern('toString')).toBeNull();
  });

  it('links only real kernel FAIL/REVIEW codes, and no PASS code', () => {
    for (const code of Object.keys(CODE_PATTERNS)) {
      const spec = (EXPLANATIONS as Record<string, { verdict: string }>)[code];
      expect(spec, code).toBeDefined();
      expect(['FAIL', 'REVIEW']).toContain(spec?.verdict);
    }
    for (const [code, spec] of Object.entries(EXPLANATIONS) as Array<[string, { verdict: string }]>) {
      if (spec.verdict === 'PASS') expect(patternsForCode(code), code).toEqual([]);
    }
    expect(patternsForCode('INV03_SECOND_MUTATION_UNDER_UNCERTAINTY').map((p) => p.id)).toEqual([
      'NO_SECOND_ORDER_WHILE_UNANSWERED',
      'RECONCILE_THROUGH_STATUS',
      'IDEMPOTENCY_KEY',
    ]);
    expect(patternsForCode('INV04_DECLARED_HOOKS_ONLY')).toEqual([]);
  });
});

describe('M53 — SDK usage found in the real subject builds', () => {
  it('naive build: every SDK call at its real line; resubmission in a loop; no status on the error path', () => {
    const s = source('naive');
    const u = scanSdkUsage(s.path, s.text);
    expect(u.parseErrors).toBe(0);
    expect(u.calls.map((c) => [c.method, c.line])).toEqual([
      ['getQuote', linesOf(s.text, '.getQuote(')[0]],
      ['submitDepositTx', linesOf(s.text, '.submitDepositTx(')[0]],
      ['getExecutionStatus', linesOf(s.text, '.getExecutionStatus(')[0]],
    ]);
    expect(u.calls[1]).toMatchObject({
      receiver: 'ctx.sdk.OneClickService',
      inLoop: true,
      inTry: true,
      functionName: 'job',
    });
    const shapes = u.shapes.map((x) => [x.shape, x.line]);
    expect(shapes).toContainEqual(['COMMIT_RETRIED_IN_LOOP', linesOf(s.text, '.submitDepositTx(')[0]]);
    expect(shapes).toContainEqual(['STATUS_NOT_READ_AFTER_COMMIT_ERROR', linesOf(s.text, '} catch')[0]]);
  });

  it('hedging build: a second quote, a second deposit, and a changed order key after the first submission', () => {
    const s = source('hedging');
    const u = scanSdkUsage(s.path, s.text);
    const quotes = linesOf(s.text, '.getQuote(');
    const commits = linesOf(s.text, '.submitDepositTx(');
    expect(quotes).toHaveLength(2);
    expect(commits).toHaveLength(2);
    const shapes = u.shapes.map((x) => [x.shape, x.line]);
    expect(shapes).toContainEqual(['REPEATED_QUOTE_CALL', quotes[1]]);
    expect(shapes).toContainEqual(['REPEATED_COMMIT_CALL', commits[1]]);
    expect(shapes).toContainEqual(['ORDER_KEY_CHANGED', linesOf(s.text, 'setLogicalJob(')[0]]);
    expect(shapes).toContainEqual(['NO_STATUS_READ', commits[0]]);
  });

  it('impatient build: the status loop stops after a fixed number of reads', () => {
    const s = source('impatient');
    const u = scanSdkUsage(s.path, s.text);
    expect(u.shapes.map((x) => [x.shape, x.line])).toEqual([
      ['STATUS_POLL_BOUNDED', linesOf(s.text, 'i < PATIENCE')[0]],
    ]);
  });

  it('the fixed builds show none of the violating shapes', () => {
    for (const name of ['reconciling', 'corrected'] as const) {
      const s = source(name);
      const shapes = scanSdkUsage(s.path, s.text).shapes.map((x) => x.shape);
      expect(
        shapes.filter((x) => x !== 'STATUS_POLL_BOUNDED'),
        name,
      ).toEqual([]);
    }
  });
});

describe('M53 — fix advice and the suggested diff', () => {
  it('without a source: links and patterns only, no usage and no diff', () => {
    const a = buildFixAdvice({
      gate: null,
      violations: [violation('INV-03', 'INV03_SECOND_MUTATION_UNDER_UNCERTAINTY')],
      source: null,
    });
    expect(a.schema).toBe(FIX_ADVICE_SCHEMA);
    expect(a.advisory).toBe(true);
    expect(a.links).toHaveLength(1);
    expect(a.links[0]?.explanation).toBe(EXPLANATIONS.INV03_SECOND_MUTATION_UNDER_UNCERTAINTY.template);
    expect(a.patterns.map((p) => p.id)).toEqual([
      'NO_SECOND_ORDER_WHILE_UNANSWERED',
      'RECONCILE_THROUGH_STATUS',
      'IDEMPOTENCY_KEY',
    ]);
    expect(a.patterns.every((p) => p.foundIn.length === 0)).toBe(true);
    expect(a.source).toBeNull();
    expect(a.diff).toBeNull();
    expect(fixAdviceSarifFindings(a)).toEqual([]);
  });

  it('a code without a client pattern keeps its remediation and links no pattern', () => {
    const a = buildFixAdvice({
      gate: null,
      violations: [
        {
          ...violation('INV-04', 'INV04_DECLARED_HOOKS_ONLY', 'REVIEW'),
          remediationCode: 'CONFIGURE_INDEPENDENT_INTERCEPTOR',
        },
      ],
      source: source('naive'),
    });
    expect(a.links[0]?.patternIds).toEqual([]);
    expect(a.links[0]?.remediation).toMatch(/independent boundary interceptor/);
    expect(a.patterns).toEqual([]);
    expect(a.diff).toBeNull();
  });

  it('PASS results produce no link at all', () => {
    const a = buildFixAdvice({
      gate: null,
      violations: [violation('INV-03', 'INV03_NO_COMMIT', 'PASS')],
      source: source('reconciling'),
    });
    expect(a.links).toEqual([]);
    expect(a.patterns).toEqual([]);
    expect(a.diff).toBeNull();
    expect(renderFixAdviceMarkdown(a)).toContain('nothing to fix');
  });

  it('naive build, INV-03 reconciliation incomplete: diff removes the resubmit loop and reconciles through status', () => {
    const s = source('naive');
    const a = buildFixAdvice({
      gate: null,
      violations: [violation('INV-03', 'INV03_RECONCILIATION_INCOMPLETE', 'REVIEW')],
      source: s,
    });
    expect(a.patterns.map((p) => p.id)).toEqual(['RECONCILE_THROUGH_STATUS']);
    expect(a.patterns[0]?.foundIn.map((f) => f.shape)).toEqual([
      'COMMIT_RETRIED_IN_LOOP',
      'STATUS_NOT_READ_AFTER_COMMIT_ERROR',
    ]);
    expect(a.diff?.rewrites.map((r) => r.rule)).toEqual(['RECONCILE_ON_UNKNOWN_COMMIT']);
    expect(a.diff?.patchedParseErrors).toBe(0);
    const patched = gitApply(s.path, s.text, a.diff?.unified ?? '');
    const after = scanSdkUsage(s.path, patched);
    expect(after.parseErrors).toBe(0);
    expect(after.calls.filter((c) => c.method === 'submitDepositTx')).toHaveLength(1);
    expect(after.calls.find((c) => c.method === 'submitDepositTx')?.inLoop).toBe(false);
    expect(after.shapes.map((x) => x.shape)).not.toContain('COMMIT_RETRIED_IN_LOOP');
    expect(after.shapes.map((x) => x.shape)).not.toContain('STATUS_NOT_READ_AFTER_COMMIT_ERROR');
    expect(patched).toContain('reconcileThroughStatus(ctx.sdk.OneClickService, depositAddress)');
    expect(patched).not.toContain("'GAVE_UP'");
    expect(a.diff?.patchedSha256).toMatch(/^sha256:/);
  });

  it('hedging build, INV-03 second mutation: diff removes the second order and reconciles the first', () => {
    const s = source('hedging');
    const a = buildFixAdvice({
      gate: null,
      violations: [violation('INV-03', 'INV03_SECOND_MUTATION_UNDER_UNCERTAINTY')],
      source: s,
    });
    const found = a.patterns
      .find((p) => p.id === 'NO_SECOND_ORDER_WHILE_UNANSWERED')
      ?.foundIn.map((f) => f.shape);
    expect(found).toEqual(
      expect.arrayContaining(['REPEATED_QUOTE_CALL', 'REPEATED_COMMIT_CALL', 'ORDER_KEY_CHANGED']),
    );
    expect(a.diff?.rewrites.map((r) => r.rule)).toEqual(['SINGLE_ORDER']);
    const patched = gitApply(s.path, s.text, a.diff?.unified ?? '');
    const after = scanSdkUsage(s.path, patched);
    expect(after.parseErrors).toBe(0);
    expect(after.calls.filter((c) => c.method === 'getQuote')).toHaveLength(1);
    expect(after.calls.filter((c) => c.method === 'submitDepositTx')).toHaveLength(1);
    expect(after.shapes.map((x) => x.shape)).not.toContain('ORDER_KEY_CHANGED');
    expect(patched).not.toContain('hedgeAddress');
    expect(patched).toContain('reconcileThroughStatus(ctx.sdk.OneClickService, depositAddress)');
    const sarif = fixAdviceSarifFindings(a);
    expect(sarif.length).toBeGreaterThan(0);
    for (const f of sarif) {
      expect(f.uri).toBe(s.path);
      expect(s.text.split('\n')[f.startLine - 1]?.trim().length).toBeGreaterThan(0);
    }
  });

  it('baseline build: the resubmit loop and the unreachable give-up are removed', () => {
    const s = source('baseline');
    const a = buildFixAdvice({
      gate: null,
      violations: [violation('INV-03', 'INV03_RECONCILIATION_INCOMPLETE', 'REVIEW')],
      source: s,
    });
    const patched = gitApply(s.path, s.text, a.diff?.unified ?? '');
    expect(scanSdkUsage(s.path, patched).shapes.map((x) => x.shape)).not.toContain('COMMIT_RETRIED_IN_LOOP');
    expect(patched).not.toContain("result: 'GAVE_UP'");
    expect(parseErrorCount(parseSource(s.path, patched))).toBe(0);
  });

  it('impatient build, INV-06 terminal not reached: the read-count bound is removed', () => {
    const s = source('impatient');
    const a = buildFixAdvice({
      gate: null,
      violations: [violation('INV-06', 'INV06_TERMINAL_NOT_REACHED', 'REVIEW')],
      source: s,
    });
    expect(a.diff?.rewrites.map((r) => r.rule)).toEqual(['UNBOUNDED_STATUS_POLL']);
    const patched = gitApply(s.path, s.text, a.diff?.unified ?? '');
    expect(patched).toContain('for (let i = 0; ; i++)');
    expect(scanSdkUsage(s.path, patched).shapes).toEqual([]);
  });

  it('is deterministic and reports whether the source is the gated artifact', () => {
    const s = source('hedging');
    const input = {
      gate: { gateRunId: 'g', gateEvaluationId: 'e', decision: 'FAIL', artifactDigest: null },
      violations: [violation('INV-03', 'INV03_SECOND_MUTATION_UNDER_UNCERTAINTY')],
      source: s,
    };
    const a = buildFixAdvice(input);
    expect(buildFixAdvice(input)).toEqual(a);
    expect(a.source?.matchesArtifactDigest).toBe(false);
    const b = buildFixAdvice({ ...input, gate: { ...input.gate, artifactDigest: a.source?.sha256 ?? null } });
    expect(b.source?.matchesArtifactDigest).toBe(true);
    expect(b.digest).not.toBe(a.digest);
    const md = renderFixAdviceMarkdown(a);
    expect(md).toContain('## No second order while the first is unanswered');
    expect(md).toContain('```diff');
    expect(md).toContain(`line ${linesOf(s.text, '.getQuote(')[1]}:`);
  });
});

describe('M53 — unified diff from edits', () => {
  it('builds a git-applicable diff for insertions, removals, and a file without a final newline', () => {
    const text = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n');
    const at = (line: number) => text.split('\n').slice(0, line).join('\n').length + (line > 0 ? 1 : 0);
    const edits = [
      { start: at(1), end: at(2), text: '' },
      { start: at(8), end: at(8), text: 'X\n' },
      { start: text.length - 1, end: text.length, text: 'J' },
    ];
    const diff = unifiedDiff('x.txt', text, edits);
    expect(gitApply('x.txt', text, diff)).toBe(['a', 'c', 'd', 'e', 'f', 'g', 'h', 'X', 'i', 'J'].join('\n'));
    expect(unifiedDiff('x.txt', text, [])).toBe('');
    expect(unifiedDiff('x.txt', text, [{ start: 0, end: 1, text: 'a' }])).toBe('');
  });
});
