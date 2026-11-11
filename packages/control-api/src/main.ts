/**
 * Local control service entry point.
 *
 *   node packages/control-api/src/main.ts --data <dir> [--port <n>] [--host 127.0.0.1|::1]
 *        [--console <dist>] [--handoff stderr|ipc|none] [--log-file <path> | --no-log]
 *
 * Opens the journal in `<dir>/journal.db` and binds the loopback control API. Nothing is printed
 * to stdout except one JSON line with the bound origin.
 *
 * One-time secrets (the console hand-off URL with the control token, and local confirmation
 * codes) go only to the operator channel chosen by `--handoff`:
 * - `stderr`: printed on stderr; the default only when stderr is an interactive terminal, so a
 *   redirected or captured stderr (a log file, a CI log) never receives them;
 * - `ipc`: sent over the inherited IPC pipe of a parent that forked this process; the default
 *   when such a pipe exists and stderr is not a terminal;
 * - `none`: withheld (the service runs but no browser or operator can authenticate).
 *
 * Structured local logs (codes and shortened identifiers only, never request values) are
 * appended to `<dir>/logs/control.jsonl` (owner-only) unless `--log-file` or `--no-log` says
 * otherwise. No telemetry leaves the machine.
 *
 * Configured secret values (for example test canaries or credentials an integrator's client
 * holds) are given once through `ROUTESPEC_CONFIGURED_SECRETS` (one value per line). The
 * variable is read and deleted before anything else runs, so no child process inherits it and
 * it never appears in arguments; the values then live only in this process's memory.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { RouteSpecStore } from '@routespec/store';
import { ControlServer } from './server.ts';
import type { LocalConfirmationNotice } from './routes.ts';

const configuredSecrets = (process.env['ROUTESPEC_CONFIGURED_SECRETS'] ?? '')
  .split(/\r?\n/)
  .map((v) => v.trim())
  .filter((v) => v.length > 0);
delete process.env['ROUTESPEC_CONFIGURED_SECRETS'];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Handoff = 'stderr' | 'ipc' | 'none';

function handoffMode(): Handoff {
  const requested = arg('handoff');
  if (requested === 'stderr' || requested === 'ipc' || requested === 'none') return requested;
  if (requested !== undefined) {
    process.stderr.write('routespec: --handoff must be stderr, ipc, or none\n');
    process.exit(3);
  }
  if (process.stderr.isTTY) return 'stderr';
  return typeof process.send === 'function' ? 'ipc' : 'none';
}

const handoff = handoffMode();
if (handoff === 'ipc' && typeof process.send !== 'function') {
  process.stderr.write('routespec: --handoff ipc needs a parent IPC channel\n');
  process.exit(3);
}

const data = resolve(arg('data') ?? '.data');
mkdirSync(data, { recursive: true, mode: 0o700 });
const logFile = process.argv.includes('--no-log')
  ? null
  : resolve(arg('log-file') ?? join(data, 'logs', 'control.jsonl'));
if (logFile !== null) mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
const logSink =
  logFile === null
    ? undefined
    : (line: string) => {
        try {
          appendFileSync(logFile, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
        } catch {
          // Logging must never take the service down.
        }
      };

function deliver(kind: 'console' | 'confirmation', payload: Record<string, unknown>, text: string): void {
  if (handoff === 'stderr') process.stderr.write(`${text}\n`);
  else if (handoff === 'ipc') process.send?.({ type: `routespec.${kind}`, ...payload });
}

const store = RouteSpecStore.open({ path: join(data, 'journal.db') });
const port = arg('port');
const host = arg('host');
const consoleDir = arg('console');
const server = await ControlServer.start({
  store,
  dataDirectory: data,
  configuredSecrets,
  ...(logSink ? { logSink } : {}),
  onLocalConfirmation: (n: LocalConfirmationNotice) =>
    deliver(
      'confirmation',
      { ...n },
      `routespec: local confirmation for ${n.actionCode} (${n.summary}): id=${n.confirmationId} code=${n.code} expires=${n.expiresAt}`,
    ),
  ...(port !== undefined ? { port: Number(port) } : {}),
  ...(host !== undefined ? { host } : {}),
  ...(consoleDir !== undefined ? { consoleDir: resolve(consoleDir) } : {}),
});
process.stdout.write(`${JSON.stringify({ origin: server.origin, bind: server.host })}\n`);
deliver(
  'console',
  { origin: server.origin, port: server.port, token: server.token.reveal(), consoleUrl: server.consoleUrl() },
  `routespec: console ${server.consoleUrl()}`,
);
if (handoff === 'none')
  process.stderr.write('routespec: console hand-off withheld (use --handoff stderr or ipc)\n');
server.logger.info('control.started', { details: { bind: server.host, handoff } });
const stop = async () => {
  server.logger.info('control.stopping');
  await server.close().catch(() => undefined);
  store.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('disconnect', () => {
  if (handoff === 'ipc') void stop();
});
