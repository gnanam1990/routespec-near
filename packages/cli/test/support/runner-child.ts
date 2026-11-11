/**
 * Separately launched runner process for T-025. It runs the real GateService (proxy,
 * supervisor, kernel, journal) with a case driver that launches the installed subject per case,
 * and is terminated abruptly (SIGKILL / TerminateProcess) at a chosen journal fault point:
 * inside the case invariant-persistence transaction or inside the gate-aggregation transaction,
 * before COMMIT. It prints only JSON status lines and never prints tokens.
 *
 * Usage: node runner-child.ts '<json args>'
 */
import { writeSync } from 'node:fs';
import { join } from 'node:path';
import type { LaunchCredentials } from '@routespec/proxy';
import { GateService, type CaseDriver, type CaseDriverOutcome, type CaseHandoff } from '@routespec/runner';
import { GateJournal, RouteSpecStore } from '@routespec/store';
import { Subject, quoteBody, type Journal } from './product.ts';

interface Args {
  readonly journal: Journal;
  readonly killAt: 'case.persist-evaluation' | 'gate.persist-evaluation' | 'none';
  /** Kill on the n-th occurrence of the label (1-based). */
  readonly occurrence: number;
  readonly leaseTtlMs: number;
}

const args = JSON.parse(process.argv[2] ?? '{}') as Args;
const say = (value: unknown): void => {
  writeSync(1, `${JSON.stringify(value)}\n`);
};

let seen = 0;
const store = RouteSpecStore.open({
  path: join(args.journal.dataDir, 'journal.db'),
  faultInjector: (point, label) => {
    if (point === 'beforeCommit' && label === args.killAt) {
      seen++;
      if (seen === args.occurrence) {
        say({ event: 'KILLING', label });
        process.kill(process.pid, 'SIGKILL');
      }
    }
  },
});

class SubjectDriver implements CaseDriver {
  private readonly subjects = new Map<string, Subject>();
  async runCase(handoff: CaseHandoff): Promise<CaseDriverOutcome> {
    const subject = await Subject.launch(args.journal.build);
    this.subjects.set(handoff.caseRunId, subject);
    try {
      await subject.send({ type: 'attach', origin: handoff.proxyOrigin, credentials: handoff.credentials });
      await subject.send({
        type: 'run',
        request: {
          logicalJob: `order-${handoff.ordinal + 1}`,
          quote: quoteBody(),
          txHash: `sim-tx-${handoff.ordinal + 1}`,
        },
      });
    } finally {
      await subject.close();
      this.subjects.delete(handoff.caseRunId);
    }
    say({ event: 'CASE_INPUT_CLOSED', caseRunId: handoff.caseRunId, ordinal: handoff.ordinal });
    return { kind: 'INPUT_CLOSED' };
  }
  pushCredentials(caseRunId: string, credentials: LaunchCredentials): void {
    this.subjects.get(caseRunId)?.push(credentials);
  }
  cancel(): void {}
}

const service = new GateService(store, { leaseTtlMs: args.leaseTtlMs, ownerLabel: 'runner-child' });
const gate = new GateJournal(store).latestGateDefinition(args.journal.gateId);
const created = service.createGateRun({
  gate,
  buildRevisionId: args.journal.buildRevisionId,
  artifactDigest: args.journal.artifactDigest,
  corpusRevisionId: args.journal.corpusRevisionId,
  effectManifestDigest: args.journal.manifestDigest,
  effectCoveragePolicyDigest: args.journal.policyDigest,
  mode: 'SIMULATE',
  maxParallelCases: 1,
});
say({ event: 'GATE_CREATED', gateRunId: created.gateRunId, caseRunIds: created.caseRunIds });
service.validateGateRun(created.gateRunId);
service.startGateRun(created.gateRunId);
const reports = await service.executeCases(created.gateRunId, new SubjectDriver());
say({
  event: 'CASES_DONE',
  reports: reports.map((r) => ({ ordinal: r.ordinal, verdict: r.verdict, lifecycle: r.lifecycle })),
});
const { decision } = service.evaluateGate(created.gateRunId);
say({ event: 'GATE_EVALUATED', decision: decision.decision });
await service.close();
store.close();
