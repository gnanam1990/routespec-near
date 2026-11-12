import { expect, test, type Page } from '@playwright/test';
import { SEED, api, open, projectPath } from './helpers.ts';

/**
 * T-050 — Status and timeline remain accessible without color or motion.
 * T-051 — Dense-session UI meets interaction and rendering targets.
 *
 * Against the real control service and real journal events: a session holding every event its
 * scenario budget allows (one status poll per persisted provider observation), the release gate
 * run with PASS, REVIEW, and FAIL cases, and a 100-case gate run whose cases together journal
 * 10,000 events and were evaluated by the real kernel. Timings come from headless Chromium on
 * this machine (docs/status/M09.md); they are not reference-hardware claims.
 */
type J = Record<string, unknown>;

const densePath = () =>
  `${projectPath()}/gate-runs/${SEED.dense.gateRunId}/cases/${encodeURIComponent(SEED.dense.caseRunId)}`;

async function eventSequences(page: Page, view: 'list' | 'table'): Promise<string[]> {
  const cells =
    view === 'table'
      ? page.locator('.timeline table tbody tr td:first-child')
      : page.locator('.timeline .event-list .event summary .num');
  return (await cells.allTextContents()).map((t) => t.replace('#', '').trim());
}

test('T-050: status meaning survives monochrome, forced colors, and reduced motion on real records', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await open(page, `${projectPath()}/gate-runs/${SEED.release.gateRunId}`);
  await page.evaluate(() => document.documentElement.style.setProperty('filter', 'grayscale(1)'));
  const badges = page.locator('.badge');
  const count = await badges.count();
  expect(count).toBeGreaterThan(10);
  const codes = new Set<string>();
  for (let i = 0; i < count; i++) {
    const badge = badges.nth(i);
    expect((await badge.locator('.badge-label').innerText()).trim().length).toBeGreaterThan(0);
    await expect(badge.locator('svg')).toHaveCount(1);
    const code = await badge.getAttribute('data-code');
    if (code) codes.add(code);
  }
  // PASS, REVIEW, and FAIL from the kernel are each distinguishable by text and icon alone.
  for (const v of ['PASS', 'REVIEW', 'FAIL']) expect(codes.has(v), v).toBe(true);
  const labels = new Map<string, string>();
  for (const v of ['PASS', 'REVIEW', 'FAIL']) {
    labels.set(v, await page.locator(`.badge[data-code="${v}"] .badge-label`).first().innerText());
  }
  expect(new Set(labels.values()).size).toBe(3);
  await open(page, densePath());
  const first = page.locator('.timeline .event').first();
  await expect(first).toBeVisible();
  expect(await first.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  expect(await first.evaluate((el) => getComputedStyle(el).transitionDuration)).toMatch(/^0s/);
});

test('T-050: list and table views present the same persisted events in order, by keyboard', async ({
  page,
}) => {
  const page1 = await api<{ items: J[]; total: number }>(
    `/sessions/${SEED.dense.sessionId}/events?limit=100`,
  );
  await open(page, densePath());
  await expect(page.getByTestId('timeline-range')).toContainText(`Showing 1–100 of ${page1.total} events`);
  const listSequences = await eventSequences(page, 'list');
  expect(listSequences).toEqual(page1.items.map((e) => String(e['sequence'])));
  const timelineTab = page.getByRole('tab', { name: 'Timeline' });
  await timelineTab.focus();
  await page.keyboard.press('ArrowRight');
  const tableTab = page.getByRole('tab', { name: 'Table' });
  await expect(tableTab).toBeFocused();
  await expect(tableTab).toHaveAttribute('aria-selected', 'true');
  expect(await eventSequences(page, 'table')).toEqual(listSequences);
  await page.keyboard.press('ArrowLeft');
  const summary = page.locator('.timeline .event summary').first();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.timeline .event details').first()).toHaveAttribute('open', '');
});

test('T-050: a server-side phase filter announces the filtered count without moving focus', async ({
  page,
}) => {
  const filtered = await api<{ total: number }>(
    `/sessions/${SEED.dense.sessionId}/events?limit=1&phase=READ_ONLY_RECONCILIATION`,
  );
  expect(filtered.total).toBeGreaterThan(0);
  await open(page, densePath());
  const select = page.getByLabel('Phase');
  await select.focus();
  await select.selectOption('READ_ONLY_RECONCILIATION');
  await expect(page.getByTestId('announcer')).toHaveText(
    `${filtered.total} events in phase Read-only reconciliation`,
  );
  await expect(select).toBeFocused();
  await expect(page.getByTestId('timeline-range')).toContainText(`of ${filtered.total} events`);
});

test('T-050: live updates pause, and a lost service freezes data as stale until Reconnect', async ({
  page,
}) => {
  await open(page, densePath());
  await page.getByRole('button', { name: 'Resume live updates' }).click();
  const pause = page.getByRole('button', { name: 'Pause live updates' });
  await expect(pause).toHaveAttribute('aria-pressed', 'true');
  await page.route('**/__routespec/v1/**', (route) => route.abort('connectionrefused'));
  await expect(page.locator('.global-banner')).toContainText(
    'Displayed records are frozen and marked stale',
    {
      timeout: 15_000,
    },
  );
  await expect(page.locator('.timeline [data-stale="true"]')).toBeVisible({ timeout: 15_000 });
  expect(await eventSequences(page, 'list')).toHaveLength(100);
  await pause.click();
  await page.waitForTimeout(1500);
  let polled = 0;
  page.on('request', (r) => {
    if (r.url().includes('/events')) polled += 1;
  });
  await page.waitForTimeout(4500);
  expect(polled).toBe(0);
  await page.unroute('**/__routespec/v1/**');
  await page.getByRole('button', { name: 'Reconnect' }).click();
  await expect(page.locator('.global-banner')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('.timeline [data-stale="false"]')).toBeVisible();
});

test('T-051: focus stays on Next page while a slow next page loads (M18)', async ({ page }) => {
  // The real service answers every request; only the timeline page requests are held back for a
  // moment, as a slow machine would. Focus must not depend on how fast the next page arrives.
  const total = SEED.dense.events;
  await open(page, densePath());
  await expect(page.getByTestId('timeline-range')).toContainText(`of ${total} events`);
  await page.route('**/__routespec/v1/sessions/*/events?*', async (route) => {
    if (route.request().url().includes('cursor=')) await new Promise((r) => setTimeout(r, 600));
    await route.continue();
  });
  const next = page.getByRole('button', { name: 'Next page' });
  for (let i = 0; i < 2; i++) {
    await next.click();
    await expect(page.getByTestId('timeline-range')).toContainText(
      `Showing ${(i + 1) * 100 + 1}–${(i + 2) * 100} of ${total}`,
    );
    await expect(next).toBeFocused();
    await expect(next).toBeEnabled();
  }
  await page.unroute('**/__routespec/v1/sessions/*/events?*');
});

test('T-051: the densest real session paginates with stable focus and fast feedback', async ({ page }) => {
  const total = SEED.dense.events;
  expect(total).toBeGreaterThan(8000);
  await open(page, densePath());
  await expect(page.getByTestId('timeline-range')).toContainText(`of ${total} events`);
  await page.evaluate(() => {
    const w = window as unknown as { __events: PerformanceEventTiming[]; __long: number[] };
    w.__events = [];
    w.__long = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__events.push(e as PerformanceEventTiming);
    }).observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__long.push(e.duration);
    }).observe({ type: 'longtask', buffered: false });
  });
  const next = page.getByRole('button', { name: 'Next page' });
  for (let i = 0; i < 5; i++) {
    await next.click();
    await expect(page.getByTestId('timeline-range')).toContainText(
      `Showing ${(i + 1) * 100 + 1}–${(i + 2) * 100} of ${total}`,
    );
    await expect(next).toBeFocused();
  }
  await page.getByLabel('Page size').selectOption('200');
  await expect(page.getByTestId('timeline-range')).toContainText(`Showing 1–200 of ${total}`);
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
  const { events, long } = await page.evaluate(() => {
    const w = window as unknown as { __events: PerformanceEventTiming[]; __long: number[] };
    return {
      events: w.__events.map((e) => ({
        name: e.name,
        processing: e.processingEnd - e.startTime,
        duration: e.duration,
      })),
      long: w.__long,
    };
  });
  for (const t of events) {
    expect(t.processing, `${t.name} input delay + processing`).toBeLessThan(100);
    expect(t.duration, `${t.name} duration`).toBeLessThan(200);
  }
  for (const d of long) expect(d, 'long task').toBeLessThan(200);
  test.info().annotations.push({
    type: 'dense-session',
    description: `${total} events; first feedback ${feedbackMs.toFixed(1)} ms; max event duration ${Math.max(
      0,
      ...events.map((e) => e.duration),
    )} ms; max long task ${Math.max(0, ...long).toFixed(0)} ms`,
  });
});

test('T-051: the 100-case / 10,000-event gate run renders every case row with CLS below 0.1', async ({
  page,
}) => {
  expect(SEED.hundred.events).toBeGreaterThanOrEqual(10_000);
  const evaluationMs =
    (SEED.timings['hundredCaseKernelEvaluationMs'] ?? 0) + (SEED.timings['hundredCaseGateEvaluationMs'] ?? 0);
  // NFR-04 target on this machine: evaluation of the 100-case, 10,000-event corpus within 60 s.
  expect(evaluationMs).toBeLessThan(60_000);
  await open(page, `${projectPath()}/gate-runs`);
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
  await page.locator(`a[href$="/gate-runs/${SEED.hundred.gateRunId}"]`).first().click();
  await expect(page.locator('tr[data-case]')).toHaveCount(100);
  const renderMs = Date.now() - started;
  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  expect(cls).toBeLessThan(0.1);
  const gate = await api(`/gate-runs/${SEED.hundred.gateRunId}`);
  expect(gate['verdict']).toBe(SEED.hundred.decision);
  test.info().annotations.push({
    type: 'hundred-case',
    description: `${SEED.hundred.events} events over 100 cases; kernel case evaluation ${SEED.timings['hundredCaseKernelEvaluationMs']} ms + gate evaluation ${SEED.timings['hundredCaseGateEvaluationMs']} ms; route rendered in ${renderMs} ms; CLS ${cls.toFixed(4)}`,
  });
});
