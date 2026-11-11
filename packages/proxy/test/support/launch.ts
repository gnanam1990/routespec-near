/** Parent-side control of the separately launched proxy process (test/support/proxy-child.ts). */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { LaunchCredentials } from '../../src/index.ts';

export interface ChildReport {
  readonly tripwire: { total: number; socketConnects: number; clientSockets: number; undiciConnects: number; dnsLookups: number; literalLookups: number; detail: string[] };
  readonly stats: { requests: number; accepted: number; denied: number; credentialHeadersStripped: number; upstreamAttempts: number };
  readonly exchanges: Array<{ phase: string; route: string; credentialAttached: number; dnsAttempted: number; upstreamAttempted: number }>;
  readonly denials: Array<{ method: string; path: string; code: string; upstreamAttempted: boolean; credentialAttached: boolean; dnsAttempted: boolean }>;
  readonly conflicts: string[];
  readonly runOperations: Array<{ phase: string; committed: boolean }>;
  readonly caseLifecycle: string;
  readonly canaryScan: { files: number; hits: string[] };
}

export interface ProxyChild {
  readonly child: ChildProcess;
  readonly port: number;
  readonly address: { address: string; family: string; port: number };
  readonly credentials: LaunchCredentials;
  report(): Promise<ChildReport>;
  close(): Promise<{ canaryScan: { files: number; hits: string[] }; tripwire: ChildReport['tripwire'] }>;
}

function next(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (m: unknown) => {
      const msg = m as Record<string, unknown>;
      if (msg['type'] === 'error') {
        child.off('message', onMessage);
        reject(new Error(`proxy child error ${String(msg['code'])}: ${String(msg['message'])}`));
      } else if (msg['type'] === type) {
        child.off('message', onMessage);
        resolve(msg);
      }
    };
    child.on('message', onMessage);
    child.once('exit', (code) => reject(new Error(`proxy child exited ${code}`)));
  });
}

export async function launchProxyChild(input: {
  scenario: string;
  mode: 'SIMULATE' | 'REPLAY';
  canaries?: string[];
}): Promise<ProxyChild> {
  const script = fileURLToPath(new URL('./proxy-child.ts', import.meta.url));
  const child = fork(script, [], { execArgv: ['--no-warnings'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const ready = next(child, 'ready');
  child.send({ type: 'start', scenario: input.scenario, mode: input.mode, canaries: input.canaries ?? [] });
  const msg = await ready;
  return {
    child,
    port: msg['port'] as number,
    address: msg['address'] as ProxyChild['address'],
    credentials: msg['credentials'] as LaunchCredentials,
    async report() {
      const p = next(child, 'report');
      child.send({ type: 'report' });
      return (await p) as unknown as ChildReport;
    },
    async close() {
      const p = next(child, 'closed');
      child.send({ type: 'close' });
      const out = (await p) as unknown as { canaryScan: { files: number; hits: string[] }; tripwire: ChildReport['tripwire'] };
      await new Promise<void>((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', () => resolve())));
      return out;
    },
  };
}
