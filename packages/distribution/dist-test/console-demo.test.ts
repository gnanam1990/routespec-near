/**
 * M54: the static read-only console demo, built for GitHub Pages and driven in Chromium.
 *
 * The site is served the way GitHub Pages serves a project site: under `/routespec-near/`, static
 * files only, and `404.html` for any other path. The test opens the site, follows the console to
 * the corrected build's gate run (PASS, contained), opens a deep link directly, and checks that a
 * mutation is refused as read-only and that no request leaves the site's own origin.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from '@playwright/test';
import { buildConsoleDemo } from '../src/console-demo/build.ts';
import { DEMO_DIR } from '../src/console-demo/record.ts';

const PORT = 9582;
const BASE = '/routespec-near/';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.tar': 'application/x-tar',
  '.svg': 'image/svg+xml',
};

const work = mkdtempSync(join(tmpdir(), 'routespec-m54-site-'));
let site: string;
let server: Server;
let browser: Browser;
const snapshot = JSON.parse(readFileSync(join(DEMO_DIR, 'snapshot.json'), 'utf8')) as {
  source: { correctedGateRunId: string; commit: string };
  responses: Record<string, { body: { items?: Array<{ projectId: string }> } }>;
};
const projectId = snapshot.responses['GET /projects']?.body.items?.[0]?.projectId as string;

function serveFile(path: string): { status: number; body: Buffer; type: string } {
  const rel = normalize(decodeURIComponent(path.slice(BASE.length))).replace(/^([/\\])+/, '');
  if (!rel.startsWith('..')) {
    const file = join(site, rel === '' ? 'index.html' : rel);
    try {
      if (statSync(file).isFile()) {
        return {
          status: 200,
          body: readFileSync(file),
          type: TYPES[extname(file)] ?? 'application/octet-stream',
        };
      }
    } catch {
      // fall through to the Pages 404 page
    }
  }
  return { status: 404, body: readFileSync(join(site, '404.html')), type: TYPES['.html'] as string };
}

beforeAll(async () => {
  site = buildConsoleDemo({ out: join(work, 'site'), base: BASE });
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', ORIGIN).pathname;
    const r = path.startsWith(BASE)
      ? serveFile(path)
      : { status: 404, body: Buffer.from('not here'), type: 'text/plain' };
    res.writeHead(r.status, { 'content-type': r.type });
    res.end(r.body);
  });
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', () => r()));
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server?.close(() => r()));
  rmSync(work, { recursive: true, force: true });
});

describe('M54 static console demo site', () => {
  it('ships the recording and a Pages fallback page', () => {
    for (const f of [
      'index.html',
      '404.html',
      '.nojekyll',
      'demo/snapshot.json',
      'demo/evidence-bundle.tar',
    ]) {
      expect(statSync(join(site, f)).isFile(), f).toBe(true);
    }
    expect(readFileSync(join(site, 'demo', 'snapshot.json'))).toEqual(
      readFileSync(join(DEMO_DIR, 'snapshot.json')),
    );
    expect(readFileSync(join(site, 'index.html'), 'utf8')).toContain(`${BASE}assets/`);
  });

  it('renders the recorded contained run read-only, from its own origin only', async () => {
    const page = await browser.newPage();
    const foreign: string[] = [];
    page.on('request', (req) => {
      if (!req.url().startsWith(ORIGIN)) foreign.push(req.url());
    });
    await page.goto(`${ORIGIN}${BASE}`);
    const banner = page.getByTestId('demo-banner');
    await expect.poll(() => banner.textContent()).toContain('Read-only demo');
    expect(await banner.textContent()).toContain('contained run');
    expect(await banner.textContent()).toContain(snapshot.source.commit.slice(0, 12));
    expect(await page.locator('.connection').textContent()).toContain('Read-only demo snapshot');

    // Deep link straight to the corrected build's gate run (served through 404.html, as on Pages).
    await page.goto(`${ORIGIN}${BASE}projects/${projectId}/gate-runs/${snapshot.source.correctedGateRunId}`);
    await expect.poll(() => page.locator('main').textContent(), { timeout: 15_000 }).toContain('PASS');
    const main = (await page.locator('main').textContent()) ?? '';
    expect(main).toContain('INV-03');

    // A mutation is refused as read-only and shown as an error, not as a result.
    await page.getByRole('button', { name: 'Evaluate gate' }).click();
    await expect.poll(() => page.locator('main').textContent()).toContain('read-only demo');
    expect(foreign).toEqual([]);
    await page.close();
  });
});
