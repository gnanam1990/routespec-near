/**
 * SEC RS-03 — requests that fail authentication do not spend the operator's read/mutation budget.
 *
 * Any local process can reach the loopback port with a valid Host header. Requests without a
 * valid credential must be counted only in the authentication-failure budget; the shared read and
 * mutation budgets are charged only after the control token (or, on the subject route, the case
 * token) is accepted. Static console assets carry no credential and have their own budget, so
 * flooding them cannot exhaust the API read budget either.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ControlToken } from '../src/index.ts';
import { PREFIX, errorCode, raw, startHarness, tempDir, type Harness } from './support/fixture.ts';

let consoleDir: string;
let cleanupConsole: () => void = () => undefined;

beforeAll(() => {
  const t = tempDir('routespec-sec-rs03-console-');
  consoleDir = join(t.dir, 'dist');
  cleanupConsole = t.cleanup;
  mkdirSync(join(consoleDir, 'assets'), { recursive: true });
  writeFileSync(join(consoleDir, 'index.html'), '<!doctype html><title>RouteSpec</title>');
  writeFileSync(join(consoleDir, 'assets', 'app.js'), 'export {};');
});

afterAll(() => cleanupConsole());

async function withHarness(
  rateLimits: Record<string, number>,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const h = await startHarness({ consoleDir, rateLimits: { windowMs: 60_000, ...rateLimits } });
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

const anonymousPost = (h: Harness) =>
  raw(h.port, {
    method: 'POST',
    path: `${PREFIX}/projects`,
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

describe('SEC RS-03 — unauthenticated requests cannot exhaust the shared budgets', () => {
  it('a credential-less POST flood does not lock the genuine token out of mutations', async () => {
    await withHarness({ mutations: 5, reads: 5, authFailures: 3 }, async (h) => {
      const statuses: number[] = [];
      for (let i = 0; i < 10; i++) statuses.push((await anonymousPost(h)).status);
      expect(statuses.slice(0, 3).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(3).every((s) => s === 429)).toBe(true);
      const genuine = await h.api('POST', '/projects', { name: 'after-flood' });
      expect(genuine.status, genuine.text.slice(0, 200)).toBe(201);
      expect((await h.api('GET', '/projects')).status).toBe(200);
    });
  });

  it('a credential-less or wrong-token GET flood does not lock the genuine token out of reads', async () => {
    await withHarness({ mutations: 5, reads: 5, authFailures: 3 }, async (h) => {
      for (let i = 0; i < 6; i++) {
        const r = await h.api('GET', '/projects', undefined, { token: null });
        expect([401, 429]).toContain(r.status);
      }
      for (let i = 0; i < 6; i++) {
        const r = await raw(h.port, {
          method: 'GET',
          path: `${PREFIX}/projects`,
          headers: { authorization: `Bearer ${new ControlToken().reveal()}` },
        });
        expect(r.status).toBe(429);
      }
      expect((await h.api('GET', '/projects')).status).toBe(200);
      expect((await h.api('POST', '/projects', { name: 'still-ok' })).status).toBe(201);
    });
  });

  it('failed case-token requests on the subject route are throttled by the failure budget only', async () => {
    await withHarness({ mutations: 5, reads: 5, authFailures: 3 }, async (h) => {
      const statuses: number[] = [];
      for (let i = 0; i < 10; i++) {
        const r = await raw(h.port, {
          method: 'POST',
          path: `${PREFIX}/effects/observe`,
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        statuses.push(r.status);
      }
      expect(statuses.slice(0, 3).every((s) => s !== 429 && s >= 400)).toBe(true);
      expect(statuses.slice(3).every((s) => s === 429)).toBe(true);
      expect((await h.api('POST', '/projects', { name: 'case-flood' })).status).toBe(201);
    });
  });

  it('static console requests have their own budget and cannot exhaust the API read budget', async () => {
    await withHarness({ mutations: 5, reads: 5, authFailures: 3 }, async (h) => {
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) statuses.push((await raw(h.port, { method: 'GET', path: '/' })).status);
      expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
      expect((await h.api('GET', '/projects')).status).toBe(200);
    });
  });

  it('the genuine token is still rate limited once its own budget is spent', async () => {
    await withHarness({ mutations: 2, reads: 3, authFailures: 3 }, async (h) => {
      const reads: number[] = [];
      for (let i = 0; i < 4; i++) reads.push((await h.api('GET', '/projects')).status);
      expect(reads).toEqual([200, 200, 200, 429]);
      const writes: number[] = [];
      for (let i = 0; i < 3; i++) writes.push((await h.api('POST', '/projects', { name: `p${i}` })).status);
      expect(writes).toEqual([201, 201, 429]);
      const limited = await h.api('POST', '/projects', { name: 'p-last' });
      expect(errorCode(limited)).toBe('RS_RATE_LIMITED');
    });
  });
});
