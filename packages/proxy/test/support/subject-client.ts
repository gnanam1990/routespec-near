/**
 * Separately launched subject client for T-016: the exact pinned official 1Click SDK
 * (`@defuse-protocol/one-click-sdk-typescript@0.1.26`) with the RouteSpec adapter attached.
 *
 * The SDK is imported by its package name and its service functions are the only way requests
 * are made; there is no substitute client in this process. The adapter attaches to the SDK's
 * exported `OpenAPI` configuration and to the very axios instance the SDK imports (resolved
 * from the SDK's own location so the ESM module identity is the same one the SDK uses).
 *
 * Credentials arrive only over the inherited IPC channel (never argv/env).
 *
 * IPC protocol: parent -> {type:'attach', origin, credentials} | {type:'credentials', credentials}
 * | {type:'reset', credentials} | {type:'logicalJob', key} | {type:'call', op, args} |
 * {type:'liveBoundaryProbe'} | {type:'log'} | {type:'detach'}; child -> {type:'<same>-done', ...}.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  RouteSpecClientAdapter,
  type AdapterCredentials,
  type OfficialSdkHandle,
} from '@routespec/client-adapter';

for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[key];
}

const SDK_NAME = '@defuse-protocol/one-click-sdk-typescript';
const require = createRequire(import.meta.url);
const sdkCjsEntry = require.resolve(SDK_NAME);
const sdkDir = dirname(dirname(sdkCjsEntry));
const sdkPkg = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};
const sdk = (await import(SDK_NAME)) as {
  OpenAPI: OfficialSdkHandle['OpenAPI'];
  OneClickService: {
    getQuote(body: unknown): Promise<unknown>;
    submitDepositTx(body: unknown): Promise<unknown>;
    getExecutionStatus(depositAddress: string, depositMemo?: string): Promise<unknown>;
  };
  ApiError: new (...args: never[]) => Error & { status: number; body: unknown };
};
// The axios module the SDK itself imports (same ESM file URL => same module instance).
const sdkRequire = createRequire(sdkCjsEntry);
const axiosDir = dirname(sdkRequire.resolve('axios/package.json'));
const axiosPkg = JSON.parse(readFileSync(join(axiosDir, 'package.json'), 'utf8')) as {
  version: string;
  exports: { '.': { default: { default: string } } };
};
const axiosModule = (await import(
  pathToFileURL(join(axiosDir, axiosPkg.exports['.'].default.default)).href
)) as {
  default: OfficialSdkHandle['axios'];
};

let adapter: RouteSpecClientAdapter | null = null;

function errorOf(error: unknown): { name: string; status: number | null; code: string | null } {
  if (error instanceof sdk.ApiError) {
    const body = error.body as { error?: { code?: string } } | null;
    return { name: 'ApiError', status: error.status, code: body?.error?.code ?? null };
  }
  const e = error as { code?: string; name?: string };
  return { name: e.name ?? 'Error', status: null, code: e.code ?? null };
}

async function liveBoundaryProbe(): Promise<{ headers: IncomingHttpHeaders; routeSpecHeaders: string[] }> {
  // A loopback stand-in for a non-RouteSpec origin (no provider is contacted). Whatever the
  // official client sends there is what would cross a live boundary.
  let seen: IncomingHttpHeaders = {};
  const server = createServer((req, res) => {
    seen = req.headers;
    req.resume();
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"message":"stand-in origin"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = sdk.OpenAPI.BASE;
  sdk.OpenAPI.BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await sdk.OneClickService.getExecutionStatus('sim-deposit-probe').catch(() => undefined);
  } finally {
    sdk.OpenAPI.BASE = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return { headers: seen, routeSpecHeaders: Object.keys(seen).filter((h) => h.startsWith('x-routespec-')) };
}

type Msg =
  | { type: 'attach'; origin: string; credentials: AdapterCredentials }
  | { type: 'credentials'; credentials: AdapterCredentials }
  | { type: 'reset'; credentials: AdapterCredentials }
  | { type: 'logicalJob'; key: string }
  | { type: 'call'; op: 'getQuote' | 'submitDepositTx' | 'getExecutionStatus'; args: unknown[] }
  | { type: 'liveBoundaryProbe' }
  | { type: 'log' }
  | { type: 'detach' };

process.on('message', (raw: unknown) => {
  void (async () => {
    const msg = raw as Msg;
    const reply = (body: Record<string, unknown>) => process.send?.({ type: `${msg.type}-done`, ...body });
    try {
      if (msg.type === 'attach') {
        adapter = RouteSpecClientAdapter.attach(
          {
            OpenAPI: sdk.OpenAPI,
            axios: axiosModule.default,
            packageName: sdkPkg.name,
            packageVersion: sdkPkg.version,
          },
          { origin: msg.origin, credentials: msg.credentials },
        );
        reply({
          sdk: { name: sdkPkg.name, version: sdkPkg.version },
          axiosVersion: axiosPkg.version,
          base: sdk.OpenAPI.BASE,
          revision: adapter.revision,
        });
      } else if (msg.type === 'credentials') {
        adapter?.updateCredentials(msg.credentials);
        reply({});
      } else if (msg.type === 'reset') {
        adapter?.reset(msg.credentials);
        reply({});
      } else if (msg.type === 'logicalJob') {
        adapter?.setLogicalJob(msg.key);
        reply({});
      } else if (msg.type === 'call') {
        try {
          const fn = sdk.OneClickService[msg.op] as (...a: unknown[]) => Promise<unknown>;
          const value = await fn(...msg.args);
          reply({ ok: true, value });
        } catch (error) {
          reply({ ok: false, error: errorOf(error) });
        }
      } else if (msg.type === 'liveBoundaryProbe') {
        reply(await liveBoundaryProbe());
      } else if (msg.type === 'log') {
        reply({ log: adapter?.log ?? [] });
      } else if (msg.type === 'detach') {
        adapter?.detach();
        reply({ base: sdk.OpenAPI.BASE, headers: sdk.OpenAPI.HEADERS === undefined ? 'undefined' : 'set' });
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
process.send?.({ type: 'loaded' });
