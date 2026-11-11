/**
 * T-042 — Parser and service resource limits hold under abuse. Covers NFR-06.
 *
 * Abuse is aimed at the real listeners over raw TCP sockets: the control service (bounded
 * strict JSON, rate limits, connection and slow-client limits) and the networkless scenario
 * proxy (denial flood). Parser limits are exercised through the real import pipeline and the
 * service's scenario validation. After every attack the service must still answer a normal
 * authenticated request, the journal must pass an integrity check, and the process must not
 * have grown by more than a bounded amount.
 */
import { connect, type Socket } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_SCENARIO_SOURCES } from '@routespec/scenario';
import { importUserFile } from '@routespec/regressions';
import { CaseSupervisor, ScenarioProxy } from '@routespec/proxy';
import { ImportJournal } from '@routespec/store';
import {
  errorCode,
  expectOk,
  raw,
  startHarness,
  type Harness,
} from '../../control-api/test/support/fixture.ts';
import { compileCore, createGate, send } from '../../proxy/test/support/gate.ts';

const WINDOW_MS = 2_000;
const HEADERS_TIMEOUT_MS = 1_500;
const REQUEST_TIMEOUT_MS = 3_000;
const MAX_CONNECTIONS = 64;

let h: Harness;

beforeAll(async () => {
  h = await startHarness({
    rateLimits: { windowMs: WINDOW_MS, reads: 400, mutations: 200, authFailures: 20 },
    limits: {
      headersTimeoutMs: HEADERS_TIMEOUT_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      maxConnections: MAX_CONNECTIONS,
    },
  });
});

afterAll(async () => {
  await h?.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the current rate-limit window has certainly rolled over. */
const nextWindow = () => sleep(WINDOW_MS + 200);

async function healthy(): Promise<void> {
  const r = await h.api('GET', '/settings');
  expect(r.status, r.text.slice(0, 200)).toBe(200);
}

function rss(): number {
  return process.memoryUsage().rss;
}

interface RawSocketResult {
  readonly status: number | null;
  readonly closedByServerAfterMs: number | null;
  readonly bytesSent: number;
}

/**
 * Open a raw socket, send `head`, then keep writing `chunk` every `everyMs` (or never). Reports
 * the response status line, when the server closed the connection, and how much was sent.
 */
function abuse(
  head: string,
  options: { chunk?: Buffer; everyMs?: number; maxMs: number; byteByByteHead?: number },
): Promise<RawSocketResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket: Socket = connect({ host: '127.0.0.1', port: h.port });
    let response = '';
    let bytesSent = 0;
    let closedAt: number | null = null;
    let timer: NodeJS.Timeout | null = null;
    const finish = () => {
      if (timer) clearInterval(timer);
      const m = /^HTTP\/1\.1 (\d{3})/.exec(response);
      resolve({ status: m ? Number(m[1]) : null, closedByServerAfterMs: closedAt, bytesSent });
    };
    socket.on('data', (c: Buffer) => (response += c.toString('latin1')));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      closedAt ??= Date.now() - started;
      finish();
    });
    const write = (b: Buffer | string) => {
      if (socket.destroyed || socket.writableEnded) return;
      const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
      bytesSent += buf.length;
      socket.write(buf);
    };
    socket.once('connect', () => {
      if (options.byteByByteHead !== undefined) {
        let i = 0;
        timer = setInterval(() => {
          if (i < head.length) write(head[i++] as string);
        }, options.byteByByteHead);
      } else {
        write(head);
        if (options.chunk && options.everyMs !== undefined) {
          timer = setInterval(() => write(options.chunk as Buffer), options.everyMs);
        }
      }
    });
    setTimeout(() => {
      if (!socket.destroyed) {
        closedAt = null;
        socket.destroy();
      }
    }, options.maxMs);
  });
}

function head(method: string, path: string, headers: Record<string, string>): string {
  const lines = [`${method} ${path} HTTP/1.1`, `host: 127.0.0.1:${h.port}`];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

const auth = () => ({ authorization: `Bearer ${h.token}`, 'content-type': 'application/json' });

describe('T-042 — Parser and service resource limits hold under abuse', () => {
  it('a declared oversized body is refused without being read', async () => {
    const r = await abuse(
      head('POST', '/__routespec/v1/projects', {
        ...auth(),
        'idempotency-key': 'k-oversize-1',
        'content-length': String(64 * 1024 * 1024),
      }),
      { maxMs: 5_000 },
    );
    expect(r.status).toBe(413);
    expect(r.closedByServerAfterMs).not.toBeNull();
    await healthy();
  });

  it('an endless chunked body is cut off at the cap and the connection is closed', async () => {
    const before = rss();
    const chunk = Buffer.concat([
      Buffer.from(`10000\r\n`, 'latin1'),
      Buffer.alloc(0x10000, 0x5b),
      Buffer.from('\r\n', 'latin1'),
    ]);
    const r = await abuse(
      head('POST', '/__routespec/v1/projects', {
        ...auth(),
        'idempotency-key': 'k-chunked-1',
        'transfer-encoding': 'chunked',
      }),
      { chunk, everyMs: 5, maxMs: 8_000 },
    );
    expect(r.status).toBe(413);
    expect(r.closedByServerAfterMs, 'server closed the connection').not.toBeNull();
    expect(r.closedByServerAfterMs as number).toBeLessThan(4_000);
    expect(rss() - before).toBeLessThan(96 * 1024 * 1024);
    await healthy();
  });

  it('deep nesting, duplicate keys, and wide documents fail closed quickly', async () => {
    const started = Date.now();
    const deep = '['.repeat(200_000);
    const r1 = await raw(h.port, {
      method: 'POST',
      path: '/__routespec/v1/scenarios/validate',
      headers: auth(),
      body: `{"source":${deep}`,
    });
    expect(r1.status).toBe(400);
    expect(errorCode(r1)).toBe('RS_SCHEMA_INVALID');
    const dup = `{"source":"a",${Array.from({ length: 5_000 }, () => '"source":"a"').join(',')}}`;
    const r2 = await raw(h.port, {
      method: 'POST',
      path: '/__routespec/v1/scenarios/validate',
      headers: auth(),
      body: dup,
    });
    expect(r2.status).toBe(400);
    // A wide collection just under the byte cap (zod advisory: oversized constrained
    // collections): the byte cap bounds the element count before schema validation runs.
    const before = rss();
    const wide = `{"projectId":"00000000-0000-4000-8000-000000000001","label":"w","cases":[${Array.from({ length: 120_000 }, () => '0').join(',')}]}`;
    expect(Buffer.byteLength(wide)).toBeLessThan(262_144);
    const r3 = await raw(h.port, {
      method: 'POST',
      path: '/__routespec/v1/corpora',
      headers: { ...auth(), 'idempotency-key': 'k-wide-collection-1' },
      body: wide,
    });
    expect(r3.status).toBe(400);
    expect(rss() - before).toBeLessThan(96 * 1024 * 1024);
    expect(Date.now() - started).toBeLessThan(5_000);
    await healthy();
  });

  it('compressed bodies are never inflated (decompression bomb)', async () => {
    const bomb = gzipSync(Buffer.alloc(256 * 1024 * 1024, 0));
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const before = rss();
    for (const encoding of ['gzip', 'deflate', 'br', 'gzip, identity', 'identity, gzip']) {
      const r = await raw(h.port, {
        method: 'POST',
        path: '/__routespec/v1/scenarios/validate',
        headers: { ...auth(), 'content-encoding': encoding },
        body: bomb.toString('latin1'),
      });
      expect([413, 415], `${encoding}: ${r.status}`).toContain(r.status);
    }
    expect(rss() - before).toBeLessThan(96 * 1024 * 1024);
    await healthy();
  });

  it('slow clients are disconnected: dribbled headers and dribbled bodies', async () => {
    const slowHeaders = Array.from({ length: 8 }, () =>
      abuse(head('GET', '/__routespec/v1/settings', { authorization: `Bearer ${h.token}` }), {
        byteByByteHead: 250,
        maxMs: 15_000,
      }),
    );
    const slowBody = Array.from({ length: 4 }, (_, i) =>
      abuse(
        head('POST', '/__routespec/v1/projects', {
          ...auth(),
          'idempotency-key': `k-slow-body-${i}-x`,
          'content-length': '4096',
        }),
        { chunk: Buffer.from('{', 'latin1'), everyMs: 250, maxMs: 15_000 },
      ),
    );
    const results = await Promise.all([...slowHeaders, ...slowBody]);
    for (const [i, r] of results.entries()) {
      expect(r.closedByServerAfterMs, `slow client ${i} was disconnected by the server`).not.toBeNull();
      expect(r.closedByServerAfterMs as number, `slow client ${i}`).toBeLessThan(REQUEST_TIMEOUT_MS + 3_000);
    }
    await healthy();
  });

  it('a connection flood is capped and the service recovers when it ends', async () => {
    const sockets: Socket[] = [];
    let closedEarly = 0;
    await Promise.all(
      Array.from(
        { length: 400 },
        () =>
          new Promise<void>((resolve) => {
            const s = connect({ host: '127.0.0.1', port: h.port });
            sockets.push(s);
            s.on('error', () => undefined);
            s.on('close', () => closedEarly++);
            s.once('connect', () => resolve());
            s.once('error', () => resolve());
          }),
      ),
    );
    await sleep(1_000);
    const open = sockets.filter((s) => !s.destroyed && s.readyState === 'open').length;
    expect(open, `${open} idle connections held open`).toBeLessThanOrEqual(MAX_CONNECTIONS);
    expect(closedEarly).toBeGreaterThan(0);
    for (const s of sockets) s.destroy();
    await sleep(300);
    await healthy();
  });

  it('request floods and authentication-failure floods are rate limited, then recover', async () => {
    await nextWindow();
    // 600 requests in waves of 40 concurrent connections (under the connection cap).
    const statuses: number[] = [];
    for (let i = 0; i < 600; i += 40) {
      statuses.push(
        ...(await Promise.all(
          Array.from({ length: 40 }, () => h.api('GET', '/settings').then((r) => r.status)),
        )),
      );
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === 200 || s === 429)).toBe(true);
    await nextWindow();
    await healthy();
    const bad = await Promise.all(
      Array.from({ length: 40 }, () =>
        h.api('GET', '/settings', undefined, { token: 'rsctl_wrongwrongwrongwrongwrong' }),
      ),
    );
    expect(bad.some((r) => r.status === 429)).toBe(true);
    // During the lockout window even the real token is refused (no oracle for guessing).
    expect((await h.api('GET', '/settings')).status).toBe(429);
    await nextWindow();
    await healthy();
  });

  it('huge virtual delays and over-budget scenarios are refused by the service without executing', async () => {
    const base = CORE_SCENARIO_SOURCES['accepted-then-lost-response'] as string;
    const huge = base.replace(/ms: \d+/, 'ms: 900000000000000');
    expect(huge).not.toBe(base);
    const r = expectOk(await h.api('POST', '/scenarios/validate', { source: huge }), 200);
    expect(r['valid']).toBe(false);
    expect(JSON.stringify(r['errors'])).toMatch(/RS_SCENARIO_(LIMIT_EXCEEDED|INVALID)/);
    expect(r['persisted']).toBe(false);
    await healthy();
  });

  it('deeply nested YAML is refused with a typed error, not a parser stack overflow', async () => {
    // GHSA-48c2-rrv3-qjmp: yaml < 2.8.3 recurses without a bound on nested flow collections.
    for (const levels of [2_000, 8_000, 20_000]) {
      const source = `schemaVersion: "1.0"
steps: ${'['.repeat(levels)}${']'.repeat(levels)}
`;
      const r = await h.api('POST', '/scenarios/validate', { source });
      expect(r.status, `${levels} levels: ${r.text.slice(0, 160)}`).toBe(200);
      expect(r.json?.['valid']).toBe(false);
      expect(JSON.stringify(r.json?.['errors'])).toMatch(
        /RS_SCENARIO_(LIMIT_EXCEEDED|INVALID|UNSAFE_CONSTRUCT)/,
      );
    }
    await healthy();
  });

  it('an imported event flood is rejected by the parser limits and persists no content', async () => {
    const imports = new ImportJournal(h.store);
    const project = expectOk(await h.api('POST', '/projects', { name: 'flood' }), 201);
    // 20,000 events of 13 nodes each: past the default node budget (200,000) of the bounded reader.
    const events = Array.from({ length: 20_000 }, (_, i) => ({
      seq: i,
      kind: 'X',
      v: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    }));
    const r = await importUserFile(imports, {
      projectId: String(project['projectId']),
      filename: 'flood.json',
      source: [Buffer.from(JSON.stringify({ schema: 'routespec.trace/1', events }), 'utf8')],
      idempotencyKey: 'k-import-flood-1',
    });
    const view = imports.getImport(r.importId);
    expect(view.state).toBe('REJECTED');
    expect(view.sanitized).toBeNull();
    expect(view.findings.map((f) => f.category).some((c) => c.startsWith('RESOURCE_'))).toBe(true);
  });

  it('a denial flood against the proxy does not grow the journal without bound', async () => {
    const compiled = compileCore('happy-path');
    createGate(h.store, compiled, { label: 't042-proxy' });
    const supervisor = new CaseSupervisor(h.store, { ownerLabel: 't042' });
    const proxy = await ScenarioProxy.start({ store: h.store, mode: 'SIMULATE', cases: supervisor });
    try {
      const auditsBefore = h.store.countRows('audit_events');
      const total = 3_000;
      for (let i = 0; i < total; i += 50) {
        await Promise.all(
          Array.from({ length: 50 }, (_, j) =>
            send(proxy.port, {
              method: 'GET',
              path: `/v0/unknown-${i + j}`,
              headers: { connection: 'close' },
            }),
          ),
        );
      }
      const grown = h.store.countRows('audit_events') - auditsBefore;
      expect(proxy.stats.denied).toBeGreaterThanOrEqual(total);
      expect(grown, `${grown} audit rows for ${total} denials`).toBeLessThan(total / 2);
      // Still serving: a well-formed but unauthenticated quote is still a typed denial.
      const r = await send(proxy.port, { method: 'POST', path: '/v0/quote', body: {} });
      expect(r.status).toBe(401);
    } finally {
      await proxy.close();
    }
  });

  it('after all abuse the journal is intact and the service reports bounded, coded metrics', async () => {
    const check = h.store.journal.read((db) => db.prepare('PRAGMA integrity_check').get()) as Record<
      string,
      unknown
    >;
    expect(Object.values(check)[0]).toBe('ok');
    await nextWindow();
    const m = expectOk(await h.api('GET', '/metrics'), 200);
    expect(m['telemetry']).toBe('OFF');
    const refused = m['refused'] as Record<string, number>;
    for (const code of [
      'RS_BODY_TOO_LARGE',
      'RS_CONTENT_TYPE_UNSUPPORTED',
      'RS_RATE_LIMITED',
      'RS_SCHEMA_INVALID',
    ]) {
      expect(refused[code] ?? 0, code).toBeGreaterThan(0);
    }
    expect(JSON.stringify(m)).not.toContain(h.token);
  });
});
