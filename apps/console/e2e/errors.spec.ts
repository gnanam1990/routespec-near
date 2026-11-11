import { expect, test } from '@playwright/test';
import { open, resetFixture } from './helpers.ts';

/** Error summary and inline errors (T-049 scope: automated checks; screen-reader runs are manual). */
test.beforeEach(async ({ request }) => {
  await resetFixture(request);
});

test('gate-run form: failed submit focuses a linked summary and keeps valid input', async ({ page }) => {
  await open(page, '/projects/proj-alpha/gate-runs/new');
  await page.getByLabel('Integration revision ID').fill('rev-150');
  await page.getByLabel('Built artifact digest').fill('sha256:not-a-digest');
  await page.getByLabel('Bounded parallelism').fill('99');
  await page.getByRole('button', { name: 'Create gate run' }).click();

  const summary = page.locator('.error-summary');
  await expect(summary).toBeFocused();
  await expect(summary).toHaveAttribute('role', 'alert');
  await expect(summary.getByRole('link')).toContainText(['Enter the subject build revision id.']);

  // Inline errors are associated with their controls.
  const artifact = page.getByLabel('Built artifact digest');
  await expect(artifact).toHaveAttribute('aria-invalid', 'true');
  const describedBy = (await artifact.getAttribute('aria-describedby')) ?? '';
  const describedText = await page.evaluate(
    (ids) =>
      ids
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' '),
    describedBy,
  );
  expect(describedText).toContain('must be sha256:');

  // Summary links move focus to the field.
  await summary.getByRole('link', { name: /Built artifact digest must be/ }).click();
  await expect(artifact).toBeFocused();

  // Valid input is preserved.
  await expect(page.getByLabel('Integration revision ID')).toHaveValue('rev-150');
  await expect(page.getByLabel('Bounded parallelism')).toHaveValue('99');
});

test('gate-run form: server field errors are rendered in the summary and inline', async ({ page }) => {
  await open(page, '/projects/proj-alpha/gate-runs/new');
  const digest = (c: string) => `sha256:${c.repeat(64)}`;
  await page.getByLabel('Integration revision ID').fill('rev-unknown');
  await page.getByLabel('Subject build revision ID').fill('build-1');
  await page.getByLabel('Built artifact digest').fill(digest('a'));
  await page.getByLabel('Corpus revision ID').fill('corpus-core-6');
  await page.getByLabel('Effect manifest digest').fill(digest('b'));
  await page.getByLabel('Effect coverage policy digest').fill(digest('c'));
  await page.getByLabel('Actual-client adapter revision').fill('adapter@1');
  await page.getByLabel('Evaluator revision').fill('kernel@1.0.0');
  await page.getByLabel('Configuration digest').fill(digest('d'));
  await page.getByRole('button', { name: 'Create gate run' }).click();
  const summary = page.locator('.error-summary');
  await expect(summary).toBeFocused();
  await expect(summary).toContainText('Integration revision rev-unknown is not registered');
  await expect(page.getByLabel('Integration revision ID')).toHaveAttribute('aria-invalid', 'true');
  // Correcting the field and resubmitting succeeds; nothing else had to be re-entered.
  await page.getByLabel('Integration revision ID').fill('rev-150');
  await page.getByRole('button', { name: 'Create gate run' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Gate run' })).toBeVisible();
  await expect(page.locator('.axis-group [data-axis="Execution state"] .badge')).toHaveAttribute(
    'data-code',
    'DRAFT',
  );
});

test('import form: invalid submit, then server secret-scan rejection, both announced', async ({ page }) => {
  await open(page, '/projects/proj-alpha/regressions');
  await page.getByRole('button', { name: 'Import into quarantine' }).click();
  const summary = page.locator('.error-summary');
  await expect(summary).toBeFocused();
  await expect(summary.getByRole('link')).toHaveCount(2);
  await summary.getByRole('link', { name: /Choose a trace file/ }).click();
  await expect(page.getByLabel('Trace file')).toBeFocused();

  await page.getByLabel('Trace file').setInputFiles({
    name: 'trace.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"events":[\n"ROUTESPEC_TEST_SECRET_MARKER"]}'),
  });
  await page.getByRole('checkbox', { name: /I understand this trace is untrusted/ }).check();
  await page.getByRole('button', { name: 'Import into quarantine' }).click();
  await expect(summary).toBeFocused();
  await expect(summary).toContainText('secret-shaped value');
  // The secret marker itself is never echoed back.
  await expect(page.locator('body')).not.toContainText('ROUTESPEC_TEST_SECRET_MARKER');
  await expect(page.getByRole('checkbox', { name: /I understand this trace is untrusted/ })).toBeChecked();
});
