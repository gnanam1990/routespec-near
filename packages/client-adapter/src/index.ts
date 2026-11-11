/**
 * @routespec/client-adapter — versioned subject-side adapter for the pinned official 1Click SDK
 * (FR-03, API-SPEC.md section 5, ADR-0007).
 *
 * The adapter attaches to the official SDK's two documented integration points and nothing
 * else: the exported mutable `OpenAPI` configuration (base URL) and the axios instance the SDK
 * itself imports (request/response interceptors). It does not replace, wrap, or re-implement
 * any SDK service call, so every request still runs through the SDK's own request pipeline.
 *
 * Per transport attempt it injects the stable correlation headers (session, case run, adapter
 * revision, fencing epoch, client instance, one-time case token), a fresh unique transport
 * request ID, the caller-declared logical job on quote requests, and the RouteSpec-assigned
 * run operation on commit and status requests (learned from the quote response header and keyed
 * by the response-assigned deposit address). It never sends a RouteSpec header or case token to
 * any origin other than the configured loopback RouteSpec origin: for every other origin all
 * `x-routespec-*` headers are removed (the live-boundary rule of `stripForUpstream`).
 *
 * Transport retry: the pinned SDK sends each request once. The adapter performs at most one
 * retry of a request that received no response at all (connection reset), with the same
 * method/body/run operation and a new transport request ID. Any HTTP response, including a
 * RouteSpec denial, is returned to the SDK unchanged and never retried.
 *
 * Credentials are held in memory only; the adapter has no persistence and no logging sink. Its
 * transport log contains identities and outcomes, never the case token.
 */
import { randomUUID } from 'node:crypto';
import { ADAPTER_HEADERS, ADAPTER_REVISION, ONECLICK_SDK_PIN, RouteSpecError } from '@routespec/contracts';

export { ADAPTER_REVISION };

export type CredentialPurpose = 'EXECUTION' | 'RECONCILIATION_ONLY';

/** One-time case credentials delivered to the subject over the launcher channel. */
export interface AdapterCredentials {
  readonly purpose: CredentialPurpose;
  readonly token: string;
  readonly sessionId: string;
  readonly caseRunId: string;
  readonly adapterRevision: string;
  readonly fencingEpoch: number;
  readonly clientInstanceId: string;
}

/** Minimal structural view of an axios request config as seen by interceptors. */
export interface AxiosConfigLike {
  url?: string;
  method?: string;
  data?: unknown;
  headers?: unknown;
  [key: string]: unknown;
}

interface AxiosResponseLike {
  status: number;
  headers: Record<string, unknown>;
  data: unknown;
  config: AxiosConfigLike;
}

interface AxiosErrorLike {
  config?: AxiosConfigLike;
  response?: AxiosResponseLike;
  code?: string;
}

interface InterceptorManagerLike<V> {
  use(onFulfilled?: (value: V) => V | Promise<V>, onRejected?: (error: unknown) => unknown): number;
  eject(id: number): void;
}

/** Structural view of the axios instance the SDK imports. */
export interface AxiosLike {
  interceptors: {
    request: InterceptorManagerLike<AxiosConfigLike>;
    response: InterceptorManagerLike<AxiosResponseLike>;
  };
  request(config: AxiosConfigLike): Promise<unknown>;
}

/** The official SDK as seen by the adapter: its config object, its axios, and its identity. */
export interface OfficialSdkHandle {
  readonly OpenAPI: {
    BASE: string;
    VERSION: string;
    TOKEN?: unknown;
    HEADERS?: unknown;
  };
  readonly axios: AxiosLike;
  readonly packageName: string;
  readonly packageVersion: string;
}

export interface TransportRecord {
  readonly transportRequestId: string;
  readonly attempt: number;
  readonly method: string;
  readonly route: string;
  readonly target: 'PROXY' | 'OTHER';
  readonly sessionId: string | null;
  readonly caseRunId: string | null;
  readonly logicalJob: string | null;
  readonly runOperationId: string | null;
  readonly fencingEpoch: number | null;
  readonly purpose: CredentialPurpose | null;
  readonly outcome: 'RESPONSE' | 'NETWORK_ERROR';
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
}

export interface AttachOptions {
  /** The loopback RouteSpec proxy origin, e.g. `http://127.0.0.1:43123`. */
  readonly origin: string;
  readonly credentials: AdapterCredentials;
  /** Total transport attempts for a request that got no response (default 2, max 3). */
  readonly maxAttempts?: number;
}

// String keys: axios's mergeConfig keeps unknown string keys on a re-issued request (symbols are dropped).
const ATTEMPT = '__routespecAttempt';
const TRANSPORT_ID = '__routespecTransportId';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCAL_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CLIENT_INSTANCE = /^[A-Za-z0-9._:-]{16,128}$/;
const PROTECTED_ROUTES = new Set(['/v0/quote', '/v0/deposit/submit', '/v0/status']);

function fail(
  code: 'RS_ADAPTER_MISMATCH' | 'RS_SCHEMA_INVALID' | 'RS_STALE_FENCING_EPOCH' | 'RS_IDENTITY_MISMATCH',
  message: string,
): never {
  throw new RouteSpecError(code, message);
}

function loopbackOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return fail('RS_SCHEMA_INVALID', 'RouteSpec origin is not a URL.');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '' || url.pathname !== '/') {
    fail('RS_SCHEMA_INVALID', 'RouteSpec origin must be http://127.0.0.1:<port>.');
  }
  return url.origin;
}

function validCredentials(c: AdapterCredentials): AdapterCredentials {
  if (
    (c.purpose !== 'EXECUTION' && c.purpose !== 'RECONCILIATION_ONLY') ||
    typeof c.token !== 'string' ||
    c.token.length < 16 ||
    !UUID.test(c.sessionId) ||
    !UUID.test(c.caseRunId) ||
    !CLIENT_INSTANCE.test(c.clientInstanceId) ||
    !Number.isSafeInteger(c.fencingEpoch) ||
    c.fencingEpoch < 0
  ) {
    fail('RS_SCHEMA_INVALID', 'Adapter credentials are malformed.');
  }
  if (c.adapterRevision !== ADAPTER_REVISION) {
    fail('RS_ADAPTER_MISMATCH', 'Credentials were issued for a different adapter revision.');
  }
  return Object.freeze({ ...c });
}

/** Header bag helpers that work with both axios `AxiosHeaders` and plain objects. */
function headerNames(headers: unknown): string[] {
  if (headers === null || typeof headers !== 'object') return [];
  const h = headers as { toJSON?: () => Record<string, unknown> };
  const source = typeof h.toJSON === 'function' ? h.toJSON() : (headers as Record<string, unknown>);
  return Object.keys(source);
}

function setHeader(headers: unknown, name: string, value: string): void {
  const h = headers as { set?: (n: string, v: string) => void } & Record<string, unknown>;
  if (typeof h.set === 'function') h.set(name, value);
  else h[name] = value;
}

function deleteHeader(headers: unknown, name: string): void {
  const h = headers as { delete?: (n: string) => void } & Record<string, unknown>;
  if (typeof h.delete === 'function') h.delete(name);
  for (const key of Object.keys(h)) if (key.toLowerCase() === name.toLowerCase()) delete h[key];
}

function stripRouteSpecHeaders(headers: unknown): void {
  for (const name of headerNames(headers)) {
    if (name.toLowerCase().startsWith('x-routespec-')) deleteHeader(headers, name);
  }
}

function bodyObject(data: unknown): Record<string, unknown> | null {
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data) as unknown;
      return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : null;
}

export class RouteSpecClientAdapter {
  readonly revision = ADAPTER_REVISION;
  readonly origin: string;
  private readonly sdk: OfficialSdkHandle;
  private readonly maxAttempts: number;
  private readonly previousBase: string;
  private readonly previousHeaders: unknown;
  private readonly requestInterceptor: number;
  private readonly responseInterceptor: number;
  private credentials: AdapterCredentials;
  private logicalJob: string | null = null;
  private readonly runOperations = new Map<string, string>();
  private readonly records: TransportRecord[] = [];
  private detached = false;

  private constructor(sdk: OfficialSdkHandle, options: AttachOptions) {
    this.sdk = sdk;
    this.origin = loopbackOrigin(options.origin);
    this.credentials = validCredentials(options.credentials);
    this.maxAttempts = Math.min(Math.max(options.maxAttempts ?? 2, 1), 3);
    this.previousBase = sdk.OpenAPI.BASE;
    this.previousHeaders = sdk.OpenAPI.HEADERS;
    sdk.OpenAPI.BASE = this.origin;
    this.requestInterceptor = sdk.axios.interceptors.request.use((config) => this.onRequest(config));
    this.responseInterceptor = sdk.axios.interceptors.response.use(
      (response) => this.onResponse(response),
      (error) => this.onError(error),
    );
  }

  /**
   * Attach to the exact pinned official SDK. Any other package or version, or an SDK whose
   * embedded API version differs from the pin, is refused before anything is changed.
   */
  static attach(sdk: OfficialSdkHandle, options: AttachOptions): RouteSpecClientAdapter {
    if (sdk.packageName !== ONECLICK_SDK_PIN.packageName || sdk.packageVersion !== ONECLICK_SDK_PIN.version) {
      fail('RS_ADAPTER_MISMATCH', 'The adapter supports only the exact pinned official SDK.');
    }
    if (sdk.OpenAPI.VERSION !== ONECLICK_SDK_PIN.embeddedApiVersion) {
      fail('RS_ADAPTER_MISMATCH', 'The SDK embedded API version differs from the pin.');
    }
    if (
      typeof sdk.axios?.interceptors?.request?.use !== 'function' ||
      typeof sdk.axios.request !== 'function'
    ) {
      fail('RS_ADAPTER_MISMATCH', 'The SDK transport does not expose the expected interceptor surface.');
    }
    return new RouteSpecClientAdapter(sdk, options);
  }

  /** Declare the logical job for the next quote request(s). */
  setLogicalJob(key: string): void {
    if (!LOCAL_ID.test(key)) fail('RS_SCHEMA_INVALID', 'Logical job key is malformed.');
    this.logicalJob = key;
  }

  /**
   * Replace credentials inside the same case (for example the reconciliation-only token issued
   * after an unknown outcome). Session, case, and client instance must be identical and the
   * fencing epoch may only move forward.
   */
  updateCredentials(next: AdapterCredentials): void {
    const c = validCredentials(next);
    const cur = this.credentials;
    if (
      c.sessionId !== cur.sessionId ||
      c.caseRunId !== cur.caseRunId ||
      c.clientInstanceId !== cur.clientInstanceId
    ) {
      fail('RS_IDENTITY_MISMATCH', 'Credential update must stay within the same session, case, and client.');
    }
    if (c.fencingEpoch <= cur.fencingEpoch) {
      fail('RS_STALE_FENCING_EPOCH', 'Credential update must advance the fencing epoch.');
    }
    this.credentials = c;
  }

  /** Next-case reset: new credentials for a different session/case/client; correlation cleared. */
  reset(next: AdapterCredentials): void {
    const c = validCredentials(next);
    const cur = this.credentials;
    if (
      c.sessionId === cur.sessionId ||
      c.caseRunId === cur.caseRunId ||
      c.clientInstanceId === cur.clientInstanceId
    ) {
      fail('RS_IDENTITY_MISMATCH', 'A reset requires a fresh session, case, and client instance.');
    }
    if (c.purpose !== 'EXECUTION') fail('RS_SCHEMA_INVALID', 'A new case starts with an execution token.');
    this.credentials = c;
    this.logicalJob = null;
    this.runOperations.clear();
  }

  runOperationFor(depositAddress: string): string | null {
    return this.runOperations.get(depositAddress) ?? null;
  }

  get log(): readonly TransportRecord[] {
    return this.records.map((r) => ({ ...r }));
  }

  /** Teardown: remove interceptors and restore the SDK's base URL and header resolver. */
  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.sdk.axios.interceptors.request.eject(this.requestInterceptor);
    this.sdk.axios.interceptors.response.eject(this.responseInterceptor);
    this.sdk.OpenAPI.BASE = this.previousBase;
    this.sdk.OpenAPI.HEADERS = this.previousHeaders;
    this.runOperations.clear();
  }

  // -------------------------------------------------------------------------------------------

  private target(config: AxiosConfigLike): { proxy: boolean; route: string; query: URLSearchParams } {
    try {
      const url = new URL(String(config.url ?? ''));
      return { proxy: url.origin === this.origin, route: url.pathname, query: url.searchParams };
    } catch {
      return { proxy: false, route: 'invalid', query: new URLSearchParams() };
    }
  }

  private correlate(route: string, config: AxiosConfigLike, query: URLSearchParams): string | null {
    if (route === '/v0/deposit/submit') {
      const address = bodyObject(config.data)?.['depositAddress'];
      return typeof address === 'string' ? (this.runOperations.get(address) ?? null) : null;
    }
    if (route === '/v0/status') {
      const address = query.get('depositAddress');
      return address !== null ? (this.runOperations.get(address) ?? null) : null;
    }
    return null;
  }

  private onRequest(config: AxiosConfigLike): AxiosConfigLike {
    if (this.detached) return config;
    const { proxy, route, query } = this.target(config);
    stripRouteSpecHeaders(config.headers);
    const attempt = typeof config[ATTEMPT] === 'number' ? (config[ATTEMPT] as number) : 1;
    config[ATTEMPT] = attempt;
    const transportRequestId = `tr-${randomUUID()}`;
    config[TRANSPORT_ID] = transportRequestId;
    if (!proxy) return config; // live boundary: no RouteSpec header or token leaves loopback
    const c = this.credentials;
    const h = ADAPTER_HEADERS;
    setHeader(config.headers, h.session, c.sessionId);
    setHeader(config.headers, h.caseRun, c.caseRunId);
    setHeader(config.headers, h.adapter, c.adapterRevision);
    setHeader(config.headers, h.fencingEpoch, String(c.fencingEpoch));
    setHeader(config.headers, h.clientInstance, c.clientInstanceId);
    setHeader(config.headers, h.caseToken, c.token);
    setHeader(config.headers, h.requestId, transportRequestId);
    if (route === '/v0/quote' && this.logicalJob !== null)
      setHeader(config.headers, h.logicalJob, this.logicalJob);
    const runOperationId = this.correlate(route, config, query);
    if (runOperationId !== null) setHeader(config.headers, h.runOperation, runOperationId);
    return config;
  }

  private record(
    config: AxiosConfigLike,
    outcome: TransportRecord['outcome'],
    response: AxiosResponseLike | null,
  ): void {
    const { proxy, route, query } = this.target(config);
    const c = this.credentials;
    let runOperationId = proxy ? this.correlate(route, config, query) : null;
    if (proxy && route === '/v0/quote' && response !== null) {
      const assigned = response.headers[ADAPTER_HEADERS.runOperation];
      runOperationId = typeof assigned === 'string' && UUID.test(assigned) ? assigned : null;
    }
    const errorCode = (response?.data as { error?: { code?: unknown } } | null | undefined)?.error?.code;
    this.records.push(
      Object.freeze({
        transportRequestId: String(config[TRANSPORT_ID] ?? ''),
        attempt: Number(config[ATTEMPT] ?? 1),
        method: String(config.method ?? '').toUpperCase(),
        route: PROTECTED_ROUTES.has(route) || proxy ? route : 'other',
        target: proxy ? 'PROXY' : 'OTHER',
        sessionId: proxy ? c.sessionId : null,
        caseRunId: proxy ? c.caseRunId : null,
        logicalJob: proxy && route === '/v0/quote' ? this.logicalJob : null,
        runOperationId,
        fencingEpoch: proxy ? c.fencingEpoch : null,
        purpose: proxy ? c.purpose : null,
        outcome,
        httpStatus: response?.status ?? null,
        errorCode: typeof errorCode === 'string' ? errorCode : null,
      }),
    );
  }

  private learn(response: AxiosResponseLike): void {
    const { proxy, route } = this.target(response.config);
    if (!proxy || route !== '/v0/quote' || response.status !== 200) return;
    const assigned = response.headers[ADAPTER_HEADERS.runOperation];
    const address = (response.data as { quote?: { depositAddress?: unknown } } | null)?.quote?.depositAddress;
    if (
      typeof assigned === 'string' &&
      UUID.test(assigned) &&
      typeof address === 'string' &&
      address.length > 0
    ) {
      // Response-assigned deposit address -> RouteSpec-assigned run operation.
      this.runOperations.set(address, assigned);
    }
  }

  private onResponse(response: AxiosResponseLike): AxiosResponseLike {
    if (!this.detached && response?.config) {
      this.learn(response);
      this.record(response.config, 'RESPONSE', response);
    }
    return response;
  }

  private onError(error: unknown): unknown {
    const e = error as AxiosErrorLike;
    if (this.detached || !e?.config) return Promise.reject(error);
    if (e.response) {
      this.record(e.config, 'RESPONSE', e.response);
      return Promise.reject(error);
    }
    this.record(e.config, 'NETWORK_ERROR', null);
    const attempt = Number(e.config[ATTEMPT] ?? 1);
    const { proxy } = this.target(e.config);
    if (!proxy || attempt >= this.maxAttempts) return Promise.reject(error);
    // Same method, URL, and body; the request interceptor assigns a new transport ID.
    return this.sdk.axios.request({ ...e.config, [ATTEMPT]: attempt + 1 });
  }
}
