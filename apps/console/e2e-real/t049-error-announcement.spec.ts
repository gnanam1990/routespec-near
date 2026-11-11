import { expect, test } from '@playwright/test';
import { SEED, api, open, projectPath } from './helpers.ts';

/**
 * T-049 — Error summary and inline errors are announced.
 *
 * Automated part, against the real control service: the error summary is an alert that takes
 * focus, its links move focus to the fields, inline errors are associated with their inputs
 * (aria-invalid, aria-describedby), correcting one field keeps the others, and server-side
 * rejections (an unknown build, a secret-bearing import scanned by the real quarantine) are
 * announced without echoing submitted content. A manual screen-reader pass is recorded
 * separately (docs/status/M09.md); it is not claimed here.
 */
type J = Record<string, unknown>;

test('gate-run form: a failed submit focuses a linked summary, errors are associated, input is kept', async ({
  page,
}) => {
  await open(page, `${projectPath()}/gate-runs/new`);
  await page.getByLabel('Built artifact digest').fill('sha256:not-a-digest');
  await page.getByLabel('Corpus revision ID').fill(SEED.journey.corpusRevisionId);
  await page.getByRole('button', { name: 'Create gate run' }).focus();
  await page.keyboard.press('Enter');
  const summary = page.getByRole('alert').filter({ hasText: 'Fix the following before submitting' }).first();
  await expect(summary).toBeFocused();
  const artifact = page.getByLabel('Built artifact digest');
  await expect(artifact).toHaveAttribute('aria-invalid', 'true');
  const describedBy = (await artifact.getAttribute('aria-describedby')) ?? '';
  const described = await Promise.all(
    describedBy.split(' ').map((id) => page.locator(`[id="${id}"]`).innerText()),
  );
  expect(described.join(' ')).toContain('sha256: followed by 64 lowercase hex characters');
  // Summary links move focus to their field.
  await summary.getByRole('link', { name: /Built artifact digest/ }).focus();
  await page.keyboard.press('Enter');
  await expect(artifact).toBeFocused();
  // Valid input is preserved and fixing a field clears only that field's error on blur.
  await expect(page.getByLabel('Corpus revision ID')).toHaveValue(SEED.journey.corpusRevisionId);
  await artifact.fill(SEED.release.artifactDigest);
  await artifact.blur();
  await expect(artifact).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Subject build revision ID')).toHaveAttribute('aria-invalid', 'true');
});

test('gate-run form: a real server rejection is announced and the form keeps every value', async ({
  page,
}) => {
  await open(page, `${projectPath()}/gate-runs/new`);
  const unknownBuild = '00000000-0000-4000-8000-00000000dead';
  await page.getByLabel('Subject build revision ID').fill(unknownBuild);
  await page.getByLabel('Built artifact digest').fill(SEED.release.artifactDigest);
  await page.getByLabel('Corpus revision ID').fill(SEED.journey.corpusRevisionId);
  await page.getByLabel('Effect manifest digest').fill(SEED.release.manifestDigest);
  await page.getByLabel('Effect coverage policy digest').fill(SEED.release.policyDigest);
  await page.getByRole('button', { name: 'Create gate run' }).click();
  const alert = page.getByRole('alert').filter({ hasText: /not found|RS_NOT_FOUND/i });
  await expect(alert.first()).toBeVisible();
  await expect(alert.first()).toContainText('RS_NOT_FOUND');
  await expect(page.getByLabel('Subject build revision ID')).toHaveValue(unknownBuild);
  await expect(page.getByLabel('Effect coverage policy digest')).toHaveValue(SEED.release.policyDigest);
  // Nothing was created: the project still lists the same gate runs.
  const matrix = await api<{ rows: J[] }>(`/projects/${SEED.release.projectId}/matrix`);
  expect(matrix.rows.some((r) => r['buildRevisionId'] === unknownBuild)).toBe(false);
});

test('import form: invalid submit, then a secret-bearing trace rejected by the real quarantine scan', async ({
  page,
}) => {
  await open(page, `${projectPath()}/regressions`);
  const form = page.getByRole('form', { name: 'Import a user trace' });
  await form.getByRole('button', { name: 'Import into quarantine' }).click();
  const summary = page.getByRole('alert').filter({ hasText: 'Fix the following before submitting' }).first();
  await expect(summary).toBeFocused();
  await expect(summary.getByRole('link')).toHaveCount(2);
  await expect(page.getByLabel('Trace file')).toHaveAttribute('aria-invalid', 'true');

  const secret = `sk_live_${'Q'.repeat(40)}`;
  await page.getByLabel('Trace file').setInputFiles({
    name: 'captured-trace.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'routespec.trace/1', note: 'pasted', apiKey: secret })),
  });
  await page.getByRole('checkbox', { name: /untrusted/ }).check();
  await form.getByRole('button', { name: 'Import into quarantine' }).click();
  await expect(summary).toBeFocused();
  await expect(summary).toContainText('The quarantine scan blocked this trace');
  await expect(page.getByLabel('Trace file')).toHaveAttribute('aria-invalid', 'true');
  // The secret value is never echoed by the service or the console.
  expect(await page.locator('body').innerText()).not.toContain(secret);
  const imports = await api<{ items: J[] }>(`/projects/${SEED.release.projectId}/imports`);
  const row = imports.items.find((i) => i['sanitizedName'] === 'captured-trace.json');
  expect(row).toBeTruthy();
  expect(JSON.stringify(row)).not.toContain(secret);
  expect(((row as J)['findings'] as J)['secret']).toBeGreaterThan(0);
});
