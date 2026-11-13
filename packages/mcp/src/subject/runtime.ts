/**
 * Subject process harness for client builds run by the MCP `run_gate` tool (M52).
 *
 * The subject is a separate process running the exact pinned official 1Click SDK
 * (`@defuse-protocol/one-click-sdk-typescript@0.1.26`) with the versioned RouteSpec adapter
 * attached to the SDK's own `OpenAPI` configuration and axios instance, so every request is an
 * official SDK service call that reaches only the RouteSpec proxy. The business logic is the
 * client module the caller names: its default export is a `ClientJob`.
 *
 * Credentials arrive only over the inherited IPC channel (never argv or the environment).
 * This is the same protocol as the reviewed subject harness of the M05/M06 suites.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

export interface OneClickSdk {
  OpenAPI: OfficialSdkHandle['OpenAPI'];
  OneClickService: {
    getQuote(body: unknown): Promise<{ quote: { depositAddress?: string } }>;
    submitDepositTx(body: unknown): Promise<unknown>;
    getExecutionStatus(depositAddress: string, depositMemo?: string): Promise<{ status: string }>;
  };
  ApiError: new (...args: never[]) => Error & { status: number; body: unknown };
}

const sdk = (await import(SDK_NAME)) as OneClickSdk;
const sdkRequire = createRequire(sdkCjsEntry);
const axiosDir = dirname(sdkRequire.resolve('axios/package.json'));
const axiosPkg = JSON.parse(readFileSync(join(axiosDir, 'package.json'), 'utf8')) as {
  exports: { '.': { default: { default: string } } };
};
const axiosModule = (await import(
  pathToFileURL(join(axiosDir, axiosPkg.exports['.'].default.default)).href
)) as {
  default: OfficialSdkHandle['axios'];
};

export interface ClientContext {
  /** The official SDK, already pointed at the RouteSpec proxy for this case. */
  readonly sdk: OneClickSdk;
  readonly adapter: RouteSpecClientAdapter;
  /** Resolves once RouteSpec has delivered reconciliation-only authority (after an unknown outcome). */
  reconciliationAuthority(): Promise<void>;
  errorOf(error: unknown): { status: number | null; code: string | null };
}

export interface ClientRequest {
  readonly logicalJob: string;
  readonly quote: Record<string, unknown>;
  readonly txHash: string;
}

/** What a client module exports by default: one swap job run against the official SDK. */
export type ClientJob = (ctx: ClientContext, request: ClientRequest) => Promise<Record<string, unknown>>;

export function runSubject(job: ClientJob): void {
  let adapter: RouteSpecClientAdapter | null = null;
  let reconciled: () => void = () => undefined;
  const reconciledPromise = new Promise<void>((r) => (reconciled = r));
  let haveReconciliation = false;
  const apply = (c: AdapterCredentials) => {
    if (c.purpose === 'RECONCILIATION_ONLY') {
      haveReconciliation = true;
      reconciled();
    }
  };
  const ctx: ClientContext = {
    sdk,
    get adapter() {
      return adapter as RouteSpecClientAdapter;
    },
    reconciliationAuthority: () => (haveReconciliation ? Promise.resolve() : reconciledPromise),
    errorOf(error) {
      if (error instanceof sdk.ApiError) {
        const body = error.body as { error?: { code?: string } } | null;
        return { status: error.status, code: body?.error?.code ?? null };
      }
      return { status: null, code: (error as { code?: string }).code ?? null };
    },
  };
  process.on('message', (raw: unknown) => {
    void (async () => {
      const msg = raw as {
        type: string;
        origin?: string;
        credentials?: AdapterCredentials;
        request?: ClientRequest;
      };
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
            { origin: msg.origin as string, credentials: msg.credentials as AdapterCredentials },
          );
          reply({ sdk: `${sdkPkg.name}@${sdkPkg.version}`, revision: adapter.revision });
        } else if (msg.type === 'credentials') {
          adapter?.updateCredentials(msg.credentials as AdapterCredentials);
          apply(msg.credentials as AdapterCredentials);
          reply({});
        } else if (msg.type === 'run') {
          const request = msg.request as ClientRequest;
          adapter?.setLogicalJob(request.logicalJob);
          reply({ outcome: await job(ctx, request) });
        } else if (msg.type === 'detach') {
          adapter?.detach();
          reply({});
          process.disconnect?.();
          setImmediate(() => process.exit(0));
        }
      } catch (error) {
        process.send?.({
          type: 'error',
          code: (error as { code?: string }).code ?? 'ERROR',
          message: String(error).slice(0, 400),
        });
      }
    })();
  });
  process.send?.({ type: 'loaded' });
}
