import { expect, type Locator, type Page } from '@playwright/test';
import { expectVisibleUnobscuredFocus } from '../e2e/helpers.ts';

export {
  expectNoAxeViolations,
  expectNoBodyHorizontalScroll,
  expectVisibleUnobscuredFocus,
} from '../e2e/helpers.ts';

type J = Record<string, unknown>;

export interface Seed {
  release: {
    projectId: string;
    buildRevisionId: string;
    artifactDigest: string;
    manifestDigest: string;
    policyDigest: string;
    corpusRevisionId: string;
    gateId: string;
    gateRunId: string;
    caseRunIds: string[];
    sessionIds: string[];
    gateEvaluationId: string;
    decision: string;
  };
  journey: {
    corpusRevisionId: string;
    gateId: string;
    corrected: { buildRevisionId: string; manifestDigest: string; policyDigest: string };
  };
  dense: { gateRunId: string; caseRunId: string; sessionId: string; events: number };
  hundred: { gateRunId: string; gateId: string; events: number; decision: string };
  queued: { gateRunId: string };
  capture: { importId: string; sourceCaseRunId: string };
  crashes: Array<{ gateRunId: string; caseRunId: string }>;
  timings: Record<string, number>;
}

export const ORIGIN = process.env['ROUTESPEC_REAL_ORIGIN'] ?? '';
const TOKEN = process.env['ROUTESPEC_REAL_TOKEN'] ?? '';
export const SEED = JSON.parse(process.env['ROUTESPEC_REAL_SEED'] ?? '{}') as Seed;

/** Opens a console route with the one-time control token in the fragment, as the service does. */
export async function open(page: Page, path: string): Promise<void> {
  await page.goto(`${ORIGIN}${path}#token=${encodeURIComponent(TOKEN)}`);
  await expect(page.locator('#main')).toBeVisible();
}

/** Reads the same persisted record the console reads, straight from the control API. */
export async function api<T = J>(path: string): Promise<T> {
  const res = await fetch(`${ORIGIN}/__routespec/v1${path}`, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
  });
  expect(res.status, `GET ${path}`).toBe(200);
  return (await res.json()) as T;
}

export const projectPath = (p = SEED.release.projectId) => `/projects/${encodeURIComponent(p)}`;

export async function axisCode(scope: Locator, axis: string): Promise<string | null> {
  return scope.locator(`[data-axis="${axis}"] .badge`).first().getAttribute('data-code');
}

/** Moves focus with Tab only, checking every stop for a visible, unobscured indicator. */
export async function tabTo(page: Page, target: Locator, label: string, max = 400): Promise<void> {
  await expect(target).toBeVisible();
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) {
      await expectVisibleUnobscuredFocus(page, label);
      return;
    }
    await page.keyboard.press('Tab');
    const onBody = await page.evaluate(() => document.activeElement === document.body);
    if (!onBody) await expectVisibleUnobscuredFocus(page, `${label} (tab stop ${i + 1})`);
  }
  throw new Error(`could not reach ${label} with Tab`);
}

/** Focus the target with Tab and activate it with Enter. */
export async function tabAndEnter(page: Page, target: Locator, label: string): Promise<void> {
  await tabTo(page, target, label);
  await page.keyboard.press('Enter');
}

/** Focus a text field with Tab and type into it (keyboard only). */
export async function tabAndType(page: Page, target: Locator, label: string, text: string): Promise<void> {
  await tabTo(page, target, label);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text, { delay: 0 });
}
