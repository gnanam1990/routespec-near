/**
 * T-025 — Interrupted evaluation cannot become PASS. Covers FR-13, NFR-05.
 *
 * A separately launched runner process (real GateService, proxy, supervisor, kernel, journal,
 * and installed official-SDK subjects) is terminated abruptly inside the case
 * invariant-persistence transaction and inside the gate-aggregation transaction. After restart
 * the journal shows transactional rollback (no partial case result, no partial gate
 * evaluation). An incomplete gate is REVIEW, a recovered interrupted case never contributes
 * PASS, a cancelled gate between corpus entries is REVIEW, FAIL still dominates, and only an
 * uninterrupted, complete set of required PASS cases aggregates PASS.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { LaunchCredentials } from '@routespec/proxy';
import { GateService, type CaseDriver, type CaseDriverOutcome, type CaseHandoff } from '@routespec/runner';
import { GateJournal, RouteSpecStore } from '@routespec/store';
import { Subject, quoteBody, runCliProcess, setupJournal, tempDir, type Journal } from './support/product.ts';

const CHILD = fileURLToPath(new URL('./support/runner-child.ts', import.meta.url));
const LEASE_TTL_MS = 3_000;

function runChild(
  journal: Journal,
  killAt: 'case.persist-evaluation' | 'gate.persist-evaluation' | 'none',
  occurrence = 1,
): Promise<{ code: number | null; signal: string | null; events: Array<Record<string, unknown>> }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--no-warnings', CHILD, JSON.stringify({ journal, killAt, occurrence, leaseTtlMs: LEASE_TTL_MS })],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('close', (code, signal) =>
      resolve({
        code,
        signal,
        events: out
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>),
      }),
    );
  });
}

function openLater(dir: string): RouteSpecStore {
  // The runner died; its lease expires with time. The later clock stands for that elapsed time.
  return RouteSpecStore.open({
    path: join(dir, 'journal.db'),
    clock: { nowMs: () => Date.now() + 10 * 60_000 },
  });
}

function gateRunIdOf(events: Array<Record<string, unknown>>): { gateRunId: string; caseRunIds: string[] } {
  const e = events.find((x) => x['event'] === 'GATE_CREATED') as { gateRunId: string; caseRunIds: string[] };
  return e;
}

describe('T-025 — Interrupted evaluation cannot become PASS', () => {
  it('termination inside case invariant persistence rolls back; the gate stays REVIEW through recovery', async () => {
    const t = tempDir();
    try {
      const j = setupJournal(t.dir, {
        scenarios: ['happy-path', 'happy-path'],
        build: 'reconciling-client',
        label: 't025-case',
      });
      const run = await runChild(j, 'case.persist-evaluation');
      expect(run.events.some((e) => e['event'] === 'KILLING')).toBe(true);
      expect(run.code === 0 && run.signal === null).toBe(false);
      expect(run.events.some((e) => e['event'] === 'GATE_EVALUATED')).toBe(false);
      const { gateRunId, caseRunIds } = gateRunIdOf(run.events);
      const store = openLater(t.dir);
      try {
        const c0 = store.getCaseRun(caseRunIds[0] as string)!;
        expect(c0['execution_lifecycle']).toBe('RUNNING');
        expect(c0['verdict']).toBeNull();
        expect(store.getCaseResult(caseRunIds[0] as string)).toBeUndefined();
        expect(store.listInvariantResults(caseRunIds[0] as string)).toHaveLength(0);
        expect(store.getCaseRun(caseRunIds[1] as string)!['execution_lifecycle']).toBe('READY');

        const service = new GateService(store, { ownerLabel: 'restarted-runner' });
        const interim = service.evaluateGate(gateRunId);
        expect(interim.decision.decision).toBe('REVIEW');
        expect(interim.decision.cases.map((c) => c.findings.find((f) => f.startsWith('CASE_')))).toEqual([
          'CASE_INCOMPLETE',
          'CASE_NOT_STARTED',
        ]);
        expect(store.getGateRun(gateRunId)!['execution_lifecycle']).toBe('RUNNING');

        const recovered = service.recoverInterruptedCases(gateRunId);
        expect(recovered).toHaveLength(1);
        expect(recovered[0]?.code).toBeNull();
        expect(store.getCaseRun(caseRunIds[0] as string)!['execution_lifecycle']).toBe('COMPLETED');
        const tokens = store.readEvaluationSnapshot(caseRunIds[0] as string).tokens;
        expect(tokens.filter((x) => x['purpose'] === 'RECONCILIATION_ONLY')).toHaveLength(1);
        expect(tokens.filter((x) => x['purpose'] === 'EXECUTION')).toHaveLength(1);

        service.abortBeforeStart(gateRunId);
        const after = service.evaluateGate(gateRunId);
        expect(after.decision.decision).toBe('REVIEW');
        expect(after.decision.cases[0]?.findings).toContain('CASE_INTERRUPTED');
        expect(after.decision.cases[0]?.contribution).toBe('REVIEW');
        expect(after.decision.cases[1]?.findings).toContain('CASE_CANCELLED_BEFORE_START');
        await service.close();
      } finally {
        store.close();
      }
    } finally {
      t.cleanup();
    }
  });

  it('termination inside gate aggregation leaves no partial evaluation; re-evaluation is complete and idempotent', async () => {
    const t = tempDir();
    try {
      const j = setupJournal(t.dir, {
        scenarios: ['happy-path', 'accepted-then-lost-response'],
        build: 'reconciling-client',
        label: 't025-gate',
      });
      const run = await runChild(j, 'gate.persist-evaluation');
      expect(run.events.find((e) => e['event'] === 'CASES_DONE')?.['reports']).toEqual([
        { ordinal: 0, verdict: 'PASS', lifecycle: 'COMPLETED' },
        { ordinal: 1, verdict: 'PASS', lifecycle: 'COMPLETED' },
      ]);
      expect(run.events.some((e) => e['event'] === 'KILLING')).toBe(true);
      const { gateRunId } = gateRunIdOf(run.events);
      const store = openLater(t.dir);
      try {
        expect(new GateJournal(store).listGateEvaluations(gateRunId)).toHaveLength(0);
        expect(store.getGateRun(gateRunId)!['execution_lifecycle']).toBe('RUNNING');
        expect(store.getGateRun(gateRunId)!['verdict']).toBeNull();
      } finally {
        store.close();
      }
      const first = await runCliProcess(['gate', 'evaluate', '--data', t.dir, '--gate-run', gateRunId]);
      expect(first.exitCode).toBe(0);
      expect(first.json?.['created']).toBe(true);
      const second = await runCliProcess(['gate', 'evaluate', '--data', t.dir, '--gate-run', gateRunId]);
      expect(second.json?.['created']).toBe(false);
      const a = first.json?.['report'] as {
        decision: string;
        decisionDigest: string;
        gateEvaluationId: string;
      };
      const b = second.json?.['report'] as { decisionDigest: string; gateEvaluationId: string };
      expect(a.decision).toBe('PASS');
      expect(b.decisionDigest).toBe(a.decisionDigest);
      expect(b.gateEvaluationId).toBe(a.gateEvaluationId);
      const check = RouteSpecStore.open({ path: join(t.dir, 'journal.db') });
      try {
        expect(check.getGateRun(gateRunId)).toMatchObject({
          execution_lifecycle: 'COMPLETED',
          verdict: 'PASS',
        });
      } finally {
        check.close();
      }
    } finally {
      t.cleanup();
    }
  });

  it('FAIL still dominates an interrupted case, before and after recovery', async () => {
    const t = tempDir();
    try {
      const j = setupJournal(t.dir, {
        scenarios: ['refund-shortfall', 'happy-path'],
        build: 'reconciling-client',
        label: 't025-fail',
      });
      const run = await runChild(j, 'case.persist-evaluation', 2);
      expect(run.events.some((e) => e['event'] === 'KILLING')).toBe(true);
      const { gateRunId } = gateRunIdOf(run.events);
      const store = openLater(t.dir);
      try {
        const service = new GateService(store, { ownerLabel: 'restarted-runner' });
        expect(service.evaluateGate(gateRunId).decision.decision).toBe('FAIL');
        service.recoverInterruptedCases(gateRunId);
        const after = service.evaluateGate(gateRunId).decision;
        expect(after.decision).toBe('FAIL');
        expect(after.cases.map((c) => c.contribution)).toEqual(['FAIL', 'REVIEW']);
        await service.close();
      } finally {
        store.close();
      }
    } finally {
      t.cleanup();
    }
  });

  it('an interrupted unknown-outcome case is recovered read-only through the CLI and stays REVIEW', async () => {
    const t = tempDir();
    try {
      const j = setupJournal(t.dir, {
        scenarios: ['accepted-then-lost-response'],
        build: 'reconciling-client',
        label: 't025-cli',
      });
      const run = await runChild(j, 'case.persist-evaluation');
      const { gateRunId, caseRunIds } = gateRunIdOf(run.events);
      const early = await runCliProcess([
        'case',
        'recover',
        '--data',
        t.dir,
        '--case-run',
        caseRunIds[0] as string,
      ]);
      expect(early.exitCode).toBe(6);
      expect((early.json?.['error'] as { code: string }).code).toBe('RS_LEASE_HELD');
      await new Promise((r) => setTimeout(r, LEASE_TTL_MS + 300));
      const rec = await runCliProcess([
        'case',
        'recover',
        '--data',
        t.dir,
        '--case-run',
        caseRunIds[0] as string,
      ]);
      expect(rec.exitCode, rec.stderr).toBe(0);
      expect(rec.json?.['interrupted']).toBe(true);
      const evalr = await runCliProcess(['gate', 'evaluate', '--data', t.dir, '--gate-run', gateRunId]);
      expect(evalr.exitCode).toBe(3);
      const rep = evalr.json?.['report'] as { decision: string; cases: Array<{ findings: string[] }> };
      expect(rep.decision).toBe('REVIEW');
      expect(rep.cases[0]?.findings).toContain('CASE_INTERRUPTED');
      const store = RouteSpecStore.open({ path: join(t.dir, 'journal.db') });
      try {
        expect(store.countRows('commit_bindings')).toBe(1);
        const tokens = store.readEvaluationSnapshot(caseRunIds[0] as string).tokens;
        // One reconciliation token from the live unknown outcome, one from the crash recovery.
        expect(tokens.filter((x) => x['purpose'] === 'RECONCILIATION_ONLY')).toHaveLength(2);
        expect(tokens.filter((x) => x['purpose'] === 'EXECUTION')).toHaveLength(1);
      } finally {
        store.close();
      }
    } finally {
      t.cleanup();
    }
  });

  it('cancelling the gate between corpus entries is REVIEW, never PASS', async () => {
    const t = tempDir();
    try {
      const j = setupJournal(t.dir, {
        scenarios: ['happy-path', 'happy-path', 'happy-path'],
        build: 'reconciling-client',
        label: 't025-cancel',
      });
      const store = RouteSpecStore.open({ path: join(t.dir, 'journal.db') });
      const controller = new AbortController();
      const service = new GateService(store, { ownerLabel: 'cancel-runner' });
      class Driver implements CaseDriver {
        private readonly pending = new Map<string, (o: CaseDriverOutcome) => void>();
        private readonly subjects = new Map<string, Subject>();
        async runCase(h: CaseHandoff): Promise<CaseDriverOutcome> {
          if (h.ordinal === 1) {
            const p = new Promise<CaseDriverOutcome>((r) => this.pending.set(h.caseRunId, r));
            controller.abort();
            return p;
          }
          const s = await Subject.launch('reconciling-client');
          this.subjects.set(h.caseRunId, s);
          try {
            await s.send({ type: 'attach', origin: h.proxyOrigin, credentials: h.credentials });
            await s.send({
              type: 'run',
              request: { logicalJob: `order-${h.ordinal}`, quote: quoteBody(), txHash: `tx-${h.ordinal}` },
            });
          } finally {
            await s.close();
          }
          return { kind: 'INPUT_CLOSED' };
        }
        pushCredentials(caseRunId: string, c: LaunchCredentials): void {
          this.subjects.get(caseRunId)?.push(c);
        }
        cancel(caseRunId: string, reason: string): void {
          this.pending.get(caseRunId)?.({ kind: 'CANCELLED', reason });
        }
      }
      try {
        const gate = new GateJournal(store).latestGateDefinition(j.gateId);
        const created = service.createGateRun({
          gate,
          buildRevisionId: j.buildRevisionId,
          artifactDigest: j.artifactDigest,
          corpusRevisionId: j.corpusRevisionId,
          effectManifestDigest: j.manifestDigest,
          effectCoveragePolicyDigest: j.policyDigest,
          mode: 'SIMULATE',
          maxParallelCases: 1,
        });
        service.validateGateRun(created.gateRunId);
        service.startGateRun(created.gateRunId);
        const reports = await service.executeCases(created.gateRunId, new Driver(), {
          signal: controller.signal,
        });
        expect(reports.map((r) => r.outcome)).toEqual(['INPUT_CLOSED', 'CANCELLED', 'NOT_STARTED']);
        expect(store.getGateRun(created.gateRunId)!['execution_lifecycle']).toBe('ABORTED');
        const { decision } = service.evaluateGate(created.gateRunId);
        expect(decision.decision).toBe('REVIEW');
        expect(decision.cases.map((c) => c.contribution)).toEqual(['PASS', 'REVIEW', 'NOT_RUN']);
        expect(decision.findings).toContain('GATE_RUN_ABORTED');
      } finally {
        await service.close();
        store.close();
      }
    } finally {
      t.cleanup();
    }
  });
});
