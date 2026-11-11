/**
 * Child process used by the crash tests (T-022, T-023, T-024). It is a real separate OS process
 * that opens the journal, performs one proxy commit through the repository API, and is then
 * terminated abruptly (SIGKILL / TerminateProcess) either after acknowledgement or at the
 * `beforeCommit` fault point. It prints only JSON status lines and never prints tokens.
 *
 * Usage: node crash-child.ts '<json args>'
 */
import { writeSync } from 'node:fs';
import { RouteSpecStore, type CaseAuth } from '../../src/index.ts';

interface Args {
  mode: 'ack-then-wait' | 'kill-before-commit' | 'try-open';
  dbPath: string;
  auth: CaseAuth;
  runOperationId: string;
  transportRequestId: string;
  body: unknown;
}

const args = JSON.parse(process.argv[2] ?? '{}') as Args;
const say = (value: unknown): void => {
  writeSync(1, `${JSON.stringify(value)}\n`);
};

let store: RouteSpecStore;
try {
  store = RouteSpecStore.open({
    path: args.dbPath,
    ...(args.mode === 'kill-before-commit'
      ? {
          faultInjector: (point: string, label: string) => {
            if (point === 'beforeCommit' && label === 'proxy.commit-mutation') {
              say({ event: 'ABOUT_TO_COMMIT' });
              process.kill(process.pid, 'SIGKILL');
            }
          },
        }
      : {}),
  });
} catch (error) {
  say({ event: 'OPEN_FAILED', code: (error as { code?: string }).code ?? 'UNKNOWN' });
  process.exit(4);
}
say({ event: 'OPENED', pid: process.pid });
if (args.mode === 'try-open') {
  store.close();
  process.exit(0);
}

try {
  const ack = store.commitMutation(args.auth, {
    transportRequestId: args.transportRequestId,
    runOperationId: args.runOperationId,
    body: args.body,
  });
  // The acknowledgement leaves this process only after the journal COMMIT returned.
  say({ event: 'ACK', ack });
} catch (error) {
  say({ event: 'REJECTED', code: (error as { code?: string }).code ?? 'UNKNOWN' });
  process.exit(3);
}
// Stay alive holding the writer lock until the parent kills this process.
setInterval(() => undefined, 1_000);
