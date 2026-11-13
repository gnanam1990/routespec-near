/**
 * M50: the read-only Explorer HTTP source, exercised over real HTTP against a loopback server
 * that implements the documented interface (authentication, rate limit, filters, cursor).
 * Time is a shared injected clock, so the five-second rule is checked without waiting.
 *
 * Not covered here, and still pending: a request to the real service (it needs the owner's key).
 */
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RouteSpecError } from '@routespec/contracts';
import {
  EXPLORER_JWT_ENV,
  EXPLORER_ORIGIN,
  ExplorerHttpSource,
  RecordingSource,
  buildCorpus,
  loadExplorerToken,
  runImport,
} from '../src/index.ts';
import { startExplorerFixtureServer, type FixtureServer } from './support/explorer-server.ts';
import { WINDOW, fixtureDoc } from './support/fixture.ts';

/** Loopback ports for the stand-in server: `M50_FIXTURE_PORTS` (comma-separated) or this window. */
const PORTS = (process.env['M50_FIXTURE_PORTS'] ?? '9519,9518,9517,9516')
  .split(',')
  .map((p) => Number(p.trim()))
  .filter((p) => Number.isInteger(p) && p >= 1024 && p <= 65535);
// Three base64url segments, assembled at run time; it is not a credential for any service.
const TOKEN = ['dGVzdC1oZWFkZXI', 'dGVzdC1wYXlsb2Fk', 'dGVzdC1zaWduYXR1cmU'].join('.');
const T1 = Date.parse('2026-11-13T12:00:00.000Z');

let server: FixtureServer;
let clock = T1;
let sleeps: number[] = [];

function source(overrides: Partial<ConstructorParameters<typeof ExplorerHttpSource>[0]> = {}) {
  return new ExplorerHttpSource({
    origin: server.origin,
    token: loadExplorerToken({ [EXPLORER_JWT_ENV]: TOKEN }),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      if (ms >= 3_600_000) server.observation = 1;
    },
    ...overrides,
  });
}

async function codeOf(p: Promise<unknown>): Promise<{ code: string; text: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RouteSpecError)
      return { code: e.code, text: `${e.message} ${JSON.stringify(e.details)}` };
    throw e;
  }
  return { code: 'NO_ERROR', text: '' };
}

beforeEach(async () => {
  clock = T1;
  sleeps = [];
  server = await startExplorerFixtureServer({
    ports: PORTS,
    token: TOKEN,
    recording: fixtureDoc(),
    now: () => clock,
  });
});
afterEach(async () => {
  await server.close();
});

describe('M50 Explorer HTTP source', () => {
  it('reads every page with the bearer credential, the documented parameters and the cursor', async () => {
    const summary = await runImport(source(), {
      window: WINDOW,
      stuckAfterSec: 900,
      recheckAfterSec: 3600,
      pageSize: 5,
    });
    const viaRecording = await runImport(new RecordingSource(fixtureDoc()), {
      window: WINDOW,
      stuckAfterSec: 900,
      recheckAfterSec: 3600,
      pageSize: 5,
    });
    expect(summary.counts).toEqual(viaRecording.counts);
    expect(buildCorpus(summary, { label: 'explorer-shape-fixture' }).manifest.manifestDigest).toBe(
      buildCorpus(viaRecording, { label: 'explorer-shape-fixture' }).manifest.manifestDigest,
    );
    expect(summary.counts.pagesRead).toBe(3);
    expect(summary.sourceKind).toBe('DOCUMENTED_SHAPE_FIXTURE');

    const listing = server.seen.filter((r) => r.query['search'] === undefined);
    const lookups = server.seen.filter((r) => r.query['search'] !== undefined);
    expect(listing).toHaveLength(3);
    expect(lookups).toHaveLength(4);
    for (const r of server.seen) {
      expect(r.method).toBe('GET');
      expect(r.path).toBe('/api/v0/transactions');
      expect(r.authorization).toBe(`Bearer ${TOKEN}`);
      expect(r.status).toBe(200);
    }
    expect(listing[0]!.query).toEqual({
      numberOfTransactions: '5',
      statuses: 'FAILED,INCOMPLETE_DEPOSIT,PROCESSING,REFUNDED',
      startTimestamp: WINDOW.startTimestamp,
      endTimestamp: WINDOW.endTimestamp,
      direction: 'next',
    });
    expect(listing[1]!.query['lastDepositAddress']).toBe('fixture-deposit-address-0006');
    expect(listing[1]!.query['lastDepositMemo']).toBeUndefined();
    expect(listing[2]!.query['lastDepositAddress']).toBe('fixture-deposit-address-0011');
    // One request every five seconds per partner: never two requests closer than that.
    for (let i = 1; i < server.seen.length; i++) {
      expect(server.seen[i]!.atMs - server.seen[i - 1]!.atMs).toBeGreaterThanOrEqual(5000);
    }
    expect(summary.counts.rateLimited).toBe(0);
    // The second look happened after the requested wait.
    expect(sleeps.some((ms) => ms >= 3_600_000)).toBe(true);
  });

  it('passes the memo of the last record as the cursor when it has one', async () => {
    await runImport(source(), { window: WINDOW, stuckAfterSec: 900, recheckAfterSec: 0, pageSize: 4 });
    const second = server.seen[1]!;
    expect(second.query['lastDepositAddress']).toBe('fixture-deposit-address-0005');
    expect(second.query['lastDepositMemo']).toBe('12345');
  });

  it('stops at the page limit and says the import is truncated', async () => {
    const summary = await runImport(source(), {
      window: WINDOW,
      stuckAfterSec: 900,
      recheckAfterSec: 0,
      pageSize: 5,
      maxPages: 2,
    });
    expect(summary.counts.pagesRead).toBe(2);
    expect(summary.counts.recordsRead).toBe(10);
    expect(summary.counts.truncated).toBe(true);
  });

  it('backs off on 429 using the server hint and then succeeds', async () => {
    const summary = await runImport(source({ minIntervalMs: 0 }), {
      window: WINDOW,
      stuckAfterSec: 900,
      recheckAfterSec: 0,
      pageSize: 5,
    });
    expect(summary.counts.recordsRead).toBe(12);
    expect(summary.counts.rateLimited).toBe(2);
    expect(server.seen.filter((r) => r.status === 429)).toHaveLength(2);
    expect(sleeps.filter((ms) => ms >= 5000)).toHaveLength(2);
  });

  it('reports a rejected credential without repeating it', async () => {
    const wrong = ['d3Jvbmc', 'd3Jvbmc', 'd3Jvbmc'].join('.');
    const bad = source({ token: loadExplorerToken({ [EXPLORER_JWT_ENV]: wrong }) });
    const out = await codeOf(runImport(bad, { window: WINDOW, stuckAfterSec: 900, recheckAfterSec: 0 }));
    expect(out.code).toBe('RS_TOKEN_INVALID');
    expect(out.text).not.toContain(wrong);
    expect(out.text).not.toContain('d3Jvbmc');
  });

  it('refuses a redirect, an upstream error and a body that is not the documented array', async () => {
    server.redirectNext = 'http://127.0.0.1:9512/elsewhere';
    expect((await codeOf(source().listPage(query()))).code).toBe('RS_HOST_REJECTED');
    clock += 10_000;
    server.failNext = 500;
    const upstream = await codeOf(source({ maxTransientRetries: 0 }).listPage(query()));
    expect(upstream.code).toBe('RS_IMPORT_BLOCKED');
    expect(upstream.text).toContain('500');
    clock += 10_000;
    // By default one 5xx answer is retried after the normal spacing, and the read then succeeds.
    server.failNext = 503;
    const before = server.seen.length;
    expect(await source().listPage(query())).toHaveLength(5);
    expect(server.seen.slice(before).map((r) => r.status)).toEqual([503, 200]);
    expect(server.seen.at(-1)!.atMs - server.seen.at(-2)!.atMs).toBeGreaterThanOrEqual(5000);
    clock += 10_000;
    server.bodyNext = { data: [] };
    expect((await codeOf(source().listPage(query()))).code).toBe('RS_SCHEMA_INVALID');
  });

  it('talks only to the pinned HTTPS origin, or to loopback as a labelled fixture', () => {
    const token = () => loadExplorerToken({ [EXPLORER_JWT_ENV]: TOKEN });
    const kind = (origin: string) => new ExplorerHttpSource({ origin, token: token() }).kind;
    expect(kind(EXPLORER_ORIGIN)).toBe('INTENTS_EXPLORER_API');
    expect(kind('http://127.0.0.1:9511')).toBe('DOCUMENTED_SHAPE_FIXTURE');
    for (const origin of [
      'http://explorer.near-intents.org',
      'https://explorer.near-intents.org.example.org',
      'https://example.org',
      'http://192.168.1.10:9511',
      'http://localhost.example.org:9511',
      'https://explorer.near-intents.org/api',
      'https://user@explorer.near-intents.org',
    ]) {
      expect(() => kind(origin), origin).toThrow(RouteSpecError);
    }
  });

  it('takes the credential from the environment once and never shows it', () => {
    const env: Record<string, string | undefined> = { [EXPLORER_JWT_ENV]: TOKEN, OTHER: 'kept' };
    const token = loadExplorerToken(env);
    expect(EXPLORER_JWT_ENV).toBe('ROUTESPEC_EXPLORER_JWT');
    expect(env[EXPLORER_JWT_ENV]).toBeUndefined();
    expect(env['OTHER']).toBe('kept');
    for (const text of [
      String(token),
      JSON.stringify({ token }),
      inspect(token, { depth: 5, showHidden: true }),
    ]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('dGVzdC1wYXlsb2Fk');
    }
    expect(() => loadExplorerToken({})).toThrow(/ROUTESPEC_EXPLORER_JWT/);
    for (const bad of ['', 'not a token', 'only.two', 'a.b.c d']) {
      let text = '';
      try {
        loadExplorerToken({ [EXPLORER_JWT_ENV]: bad });
      } catch (e) {
        text = e instanceof RouteSpecError ? `${e.code} ${e.message} ${JSON.stringify(e.details)}` : 'other';
      }
      expect(text, JSON.stringify(bad)).toMatch(/^RS_(TOKEN_INVALID|CLI_USAGE) /);
      if (bad.length > 3) expect(text).not.toContain(bad);
    }
  });
});

function query() {
  return {
    statuses: ['FAILED', 'REFUNDED'] as const,
    startTimestamp: WINDOW.startTimestamp,
    endTimestamp: WINDOW.endTimestamp,
    numberOfTransactions: 5,
    cursor: null,
  };
}
