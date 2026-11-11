import { expect, test } from '@playwright/test';
import {
  SEED,
  api,
  expectNoAxeViolations,
  expectNoBodyHorizontalScroll,
  open,
  projectPath,
} from './helpers.ts';

/**
 * Console served by the real control service (same origin, production CSP) over real records:
 * every route renders without CSP violations or console errors, the token fragment is removed,
 * nothing sensitive is stored, axe finds no WCAG 2.2 AA violations in either theme, and the
 * layout holds at 375, 768, 1024, and 1440 CSS pixels. Supports T-047..T-051.
 */
async function routes(): Promise<Array<[string, string]>> {
  const p = projectPath();
  const r = SEED.release;
  const failing = r.caseRunIds[4] as string;
  const cases = (await api<{ items: Array<Record<string, unknown>> }>(`/gate-runs/${r.gateRunId}/cases`))
    .items;
  const opId = String(((cases[4] as Record<string, unknown>)['runOperationIds'] as string[])[0]);
  return [
    [`${p}/operations/${opId}`, 'Run operation'],
    [`${p}/gate-runs/${SEED.dense.gateRunId}/cases/${SEED.dense.caseRunId}`, 'Case run'],
    [`${p}/releases`, 'Releases'],
    [`${p}/gate-runs`, 'Gate runs'],
    [`${p}/gate-runs/new`, 'Create gate run'],
    [`${p}/gate-runs/${r.gateRunId}`, 'Gate run'],
    [`${p}/gate-runs/${r.gateRunId}/cases/${failing}`, 'Case run'],
    [`${p}/operations`, 'Operations'],
    [`${p}/regressions`, 'Regressions'],
    [`${p}/regressions/${SEED.capture.importId}`, 'Regression review'],
    ['/settings', 'Safety & Settings'],
    ['/connect', 'Connect control session'],
  ];
}

test('every route renders under the service CSP without console errors or CSP violations', async ({
  page,
}) => {
  const problems: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(msg.text());
  });
  page.on('pageerror', (err) => problems.push(err.message));
  for (const [path, title] of await routes()) {
    const shell = await fetch(`${process.env['ROUTESPEC_REAL_ORIGIN']}${path}`);
    expect(shell.headers.get('content-security-policy') ?? '').toContain("default-src 'none'");
    await open(page, path);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  }
  expect(problems).toEqual([]);
});

test('the token fragment is removed from the address bar and nothing is stored', async ({ page }) => {
  await open(page, `${projectPath()}/releases`);
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

for (const scheme of ['light', 'dark'] as const) {
  test(`axe finds no WCAG 2.2 AA violations on real records in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [path] of await routes()) {
      await open(page, path);
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expectNoAxeViolations(page, `${path} (${scheme})`);
    }
  });
}

for (const width of [375, 768, 1024, 1440]) {
  test(`layout at ${width}px keeps the eight axes and no body horizontal scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const [path] of await routes()) {
      await open(page, path);
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expectNoBodyHorizontalScroll(page, `${path} @${width}`);
    }
    await open(page, `${projectPath()}/gate-runs/${SEED.release.gateRunId}`);
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
  });
}
