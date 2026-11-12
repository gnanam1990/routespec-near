/**
 * Separately launched export writer for the M14 export-boundary termination test (RP-04). It
 * plans and writes the bundle of one gate evaluation through the real runner export code and
 * is terminated abruptly (SIGKILL / TerminateProcess) inside the journal transaction that
 * records the write, after the bundle file was published and before COMMIT.
 *
 * Usage: node export-child.ts '<json args>'
 */
import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { planExport, writeExport } from '@routespec/runner';
import { RouteSpecStore } from '@routespec/store';

interface Args {
  readonly dataDir: string;
  readonly gateEvaluationId: string;
  readonly outPath: string;
  readonly killAt: 'export.write' | 'none';
}

const args = JSON.parse(process.argv[2] ?? '{}') as Args;
const say = (value: unknown): void => {
  writeSync(1, `${JSON.stringify(value)}\n`);
};
const store = RouteSpecStore.open({
  path: join(args.dataDir, 'journal.db'),
  faultInjector: (point, label) => {
    if (point === 'beforeCommit' && label === args.killAt) {
      say({ event: 'KILLING', label });
      process.kill(process.pid, 'SIGKILL');
    }
  },
});
const plan = planExport(store, args.gateEvaluationId, { idempotencyKey: 'm14-export-plan' });
say({ event: 'PLANNED', exportId: plan.exportId, planDigest: plan.planDigest });
const written = writeExport(store, plan.exportId, {
  outPath: args.outPath,
  confirm: plan.planDigest,
  idempotencyKey: 'm14-export-write',
});
say({ event: 'WRITTEN', ...written });
store.close();
