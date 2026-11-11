/**
 * Separately launched RouteSpec proxy process for T-010/T-016/T-017.
 *
 * The network tripwire is installed before anything else, so every DNS lookup or outbound
 * socket this RouteSpec process could make is counted. The parent test talks to it only over
 * the inherited IPC channel (credentials and canary values never appear on argv or env) and,
 * as the subject client, over loopback HTTP.
 *
 * IPC protocol (JSON): parent -> {type:'start', scenario, mode, canaries[], cases} |
 * {type:'startCase', index} | {type:'teardownCase', index} | {type:'advanceClock', ms} |
 * {type:'report', index?} | {type:'close'}; child -> {type:'ready', port, credentials} |
 * {type:'started', credentials} | {type:'tornDown', revokedTokens} | {type:'clock', offsetMs} |
 * {type:'credentials', caseRunId, credentials} (reconciliation-only token after an unknown
 * outcome, pushed by the case supervisor) | {type:'report', ...} | {type:'error'}.
 */
import { installNetworkTripwire } from '../../src/tripwire.ts';

const tripwire = installNetworkTripwire();

const { readdirSync, readFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { CaseSupervisor, Redactor, ScenarioProxy } = await import('../../src/index.ts');
const { compileCore, createGate, openStore, tempDir } = await import('./gate.ts');

type Msg =
  | { type: 'start'; scenario: string; mode: 'SIMULATE' | 'REPLAY'; canaries: string[]; cases?: number }
  | { type: 'startCase'; index: number }
  | { type: 'teardownCase'; index: number }
  | { type: 'advanceClock'; ms: number }
  | { type: 'report'; index?: number }
  | { type: 'close' };

let clockOffsetMs = 0;
const clock = { nowMs: () => Date.now() + clockOffsetMs };

let state: {
  dir: { dir: string; cleanup: () => void };
  store: ReturnType<typeof openStore>;
  proxy: Awaited<ReturnType<typeof ScenarioProxy.start>>;
  supervisor: InstanceType<typeof CaseSupervisor>;
  compiled: ReturnType<typeof compileCore>;
  mode: 'SIMULATE' | 'REPLAY';
  canaries: string[];
  caseRunIds: string[];
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

function started(): NonNullable<typeof state> {
  if (!state) throw new Error('not started');
  return state;
}

process.on('message', (raw: unknown) => {
  void (async () => {
    const msg = raw as Msg;
    try {
      if (msg.type === 'start') {
        const dir = tempDir('routespec-proxy-child-');
        const store = openStore(dir.dir, { clock });
        const compiled = compileCore(msg.scenario);
        const gate = createGate(store, compiled, { label: msg.scenario, cases: msg.cases ?? 1 });
        // Token TTL shorter than the lease TTL so token expiry is observable on its own.
        const supervisor = new CaseSupervisor(store, {
          ownerLabel: 'proxy-child',
          leaseTtlMs: 900_000,
          tokenTtlMs: 120_000,
          onCredentials: (caseRunId, credentials) =>
            process.send?.({ type: 'credentials', caseRunId, credentials }),
        });
        const credentials = supervisor.startCase({
          caseRunId: gate.caseRunIds[0]!,
          compiled,
          mode: msg.mode,
        });
        const proxy = await ScenarioProxy.start({
          store,
          mode: msg.mode,
          cases: supervisor,
          redactor: new Redactor(msg.canaries),
        });
        state = {
          dir,
          store,
          proxy,
          supervisor,
          compiled,
          mode: msg.mode,
          canaries: msg.canaries,
          caseRunIds: gate.caseRunIds,
        };
        process.send?.({ type: 'ready', port: proxy.port, address: proxy.boundAddress, credentials });
      } else if (msg.type === 'startCase') {
        const s = started();
        const credentials = s.supervisor.startCase({
          caseRunId: s.caseRunIds[msg.index]!,
          compiled: s.compiled,
          mode: s.mode,
        });
        process.send?.({ type: 'started', credentials });
      } else if (msg.type === 'teardownCase') {
        const s = started();
        const out = s.supervisor.teardown(s.caseRunIds[msg.index]!);
        process.send?.({
          type: 'tornDown',
          revokedTokens: out.revokedTokens,
          evidence: out.evidenceIds.length,
        });
      } else if (msg.type === 'advanceClock') {
        clockOffsetMs += msg.ms;
        process.send?.({ type: 'clock', offsetMs: clockOffsetMs });
      } else if (msg.type === 'report') {
        const { store, proxy, caseRunIds } = started();
        const caseRunId = caseRunIds[msg.index ?? 0]!;
        store.checkpoint();
        const session = String(store.getCaseRun(caseRunId)?.['session_id']);
        const exchanges = store.listExchanges(session, 200);
        const operations = store.listRunOperations(caseRunId);
        process.send?.({
          type: 'report',
          tripwire: tripwire.report(),
          stats: proxy.stats,
          sessionId: session,
          exchanges: exchanges.map((e) => ({
            phase: e['phase'],
            route: e['route_template'],
            transportRequestId: e['transport_request_id'],
            runOperationId: e['run_operation_id'],
            fencingEpoch: e['fencing_epoch'],
            credentialAttached: e['credential_attached'],
            dnsAttempted: e['dns_attempted'],
            upstreamAttempted: e['upstream_attempted'],
          })),
          denials: store
            .listAuditEvents('PROXY_REQUEST_DENIED')
            .map((a) => JSON.parse(String(a['details_json']))),
          conflicts: store.listConflicts(session).map((c) => c['error_code']),
          runOperations: operations.map((o) => ({
            runOperationId: o['run_operation_id'],
            logicalJobKey: o['logical_job_key'] ?? null,
            phase: o['current_phase'],
            committed: o['commit_binding_digest'] !== null,
          })),
          attempts: operations.flatMap((o) =>
            store.listAttempts(String(o['run_operation_id'])).map((a) => ({
              runOperationId: a['run_operation_id'],
              transportRequestId: a['transport_request_id'],
              phase: a['phase'],
              outcome: a['outcome'],
              fencingEpoch: a['fencing_epoch'],
            })),
          ),
          caseLifecycle: store.getCaseRun(caseRunId)?.['execution_lifecycle'],
          fencingEpoch: store.getCaseRun(caseRunId)?.['fencing_epoch'],
          uncertain: started().supervisor.uncertainOutcomes(caseRunId).length,
          canaryScan: scanForCanaries(started().dir.dir, started().canaries),
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
      process.send?.({
        type: 'error',
        code: (error as { code?: string }).code ?? 'ERROR',
        message: String((error as Error).message),
      });
    }
  })();
});
