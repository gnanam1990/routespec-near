/**
 * M52 — run_gate and list_findings over the MCP stdio server, on real client modules.
 *
 * The demo client before the fix (`swap-client.naive.ts`) and after it (`swap-client.fixed.ts`)
 * run as separate processes with the pinned official SDK against the RouteSpec proxy; every
 * verdict is the invariant kernel's result over what they sent. Nothing here states a verdict
 * to the product: the tests only read what the gate decided.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { McpTestClient } from './support/mcp-client.ts';

type J = Record<string, unknown>;

vi.setConfig({ testTimeout: 240_000 });

interface FindingsCase {
  scenario: string;
  contribution: string;
  invariants: Array<{
    invariantId: string;
    verdict: string;
    explanationCode: string | null;
    explanation: string | null;
    remediationCode: string | null;
    fixPatterns: string[];
  }>;
}

let client: McpTestClient;
beforeAll(async () => {
  client = McpTestClient.start();
  await client.initialize();
});
afterAll(async () => {
  await client.close();
});

describe('run_gate and list_findings on the demo client', () => {
  it('the naive client FAILs: a second order under an unknown outcome (INV-03) on the slow answer', async () => {
    const run = await client.call('run_gate', { client: 'examples/agent-skill/demo/swap-client.naive.ts' });
    expect(run.isError, run.text).toBe(false);
    const s = run.structuredContent;
    expect(s).toMatchObject({
      runId: 'run-1',
      client: 'examples/agent-skill/demo/swap-client.naive.ts',
      decision: 'FAIL',
      exitCode: 2,
      containment: 'UNCONTAINED_DECLARED_HOOKS_ONLY',
      evidenceUse: 'DIAGNOSTIC_ONLY',
      error: null,
    });
    const cases = s['cases'] as Array<{ scenario: string; contribution: string; failing: string[] }>;
    expect(cases.map((c) => c.scenario)).toEqual([
      'happy-path',
      'accepted-then-lost-response',
      'slow-deposit-answer',
    ]);
    expect(cases.find((c) => c.scenario === 'slow-deposit-answer')).toMatchObject({ contribution: 'FAIL' });
    expect(cases.find((c) => c.scenario === 'slow-deposit-answer')?.failing).toContain('INV-03:FAIL');
    // No case passes: the client never reads an order to a terminal status.
    expect(cases.every((c) => c.contribution !== 'PASS')).toBe(true);
    expect(run.text).toMatch(
      /^Gate FAIL for examples\/agent-skill\/demo\/swap-client\.naive\.ts \(run-1\)\./,
    );

    const f = await client.call('list_findings');
    expect(f.isError).toBe(false);
    const report = f.structuredContent as {
      decision: string;
      cases: FindingsCase[];
      nextFixPatterns: string[];
    };
    expect(report.decision).toBe('FAIL');
    const slow = report.cases.find((c) => c.scenario === 'slow-deposit-answer') as FindingsCase;
    const inv03 = slow.invariants[0];
    expect(inv03).toMatchObject({
      invariantId: 'INV-03',
      verdict: 'FAIL',
      explanationCode: 'INV03_SECOND_MUTATION_UNDER_UNCERTAINTY',
      remediationCode: 'RECONCILE_BEFORE_RETRY',
      fixPatterns: ['no-second-order-while-unanswered', 'reconcile-through-status'],
    });
    expect(inv03?.explanation).toMatch(/mutation was accepted while a commit outcome was still unknown/);
    // The lost answer is left unreconciled.
    const lost = report.cases.find((c) => c.scenario === 'accepted-then-lost-response') as FindingsCase;
    expect(lost.invariants.find((i) => i.invariantId === 'INV-03')).toMatchObject({
      verdict: 'REVIEW',
      explanationCode: 'INV03_RECONCILIATION_INCOMPLETE',
    });
    // INV-04 is never listed as a finding of the client (it is not required uncontained).
    for (const c of report.cases) expect(c.invariants.map((i) => i.invariantId)).not.toContain('INV-04');
    expect(report.nextFixPatterns.slice(0, 2)).toEqual([
      'no-second-order-while-unanswered',
      'reconcile-through-status',
    ]);
  });

  it('the fixed client (reconcile pattern) PASSes every scenario, and both runs stay listed', async () => {
    const run = await client.call('run_gate', { client: 'examples/agent-skill/demo/swap-client.fixed.ts' });
    expect(run.isError, run.text).toBe(false);
    expect(run.structuredContent).toMatchObject({ runId: 'run-2', decision: 'PASS', exitCode: 0 });
    const cases = run.structuredContent['cases'] as Array<{ contribution: string; failing: string[] }>;
    expect(cases.map((c) => c.contribution)).toEqual(['PASS', 'PASS', 'PASS']);
    expect(cases.every((c) => c.failing.length === 0)).toBe(true);
    const fixedDigest = run.structuredContent['artifactDigest'];
    expect(fixedDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const latest = await client.call('list_findings');
    expect(latest.structuredContent).toMatchObject({
      runId: 'run-2',
      decision: 'PASS',
      cases: [],
      nextFixPatterns: [],
    });
    const all = await client.call('list_findings', { includePassing: true });
    expect((all.structuredContent['cases'] as unknown[]).length).toBe(3);
    const earlier = await client.call('list_findings', { runId: 'run-1' });
    expect(earlier.structuredContent).toMatchObject({ runId: 'run-1', decision: 'FAIL' });
    expect((earlier.structuredContent as J)['artifactDigest']).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((earlier.structuredContent as J)['artifactDigest']).not.toBe(fixedDigest);
    expect((await client.call('list_findings', { runId: 'run-9' })).structuredContent).toMatchObject({
      error: { code: 'UNKNOWN_RUN' },
    });
  });

  it('runs a chosen scenario subset in order', async () => {
    const run = await client.call('run_gate', {
      client: 'examples/agent-skill/demo/swap-client.naive.ts',
      scenarios: ['slow-deposit-answer'],
    });
    expect(run.structuredContent).toMatchObject({
      decision: 'FAIL',
      cases: [{ scenario: 'slow-deposit-answer' }],
    });
    const unknown = await client.call('run_gate', {
      client: 'examples/agent-skill/demo/swap-client.naive.ts',
      scenarios: ['no-such-scenario'],
    });
    expect(unknown.structuredContent).toMatchObject({ error: { code: 'UNKNOWN_SCENARIO' } });
  });
});

describe('run_gate input confinement', () => {
  let root: string;
  let outside: string;
  let local: McpTestClient;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'routespec-m52-root-'));
    outside = mkdtempSync(join(tmpdir(), 'routespec-m52-outside-'));
    writeFileSync(join(root, 'no-default.mjs'), 'export const swap = async () => ({});\n');
    writeFileSync(join(root, 'notes.txt'), 'not a module\n');
    writeFileSync(join(outside, 'client.mjs'), 'export default async () => ({});\n');
    local = McpTestClient.start(['--root', root]);
    await local.initialize();
  });
  afterAll(async () => {
    await local.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('refuses files outside the root, missing files and non-modules before anything starts', async () => {
    for (const [client, code] of [
      [join(outside, 'client.mjs'), 'PATH_OUTSIDE_ROOT'],
      ['../client.mjs', 'FILE_NOT_FOUND'],
      ['missing.ts', 'FILE_NOT_FOUND'],
      ['notes.txt', 'INPUT_INVALID'],
      ['.', 'PATH_OUTSIDE_ROOT'],
    ] as const) {
      const r = await local.call('run_gate', { client });
      expect(r.isError, client).toBe(true);
      expect(r.structuredContent, client).toMatchObject({ error: { code } });
    }
    expect((await local.call('run_gate', {})).structuredContent).toMatchObject({
      error: { code: 'INPUT_MISSING' },
    });
  });

  it('a module without a default job never passes: the case is aborted with the client error', async () => {
    const r = await local.call('run_gate', { client: 'no-default.mjs', scenarios: ['happy-path'] });
    expect(r.structuredContent['decision']).not.toBe('PASS');
    const cases = r.structuredContent['cases'] as Array<{ contribution: string; clientError: string }>;
    expect(cases[0]?.contribution).toBe('REVIEW');
    expect(cases[0]?.clientError).toMatch(/^CLIENT_MODULE_NO_DEFAULT_JOB/);
  });
});
