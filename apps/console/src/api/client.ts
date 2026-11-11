/**
 * Typed client for the loopback control API (API-SPEC.md, prefix /__routespec/v1).
 *
 * - The control bearer token lives only in this object's memory. It is never written to
 *   localStorage, sessionStorage, IndexedDB, cookies, URLs, or logs.
 * - Every response is validated against a closed schema; a mismatch is UNSUPPORTED_SCHEMA.
 * - Read-only GET requests retry a bounded number of times on transport failure and report the
 *   attempt count. Mutations are never retried automatically: a transport failure after send
 *   is reported as "outcome unknown" so the UI reloads authoritative state instead of resending.
 * - Mutations carry an Idempotency-Key (and If-Match where the API requires a revision).
 */
import type { z } from 'zod';
import { ApiError, classifyStatus, type ApiErrorKind, type FieldError } from './errors.ts';
import {
  zCaseRun,
  zCaseRunPage,
  zCaseStart,
  zErrorEnvelope,
  zEventPage,
  zGateRun,
  zImportDetail,
  zImportPage,
  zImportRow,
  zMatrix,
  zPage,
  zProject,
  zRecoveryResult,
  zRunOperation,
  zSession,
  zSettings,
} from './schemas.ts';

export const API_PREFIX = '/__routespec/v1';

export type ConnectionState = 'CONNECTED' | 'DISCONNECTED' | 'UNAUTHENTICATED' | 'UNKNOWN';

export interface ClientOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly readAttempts?: number;
  readonly retryDelayMs?: number;
  readonly newIdempotencyKey?: () => string;
}

export interface MutationOptions {
  readonly idempotencyKey?: string;
  readonly expectedRevision?: number;
}

export interface MutationResult<T> {
  readonly data: T;
  readonly idempotencyKey: string;
}

export interface GateRunCreateInput {
  readonly projectId: string;
  readonly revisionId: string;
  readonly buildRevisionId: string;
  readonly artifactDigest: string;
  readonly subjectAttestationId: string;
  readonly corpusRevisionId: string;
  readonly effectManifestDigest: string;
  readonly effectCoveragePolicyDigest: string;
  readonly adapterRevision: string;
  readonly evaluatorRevision: string;
  readonly configurationDigest: string;
  readonly mode: 'SIMULATE' | 'REPLAY';
  readonly parallelism: number;
}

export interface ImportCreateInput {
  readonly projectId: string;
  readonly fileName: string;
  readonly content: string;
}

type Listener = (state: ConnectionState) => void;

function defaultIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ControlClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #readAttempts: number;
  readonly #retryDelayMs: number;
  readonly #newKey: () => string;
  #token: string | null = null;
  #state: ConnectionState = 'UNKNOWN';
  readonly #listeners = new Set<Listener>();

  constructor(options: ClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? '';
    this.#fetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#readAttempts = Math.min(Math.max(options.readAttempts ?? 3, 1), 5);
    this.#retryDelayMs = options.retryDelayMs ?? 250;
    this.#newKey = options.newIdempotencyKey ?? defaultIdempotencyKey;
  }

  /** Accepts the ephemeral control token. It is held in memory only. */
  setToken(token: string | null): void {
    this.#token = token !== null && token.length > 0 ? token : null;
    if (this.#token === null) this.#setState('UNAUTHENTICATED');
  }

  hasToken(): boolean {
    return this.#token !== null;
  }

  get connectionState(): ConnectionState {
    return this.#state;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  // ---------------------------------------------------------------- reads

  listProjects(signal?: AbortSignal) {
    return this.#get('/projects', zPage(zProject), signal);
  }

  getMatrix(projectId: string, signal?: AbortSignal) {
    return this.#get(`/projects/${enc(projectId)}/matrix`, zMatrix, signal);
  }

  getGateRun(gateRunId: string, signal?: AbortSignal) {
    return this.#get(`/gate-runs/${enc(gateRunId)}`, zGateRun, signal);
  }

  listCases(gateRunId: string, cursor: string | null, signal?: AbortSignal) {
    const query = cursor === null ? '?limit=200' : `?limit=200&cursor=${enc(cursor)}`;
    return this.#get(`/gate-runs/${enc(gateRunId)}/cases${query}`, zCaseRunPage, signal);
  }

  getSession(sessionId: string, signal?: AbortSignal) {
    return this.#get(`/sessions/${enc(sessionId)}`, zSession, signal);
  }

  listEvents(
    sessionId: string,
    params: { cursor?: string | null; limit?: number; runOperationId?: string | null; kind?: string | null },
    signal?: AbortSignal,
  ) {
    const search = new URLSearchParams();
    search.set('limit', String(Math.min(Math.max(params.limit ?? 100, 1), 200)));
    if (params.cursor) search.set('cursor', params.cursor);
    if (params.runOperationId) search.set('runOperationId', params.runOperationId);
    if (params.kind) search.set('kind', params.kind);
    return this.#get(`/sessions/${enc(sessionId)}/events?${search.toString()}`, zEventPage, signal);
  }

  getRunOperation(runOperationId: string, signal?: AbortSignal) {
    return this.#get(`/run-operations/${enc(runOperationId)}`, zRunOperation, signal);
  }

  listImports(projectId: string, signal?: AbortSignal) {
    return this.#get(`/projects/${enc(projectId)}/imports`, zImportPage, signal);
  }

  getImport(importId: string, signal?: AbortSignal) {
    return this.#get(`/imports/${enc(importId)}`, zImportDetail, signal);
  }

  getSettings(signal?: AbortSignal) {
    return this.#get('/settings', zSettings, signal);
  }

  // ------------------------------------------------------------ mutations

  createGateRun(input: GateRunCreateInput, options: MutationOptions = {}) {
    return this.#mutate('POST', '/gate-runs', input, zGateRun, options);
  }

  validateGateRun(gateRunId: string, options: MutationOptions = {}) {
    return this.#mutate('POST', `/gate-runs/${enc(gateRunId)}/validate`, {}, zGateRun, options);
  }

  startGateRun(gateRunId: string, options: MutationOptions = {}) {
    return this.#mutate('POST', `/gate-runs/${enc(gateRunId)}/start`, {}, zGateRun, options);
  }

  startCase(caseRunId: string, options: MutationOptions = {}) {
    return this.#mutate('POST', `/case-runs/${enc(caseRunId)}/start`, {}, zCaseStart, options);
  }

  abortCase(caseRunId: string, options: MutationOptions = {}) {
    return this.#mutate('POST', `/case-runs/${enc(caseRunId)}/abort`, {}, zCaseRun, options);
  }

  /** Fenced recovery: the only recovery action. The server returns a RECONCILIATION_ONLY token. */
  recoverCase(caseRunId: string, options: MutationOptions = {}) {
    return this.#mutate('POST', `/case-runs/${enc(caseRunId)}/recover`, {}, zRecoveryResult, options);
  }

  captureCase(caseRunId: string, options: MutationOptions = {}) {
    return this.#mutate('POST', `/case-runs/${enc(caseRunId)}/captures`, {}, zImportRow, options);
  }

  createImport(input: ImportCreateInput, options: MutationOptions = {}) {
    return this.#mutate('POST', '/imports', input, zImportRow, options);
  }

  verifyReplay(importId: string, options: MutationOptions = {}) {
    return this.#mutate('POST', `/imports/${enc(importId)}/verify-replay`, {}, zImportDetail, options);
  }

  promoteImport(importId: string, review: { reviewNote: string }, options: MutationOptions = {}) {
    return this.#mutate('POST', `/imports/${enc(importId)}/promote`, review, zImportDetail, options);
  }

  // ------------------------------------------------------------- transport

  #headers(extra: Record<string, string>): Headers {
    const headers = new Headers({ Accept: 'application/json', ...extra });
    if (this.#token !== null) headers.set('Authorization', `Bearer ${this.#token}`);
    return headers;
  }

  async #get<S extends z.ZodTypeAny>(path: string, schema: S, signal?: AbortSignal): Promise<z.infer<S>> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const response = await this.#send('GET', path, undefined, this.#headers({}), signal);
        return await this.#parse(response, schema, 'GET', path, attempt, false);
      } catch (error) {
        const transport = error instanceof ApiError && (error.kind === 'NETWORK' || error.kind === 'TIMEOUT');
        if (signal?.aborted) throw error;
        if (!transport || attempt >= this.#readAttempts) {
          if (error instanceof ApiError) throw withAttempts(error, attempt);
          throw error;
        }
        await wait(this.#retryDelayMs * attempt);
      }
    }
  }

  async #mutate<S extends z.ZodTypeAny>(
    method: 'POST' | 'DELETE',
    path: string,
    body: unknown,
    schema: S,
    options: MutationOptions,
  ): Promise<MutationResult<z.infer<S>>> {
    const idempotencyKey = options.idempotencyKey ?? this.#newKey();
    const extra: Record<string, string> = {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    };
    if (options.expectedRevision !== undefined) extra['If-Match'] = `"${options.expectedRevision}"`;
    let response: Response;
    try {
      response = await this.#send(method, path, JSON.stringify(body), this.#headers(extra));
    } catch (error) {
      if (error instanceof ApiError) {
        throw new ApiError({ ...errorInit(error), outcomeUnknown: true });
      }
      throw error;
    }
    const data = await this.#parse(response, schema, method, path, 1, true);
    return { data, idempotencyKey };
  }

  async #send(
    method: string,
    path: string,
    body: string | undefined,
    headers: Headers,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.#timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      };
      if (body !== undefined) init.body = body;
      return await this.#fetch(`${this.#baseUrl}${API_PREFIX}${path}`, init);
    } catch (error) {
      const timedOut = controller.signal.aborted && !signal?.aborted;
      if (!signal?.aborted) this.#setState('DISCONNECTED');
      throw new ApiError({
        kind: timedOut ? 'TIMEOUT' : 'NETWORK',
        message: timedOut
          ? 'The local RouteSpec service did not answer in time.'
          : 'The local RouteSpec service is not reachable.',
        status: null,
        code: null,
        requestId: null,
        recoverable: true,
        fieldErrors: [],
        method,
        path,
        attempts: 1,
        outcomeUnknown: false,
        ...(error instanceof Error && signal?.aborted ? { message: 'Request cancelled.' } : {}),
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async #parse<S extends z.ZodTypeAny>(
    response: Response,
    schema: S,
    method: string,
    path: string,
    attempts: number,
    mutation: boolean,
  ): Promise<z.infer<S>> {
    const text = await response.text();
    let json: unknown = undefined;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!response.ok) {
      const envelope = zErrorEnvelope.safeParse(json);
      const code = envelope.success ? envelope.data.error.code : null;
      const kind: ApiErrorKind = classifyStatus(response.status, code, envelope.success);
      if (kind === 'UNAUTHENTICATED' || kind === 'TOKEN_EXPIRED' || kind === 'TOKEN_REVOKED') {
        this.#setState('UNAUTHENTICATED');
      } else {
        this.#setState('CONNECTED');
      }
      const fieldErrors: FieldError[] = envelope.success
        ? [...(envelope.data.error.details?.fields ?? [])]
        : [];
      throw new ApiError({
        kind,
        message: envelope.success
          ? envelope.data.error.message
          : `The service answered HTTP ${response.status}.`,
        status: response.status,
        code,
        requestId: envelope.success ? (envelope.data.error.requestId ?? null) : null,
        recoverable: envelope.success ? (envelope.data.error.recoverable ?? false) : false,
        fieldErrors,
        method,
        path,
        attempts,
        outcomeUnknown: false,
      });
    }
    this.#setState('CONNECTED');
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError({
        kind: 'UNSUPPORTED_SCHEMA',
        message: 'The service returned a record this console version cannot interpret, so nothing is shown.',
        status: response.status,
        code: null,
        requestId: null,
        recoverable: false,
        fieldErrors: [],
        method,
        path,
        attempts,
        // A mutation whose reply cannot be read has an authoritative outcome the UI cannot show.
        outcomeUnknown: mutation,
      });
    }
    return parsed.data;
  }
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

function errorInit(error: ApiError) {
  return {
    kind: error.kind,
    message: error.message,
    status: error.status,
    code: error.code,
    requestId: error.requestId,
    recoverable: error.recoverable,
    fieldErrors: error.fieldErrors,
    method: error.method,
    path: error.path,
    attempts: error.attempts,
    outcomeUnknown: error.outcomeUnknown,
  };
}

function withAttempts(error: ApiError, attempts: number): ApiError {
  return new ApiError({ ...errorInit(error), attempts });
}

/**
 * Reads a one-time control token handed to the console in the URL fragment (`#token=...`),
 * then removes the fragment from the address bar and history so it never persists.
 */
export function takeTokenFromFragment(location: Location, history: History): string | null {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (hash.length === 0) return null;
  const params = new URLSearchParams(hash);
  const token = params.get('token');
  if (token === null) return null;
  params.delete('token');
  const rest = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`);
  return token.length > 0 ? token : null;
}
