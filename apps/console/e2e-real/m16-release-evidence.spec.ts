import { expect, test } from '@playwright/test';
import { SEED, api, expectNoAxeViolations, open, projectPath, tabAndEnter, tabTo } from './helpers.ts';

/**
 * M16 (RP-08) in the console against the real control service: the refusal of a capture that
 * is not release evidence is shown with its stable reasons, the promotion dialog offers only
 * the diagnostic-only, advisory choice for it, a promoted diagnostic capture is labelled as such,
 * and a release-evidence bundle for a gate that uses it is refused by the service (the console
 * shows the service's code) while an explicit diagnostic bundle is planned. The console decides
 * none of this; it renders what the service returns.
 */
type J = Record<string, unknown>;

test('an unconfined capture is shown as not release evidence, with the service reasons', async ({ page }) => {
  const detail = await api<J>(`/imports/${SEED.capture.importId}`);
  const evidence = detail['releaseEvidence'] as { releaseEvidence: boolean; refusalReasons: string[] };
  expect(evidence.releaseEvidence).toBe(false);
  expect(evidence.refusalReasons).toEqual(
    expect.arrayContaining(['DECLARED_HOOKS_ONLY', 'PROCESS_TREE_NOT_CONFINED']),
  );
  await open(page, `${projectPath()}/regressions/${SEED.capture.importId}`);
  const panel = page.locator('.release-evidence[data-release-evidence="false"]');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Not release evidence')).toBeVisible();
  const reasons = panel.getByRole('list', { name: 'Release-evidence refusal reasons' });
  for (const r of evidence.refusalReasons) await expect(reasons).toContainText(r);
  await expectNoAxeViolations(page, 'regression review with a release-evidence refusal');
});

test('a promoted diagnostic capture is labelled diagnostic only', async ({ page }) => {
  const detail = await api<J>(`/imports/${SEED.diagnostic.importId}`);
  expect((detail['promotion'] as J)['evidenceUse']).toBe('DIAGNOSTIC_ONLY');
  await open(page, `${projectPath()}/regressions/${SEED.diagnostic.importId}`);
  await expect(page.locator('[data-evidence-use="DIAGNOSTIC_ONLY"]')).toContainText('Diagnostic only');
});

test('a release-evidence bundle is refused for a gate using a diagnostic capture; a diagnostic bundle is planned', async ({
  page,
}) => {
  await open(page, `${projectPath()}/gate-runs/${SEED.diagnostic.gateRunId}`);
  await expect(page.getByLabel('Bundle use')).toHaveValue('RELEASE_EVIDENCE');
  await tabAndEnter(page, page.getByRole('button', { name: 'Plan export' }), 'plan export');
  const alert = page.getByRole('alert').filter({ hasText: 'RS_CAPTURE_NOT_RELEASE_EVIDENCE' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Safety policy denied the action');
  await expect(page.locator('.export-plan')).toHaveCount(0);
  await tabTo(page, page.getByLabel('Bundle use'), 'bundle use');
  await page.getByLabel('Bundle use').selectOption('DIAGNOSTIC_ONLY');
  await tabAndEnter(page, page.getByRole('button', { name: 'Plan export' }), 'plan diagnostic export');
  const plan = page.locator('.export-plan');
  await expect(plan).toBeVisible();
  await expect(plan.locator('.kv-row', { hasText: 'Bundle use' })).toContainText('DIAGNOSTIC_ONLY');
});
