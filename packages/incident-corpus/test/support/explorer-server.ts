/**
 * A loopback HTTP server that answers `GET /api/v0/transactions` the way the public Intents
 * Explorer OpenAPI document describes: bearer authentication (401 without it), one request per
 * five seconds per partner (429 otherwise), status and time-window filters, the
 * `lastDepositAddress`/`lastDepositMemo` cursor, and `search`. It serves the hand-authored
 * documented-shape recording. It is a stand-in for the documented interface only: it proves
 * nothing about the real service's data or availability.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ExplorerRecording } from '../../src/index.ts';

export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly authorization: string | null;
  readonly atMs: number;
  readonly status: number;
}

export interface FixtureServer {
  readonly origin: string;
  readonly seen: SeenRequest[];
  /** Which observation of the recording the server currently answers from. */
  observation: number;
  /** Answer the next request with this status instead (one shot). */
  failNext: number | null;
  redirectNext: string | null;
  /** Answer the next request with this JSON body and status 200 instead (one shot). */
  bodyNext: unknown;
  close(): Promise<void>;
}

export async function startExplorerFixtureServer(options: {
  port: number;
  token: string;
  recording: ExplorerRecording;
  now: () => number;
  minIntervalMs?: number;
}): Promise<FixtureServer> {
  const minInterval = options.minIntervalMs ?? 5000;
  let lastAccepted = Number.NEGATIVE_INFINITY;
  const state: FixtureServer = {
    origin: `http://127.0.0.1:${options.port}`,
    seen: [],
    observation: 0,
    failNext: null,
    redirectNext: null,
    bodyNext: undefined,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  const reply = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...headers });
    res.end(JSON.stringify(body));
    return status;
  };
  const handle = (req: IncomingMessage, res: ServerResponse): number => {
    const url = new URL(req.url ?? '/', state.origin);
    const q = url.searchParams;
    if (req.method !== 'GET' || url.pathname !== '/api/v0/transactions') {
      return reply(res, 404, { status: 404, error: { code: 'NOT_FOUND', message: 'not found' } });
    }
    if (req.headers.authorization !== `Bearer ${options.token}`) {
      return reply(res, 401, { status: 400, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    }
    if (state.redirectNext !== null) {
      const location = state.redirectNext;
      state.redirectNext = null;
      res.writeHead(302, { location, connection: 'close' });
      res.end();
      return 302;
    }
    if (state.failNext !== null) {
      const status = state.failNext;
      state.failNext = null;
      return reply(res, status, { status, error: { code: 'FIXTURE_ERROR', message: 'forced' } });
    }
    if (state.bodyNext !== undefined) {
      const body = state.bodyNext;
      state.bodyNext = undefined;
      return reply(res, 200, body);
    }
    const now = options.now();
    if (now - lastAccepted < minInterval) {
      return reply(
        res,
        429,
        { status: 429, error: { code: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded' } },
        { 'retry-after': String(Math.ceil((minInterval - (now - lastAccepted)) / 1000)) },
      );
    }
    lastAccepted = now;
    const limit = Number(q.get('numberOfTransactions') ?? '50');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      return reply(res, 400, {
        status: 400,
        error: { code: 'BAD_REQUEST', message: 'numberOfTransactions' },
      });
    }
    const statuses = (q.get('statuses') ?? 'FAILED,PROCESSING,REFUNDED,SUCCESS').split(',');
    const start = q.get('startTimestamp');
    const end = q.get('endTimestamp');
    const search = q.get('search');
    const memo = q.get('depositMemo');
    const all = (options.recording.observations[state.observation]?.transactions ?? []) as Array<
      Record<string, unknown>
    >;
    let rows = all.filter((t) => {
      const created = Date.parse(String(t['createdAt']));
      if (!statuses.includes(String(t['status']))) return false;
      if (start !== null && !(created > Date.parse(start))) return false;
      if (end !== null && !(created < Date.parse(end))) return false;
      if (search !== null && t['depositAddress'] !== search && t['recipient'] !== search) return false;
      if (memo !== null && t['depositMemo'] !== memo) return false;
      return true;
    });
    const lastAddress = q.get('lastDepositAddress');
    if (lastAddress !== null) {
      const lastMemo = q.get('lastDepositMemo');
      const at = rows.findIndex(
        (t) => t['depositAddress'] === lastAddress && (t['depositMemo'] ?? null) === lastMemo,
      );
      rows = at === -1 ? [] : rows.slice(at + 1);
    }
    return reply(res, 200, rows.slice(0, limit));
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', state.origin);
    const status = handle(req, res);
    state.seen.push({
      method: req.method ?? '',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: req.headers.authorization ?? null,
      atMs: options.now(),
      status,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => resolve());
  });
  return state;
}
