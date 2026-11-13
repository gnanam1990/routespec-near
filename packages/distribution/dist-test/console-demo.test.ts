/**
 * M54: the static read-only console demo, built for GitHub Pages and driven in Chromium.
 *
 * The demo is built into `console/` of a site served the way GitHub Pages serves this project
 * site: under `/routespec-near/`, static files only, and the site root's `404.html` for any other
 * path (the RouteSpec Pages site holds the verify page at its root and the demo below it). The
 * test opens the demo, opens a deep link to the corrected build's gate run (PASS, contained) that
 * only the root fallback can serve, and checks that a mutation is refused as read-only and that
 * no request leaves the site's own origin.
 */
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from '@playwright/test';
import { buildConsoleDemo } from '../src/console-demo/build.ts';
import { DEMO_DIR } from '../src/console-demo/record.ts';

const PORT = 9582;
const SITE_BASE = '/routespec-near/';
const BASE = '/routespec-near/console/';
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
let demoDir: string;
let server: Server;
let browser: Browser;
const snapshot = JSON.parse(readFileSync(join(DEMO_DIR, 'snapshot.json'), 'utf8')) as {
  source: { correctedGateRunId: string; commit: string };
  responses: Record<string, { body: { items?: Array<{ projectId: string }> } }>;
};
const projectId = snapshot.responses['GET /projects']?.body.items?.[0]?.projectId as string;

function serveFile(path: string): { status: number; body: Buffer; type: string } {
  const rel = normalize(decodeURIComponent(path.slice(SITE_BASE.length))).replace(/^([/\\])+/, '');
  if (!rel.startsWith('..')) {
    // Like Pages: a directory is served by its index.html.
    const named = join(site, rel);
    const file = existsSync(named) && statSync(named).isDirectory() ? join(named, 'index.html') : named;
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
  site = join(work, 'site');
  demoDir = buildConsoleDemo({ out: join(site, 'console'), base: BASE, rootFallback: site });
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', ORIGIN).pathname;
    const r = path.startsWith(SITE_BASE)
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
      expect(statSync(join(demoDir, f)).isFile(), f).toBe(true);
    }
    expect(readFileSync(join(site, '404.html'), 'utf8')).toContain(JSON.stringify(BASE));
    expect(readFileSync(join(demoDir, 'demo', 'snapshot.json'))).toEqual(
      readFileSync(join(DEMO_DIR, 'snapshot.json')),
    );
    expect(readFileSync(join(demoDir, 'index.html'), 'utf8')).toContain(`${BASE}assets/`);
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

    // Deep link straight to the corrected build's gate run: the server has no such file, so the
    // site root's 404.html hands it to the demo, which restores the route.
    const deep = `${BASE}projects/${projectId}/gate-runs/${snapshot.source.correctedGateRunId}`;
    await page.goto(`${ORIGIN}${deep}`);
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe(deep);
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
