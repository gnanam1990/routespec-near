import { expect, test, type Page } from '@playwright/test';
import { apiGet, open, resetFixture, setMode } from './helpers.ts';

/**
 * Status parity and authentic states (T-047 scope: console shell against the contract fixture).
 * The displayed axis values are compared with the record the API returned; nothing is
 * recomputed in the browser.
 */
interface Row {
  revisionLabel: string;
  lifecycle: string;
  verdict: string;
  enforcementMode: string;
  artifactReady: boolean | null;
  officialCompatibility: { status: string };
  effectCoverage: { basis: string | null; finding: string };
  attestation: { class: string; freshness: string };
}

test.beforeEach(async ({ request }) => {
  await resetFixture(request);
});

async function axisCode(page: Page, axis: string): Promise<string | null> {
  return page.locator(`.axis-group [data-axis="${axis}"] .badge`).first().getAttribute('data-code');
}

test('every matrix row shows the API axis values, separately, without collapsing them', async ({
  page,
  request,
}) => {
  const matrix = await apiGet<{ rows: Row[] }>(request, '/projects/proj-alpha/matrix');
  await open(page, '/projects/proj-alpha/releases');
  for (const row of matrix.rows) {
    await page.getByRole('button', { name: row.revisionLabel, exact: true }).click();
    await expect(page.getByRole('heading', { name: `Gate summary — ${row.revisionLabel}` })).toBeVisible();
    expect(await axisCode(page, 'Execution state')).toBe(row.lifecycle);
    expect(await axisCode(page, 'Verdict')).toBe(row.verdict);
    expect(await axisCode(page, 'Enforcement')).toBe(row.enforcementMode);
    expect(await axisCode(page, 'Artifact')).toBe(`artifactReady=${String(row.artifactReady)}`);
    expect(await axisCode(page, 'Official compatibility')).toBe(row.officialCompatibility.status);
    expect(await axisCode(page, 'Effect coverage')).toBe(
      `${row.effectCoverage.basis ?? 'NO_BASIS'} ${row.effectCoverage.finding}`,
    );
    expect(await axisCode(page, 'Subject identity')).toBe(
      `${row.attestation.class} ${row.attestation.freshness}`,
    );
    await expect(page.locator('.axis-group .axis-row')).toHaveCount(8);
  }
});

test('PASS stays visible when the artifact is not ready, and compatibility stays separate', async ({
  page,
}) => {
  await open(page, '/projects/proj-alpha/releases');
  await page.getByRole('button', { name: 'v1.5.0', exact: true }).click();
  const group = page.locator('.axis-group');
  await expect(group.locator('[data-axis="Verdict"]')).toContainText('PASS');
  await expect(group.locator('[data-axis="Verdict"]')).toContainText(
    'All required cases passed for these exact revisions.',
  );
  await expect(group.locator('[data-axis="Artifact"]')).toContainText('Artifact not ready');
  await expect(group.locator('[data-axis="Enforcement"]')).toContainText(
    'Required check — verification unavailable',
  );
  await expect(group.locator('[data-axis="Official compatibility"]')).toContainText(
    'Official endpoint compatible',
  );
  await expect(group.locator('[data-axis="Official compatibility"]')).toContainText(
    'No settlement is tested',
  );
  await expect(group.locator('[data-axis="Subject identity"]')).toContainText('Trusted launcher attestation');
});

test('private evidence and declared hooks read as REVIEW, never as PASS or as a NOT_VISIBLE verdict', async ({
  page,
}) => {
  await open(page, '/projects/proj-alpha/releases');
  await page.getByRole('button', { name: 'v1.4.1', exact: true }).click();
  const group = page.locator('.axis-group');
  await expect(group.locator('[data-axis="Verdict"] .badge')).toHaveText('REVIEW');
  await expect(group.locator('[data-axis="Evidence"]')).toContainText('Private — not visible');
  await expect(group.locator('[data-axis="Effect coverage"]')).toContainText('Declared hooks only — REVIEW');
  await expect(page.getByText('Partial result — REVIEW')).toBeVisible();
  // NOT_VISIBLE never appears as a verdict anywhere in the matrix.
  const verdicts = await page.locator('table tbody td:nth-child(5) .badge').allTextContents();
  expect(verdicts.length).toBeGreaterThan(0);
  for (const v of verdicts) expect(['PASS', 'FAIL', 'REVIEW', 'NOT_RUN', 'UNSUPPORTED']).toContain(v.trim());
});

test('no page claims release blocking', async ({ page }) => {
  for (const path of [
    '/projects/proj-alpha/releases',
    '/projects/proj-alpha/gate-runs/gr-pass',
    '/projects/proj-alpha/gate-runs/gr-fail',
    '/settings',
  ]) {
    await open(page, path);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(/blocks? (the )?release|release blocked|branch protect/i);
  }
});

test('a FAIL traces gate run -> case -> run operation -> invariant evidence in four actions', async ({
  page,
}) => {
  await open(page, '/projects/proj-alpha/releases');
  await page.getByRole('link', { name: 'Open gate run for v1.4.0' }).click(); // 1
  await expect(page.locator('.axis-group [data-axis="Verdict"]')).toContainText('INV-03 violated');
  await page.getByRole('link', { name: 'Accepted then response lost' }).click(); // 2
  await page.getByRole('link', { name: 'op-fail-1' }).click(); // 3
  await expect(page.getByRole('heading', { level: 1, name: 'Run operation' })).toBeVisible();
  const failingRow = page.getByRole('row', { name: /INV-03/ });
  await expect(failingRow).toContainText('FAIL');
  await failingRow.getByRole('link', { name: 'ev-gt-1' }).click(); // 4
  const drawer = page.getByRole('complementary', { name: /Evidence/ });
  await expect(drawer).toContainText('proven within scenario');
  // Provider-reported and independently evaluated outcomes are both visible and not collapsed.
  await expect(page.getByRole('heading', { name: 'Provider reported' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Independently evaluated' })).toBeVisible();
  await expect(drawer).not.toContainText('reported by subject');
  await expect(page.getByRole('heading', { name: 'Subject reports' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Independent boundary observations' })).toBeVisible();
});

test('crash recovery exposes only read-only reconciliation, never a mutation retry', async ({ page }) => {
  await open(page, '/projects/proj-alpha/gate-runs/gr-fail/cases/c-fail-2');
  await expect(page.getByText('Crash recovery required')).toBeVisible();
  const actions = page.getByRole('region', { name: 'Actions' });
  await expect(actions.getByRole('button')).toHaveText(['Reconcile existing operation']);
  await expect(page.getByRole('button', { name: /retry/i })).toHaveCount(0);
  await actions.getByRole('button', { name: 'Reconcile existing operation' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reconcile (read-only)' }).click();
  await expect(page.getByText('Epoch 2 → 3.')).toBeVisible();
  await expect(page.getByText('Reconciliation-only case token. Shown once')).toBeVisible();
  await page.getByRole('button', { name: 'I have configured the client — hide token' }).click();
  await expect(page.locator('[data-sensitive="one-time-token"]')).toHaveCount(0);
});

test('empty, unsupported-schema, and unsupported-endpoint states are authentic', async ({ page }) => {
  await open(page, '/projects/proj-empty/releases');
  await expect(page.getByText('No revision registered')).toBeVisible();
  await expect(page.locator('.axis-group')).toHaveCount(0);

  await open(page, '/projects/proj-broken/releases');
  await expect(page.getByRole('alert')).toContainText('Unsupported record schema');
  await expect(page.locator('.axis-group')).toHaveCount(0);

  await open(page, '/projects/proj-legacy/regressions');
  await expect(page.getByRole('alert')).toContainText('Not provided by this control API revision');
});

test('loading reserves layout with a skeleton that implies no values', async ({ page, request }) => {
  await setMode(request, { delayMs: 1500 });
  await open(page, '/projects/proj-alpha/gate-runs/gr-fail');
  const skeleton = page.locator('[aria-busy="true"]').first();
  await expect(skeleton).toBeVisible();
  await expect(skeleton).not.toContainText(/PASS|FAIL|REVIEW/);
  await setMode(request, {});
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 10_000 });
});

test('an expired control token shows a session state, not data', async ({ page }) => {
  await page.goto('/projects/proj-alpha/releases#token=not-the-current-token-0000');
  await expect(page.getByRole('alert').first()).toContainText('Control token expired');
  await expect(page.locator('.axis-group')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Connect control session' }).first()).toBeVisible();
});

test('a concurrent client start is rejected with the authoritative conflict', async ({ page, request }) => {
  // Create and start a fresh gate run through the API so a case is READY.
  const key = () => crypto.randomUUID();
  const headers = { Authorization: `Bearer ${process.env['FIXTURE_CONTROL_TOKEN']}` };
  const created = await request.post('/__routespec/v1/gate-runs', {
    headers: { ...headers, 'Idempotency-Key': key() },
    data: {
      projectId: 'proj-alpha',
      gateId: null,
      buildRevisionId: 'b',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      corpusRevisionId: 'c',
      effectManifestDigest: `sha256:${'b'.repeat(64)}`,
      effectCoveragePolicyDigest: `sha256:${'c'.repeat(64)}`,
      callsiteInventoryDigest: null,
      interceptorProfileDigest: null,
      buildAttestation: { class: 'USER_ASSERTED_LOCAL' },
      mode: 'SIMULATE',
      maxParallelCases: 1,
    },
  });
  const g = (await created.json()) as { gateRunId: string };
  await request.post(`/__routespec/v1/gate-runs/${g.gateRunId}/validate`, {
    headers: { ...headers, 'Idempotency-Key': key(), 'If-Match': '"1"' },
  });
  await request.post(`/__routespec/v1/gate-runs/${g.gateRunId}/start`, {
    headers: { ...headers, 'Idempotency-Key': key(), 'If-Match': '"2"' },
  });
  await open(page, `/projects/proj-alpha/gate-runs/${g.gateRunId}/cases/${g.gateRunId}-c1`);
  // Another client takes the case first.
  await request.post(`/__routespec/v1/case-runs/${g.gateRunId}-c1/start`, {
    headers: { ...headers, 'Idempotency-Key': key() },
  });
  await page.getByRole('button', { name: 'Start isolated case' }).click();
  await expect(page.getByRole('alert')).toContainText('Concurrent client rejected');
  await expect(page.locator('[data-sensitive="one-time-token"]')).toHaveCount(0);
});
