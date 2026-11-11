import AxeBuilder from '@axe-core/playwright';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const TOKEN = process.env['FIXTURE_CONTROL_TOKEN'] ?? '';

/** Opens a console route with the one-time control token in the fragment, as the CLI does. */
export async function open(page: Page, path: string): Promise<void> {
  await page.goto(`${path}#token=${encodeURIComponent(TOKEN)}`);
  await expect(page.locator('#main')).toBeVisible();
}

export async function resetFixture(request: APIRequestContext): Promise<void> {
  const res = await request.post('/__fixture/reset');
  expect(res.status()).toBe(204);
}

export async function setMode(
  request: APIRequestContext,
  mode: { offline?: boolean; delayMs?: number },
): Promise<void> {
  const res = await request.post('/__fixture/mode', { data: mode });
  expect(res.status()).toBe(204);
}

export async function apiGet<T>(request: APIRequestContext, path: string): Promise<T> {
  const res = await request.get(`/__routespec/v1${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  expect(res.ok()).toBe(true);
  return (await res.json()) as T;
}

/** WCAG 2.2 AA automated checks (axe-core). Manual screen-reader review is still required. */
export async function expectNoAxeViolations(page: Page, context: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const summary = results.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join(' | ')}`,
  );
  expect(summary, `axe violations on ${context}`).toEqual([]);
}

export async function expectNoBodyHorizontalScroll(page: Page, context: string): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `body horizontal overflow on ${context}`).toBeLessThanOrEqual(0);
}

/** Asserts the focused element has a visible focus indicator and is not covered by sticky UI. */
export async function expectVisibleUnobscuredFocus(page: Page, context: string): Promise<void> {
  const info = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { ok: false, reason: 'no focused element' };
    const style = getComputedStyle(el);
    const outline = parseFloat(style.outlineWidth) >= 2 && style.outlineStyle !== 'none';
    const ring = style.boxShadow !== 'none';
    const rect = el.getBoundingClientRect();
    // WCAG 2.4.11: the focused element must not be entirely hidden by author content such as
    // the sticky header or bottom navigation. Sample points across its visible part.
    const left = Math.max(rect.left + 2, 0);
    const right = Math.min(rect.right - 2, window.innerWidth - 1);
    const topY = Math.max(rect.top + 2, 0);
    const bottomY = Math.min(rect.bottom - 2, window.innerHeight - 1);
    const inView = right > left && bottomY > topY;
    const samples: Array<[number, number]> = [];
    for (const fx of [0, 0.5, 1])
      for (const fy of [0, 0.5, 1]) samples.push([left + (right - left) * fx, topY + (bottomY - topY) * fy]);
    const visiblePoint = samples.some(([x, y]) => {
      const top = document.elementFromPoint(x, y);
      return top !== null && (top === el || el.contains(top));
    });
    const covered = !visiblePoint;
    return {
      ok: (outline || ring) && inView && !covered,
      reason: `${el.tagName}#${el.id} outline=${style.outlineWidth}/${style.outlineStyle} inView=${inView} covered=${covered}`,
    };
  });
  expect(info.ok, `${context}: ${info.reason}`).toBe(true);
}
