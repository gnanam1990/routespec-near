import { expect, test } from '@playwright/test';
import { expectNoAxeViolations, expectNoBodyHorizontalScroll, open, resetFixture } from './helpers.ts';

/** Console shell smoke against the loopback contract fixture (simulated records). */
const ROUTES: Array<[string, string]> = [
  ['/projects/proj-alpha/releases', 'Releases'],
  ['/projects/proj-alpha/gate-runs', 'Gate runs'],
  ['/projects/proj-alpha/gate-runs/new', 'Create gate run'],
  ['/projects/proj-alpha/gate-runs/gr-fail', 'Gate run'],
  ['/projects/proj-alpha/gate-runs/gr-fail/cases/c-fail-2', 'Case run'],
  ['/projects/proj-alpha/operations', 'Operations'],
  ['/projects/proj-alpha/operations/op-fail-1', 'Run operation'],
  ['/projects/proj-alpha/regressions', 'Regressions'],
  ['/projects/proj-alpha/regressions/imp-secret', 'Regression review'],
  ['/settings', 'Safety & Settings'],
  ['/connect', 'Connect control session'],
];

test.beforeEach(async ({ request }) => {
  await resetFixture(request);
});

test('every route renders under the strict CSP without console errors', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(msg.text());
  });
  page.on('pageerror', (err) => problems.push(err.message));
  for (const [path, title] of ROUTES) {
    await open(page, path);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  }
  expect(problems).toEqual([]);
});

test('the token fragment is removed from the address bar and nothing is stored', async ({ page }) => {
  await open(page, '/projects/proj-alpha/releases');
  await expect(page.getByRole('heading', { level: 1, name: 'Releases' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  const stored = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    cookie: document.cookie,
  }));
  expect(stored.session).toEqual([]);
  expect(stored.cookie).toBe('');
  expect(stored.local.every((k) => k === 'routespec.console.theme')).toBe(true);
});

test('fonts are bundled locally and no remote origin is contacted', async ({ page }) => {
  const origins = new Set<string>();
  page.on('request', (req) => origins.add(new URL(req.url()).origin));
  await open(page, '/projects/proj-alpha/releases');
  await page.evaluate(() => document.fonts.ready);
  const families = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
  );
  expect(families.some((f) => f.includes('IBM Plex Sans'))).toBe(true);
  expect([...origins]).toEqual([new URL(page.url()).origin]);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`axe finds no WCAG 2.2 AA violations in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [path] of ROUTES) {
      await open(page, path);
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expectNoAxeViolations(page, `${path} (${scheme})`);
    }
  });
}

for (const width of [375, 768, 1024, 1440]) {
  test(`layout at ${width}px keeps axes, navigation, and no body horizontal scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const [path] of ROUTES) {
      await open(page, path);
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expectNoBodyHorizontalScroll(page, `${path} @${width}`);
    }
    await open(page, '/projects/proj-alpha/releases');
    // All eight axes stay separately named at every width.
    for (const axis of [
      'Execution state',
      'Verdict',
      'Evidence',
      'Subject identity',
      'Effect coverage',
      'Artifact',
      'Enforcement',
      'Official compatibility',
    ]) {
      await expect(page.locator(`.axis-group [data-axis="${axis}"]`).first()).toBeVisible();
    }
    const nav = page.getByRole('navigation', { name: 'Primary' });
    if (width < 768) {
      await expect(nav).toBeVisible();
      await expect(nav.getByRole('link')).toHaveCount(5);
    } else if (width < 1024) {
      await expect(nav).toBeHidden();
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await expect(nav).toBeVisible();
    } else {
      await expect(nav).toBeVisible();
    }
  });
}

test('browser Back restores the selected matrix row', async ({ page }) => {
  await open(page, '/projects/proj-alpha/releases');
  await page.getByRole('button', { name: 'v1.4.1' }).click();
  await expect(page.getByRole('heading', { name: 'Gate summary — v1.4.1' })).toBeVisible();
  await page.getByRole('link', { name: 'Open gate run for v1.4.1' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Gate run' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Gate summary — v1.4.1' })).toBeVisible();
});
