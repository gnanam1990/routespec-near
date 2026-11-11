import { expect, test, type Page } from '@playwright/test';
import { open, resetFixture, setMode } from './helpers.ts';

/**
 * Timeline accessibility without color/motion (T-050 scope) and dense-session rendering
 * (T-051 scope), measured in headless Chromium on this machine against the contract fixture.
 */
test.beforeEach(async ({ request }) => {
  await resetFixture(request);
});

const CASE_WITH_DENSE_SESSION = '/projects/proj-alpha/gate-runs/gr-running/cases/c-run-004';

async function eventSequences(page: Page, view: 'list' | 'table'): Promise<string[]> {
  const cells =
    view === 'table'
      ? page.locator('.timeline table tbody tr td:first-child')
      : page.locator('.timeline .event-list .event summary .num');
  return (await cells.allTextContents()).map((t) => t.replace('#', '').trim());
}

test('status meaning survives monochrome, forced colors, and reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await open(page, '/projects/proj-alpha/gate-runs/gr-fail');
  // The strict CSP blocks injected style tags, so monochrome is applied through the CSSOM.
  await page.evaluate(() => document.documentElement.style.setProperty('filter', 'grayscale(1)'));
  const badges = page.locator('.badge');
  const count = await badges.count();
  expect(count).toBeGreaterThan(10);
  for (let i = 0; i < count; i++) {
    const badge = badges.nth(i);
    // Every badge carries a text label and an icon; color is never the only signal.
    expect((await badge.locator('.badge-label').innerText()).trim().length).toBeGreaterThan(0);
    await expect(badge.locator('svg')).toHaveCount(1);
  }
  await open(page, CASE_WITH_DENSE_SESSION);
  const first = page.locator('.timeline .event').first();
  await expect(first).toBeVisible();
  const animation = await first.evaluate((el) => getComputedStyle(el).animationName);
  expect(animation).toBe('none');
});

test('timeline list and table views present the same ordered events, operable by keyboard', async ({
  page,
}) => {
  await open(page, CASE_WITH_DENSE_SESSION);
  await expect(page.getByTestId('timeline-range')).toContainText('Showing 1–100 of 10000 events');
  const listSequences = await eventSequences(page, 'list');
  expect(listSequences).toHaveLength(100);
  const timelineTab = page.getByRole('tab', { name: 'Timeline' });
  await timelineTab.focus();
  await page.keyboard.press('ArrowRight');
  const tableTab = page.getByRole('tab', { name: 'Table' });
  await expect(tableTab).toBeFocused();
  await expect(tableTab).toHaveAttribute('aria-selected', 'true');
  expect(await eventSequences(page, 'table')).toEqual(listSequences);
  // Noncanonical timer evidence is labelled in text, not color.
  await expect(page.locator('.timeline table')).toContainText('Canonical');
  // Expanding an event works from the keyboard (native details/summary).
  await page.keyboard.press('ArrowLeft');
  const summary = page.locator('.timeline .event summary').first();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.timeline .event details').first()).toHaveAttribute('open', '');
});

test('filtering announces the resulting count without moving focus', async ({ page }) => {
  await open(page, CASE_WITH_DENSE_SESSION);
  const select = page.getByLabel('Event kind');
  await select.focus();
  await select.selectOption('EVIDENCE');
  await expect(page.getByTestId('announcer')).toHaveText('1250 events of kind Evidence');
  await expect(select).toBeFocused();
  await expect(page.getByTestId('timeline-range')).toContainText('of 1250 events');
});

test('live updates can be paused, and a disconnect freezes data as stale until reconnect', async ({
  page,
  request,
}) => {
  await open(page, CASE_WITH_DENSE_SESSION);
  const resume = page.getByRole('button', { name: 'Resume live updates' });
  await resume.click();
  const pause = page.getByRole('button', { name: 'Pause live updates' });
  await expect(pause).toHaveAttribute('aria-pressed', 'true');

  await setMode(request, { offline: true });
  await expect(page.locator('.global-banner')).toContainText(
    'Displayed records are frozen and marked stale',
    { timeout: 15_000 },
  );
  await expect(page.locator('.timeline [data-stale="true"]')).toBeVisible({ timeout: 15_000 });
  // The last received events remain visible; nothing became PASS or FAIL.
  expect(await eventSequences(page, 'list')).toHaveLength(100);

  await pause.click();
  // Let any read already in flight finish its bounded retries; then no new polling may start.
  await page.waitForTimeout(1500);
  let polled = 0;
  page.on('request', (r) => {
    if (r.url().includes('/events')) polled += 1;
  });
  await page.waitForTimeout(4500);
  expect(polled).toBe(0);

  await setMode(request, {});
  await page.getByRole('button', { name: 'Reconnect' }).click();
  await expect(page.locator('.global-banner')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('.timeline [data-stale="false"]')).toBeVisible();
});

test('a 10,000-event session paginates with stable focus and fast feedback', async ({ page }) => {
  await open(page, CASE_WITH_DENSE_SESSION);
  await expect(page.getByTestId('timeline-range')).toContainText('of 10000 events');
  await page.evaluate(() => {
    const w = window as unknown as { __events: PerformanceEventTiming[] };
    w.__events = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__events.push(e as PerformanceEventTiming);
    }).observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit);
  });
  const next = page.getByRole('button', { name: 'Next page' });
  for (let i = 0; i < 5; i++) {
    await next.click();
    await expect(page.getByTestId('timeline-range')).toContainText(
      `Showing ${(i + 1) * 100 + 1}–${(i + 2) * 100} of 10000`,
    );
    await expect(next).toBeFocused();
  }
  await page.getByLabel('Page size').selectOption('200');
  await expect(page.getByTestId('timeline-range')).toContainText('Showing 1–200 of 10000');
  const timings = await page.evaluate(() =>
    (window as unknown as { __events: PerformanceEventTiming[] }).__events.map((e) => ({
      name: e.name,
      inputDelayAndProcessing: e.processingEnd - e.startTime,
      duration: e.duration,
    })),
  );
  // Explicit first-visual-feedback measurement: click -> loading skeleton or refresh indicator painted.
  const feedbackMs = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const button = [...document.querySelectorAll('button')].find(
          (b) => b.textContent === 'Next page',
        ) as HTMLButtonElement;
        let t0 = 0;
        const obs = new MutationObserver(() => {
          if (document.querySelector('.timeline .refreshing.is-visible, .timeline [aria-busy="true"]')) {
            obs.disconnect();
            requestAnimationFrame(() => resolve(performance.now() - t0));
          }
        });
        obs.observe(document.querySelector('.timeline') as Element, {
          subtree: true,
          attributes: true,
          childList: true,
        });
        t0 = performance.now();
        button.click();
        setTimeout(() => resolve(Number.POSITIVE_INFINITY), 2000);
      }),
  );
  expect(feedbackMs).toBeLessThan(100);
  test.info().annotations.push({ type: 'first-feedback-ms', description: feedbackMs.toFixed(1) });
  for (const t of timings) {
    // Feedback (input delay + handler) under 100 ms; no interaction blocks beyond 200 ms.
    expect(t.inputDelayAndProcessing, `${t.name} processing`).toBeLessThan(100);
    expect(t.duration, `${t.name} duration`).toBeLessThan(200);
  }
  const maxDuration = Math.max(0, ...timings.map((t) => t.duration));
  const maxProcessing = Math.max(0, ...timings.map((t) => t.inputDelayAndProcessing));
  test.info().annotations.push({
    type: 'event-timings',
    description: `${timings.length} events >=16ms recorded; max duration ${maxDuration} ms; max input delay+processing ${maxProcessing.toFixed(1)} ms`,
  });
});

test('a 100-case gate run renders every case row and route changes keep CLS below 0.1', async ({ page }) => {
  await open(page, '/projects/proj-alpha/releases');
  await page.evaluate(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) {
        if (!e.hadRecentInput) w.__cls += e.value;
      }
    }).observe({ type: 'layout-shift', buffered: false });
  });
  const started = Date.now();
  await page.getByRole('link', { name: 'Open gate run for v1.6.0-rc.1' }).click();
  await expect(page.locator('tr[data-case]')).toHaveCount(100);
  const renderMs = Date.now() - started;
  await expect(page.getByText('Queued (waiting for a slot)')).toBeVisible();
  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  expect(cls).toBeLessThan(0.1);
  test.info().annotations.push({
    type: 'route-render',
    description: `100-case route rendered in ${renderMs} ms; CLS ${cls.toFixed(4)}`,
  });
});
