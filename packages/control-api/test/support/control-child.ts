/**
 * The control service as its own process: opens the journal in the given data directory,
 * starts the loopback ControlServer, and reports its port and the control token to the parent
 * over the inherited IPC pipe (never argv, env, or stdout). Exits when the pipe closes.
 */
import { join } from 'node:path';
import { RouteSpecStore } from '@routespec/store';
import { ControlServer } from '../../src/index.ts';

const dataDir = process.argv[2] as string;
const store = RouteSpecStore.open({ path: join(dataDir, 'journal.db') });
const server = await ControlServer.start({
  store,
  dataDirectory: dataDir,
  onLocalConfirmation: () => undefined,
});
process.send?.({ type: 'ready', port: server.port, token: server.token.reveal() });
const stop = async () => {
  await server.close().catch(() => undefined);
  store.close();
  process.exit(0);
};
process.on('disconnect', () => void stop());
process.on('message', (m: unknown) => {
  if ((m as { type?: string }).type === 'stop') void stop();
});
