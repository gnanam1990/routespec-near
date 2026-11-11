import { expect, test, type Page } from '@playwright/test';
import {
  SEED,
  api,
  expectNoBodyHorizontalScroll,
  expectVisibleUnobscuredFocus,
  open,
  projectPath,
  tabTo,
} from './helpers.ts';

/**
 * T-052 — Responsive journeys pass at required widths and platforms (M12).
 *
 * Real control service and real records (see support/service.ts). Every combination of the four
 * required widths, light and dark color schemes, and three rendering contexts (default, reduced
 * motion, forced colors) loads the core routes and checks: no body horizontal scroll; the first
 * keyboard stops show a visible focus indicator that sticky UI does not cover; every status badge
 * carries a text label (meaning never by color alone); and the design tokens and badge geometry
 * are identical everywhere (no token or component drift). The core journey (gate run -> case ->
 * run operation -> evidence drawer -> close by Escape and by browser Back) is repeated at every
 * width and at 200 percent zoom.
 *
 * Platform scope: headless Chromium on the host OS only. Firefox, WebKit, touch devices, and
 * other operating systems are NOT_RUN (not installed here); see docs/status/M12.md.
 */

const WIDTHS = [375, 768, 1024, 1440] as const;
const SCHEMES = ['light', 'dark'] as const;
const CONTEXTS = ['default', 'reduced-motion', 'forced-colors'] as const;
const TOKENS = ['--radius-tag', '--radius-control', '--focus-width', '--space-2', '--text-dense'] as const;
const EXPECTED_TOKENS: Record<(typeof TOKENS)[number], string> = {
  '--radius-tag': '4px',
  '--radius-control': '6px',
  '--focus-width': '2px',
  '--space-2': '8px',
  '--text-dense': '0.875rem',
};

type J = Record<string, unknown>;

async function coreRoutes(): Promise<{ gateRun: string; caseRun: string; operation: string; all: string[] }> {
  const p = projectPath();
  const r = SEED.release;
  const cases = (await api<{ items: J[] }>(`/gate-runs/${r.gateRunId}/cases`)).items;
  const failing = cases[4] as J;
  const opId = String((failing['runOperationIds'] as string[])[0]);
  const gateRun = `${p}/gate-runs/${r.gateRunId}`;
  const caseRun = `${gateRun}/cases/${String(failing['caseRunId'])}`;
  const operation = `${p}/operations/${opId}`;
  return {
    gateRun,
    caseRun,
    operation,
    all: [
      `${p}/releases`,
      gateRun,
      caseRun,
      operation,
      `${p}/regressions/${SEED.capture.importId}`,
      '/settings',
    ],
  };
}

async function settle(page: Page): Promise<void> {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

async function badgesHaveText(page: Page, context: string): Promise<number> {
  const badges = await page
    .locator('.badge')
    .evaluateAll((els) =>
      els
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => ({ text: (el.textContent ?? '').trim(), code: el.getAttribute('data-code') })),
    );
  for (const b of badges)
    expect(b.text.length, `${context}: badge ${String(b.code)} has no text label`).toBeGreaterThan(0);
  return badges.length;
}

async function tokenSnapshot(page: Page): Promise<J> {
  return page.evaluate(
    (names) => {
      const root = getComputedStyle(document.documentElement);
      const badge = document.querySelector('.badge');
      const b = badge ? getComputedStyle(badge) : null;
      return {
        // The production CSS minifier drops a leading zero (`.875rem`); compare the value.
        tokens: Object.fromEntries(
          names.map((n) => [n, root.getPropertyValue(n).trim().replace(/^\./, '0.')]),
        ),
        badge: b
          ? {
              radius: b.borderTopLeftRadius,
              borderWidth: b.borderTopWidth,
              fontWeight: b.fontWeight,
              fontFamily: b.fontFamily,
            }
          : null,
      };
    },
    TOKENS as unknown as string[],
  );
}

async function firstTabStopsVisible(page: Page, context: string, stops = 8): Promise<void> {
  await page
    .locator('body')
    .click({ position: { x: 1, y: 1 } })
    .catch(() => undefined);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press('Tab');
    const onBody = await page.evaluate(() => document.activeElement === document.body);
    if (!onBody) await expectVisibleUnobscuredFocus(page, `${context} (tab stop ${i + 1})`);
  }
}

for (const width of WIDTHS) {
  for (const scheme of SCHEMES) {
    for (const ctx of CONTEXTS) {
      test(`core routes at ${width}px, ${scheme}, ${ctx}: no horizontal scroll, visible focus, labelled status, stable tokens`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({
          colorScheme: scheme,
          reducedMotion: ctx === 'reduced-motion' ? 'reduce' : 'no-preference',
          forcedColors: ctx === 'forced-colors' ? 'active' : 'none',
        });
        const routes = await coreRoutes();
        let reference: J | null = null;
        for (const path of routes.all) {
          const label = `${path} @${width} ${scheme} ${ctx}`;
          await open(page, path);
          await settle(page);
          await expectNoBodyHorizontalScroll(page, label);
          await badgesHaveText(page, label);
          const snap = await tokenSnapshot(page);
          expect(snap['tokens'], `${label}: design tokens`).toEqual(EXPECTED_TOKENS);
          if (snap['badge'] !== null) {
            if (reference === null) reference = snap['badge'] as J;
            expect(snap['badge'], `${label}: badge geometry`).toEqual(reference);
          }
          if (ctx === 'reduced-motion') {
            const animating = await page.evaluate(
              () => document.getAnimations().filter((a) => a.playState === 'running').length,
            );
            expect(animating, `${label}: running animations under reduced motion`).toBe(0);
          }
        }
        await open(page, routes.gateRun);
        await settle(page);
        await firstTabStopsVisible(page, `${routes.gateRun} @${width} ${scheme} ${ctx}`);
      });
    }
  }
}

async function drawerJourney(page: Page, label: string): Promise<void> {
  const routes = await coreRoutes();
  await open(page, routes.gateRun);
  await settle(page);
  await expectNoBodyHorizontalScroll(page, `${label} gate run`);
  await open(page, routes.caseRun);
  await settle(page);
  await expectNoBodyHorizontalScroll(page, `${label} case run`);
  await open(page, routes.operation);
  await settle(page);
  await expectNoBodyHorizontalScroll(page, `${label} run operation`);
  const link = page.locator('a.evidence-link').first();
  // Open the route-addressable evidence drawer by keyboard, close it with Escape.
  await tabTo(page, link, `${label} evidence link`);
  await page.keyboard.press('Enter');
  await expect(page.locator('#evidence-heading')).toBeFocused();
  await expectVisibleUnobscuredFocus(page, `${label} drawer heading`);
  await expectNoBodyHorizontalScroll(page, `${label} drawer open`);
  await page.keyboard.press('Escape');
  await expect(page.locator('#evidence-heading')).toHaveCount(0);
  await expect(link).toBeFocused();
  // Open it again and leave with the browser Back control: the drawer closes, the page stays.
  await page.keyboard.press('Enter');
  await expect(page.locator('#evidence-heading')).toBeFocused();
  await page.goBack();
  await expect(page.locator('#evidence-heading')).toHaveCount(0);
  await expect(page.locator('#main')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(routes.operation);
}

for (const width of WIDTHS) {
  test(`core journey at ${width}px: drawer opens by keyboard and closes by Escape and by Back`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await drawerJourney(page, `@${width}`);
  });
}

for (const [width, scheme] of [
  [1280, 'light'],
  [1280, 'dark'],
  [750, 'light'],
] as const) {
  test(`core journey at 200 percent zoom of a ${width}px window (${scheme})`, async ({ browser }) => {
    // Browser zoom halves the CSS viewport and doubles the device pixel ratio.
    const context = await browser.newContext({
      viewport: { width: Math.round(width / 2), height: 450 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
    });
    const page = await context.newPage();
    try {
      await drawerJourney(page, `200% of ${width}px ${scheme}`);
      const routes = await coreRoutes();
      for (const path of routes.all) {
        await open(page, path);
        await settle(page);
        await expectNoBodyHorizontalScroll(page, `${path} @200% of ${width}px`);
        await badgesHaveText(page, `${path} @200% of ${width}px`);
      }
    } finally {
      await context.close();
    }
  });
}
