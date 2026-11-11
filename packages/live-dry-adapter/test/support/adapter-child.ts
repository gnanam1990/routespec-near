/**
 * Test entry for the separately launched live-dry adapter.
 *
 * Runs the same process body as the production entry (src/process.ts: preflight, vault, policy,
 * server, egress, ledger). Two things differ, and both are reported:
 * - the process-wide network tripwire from @routespec/proxy is installed first, so every DNS
 *   lookup and outbound socket this process makes is counted independently of the adapter;
 * - the egress transport is injected:
 *     `deny-all`     resolve/connect throw (and are counted); used where nothing may be reached;
 *     `loopback-tls` resolve returns scripted answers, connect opens real TLS to the loopback
 *                    upstream emulator with SNI = pinned host and the run-time test CA, with
 *                    certificate validation on. The target address the adapter pinned is
 *                    recorded, so DNS-rebinding behaviour is visible.
 * An injected transport can never produce OFFICIAL_ENDPOINT_COMPATIBLE (egress.ts).
 */
import { installNetworkTripwire } from '@routespec/proxy';

const tripwire = installNetworkTripwire();

const { connect } = await import('node:tls');
const { runAdapterProcess } = await import('../../src/process.ts');
type Transport = import('../../src/egress.ts').EgressTransport;

interface TestConfig {
  readonly kind: 'deny-all' | 'loopback-tls';
  readonly port?: number;
  readonly ca?: string;
  /** Answers per resolve call; the last entry repeats. */
  readonly answers?: ReadonlyArray<ReadonlyArray<{ address: string; family: number }>>;
  /** Simulates a careless connector that does not reject bad certificates itself. */
  readonly connectorRejectsUnauthorized?: boolean;
}

const seen = {
  resolveCalls: 0,
  connectCalls: 0,
  connectTargets: [] as string[],
  resolvedHosts: [] as string[],
};

function transportFor(config: TestConfig): Transport {
  if (config.kind === 'deny-all') {
    return {
      label: 'TEST_DENY_ALL',
      async resolve(hostname) {
        seen.resolveCalls++;
        seen.resolvedHosts.push(hostname);
        throw new Error('test transport: resolution must not be reached');
      },
      connect(target) {
        seen.connectCalls++;
        seen.connectTargets.push(target.address);
        throw new Error('test transport: connection must not be reached');
      },
    };
  }
  const answers = config.answers ?? [[{ address: '8.8.8.8', family: 4 }]];
  return {
    label: 'TEST_LOOPBACK_TLS',
    async resolve(hostname) {
      const i = Math.min(seen.resolveCalls, answers.length - 1);
      seen.resolveCalls++;
      seen.resolvedHosts.push(hostname);
      return answers[i]!;
    },
    connect(target) {
      seen.connectCalls++;
      seen.connectTargets.push(target.address);
      return connect({
        host: '127.0.0.1',
        port: config.port!,
        servername: target.servername,
        ca: config.ca,
        rejectUnauthorized: config.connectorRejectsUnauthorized ?? true,
        ALPNProtocols: ['http/1.1'],
      });
    },
  };
}

runAdapterProcess({
  transportFor: (start) => transportFor((start.test ?? { kind: 'deny-all' }) as TestConfig),
  extraReport: () => ({ tripwire: tripwire.report(), transportSeen: { ...seen } }),
});
