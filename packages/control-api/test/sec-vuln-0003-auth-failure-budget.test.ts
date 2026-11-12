/**
 * SEC vuln-0003 — the authentication-failure budget is not a global lockout.
 *
 * Any local process can reach the loopback port. Exhausting the failed-authentication window must
 * hold back further failing guesses (429) without locking the operator's genuine token or the
 * console's static assets out, and requests refused by the Host/Origin/Fetch-Metadata boundary
 * must not consume the shared read or mutation budgets.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ControlToken } from '../src/index.ts';
import { PREFIX, errorCode, raw, startHarness, tempDir, type Harness } from './support/fixture.ts';

let consoleDir: string;
let cleanupConsole: () => void = () => undefined;

beforeAll(() => {
  const t = tempDir('routespec-sec-0003-console-');
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

describe('SEC vuln-0003 — auth-failure budget cannot lock out the operator', () => {
  it('after the failure window is exhausted, wrong tokens get 429 but the genuine token and the console still work', async () => {
    await withHarness({ authFailures: 5 }, async (h) => {
      const before = h.tableCounts();
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const r = await raw(h.port, {
          method: 'GET',
          path: `${PREFIX}/metrics`,
          headers: { authorization: `Bearer ${new ControlToken().reveal()}` },
        });
        statuses.push(r.status);
      }
      expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
      // Missing credentials are failures too and stay held back.
      const anonymous = await h.api('GET', '/metrics', undefined, { token: null });
      expect(anonymous.status).toBe(429);
      expect(errorCode(anonymous)).toBe('RS_RATE_LIMITED');

      expect((await h.api('GET', '/metrics')).status).toBe(200);
      expect((await h.api('GET', '/projects')).status).toBe(200);
      expect((await raw(h.port, { method: 'GET', path: '/' })).status).toBe(200);
      expect((await raw(h.port, { method: 'GET', path: '/assets/app.js' })).status).toBe(200);
      expect(h.tableCounts()).toEqual(before);
    });
  });

  it('requests refused by the browser boundary do not consume the shared read budget', async () => {
    await withHarness({ reads: 5, authFailures: 1000 }, async (h) => {
      for (let i = 0; i < 20; i++) {
        const foreignHost = await raw(h.port, {
          method: 'GET',
          path: `${PREFIX}/metrics`,
          host: 'evil.example',
        });
        expect(foreignHost.status).not.toBe(200);
        expect(errorCode(foreignHost)).toBe('RS_HOST_REJECTED');
        const crossSite = await h.api('GET', '/metrics', undefined, {
          headers: { origin: 'https://evil.example' },
        });
        expect(errorCode(crossSite)).toBe('RS_ORIGIN_REJECTED');
      }
      expect((await h.api('GET', '/metrics')).status).toBe(200);
    });
  });
});
