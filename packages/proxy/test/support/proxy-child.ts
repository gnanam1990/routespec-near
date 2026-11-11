/**
 * Separately launched RouteSpec proxy process for T-010/T-017.
 *
 * The network tripwire is installed before anything else, so every DNS lookup or outbound
 * socket this RouteSpec process could make is counted. The parent test talks to it only over
 * the inherited IPC channel (credentials and canary values never appear on argv or env) and,
 * as the subject client, over loopback HTTP.
 *
 * IPC protocol (JSON): parent -> {type:'start', scenario, mode, canaries[]} | {type:'report'} |
 * {type:'close'}; child -> {type:'ready', port, credentials} | {type:'report', ...} | {type:'error'}.
 */
import { installNetworkTripwire } from '../../src/tripwire.ts';

const tripwire = installNetworkTripwire();

const { readdirSync, readFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { CaseSupervisor, Redactor, ScenarioProxy } = await import('../../src/index.ts');
const { compileCore, createGate, openStore, tempDir } = await import('./gate.ts');

type Msg =
  | { type: 'start'; scenario: string; mode: 'SIMULATE' | 'REPLAY'; canaries: string[] }
  | { type: 'report' }
  | { type: 'close' };

let state: {
  dir: { dir: string; cleanup: () => void };
  store: ReturnType<typeof openStore>;
  proxy: Awaited<ReturnType<typeof ScenarioProxy.start>>;
  canaries: string[];
  caseRunId: string;
} | null = null;

function scanForCanaries(dir: string, canaries: readonly string[]): { files: number; hits: string[] } {
  const hits: string[] = [];
  let files = 0;
  for (const name of readdirSync(dir)) {
    files++;
    const bytes = readFileSync(join(dir, name));
    for (const c of canaries) {
      if (bytes.includes(Buffer.from(c, 'utf8'))) hits.push(`${name}:configured-canary`);
    }
  }
  return { files, hits };
}

process.on('message', (raw: unknown) => {
  void (async () => {
    const msg = raw as Msg;
    try {
      if (msg.type === 'start') {
        const dir = tempDir('routespec-proxy-child-');
        const store = openStore(dir.dir);
        const compiled = compileCore(msg.scenario);
        const gate = createGate(store, compiled, { label: msg.scenario });
        const supervisor = new CaseSupervisor(store, { ownerLabel: 'proxy-child' });
        const credentials = supervisor.startCase({ caseRunId: gate.caseRunIds[0]!, compiled, mode: msg.mode });
        const proxy = await ScenarioProxy.start({
          store,
          mode: msg.mode,
          cases: supervisor,
          redactor: new Redactor(msg.canaries),
        });
        state = { dir, store, proxy, canaries: msg.canaries, caseRunId: gate.caseRunIds[0]! };
        process.send?.({ type: 'ready', port: proxy.port, address: proxy.boundAddress, credentials });
      } else if (msg.type === 'report') {
        if (!state) throw new Error('not started');
        const { store, proxy, caseRunId } = state;
        store.checkpoint();
        const session = String(store.getCaseRun(caseRunId)?.['session_id']);
        const exchanges = store.listExchanges(session, 200);
        process.send?.({
          type: 'report',
          tripwire: tripwire.report(),
          stats: proxy.stats,
          exchanges: exchanges.map((e) => ({
            phase: e['phase'],
            route: e['route_template'],
            credentialAttached: e['credential_attached'],
            dnsAttempted: e['dns_attempted'],
            upstreamAttempted: e['upstream_attempted'],
          })),
          denials: store.listAuditEvents('PROXY_REQUEST_DENIED').map((a) => JSON.parse(String(a['details_json']))),
          conflicts: store.listConflicts(session).map((c) => c['error_code']),
          runOperations: store.listRunOperations(caseRunId).map((o) => ({
            phase: o['current_phase'],
            committed: o['commit_binding_digest'] !== null,
          })),
          caseLifecycle: store.getCaseRun(caseRunId)?.['execution_lifecycle'],
          canaryScan: scanForCanaries(state.dir.dir, state.canaries),
        });
      } else if (msg.type === 'close') {
        if (state) {
          await state.proxy.close();
          state.store.close();
          const scan = scanForCanaries(state.dir.dir, state.canaries);
          state.dir.cleanup();
          process.send?.({ type: 'closed', canaryScan: scan, tripwire: tripwire.report() });
        }
        process.disconnect?.();
        setImmediate(() => process.exit(0));
      }
    } catch (error) {
      process.send?.({ type: 'error', code: (error as { code?: string }).code ?? 'ERROR', message: String((error as Error).message) });
    }
  })();
});
