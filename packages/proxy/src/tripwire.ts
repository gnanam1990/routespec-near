/**
 * Process-local network instrumentation (NFR-02, INV-10; T-010 evidence).
 *
 * Counts every outbound network capability use inside the RouteSpec process that installs it:
 * - TCP/pipe client socket creation via the `net.client.socket` diagnostics channel and
 *   `net.Socket.prototype.connect`;
 * - undici (global `fetch`) connection attempts via its diagnostics channels;
 * - DNS resolution via every `node:dns` and `node:dns/promises` lookup/resolve entry point.
 *   A `lookup` of an IP literal is reported separately as `literalLookups`: Node returns it
 *   without calling the resolver (its `isIP` short-circuit), and `server.listen({ host })` on
 *   127.0.0.1 always makes one. Any non-literal hostname counts as a DNS attempt.
 *
 * It observes; it does not sandbox. Scope is the RouteSpec process only: it says nothing about
 * the separately launched subject client process tree (that needs an OS/container sandbox).
 * This is the only RouteSpec runtime module allowed to import `node:dns`/`node:net`, and only
 * to wrap them for counting.
 */
import diagnosticsChannel from 'node:diagnostics_channel';
import dns from 'node:dns';
import net from 'node:net';

export interface NetworkTripwireReport {
  readonly socketConnects: number;
  readonly clientSockets: number;
  readonly undiciConnects: number;
  readonly dnsLookups: number;
  /** `lookup` calls on IP literals (no resolver call); reported, not counted in `total`. */
  readonly literalLookups: number;
  readonly total: number;
  readonly detail: readonly string[];
}

export interface NetworkTripwire {
  report(): NetworkTripwireReport;
  uninstall(): void;
}

const DNS_FUNCTIONS = [
  'lookup',
  'lookupService',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCname',
  'resolveMx',
  'resolveNs',
  'resolveSrv',
  'resolveTxt',
  'reverse',
] as const;

export function installNetworkTripwire(): NetworkTripwire {
  let socketConnects = 0;
  let clientSockets = 0;
  let undiciConnects = 0;
  let dnsLookups = 0;
  let literalLookups = 0;
  const detail: string[] = [];
  const note = (what: string) => {
    if (detail.length < 32) detail.push(what);
  };

  const onClientSocket = () => {
    clientSockets++;
    note('net.client.socket');
  };
  const onUndici = () => {
    undiciConnects++;
    note('undici:client:beforeConnect');
  };
  diagnosticsChannel.subscribe('net.client.socket', onClientSocket);
  diagnosticsChannel.subscribe('undici:client:beforeConnect', onUndici);

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patchedConnect(this: net.Socket, ...args: unknown[]) {
    socketConnects++;
    note('net.Socket.connect');
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof originalConnect;

  const restores: Array<() => void> = [];
  const wrap = (target: Record<string, unknown>, label: string) => {
    for (const name of DNS_FUNCTIONS) {
      const original = target[name];
      if (typeof original !== 'function') continue;
      target[name] = function patchedDns(this: unknown, ...args: unknown[]) {
        const host = args[0];
        if ((name === 'lookup' || name === 'lookupService') && typeof host === 'string' && net.isIP(host) !== 0) {
          literalLookups++;
          note(`${label}.${name}(ip-literal)`);
        } else {
          dnsLookups++;
          note(`${label}.${name}`);
        }
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      };
      restores.push(() => {
        target[name] = original;
      });
    }
  };
  wrap(dns as unknown as Record<string, unknown>, 'dns');
  wrap(dns.promises as unknown as Record<string, unknown>, 'dns.promises');

  return {
    report(): NetworkTripwireReport {
      return Object.freeze({
        socketConnects,
        clientSockets,
        undiciConnects,
        dnsLookups,
        literalLookups,
        total: socketConnects + clientSockets + undiciConnects + dnsLookups,
        detail: Object.freeze([...detail]),
      });
    },
    uninstall(): void {
      diagnosticsChannel.unsubscribe('net.client.socket', onClientSocket);
      diagnosticsChannel.unsubscribe('undici:client:beforeConnect', onUndici);
      net.Socket.prototype.connect = originalConnect;
      for (const restore of restores) restore();
    },
  };
}
