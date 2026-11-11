/** Parent-side control of the separately launched proxy process (test/support/proxy-child.ts). */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { LaunchCredentials } from '../../src/index.ts';

export interface ChildReport {
  readonly tripwire: {
    total: number;
    socketConnects: number;
    clientSockets: number;
    undiciConnects: number;
    dnsLookups: number;
    literalLookups: number;
    detail: string[];
  };
  readonly stats: {
    requests: number;
    accepted: number;
    denied: number;
    credentialHeadersStripped: number;
    upstreamAttempts: number;
  };
  readonly sessionId: string;
  readonly exchanges: Array<{
    phase: string;
    route: string;
    transportRequestId: string;
    runOperationId: string | null;
    fencingEpoch: number;
    credentialAttached: number;
    dnsAttempted: number;
    upstreamAttempted: number;
  }>;
  readonly denials: Array<{
    method: string;
    path: string;
    code: string;
    upstreamAttempted: boolean;
    credentialAttached: boolean;
    dnsAttempted: boolean;
  }>;
  readonly conflicts: string[];
  readonly runOperations: Array<{
    runOperationId: string;
    logicalJobKey: string | null;
    phase: string;
    committed: boolean;
  }>;
  readonly attempts: Array<{
    runOperationId: string;
    transportRequestId: string;
    phase: string;
    outcome: string;
    fencingEpoch: number;
  }>;
  readonly caseLifecycle: string;
  readonly fencingEpoch: number;
  readonly uncertain: number;
  readonly canaryScan: { files: number; hits: string[] };
}

export interface ProxyChild {
  readonly child: ChildProcess;
  readonly port: number;
  readonly address: { address: string; family: string; port: number };
  readonly credentials: LaunchCredentials;
  /** Credentials pushed by the supervisor (reconciliation-only tokens), in arrival order. */
  readonly pushed: Array<{ caseRunId: string; credentials: LaunchCredentials }>;
  report(index?: number): Promise<ChildReport>;
  startCase(index: number): Promise<LaunchCredentials>;
  teardownCase(index: number): Promise<{ revokedTokens: number; evidence: number }>;
  advanceClock(ms: number): Promise<number>;
  close(): Promise<{ canaryScan: { files: number; hits: string[] }; tripwire: ChildReport['tripwire'] }>;
}

function next(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null) => reject(new Error(`proxy child exited ${code}`));
    const onMessage = (m: unknown) => {
      const msg = m as Record<string, unknown>;
      if (msg['type'] === 'error') {
        child.off('message', onMessage);
        child.off('exit', onExit);
        reject(new Error(`proxy child error ${String(msg['code'])}: ${String(msg['message'])}`));
      } else if (msg['type'] === type) {
        child.off('message', onMessage);
        child.off('exit', onExit);
        resolve(msg);
      }
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

export async function launchProxyChild(input: {
  scenario: string;
  mode: 'SIMULATE' | 'REPLAY';
  canaries?: string[];
  cases?: number;
}): Promise<ProxyChild> {
  const script = fileURLToPath(new URL('./proxy-child.ts', import.meta.url));
  const child = fork(script, [], { execArgv: ['--no-warnings'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const pushed: ProxyChild['pushed'] = [];
  child.on('message', (m: unknown) => {
    const msg = m as Record<string, unknown>;
    if (msg['type'] === 'credentials') {
      pushed.push({
        caseRunId: String(msg['caseRunId']),
        credentials: msg['credentials'] as LaunchCredentials,
      });
    }
  });
  const ready = next(child, 'ready');
  child.send({
    type: 'start',
    scenario: input.scenario,
    mode: input.mode,
    canaries: input.canaries ?? [],
    cases: input.cases ?? 1,
  });
  const msg = await ready;
  return {
    child,
    port: msg['port'] as number,
    address: msg['address'] as ProxyChild['address'],
    credentials: msg['credentials'] as LaunchCredentials,
    pushed,
    async report(index = 0) {
      const p = next(child, 'report');
      child.send({ type: 'report', index });
      return (await p) as unknown as ChildReport;
    },
    async startCase(index) {
      const p = next(child, 'started');
      child.send({ type: 'startCase', index });
      return (await p)['credentials'] as LaunchCredentials;
    },
    async teardownCase(index) {
      const p = next(child, 'tornDown');
      child.send({ type: 'teardownCase', index });
      const out = await p;
      return { revokedTokens: out['revokedTokens'] as number, evidence: out['evidence'] as number };
    },
    async advanceClock(ms) {
      const p = next(child, 'clock');
      child.send({ type: 'advanceClock', ms });
      return (await p)['offsetMs'] as number;
    },
    async close() {
      const p = next(child, 'closed');
      child.send({ type: 'close' });
      const out = (await p) as unknown as {
        canaryScan: { files: number; hits: string[] };
        tripwire: ChildReport['tripwire'];
      };
      await new Promise<void>((resolve) =>
        child.exitCode !== null ? resolve() : child.once('exit', () => resolve()),
      );
      return out;
    },
  };
}
