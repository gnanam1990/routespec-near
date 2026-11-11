/**
 * T-045 — Cursor pagination is stable under concurrent append.
 *
 * The control service runs as its own process. A separately launched subject (the pinned
 * official SDK with the RouteSpec adapter) keeps polling execution status through the
 * networkless proxy, and every poll appends journal events to the session while this test pages
 * the session's events through the control API with a small page size. The union of all pages
 * must equal the final full listing exactly: no duplicate, no skip, strictly increasing. Invalid,
 * tampered, cross-list, cross-filter, and pre-restart cursors fail with RS_CURSOR_INVALID.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  errorCode,
  expectOk,
  quoteBody,
  setupProject,
  startChildServer,
  startedGateRun,
  Subject,
  tempDir,
  type RemoteHarness,
} from './support/fixture.ts';

let tmp: ReturnType<typeof tempDir>;
let h: RemoteHarness;
let subject: Subject | null = null;
let sessionId = '';
let depositAddress = '';
let gateRunId = '';

type Page = {
  items: Array<Record<string, unknown>>;
  nextCursor: string | null;
  hasMore?: boolean;
  total: number;
};

async function page(path: string): Promise<Page> {
  return expectOk(await h.api('GET', path), 200) as unknown as Page;
}

beforeAll(async () => {
  tmp = tempDir('routespec-m08-t045-');
  h = await startChildServer(tmp.dir);
  const p = await setupProject(h, 't045');
  const run = await startedGateRun(h, p);
  gateRunId = run.gateRunId;
  const start = expectOk(await h.api('POST', `/case-runs/${run.caseRunId}/start`, {}), 201);
  sessionId = String(start['sessionId']);
  subject = await Subject.launch();
  await subject.attach(String(start['proxyBaseUrl']), start);
  await subject.send({ type: 'logicalJob', key: 'order-t045' });
  const q = await subject.call('getQuote', quoteBody());
  expect(q['ok']).toBe(true);
  depositAddress = String(
    ((q['value'] as Record<string, unknown>)['quote'] as Record<string, unknown>)['depositAddress'],
  );
  const c = await subject.call('submitDepositTx', { txHash: 'sim-tx-t045', depositAddress });
  expect(c['ok']).toBe(true);
});

afterAll(async () => {
  await subject?.close().catch(() => undefined);
  await h?.stop();
  tmp?.cleanup();
});

describe('T-045 — Cursor pagination is stable under concurrent append', () => {
  it('pages session events while the subject appends: no duplicate, no skip, strictly ordered', async () => {
    let appending = true;
    let polls = 0;
    const appender = (async () => {
      for (let i = 0; i < 24; i++) {
        const r = await (subject as Subject).call('getExecutionStatus', depositAddress);
        expect(r['ok'], JSON.stringify(r)).toBe(true);
        polls++;
      }
      appending = false;
    })();
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let idleAfterDone = 0;
    while (idleAfterDone < 2) {
      const q = cursor === null ? 'limit=3' : `limit=3&cursor=${encodeURIComponent(cursor)}`;
      const p = await page(`/sessions/${sessionId}/events?${q}`);
      pages++;
      for (const e of p.items) seen.push(Number(e['sequence']));
      expect(p.nextCursor).not.toBeNull();
      cursor = p.nextCursor;
      if (p.items.length === 0 && !appending) idleAfterDone++;
      if (p.items.length === 0) await new Promise((r) => setTimeout(r, 5));
    }
    await appender;
    expect(polls).toBe(24);
    const full = await page(`/sessions/${sessionId}/events?limit=200`);
    const all = full.items.map((e) => Number(e['sequence']));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(all);
    for (let i = 1; i < all.length; i++) expect(all[i] as number).toBeGreaterThan(all[i - 1] as number);
    // Quote request, finalization, commit, and one event per status poll were all paged.
    expect(all.length).toBeGreaterThanOrEqual(3 + 24);
    expect(full.total).toBe(all.length);
    expect(pages).toBeGreaterThan(all.length / 3);
    // The cursor of the last page resumes after the newest event, never re-delivering one.
    const again = await page(
      `/sessions/${sessionId}/events?limit=3&cursor=${encodeURIComponent(cursor as string)}`,
    );
    expect(again.items).toEqual([]);
  });

  it('filtered pages are stable too and keep their filter bound to the cursor', async () => {
    const filtered: number[] = [];
    let cursor: string | null = null;
    for (;;) {
      const q = `eventKind=PROVIDER_STATUS&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const p = await page(`/sessions/${sessionId}/events?${q}`);
      for (const e of p.items) {
        expect(e['eventCode']).toBe('PROVIDER_STATUS');
        filtered.push(Number(e['sequence']));
      }
      cursor = p.nextCursor;
      if (p.items.length < 2) break;
    }
    const full = await page(`/sessions/${sessionId}/events?eventKind=PROVIDER_STATUS&limit=200`);
    expect(filtered).toEqual(full.items.map((e) => Number(e['sequence'])));
    // The same cursor without its filter, or with another filter, is refused.
    const first = await page(`/sessions/${sessionId}/events?eventKind=PROVIDER_STATUS&limit=2`);
    const c = encodeURIComponent(first.nextCursor as string);
    for (const q of [`cursor=${c}`, `eventKind=QUOTE_FINALIZED&cursor=${c}`]) {
      const r = await h.api('GET', `/sessions/${sessionId}/events?${q}`);
      expect(r.status, q).toBe(400);
      expect(errorCode(r), q).toBe('RS_CURSOR_INVALID');
    }
  });

  it('invalid, tampered, and cross-list cursors and out-of-range limits fail clearly', async () => {
    const first = await page(`/sessions/${sessionId}/events?limit=2`);
    const cursor = first.nextCursor as string;
    const [payload, mac] = cursor.split('.') as [string, string];
    const tamperedPayload = Buffer.from(
      Buffer.from(payload, 'base64url')
        .toString('utf8')
        .replace(/"seq":\d+/, '"seq":1'),
      'utf8',
    ).toString('base64url');
    const cases = page(`/gate-runs/${gateRunId}/cases?limit=1`);
    const crossList = (await cases).nextCursor;
    const bad = [
      'garbage',
      '',
      `${tamperedPayload}.${mac}`,
      `${payload}.${mac.slice(0, -2)}AA`,
      `${payload}`,
      `${payload}.${mac}.extra`,
      'a'.repeat(600),
    ];
    if (crossList) bad.push(crossList);
    for (const c of bad) {
      const r = await h.api('GET', `/sessions/${sessionId}/events?cursor=${encodeURIComponent(c)}`);
      expect(r.status, c.slice(0, 40)).toBe(400);
      expect(errorCode(r), c.slice(0, 40)).toBe('RS_CURSOR_INVALID');
    }
    for (const limit of ['0', '201', '-1', '1.5', 'ten']) {
      const r = await h.api('GET', `/sessions/${sessionId}/events?limit=${limit}`);
      expect(r.status, limit).toBe(400);
      expect(errorCode(r), limit).toBe('RS_SCHEMA_INVALID');
    }
    const unknown = await h.api('GET', `/sessions/${sessionId}/events?sort=desc`);
    expect(errorCode(unknown)).toBe('RS_SCHEMA_INVALID');
    const twice = await h.api('GET', `/sessions/${sessionId}/events?limit=2&limit=3`);
    expect(errorCode(twice)).toBe('RS_SCHEMA_INVALID');
  });

  it('project pages stay stable while projects are created concurrently', async () => {
    const before = await page('/projects?limit=200');
    const creating = Promise.all(
      Array.from({ length: 12 }, (_, i) => h.api('POST', '/projects', { name: `concurrent ${i}` })),
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 60; i++) {
      const p = await page(`/projects?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const it of p.items) seen.push(String(it['projectId']));
      if (p.nextCursor === null) break;
      cursor = p.nextCursor;
    }
    const created = await creating;
    expect(created.every((r) => r.status === 201)).toBe(true);
    expect(new Set(seen).size).toBe(seen.length);
    for (const it of before.items) expect(seen).toContain(String(it['projectId']));
    const after = await page('/projects?limit=200');
    const order = after.items.map((it) => String(it['projectId']));
    // Whatever the page walk saw is a prefix of the final order: nothing was skipped behind it.
    expect(order.slice(0, seen.length)).toEqual(seen);
  });

  it('a cursor issued before a service restart is refused, and a fresh listing still matches', async () => {
    const before = await page(`/sessions/${sessionId}/events?limit=2`);
    const all = await page(`/sessions/${sessionId}/events?limit=200`);
    await subject?.close();
    subject = null;
    await h.stop();
    h = await startChildServer(tmp.dir);
    const stale = await h.api(
      'GET',
      `/sessions/${sessionId}/events?cursor=${encodeURIComponent(before.nextCursor as string)}`,
    );
    expect(stale.status).toBe(400);
    expect(errorCode(stale)).toBe('RS_CURSOR_INVALID');
    const fresh = await page(`/sessions/${sessionId}/events?limit=200`);
    expect(fresh.items.map((e) => e['sequence'])).toEqual(all.items.map((e) => e['sequence']));
  });
});
