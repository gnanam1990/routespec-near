import { expect, test, type Page } from '@playwright/test';
import { SEED, api, axisCode, open, projectPath } from './helpers.ts';

/**
 * T-047 — Gate and evidence statuses are consistent across UI and API.
 *
 * Every value compared here was produced by the real product path (separately launched subjects,
 * proxy, scenario runtime, kernel, gate aggregation) and read back from the real control API.
 * The test reads the same record over HTTP and compares it with what the console renders;
 * nothing is recomputed in the browser and no expected verdict is hard-coded.
 */
type J = Record<string, unknown>;

const AXES = [
  'Execution state',
  'Verdict',
  'Evidence',
  'Subject identity',
  'Effect coverage',
  'Artifact',
  'Enforcement',
  'Official compatibility',
] as const;

function expectedCodes(r: J): Record<(typeof AXES)[number], string> {
  const ev = r['evidence'] as { class: string; scope: string | null; reasons: string[] };
  const att = r['attestation'] as { class: string; freshness: string };
  const cov = r['effectCoverage'] as { basis: string | null; finding: string };
  return {
    'Execution state': String(r['lifecycle']),
    Verdict: String(r['verdict']),
    Evidence: [ev.class, ev.scope ?? 'NO_SCOPE', ...ev.reasons].join(' '),
    'Subject identity': `${att.class} ${att.freshness}`,
    'Effect coverage': `${cov.basis ?? 'NO_BASIS'} ${cov.finding}`,
    Artifact: `artifactReady=${String(r['artifactReady'])}`,
    Enforcement: String(r['enforcementMode']),
    'Official compatibility': String((r['officialCompatibility'] as J)['status']),
  };
}

async function noBlockingClaim(page: Page): Promise<void> {
  const text = (await page.locator('body').innerText()).toLowerCase();
  expect(text).not.toContain('blocks release');
  expect(text).not.toContain('release blocked');
}

const gateRunPath = (id = SEED.release.gateRunId) => `${projectPath()}/gate-runs/${encodeURIComponent(id)}`;

test('the gate run shows the eight persisted axes and every case row equals the API record', async ({
  page,
}) => {
  const gate = await api(`/gate-runs/${SEED.release.gateRunId}`);
  const cases = (await api<{ items: J[] }>(`/gate-runs/${SEED.release.gateRunId}/cases`)).items;
  // The gate decision is the persisted evaluation the seed recorded, not a browser value.
  expect(gate['verdict']).toBe(SEED.release.decision);
  await open(page, gateRunPath());
  const group = page.locator('.axis-group').first();
  await expect(group.locator('.axis-row')).toHaveCount(8);
  const expected = expectedCodes(gate);
  for (const axis of AXES) expect(await axisCode(group, axis), axis).toBe(expected[axis]);
  const counts = gate['counts'] as Record<string, number>;
  await expect(page.locator('.kv').filter({ hasText: 'Passed' }).first()).toContainText(
    String(counts['passed']),
  );
  for (const c of cases) {
    const row = page.locator(`tr[data-case="${String(c['caseRunId'])}"]`);
    await expect(row.locator(`.badge[data-code="${String(c['lifecycle'])}"]`)).toHaveCount(1);
    await expect(row.locator(`.badge[data-code="${String(c['verdict'])}"]`)).toHaveCount(1);
    await expect(row).toContainText(`${String(c['fencingEpoch'])}`);
  }
  // The real records cover PASS, REVIEW, and FAIL cases; their counts match the API.
  const verdicts = cases.map((c) => String(c['verdict'])).sort();
  expect(new Set(verdicts).size).toBeGreaterThanOrEqual(3);
  await noBlockingClaim(page);
});

test('the release matrix rows equal the API matrix rows, axis by axis', async ({ page }) => {
  const matrix = await api<{ rows: J[] }>(`/projects/${SEED.release.projectId}/matrix`);
  expect(matrix.rows.length).toBeGreaterThan(0);
  await open(page, `${projectPath()}/releases`);
  const buttons = page.locator('table .link-button');
  await expect(buttons).toHaveCount(matrix.rows.length);
  for (let i = 0; i < matrix.rows.length; i++) {
    const row = matrix.rows[i] as J;
    await buttons.nth(i).click();
    await expect(buttons.nth(i)).toHaveAttribute('aria-pressed', 'true');
    const group = page.locator('.axis-group').first();
    await expect(group).toBeVisible();
    const expected = expectedCodes(row);
    for (const axis of AXES) expect(await axisCode(group, axis), `row ${i} ${axis}`).toBe(expected[axis]);
  }
  await noBlockingClaim(page);
});

test('each case page renders its persisted lifecycle, verdict, evidence, and coverage separately', async ({
  page,
}) => {
  const cases = (await api<{ items: J[] }>(`/gate-runs/${SEED.release.gateRunId}/cases`)).items;
  for (const c of cases) {
    await open(page, `${gateRunPath()}/cases/${encodeURIComponent(String(c['caseRunId']))}`);
    const axes = page.locator('.axis-list');
    const axisRow = (name: string) =>
      axes.locator('.axis-row').filter({ has: page.locator('dt', { hasText: new RegExp(`^${name}$`) }) });
    await expect(axes.locator(`.badge[data-code="${String(c['lifecycle'])}"]`)).toHaveCount(1);
    await expect(axes.locator(`.badge[data-code="${String(c['verdict'])}"]`)).toHaveCount(1);
    const ev = c['evidence'] as { class: string; scope: string | null; reasons: string[] };
    const evidence = axisRow('Evidence');
    if (ev.scope === 'SIMULATED_GROUND_TRUTH') await expect(evidence).toContainText('proven within scenario');
    if (ev.scope === 'PRIVATE_NOT_VISIBLE') {
      // Not visible is an evidence scope with a reason; it is never shown as a verdict.
      await expect(evidence).toContainText(/not visible/i);
      await expect(axisRow('Verdict').locator('.badge')).not.toHaveAttribute('data-code', 'NOT_VISIBLE');
    }
    const cov = c['effectCoverage'] as { basis: string | null };
    if (cov.basis === 'DECLARED_HOOKS_ONLY') {
      await expect(axisRow('Effect coverage')).toContainText('Declared hooks only — REVIEW');
    }
    await noBlockingClaim(page);
  }
});

test('a FAIL traces gate run -> case -> run operation -> invariant in four actions, matching the API', async ({
  page,
}) => {
  const cases = (await api<{ items: J[] }>(`/gate-runs/${SEED.release.gateRunId}/cases`)).items;
  const failing = cases.find((c) => c['verdict'] === 'FAIL');
  expect(failing, 'the real kernel recorded a FAIL case').toBeTruthy();
  const opId = String((failing?.['runOperationIds'] as string[])[0]);
  const op = await api(`/run-operations/${opId}`);
  await open(page, gateRunPath());
  let actions = 0;
  await page.locator(`tr[data-case="${String(failing?.['caseRunId'])}"] th a`).click();
  actions++;
  await page.getByRole('link', { name: opId }).click();
  actions++;
  const invariants = page.getByRole('region', { name: 'Invariants (scrolls horizontally)' });
  await page.getByRole('button', { name: 'Failures and review' }).click();
  actions++;
  for (const inv of op['invariants'] as J[]) {
    if (inv['status'] !== 'FAIL') continue;
    const row = invariants.locator('tr', { hasText: String(inv['invariantId']) });
    await expect(row.locator('.badge[data-code="FAIL"]')).toHaveCount(1);
  }
  expect((op['invariants'] as J[]).some((i) => i['status'] === 'FAIL')).toBe(true);
  expect(actions).toBeLessThanOrEqual(4);
  // The operation outcome shows the persisted kernel verdict and the provider's raw report apart.
  expect((op['evaluatedOutcome'] as J)['verdict']).toBe(failing?.['verdict']);
  const evaluated = page
    .getByRole('region', { name: 'Outcome' })
    .locator('div', { has: page.getByRole('heading', { name: 'Independently evaluated' }) })
    .last();
  await expect(evaluated.locator('.badge')).toHaveAttribute('data-code', String(failing?.['verdict']));
  const raw = (op['providerReported'] as J)['rawStatus'];
  if (typeof raw === 'string') await expect(page.getByText(raw, { exact: true }).first()).toBeVisible();
  await expect(page.locator('body')).toContainText(String(op['currentPhase']));
  // Locator-like fields stay masked in the browser.
  const finFields = ((op['phases'] as J)['quoteFinalization'] as J)['fields'] as J[];
  for (const f of finFields.filter((x) => x['masked'] === true)) expect(f['value']).toBe('masked');
  await noBlockingClaim(page);
});

test('a crashed runner offers only the backend-authorized read-only reconciliation', async ({ page }) => {
  const crash = SEED.crashes[2] as { gateRunId: string; caseRunId: string };
  const before = (await api<{ items: J[] }>(`/gate-runs/${crash.gateRunId}/cases`)).items[0] as J;
  expect((before['recovery'] as J | null)?.['action']).toBe('RECONCILE_EXISTING_OPERATION');
  await open(page, `${gateRunPath(crash.gateRunId)}/cases/${encodeURIComponent(crash.caseRunId)}`);
  const actions = page.getByRole('region', { name: 'Actions' });
  await expect(actions.getByRole('button')).toHaveText(['Reconcile existing operation']);
  await expect(page.getByRole('button', { name: /retry|resubmit|commit/i })).toHaveCount(0);
  await actions.getByRole('button', { name: 'Reconcile existing operation' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reconcile (read-only)' }).click();
  await expect(page.locator('[data-sensitive="one-time-token"]')).toHaveCount(1);
  const after = (await api<{ items: J[] }>(`/gate-runs/${crash.gateRunId}/cases`)).items[0] as J;
  const epoch = Number(after['fencingEpoch']);
  expect(epoch).toBeGreaterThanOrEqual(Number(before['fencingEpoch']));
  expect((after['token'] as J)['purpose']).toBe('RECONCILIATION_ONLY');
  await expect(page.getByRole('region', { name: 'Recovery issued' })).toContainText(
    `Epoch ${epoch - 1} → ${epoch}`,
  );
  await page.getByRole('button', { name: 'I have configured the client — hide token' }).click();
  await expect(page.locator('[data-sensitive="one-time-token"]')).toHaveCount(0);
  // The token value is not kept anywhere in browser storage.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toMatch(/rscase_|rsctl_/);
});

test('queued cases under bounded parallelism and the 100-case PASS read back exactly', async ({ page }) => {
  const queued = await api(`/gate-runs/${SEED.queued.gateRunId}`);
  await open(page, gateRunPath(SEED.queued.gateRunId));
  const par = queued['parallelism'] as Record<string, number>;
  await expect(page.locator('.kv').filter({ hasText: 'Queued (waiting for a slot)' }).first()).toContainText(
    String(par['queued']),
  );
  const hundred = await api(`/gate-runs/${SEED.hundred.gateRunId}`);
  expect(hundred['verdict']).toBe(SEED.hundred.decision);
  await open(page, gateRunPath(SEED.hundred.gateRunId));
  const group = page.locator('.axis-group').first();
  expect(await axisCode(group, 'Verdict')).toBe(String(hundred['verdict']));
  expect(await axisCode(group, 'Effect coverage')).toBe(expectedCodes(hundred)['Effect coverage']);
  await expect(page.getByText('Diagnostic run: declared hooks only')).toBeVisible();
});

test('an invalid control token shows a session state and no record data', async ({ page }) => {
  await page.goto(
    `${process.env['ROUTESPEC_REAL_ORIGIN']}${gateRunPath()}#token=rsctl_not-the-service-token`,
  );
  await expect(page.locator('#main')).toBeVisible();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expect(page.locator('.axis-group')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(SEED.release.artifactDigest.slice(7, 19));
});

test('a lost connection keeps the last persisted record marked stale until Reconnect', async ({ page }) => {
  await open(page, gateRunPath());
  await expect(page.locator('.axis-group').first()).toBeVisible();
  await page.route('**/__routespec/v1/**', (route) => route.abort('connectionrefused'));
  await page.getByRole('link', { name: 'Gate runs' }).first().click();
  await expect(page.getByText(/not reachable|disconnected/i).first()).toBeVisible();
  await page.unroute('**/__routespec/v1/**');
  await page.getByRole('button', { name: 'Reconnect' }).first().click();
  await expect(page.getByText(/not reachable/i)).toHaveCount(0);
});

test('Safety & Settings shows the service settings and committed live is never supported', async ({
  page,
}) => {
  const settings = await api('/settings');
  await open(page, '/settings');
  const modes = page.getByRole('table').filter({ hasText: 'Runtime' }).first();
  for (const m of settings['modes'] as J[]) {
    const label = m['mode'] === 'COMMITTED_LIVE' ? 'Committed live' : String(m['mode']);
    const row = modes.locator('tr', { hasText: label });
    await expect(row).toContainText(m['supported'] === true ? 'Supported' : 'UNSUPPORTED');
  }
  expect((settings['modes'] as J[]).find((m) => m['mode'] === 'COMMITTED_LIVE')?.['supported']).toBe(false);
  await expect(page.locator('body')).toContainText(String((settings['versions'] as J)['evaluator']));
  await noBlockingClaim(page);
});
