/**
 * Read-only HTTP source for the Intents Explorer API (M50).
 *
 * - One method (GET), one path (`/api/v0/transactions`), one pinned HTTPS origin. A loopback
 *   `http://127.0.0.1:<port>` origin is accepted only as a stand-in for the documented interface
 *   and makes the source a `DOCUMENTED_SHAPE_FIXTURE`, which can never be labelled as mainnet.
 * - The partner key is read once from `ROUTESPEC_EXPLORER_JWT`, removed from the environment,
 *   kept in a private field, and sent only as the `Authorization` header to the origin above.
 *   It is never printed, logged, serialised or placed in an error.
 * - The documented limit of one request per five seconds is kept by spacing requests; a 429 is
 *   honoured by waiting and retrying a bounded number of times.
 * - Redirects are refused, responses are size-capped, and a body that is not a JSON array is
 *   rejected. Raw records are returned to the importer in memory and never written anywhere.
 */
import { inspect } from 'node:util';
import { RouteSpecError } from '@routespec/contracts';
import {
  EXPLORER_API_SPEC,
  EXPLORER_ORIGIN,
  EXPLORER_TRANSACTIONS_PATH,
  buildLookupQuery,
  buildTransactionsQuery,
  type TransactionsQuery,
} from './explorer-shape.ts';
import type { SourceKind, TransactionSource } from './source.ts';

export const EXPLORER_JWT_ENV = 'ROUTESPEC_EXPLORER_JWT';

const secrets = new WeakMap<ExplorerToken, string>();

/** Opaque holder of the partner key. Nothing but `ExplorerHttpSource` can read the value. */
export class ExplorerToken {
  constructor(value: string) {
    secrets.set(this, value);
    Object.freeze(this);
  }
  toString(): string {
    return '[ExplorerToken]';
  }
  toJSON(): string {
    return '[ExplorerToken]';
  }
  [inspect.custom](): string {
    return '[ExplorerToken]';
  }
}

/** Read the partner key from the environment and remove it from there. The value is never echoed. */
export function loadExplorerToken(env: Record<string, string | undefined>): ExplorerToken {
  const raw = env[EXPLORER_JWT_ENV];
  delete env[EXPLORER_JWT_ENV];
  if (raw === undefined || raw.trim() === '') {
    throw new RouteSpecError(
      'RS_CLI_USAGE',
      `The Explorer API key is required in the ${EXPLORER_JWT_ENV} environment variable.`,
      { details: { variable: EXPLORER_JWT_ENV } },
    );
  }
  const value = raw.trim();
  const parts = value.split('.');
  if (value.length > 8192 || parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) {
    throw new RouteSpecError('RS_TOKEN_INVALID', 'The Explorer API key is not a compact JWT.', {
      details: { variable: EXPLORER_JWT_ENV },
    });
  }
  return new ExplorerToken(value);
}

export interface ExplorerHttpSourceOptions {
  readonly origin: string;
  readonly token: ExplorerToken;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Minimum spacing of requests. Default: the documented five seconds plus a small margin. */
  readonly minIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxRetriesOn429?: number;
  /** Retries of one request after a transport error or a 5xx answer. Default 2. */
  readonly maxTransientRetries?: number;
}

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

function sourceKindOf(origin: string): SourceKind {
  if (origin === EXPLORER_ORIGIN) return 'INTENTS_EXPLORER_API';
  if (/^http:\/\/127\.0\.0\.1:[1-9][0-9]{1,4}$/.test(origin)) return 'DOCUMENTED_SHAPE_FIXTURE';
  throw new RouteSpecError('RS_HOST_REJECTED', 'Only the pinned Explorer origin can be contacted.', {
    details: { pinned: EXPLORER_ORIGIN },
  });
}

export class ExplorerHttpSource implements TransactionSource {
  readonly kind: SourceKind;
  readonly #origin: string;
  readonly #token: ExplorerToken;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #minIntervalMs: number;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #maxTransient: number;
  #lastRequestAt: number | null = null;
  #rateLimited = 0;

  constructor(options: ExplorerHttpSourceOptions) {
    this.kind = sourceKindOf(options.origin);
    this.#origin = options.origin;
    this.#token = options.token;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#minIntervalMs = options.minIntervalMs ?? EXPLORER_API_SPEC.minRequestIntervalMs + 200;
    this.#timeoutMs = options.requestTimeoutMs ?? 60_000;
    this.#maxRetries = options.maxRetriesOn429 ?? 5;
    this.#maxTransient = options.maxTransientRetries ?? 2;
  }

  nowMs(): number {
    return this.#now();
  }

  wait(ms: number): Promise<void> {
    return this.#sleep(ms);
  }

  rateLimitedCount(): number {
    return this.#rateLimited;
  }

  listPage(query: TransactionsQuery): Promise<unknown[]> {
    return this.#get(buildTransactionsQuery(query));
  }

  lookup(depositAddress: string, depositMemo: string | null): Promise<unknown[]> {
    return this.#get(buildLookupQuery(depositAddress, depositMemo));
  }

  async #get(params: URLSearchParams): Promise<unknown[]> {
    const url = `${this.#origin}${EXPLORER_TRANSACTIONS_PATH}?${params.toString()}`;
    let transientLeft = this.#maxTransient;
    let rateLimitedHere = 0;
    for (;;) {
      if (this.#lastRequestAt !== null) {
        const since = this.#now() - this.#lastRequestAt;
        if (since < this.#minIntervalMs) await this.#sleep(this.#minIntervalMs - since);
      }
      this.#lastRequestAt = this.#now();
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${secrets.get(this.#token) as string}`,
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch {
        if (transientLeft > 0) {
          transientLeft--;
          continue;
        }
        // The cause is deliberately dropped: a transport error text can echo request details.
        throw new RouteSpecError('RS_IMPORT_BLOCKED', 'The Explorer API could not be reached.', {
          recoverable: true,
          details: { stage: 'transport' },
        });
      }
      const status = response.status;
      if (status === 429) {
        await response.body?.cancel().catch(() => undefined);
        this.#rateLimited++;
        rateLimitedHere++;
        if (rateLimitedHere > this.#maxRetries) {
          throw new RouteSpecError('RS_RATE_LIMITED', 'The Explorer API kept answering 429.', {
            recoverable: true,
            details: { attempts: rateLimitedHere },
          });
        }
        const hinted = Number(response.headers.get('retry-after'));
        const waitMs =
          Number.isFinite(hinted) && hinted > 0 && hinted <= 600
            ? Math.ceil(hinted * 1000)
            : EXPLORER_API_SPEC.minRequestIntervalMs;
        await this.#sleep(Math.max(waitMs, EXPLORER_API_SPEC.minRequestIntervalMs));
        continue;
      }
      if (status >= 300 && status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new RouteSpecError(
          'RS_HOST_REJECTED',
          'The Explorer API answered with a redirect; it was not followed.',
          {
            details: { httpStatus: status },
          },
        );
      }
      if (status === 401 || status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new RouteSpecError('RS_TOKEN_INVALID', 'The Explorer API rejected the key.', {
          details: { httpStatus: status, variable: EXPLORER_JWT_ENV },
        });
      }
      if (status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        if (status >= 500 && transientLeft > 0) {
          transientLeft--;
          continue;
        }
        throw new RouteSpecError('RS_IMPORT_BLOCKED', `The Explorer API answered HTTP ${status}.`, {
          recoverable: status >= 500,
          details: { httpStatus: status },
        });
      }
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new RouteSpecError('RS_IMPORT_LIMIT_EXCEEDED', 'The Explorer API response is too large.');
      }
      let body: unknown;
      try {
        const text = await response.text();
        if (text.length > MAX_RESPONSE_BYTES) {
          throw new RouteSpecError('RS_IMPORT_LIMIT_EXCEEDED', 'The Explorer API response is too large.');
        }
        body = JSON.parse(text);
      } catch (error) {
        if (error instanceof RouteSpecError) throw error;
        throw new RouteSpecError('RS_SCHEMA_INVALID', 'The Explorer API response is not JSON.');
      }
      if (!Array.isArray(body)) {
        throw new RouteSpecError(
          'RS_SCHEMA_INVALID',
          'The Explorer API response is not the documented array.',
        );
      }
      return body;
    }
  }
}
