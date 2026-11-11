/**
 * Local control service entry point.
 *
 *   node packages/control-api/src/main.ts --data <dir> [--port <n>] [--host 127.0.0.1|::1] [--console <dist>]
 *
 * Opens the journal in `<dir>/journal.db`, binds the loopback control API, and prints the
 * one-time console URL (token in the URL fragment) and local confirmation codes to stderr for
 * the operator. Nothing is printed to stdout except one JSON line with the bound origin.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RouteSpecStore } from '@routespec/store';
import { ControlServer } from './server.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const data = resolve(arg('data') ?? '.data');
mkdirSync(data, { recursive: true });
const store = RouteSpecStore.open({ path: join(data, 'journal.db') });
const port = arg('port');
const host = arg('host');
const consoleDir = arg('console');
const server = await ControlServer.start({
  store,
  dataDirectory: data,
  ...(port !== undefined ? { port: Number(port) } : {}),
  ...(host !== undefined ? { host } : {}),
  ...(consoleDir !== undefined ? { consoleDir: resolve(consoleDir) } : {}),
});
process.stdout.write(`${JSON.stringify({ origin: server.origin, bind: server.host })}\n`);
process.stderr.write(`routespec: console ${server.consoleUrl()}\n`);
const stop = async () => {
  await server.close().catch(() => undefined);
  store.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
