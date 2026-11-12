/**
 * Shared process harness for the installed subject clients used by the M05 tests.
 *
 * The subject is a separately launched process running the exact pinned official 1Click SDK
 * (`@defuse-protocol/one-click-sdk-typescript@0.1.26`) with the versioned RouteSpec adapter
 * attached to the SDK's own `OpenAPI` configuration and axios instance. Every request is an
 * official SDK service call. The business logic (the part a client fix changes) lives in the
 * build file that imports this harness (`baseline-client.ts`, `corrected-client.ts`); the test
 * registers that file's bytes as the subject artifact digest.
 *
 * Credentials arrive only over the inherited IPC channel (never argv/env).
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

export interface JobContext {
  readonly sdk: OneClickSdk;
  readonly adapter: RouteSpecClientAdapter;
  /** Resolves once reconciliation-only authority has been delivered by the launcher. */
  reconciliationAuthority(): Promise<void>;
  errorOf(error: unknown): { status: number | null; code: string | null };
}

export interface JobRequest {
  readonly logicalJob: string;
  readonly quote: Record<string, unknown>;
  readonly txHash: string;
  /**
   * Where this integration performs its protected effect (order fulfilment). When the launcher
   * runs the build under containment (M14) this is the loopback tunnel to RouteSpec's effect
   * interceptor; absent, the build performs no effect.
   */
  readonly effectSink?: { readonly origin: string; readonly sinkClass: string } | null;
}

export interface EffectAttempt {
  readonly status: number | null;
  readonly released: boolean;
}

/** One protected-effect delivery attempt at the configured sink (plain HTTP, no SDK). */
export async function deliverEffect(
  sink: { readonly origin: string; readonly sinkClass: string },
  effectId: string,
): Promise<EffectAttempt> {
  try {
    const res = await fetch(`${sink.origin}/sink/${sink.sinkClass}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ effectId }),
    });
    const body = (await res.json().catch(() => ({}))) as { denied?: boolean };
    return { status: res.status, released: res.status === 202 && body.denied === false };
  } catch {
    return { status: null, released: false };
  }
}

export type Job = (ctx: JobContext, request: JobRequest) => Promise<Record<string, unknown>>;

export function runSubject(job: Job): void {
  let adapter: RouteSpecClientAdapter | null = null;
  let reconciled: () => void = () => undefined;
  let reconciledPromise = new Promise<void>((r) => (reconciled = r));
  let haveReconciliation = false;
  const apply = (c: AdapterCredentials) => {
    if (c.purpose === 'RECONCILIATION_ONLY') {
      haveReconciliation = true;
      reconciled();
    }
  };
  const ctx: JobContext = {
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
        request?: JobRequest;
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
        } else if (msg.type === 'reset') {
          adapter?.reset(msg.credentials as AdapterCredentials);
          haveReconciliation = false;
          reconciledPromise = new Promise<void>((r) => (reconciled = r));
          reply({});
        } else if (msg.type === 'run') {
          const request = msg.request as JobRequest;
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
          message: String(error),
        });
      }
    })();
  });
  process.send?.({ type: 'loaded' });
}
