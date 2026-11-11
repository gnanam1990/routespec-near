import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectVisibleUnobscuredFocus, open, resetFixture } from './helpers.ts';

/**
 * Keyboard-only journey (T-048 scope: console shell against the contract fixture). Every step
 * moves focus with Tab/Shift+Tab and activates with Enter/Space/Escape; each focus stop is
 * checked for a visible, unobscured indicator.
 */
async function tabTo(page: Page, target: Locator, label: string, max = 250): Promise<void> {
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

async function typeInto(page: Page, field: Locator, label: string, text: string): Promise<void> {
  await tabTo(page, field, label);
  await page.keyboard.type(text);
}

const digest = (c: string) => `sha256:${c.repeat(64)}`;

const VIEWPORTS = [
  { name: 'default size', viewport: { width: 1440, height: 900 }, scale: 1 },
  // 200 percent browser zoom on a 1440x900 window gives a 720x450 CSS-pixel viewport.
  { name: '200 percent zoom', viewport: { width: 720, height: 450 }, scale: 2 },
];

for (const vp of VIEWPORTS) {
  test.describe(`keyboard journey at ${vp.name}`, () => {
    test.use({ viewport: vp.viewport, deviceScaleFactor: vp.scale });

    test.beforeEach(async ({ request }) => {
      await resetFixture(request);
    });

    test('skip link, then create, validate, and start a gate run, then start an isolated case', async ({
      page,
    }) => {
      await open(page, '/projects/proj-alpha/releases');
      await page.keyboard.press('Tab');
      const skip = page.getByRole('link', { name: 'Skip to main content' });
      await expect(skip).toBeFocused();
      await expectVisibleUnobscuredFocus(page, 'skip link');
      await page.keyboard.press('Enter');
      await expect(page.locator('#main')).toBeFocused();

      await tabTo(page, page.getByRole('link', { name: 'Run gate' }), 'Run gate');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { level: 1, name: 'Create gate run' })).toBeFocused();

      await typeInto(page, page.getByLabel('Integration revision ID'), 'revision', 'rev-150');
      await typeInto(page, page.getByLabel('Subject build revision ID'), 'build', 'build-rev-150');
      await typeInto(page, page.getByLabel('Built artifact digest'), 'artifact', digest('a'));
      await typeInto(page, page.getByLabel('Corpus revision ID'), 'corpus', 'corpus-core-6');
      await typeInto(page, page.getByLabel('Effect manifest digest'), 'manifest', digest('b'));
      await typeInto(page, page.getByLabel('Effect coverage policy digest'), 'policy', digest('c'));
      await typeInto(
        page,
        page.getByLabel('Actual-client adapter revision'),
        'adapter',
        'one-click-sdk-adapter@0.1.26+1',
      );
      await typeInto(page, page.getByLabel('Evaluator revision'), 'evaluator', 'kernel@1.0.0');
      await typeInto(page, page.getByLabel('Configuration digest'), 'configuration', digest('d'));
      await tabTo(page, page.getByRole('button', { name: 'Create gate run' }), 'submit');
      await page.keyboard.press('Enter');

      await expect(page.getByRole('heading', { level: 1, name: 'Gate run' })).toBeVisible();
      await tabTo(page, page.getByRole('button', { name: 'Validate preflight' }), 'validate');
      await page.keyboard.press('Enter');
      await tabTo(page, page.getByRole('button', { name: 'Start gate run' }), 'start gate run');
      await page.keyboard.press('Enter');
      await expect(page.locator('.axis-group [data-axis="Execution state"] .badge')).toHaveAttribute(
        'data-code',
        'RUNNING',
      );

      await tabTo(
        page,
        page.getByRole('link', { name: 'Accepted then response lost (promoted regression)' }),
        'case link',
      );
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { level: 1, name: 'Case run' })).toBeFocused();
      await tabTo(page, page.getByRole('button', { name: 'Start isolated case' }), 'start case');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: 'Connect client' })).toBeVisible();
      await expect(page.locator('[data-sensitive="one-time-token"]')).toHaveCount(1);
      await tabTo(
        page,
        page.getByRole('button', { name: 'I have configured the client — hide token' }),
        'hide token',
      );
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-sensitive="one-time-token"]')).toHaveCount(0);
    });

    test('inspect a phase/effect failure and its evidence, then return focus', async ({ page }) => {
      await open(page, '/projects/proj-alpha/gate-runs/gr-fail/cases/c-fail-1');
      await tabTo(page, page.getByRole('link', { name: 'op-fail-1' }), 'run operation');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { level: 1, name: 'Run operation' })).toBeFocused();
      await expect(
        page.getByText('Second commit with changed material rejected; original binding kept.'),
      ).toBeVisible();
      const evidenceLink = page.getByRole('row', { name: /INV-03/ }).getByRole('link', { name: 'ev-gt-1' });
      await tabTo(page, evidenceLink, 'evidence link');
      await page.keyboard.press('Enter');
      await expect(page.locator('#evidence-heading')).toBeFocused();
      await expect(page.getByRole('complementary', { name: /Evidence/ })).toContainText(
        'proven within scenario',
      );
      await page.keyboard.press('Escape');
      await expect(page.getByRole('complementary', { name: /Evidence/ })).toHaveCount(0);
      await expect(evidenceLink).toBeFocused();
    });

    test('fenced reconciliation through a dialog that restores focus', async ({ page }) => {
      await open(page, '/projects/proj-alpha/gate-runs/gr-fail/cases/c-fail-2');
      const reconcile = page.getByRole('button', { name: 'Reconcile existing operation' });
      await tabTo(page, reconcile, 'reconcile');
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Reconcile existing operation' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Reconcile (read-only)' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(reconcile).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(dialog.getByRole('button', { name: 'Reconcile (read-only)' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByText('Epoch 2 → 3.')).toBeVisible();
    });

    test('capture an installed trace, then verify and promote a mapped capture', async ({ page }) => {
      await open(page, '/projects/proj-alpha/gate-runs/gr-fail/cases/c-fail-3');
      await tabTo(page, page.getByRole('button', { name: 'Capture installed trace' }), 'capture');
      await page.keyboard.press('Enter');
      const toLibrary = page.getByRole('link', { name: 'Review in the regression library' });
      await tabTo(page, toLibrary, 'library link');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { level: 1, name: 'Regression review' })).toBeFocused();
      await expect(page.getByRole('button', { name: 'Promote regression' })).toHaveCount(0);

      await open(page, '/projects/proj-alpha/regressions');
      await tabTo(page, page.getByRole('link', { name: 'capture-response-loss' }), 'mapped capture');
      await page.keyboard.press('Enter');
      await tabTo(page, page.getByRole('button', { name: 'Verify deterministic replay' }), 'verify replay');
      await page.keyboard.press('Enter');
      const promote = page.getByRole('button', { name: 'Promote regression' });
      await tabTo(page, promote, 'promote');
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Promote to a new immutable scenario?' });
      await expect(dialog).toBeVisible();
      await tabTo(page, dialog.getByLabel('Review note'), 'review note');
      await page.keyboard.type('Reviewed: response-loss after accepted commit; secrets absent.');
      await tabTo(page, dialog.getByRole('button', { name: 'Promote regression' }), 'confirm promote');
      await page.keyboard.press('Enter');
      await expect(page.locator('.badge[data-code="PROMOTED"]')).toBeVisible();
      await expect(page.getByText('Replay-only PASS is insufficient')).toBeVisible();
      await expect(page.locator('.lineage-node', { hasText: 'New corpus' })).toContainText('Done');
      await expect(
        page.locator('.lineage-node', { hasText: 'Corrected installed-client gate run' }),
      ).toContainText('Pending');
    });
  });
}
