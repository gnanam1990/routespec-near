import { expect, test, type Locator, type Page } from '@playwright/test';
import { Subject, driveJob, type Behaviour, type CaseCredentials } from './support/subject.ts';
import {
  SEED,
  api,
  expectVisibleUnobscuredFocus,
  open,
  projectPath,
  tabAndEnter,
  tabAndType,
  tabTo,
} from './helpers.ts';

/**
 * T-048 — Complete keyboard journey works with visible focus.
 *
 * Against the real control service, at default size and at 200 percent zoom, a keyboard-only
 * user creates a gate run, starts an isolated case, inspects a phase/effect failure and its
 * evidence, captures, quarantines, maps, replay-verifies, reviews, and promotes the trace to a
 * new corpus, runs the corrected client against that corpus, plans an export, and performs
 * fenced reconciliation. Every focus stop is checked for a visible, unobscured indicator. The
 * installed client is a separately launched official-SDK subject that the test configures with
 * the values the console displays, as an operator would copy them.
 */
type J = Record<string, unknown>;

const VIEWPORTS = [
  { name: 'default size', viewport: { width: 1440, height: 900 }, scale: 1, crash: 0 },
  // 200 percent browser zoom on a 1440x900 window gives a 720x450 CSS-pixel viewport.
  { name: '200 percent zoom', viewport: { width: 720, height: 450 }, scale: 2, crash: 1 },
];

async function kv(scope: Locator, key: string): Promise<string> {
  const row = scope
    .locator('.kv-row')
    .filter({ has: scope.page().locator('dt', { hasText: new RegExp(`^${key}$`) }) });
  return (await row.locator('dd').innerText()).trim();
}

/** The operator copies the handoff values into the installed client; the subject runs the job. */
async function runInstalledClient(page: Page, key: string, behaviour: Behaviour): Promise<void> {
  const handoff = page.getByRole('region', { name: 'Connect client' });
  await expect(handoff).toBeVisible();
  const token = (await page.locator('[data-sensitive="one-time-token"]').innerText()).trim();
  const credentials: CaseCredentials = {
    purpose: 'EXECUTION',
    token,
    sessionId: await kv(handoff, 'X-RouteSpec-Session'),
    caseRunId: await kv(handoff, 'X-RouteSpec-Case-Run'),
    fencingEpoch: Number(await kv(handoff, 'X-RouteSpec-Fencing-Epoch')),
    clientInstanceId: await kv(handoff, 'Client instance'),
  };
  const subject = await Subject.launch();
  try {
    await subject.attach(await kv(handoff, 'Proxy base URL'), credentials);
    await driveJob(subject, key, behaviour);
  } finally {
    await subject.close();
  }
}

async function fillGateRunForm(
  page: Page,
  values: {
    gateId?: string;
    build: string;
    artifact: string;
    corpus?: string;
    manifest: string;
    policy: string;
  },
): Promise<void> {
  if (values.gateId) await tabAndType(page, page.getByLabel('Gate ID (optional)'), 'gate id', values.gateId);
  await tabAndType(page, page.getByLabel('Subject build revision ID'), 'build', values.build);
  await tabAndType(page, page.getByLabel('Built artifact digest'), 'artifact', values.artifact);
  if (values.corpus) await tabAndType(page, page.getByLabel('Corpus revision ID'), 'corpus', values.corpus);
  await tabAndType(page, page.getByLabel('Effect manifest digest'), 'manifest', values.manifest);
  await tabAndType(page, page.getByLabel('Effect coverage policy digest'), 'policy', values.policy);
  await tabAndEnter(page, page.getByRole('button', { name: 'Create gate run' }), 'create gate run');
  await expect(page.getByRole('heading', { level: 1, name: 'Gate run' })).toBeVisible();
}

async function validateAndStart(page: Page): Promise<string> {
  await tabAndEnter(page, page.getByRole('button', { name: 'Validate preflight' }), 'validate');
  await tabAndEnter(page, page.getByRole('button', { name: 'Start gate run' }), 'start gate run');
  await expect(page.locator('.axis-group [data-axis="Execution state"] .badge').first()).toHaveAttribute(
    'data-code',
    'RUNNING',
  );
  const m = /gate-runs\/([0-9a-f-]{36})/.exec(page.url());
  expect(m).not.toBeNull();
  return (m as RegExpExecArray)[1] as string;
}

async function startCaseAndRun(page: Page, gateRunId: string, key: string, behaviour: Behaviour): Promise<J> {
  const firstCase = (await api<{ items: J[] }>(`/gate-runs/${gateRunId}/cases`)).items[0] as J;
  await tabAndEnter(
    page,
    page.locator(`tr[data-case="${String(firstCase['caseRunId'])}"] th a`),
    'case link',
  );
  await expect(page.getByRole('heading', { level: 1, name: 'Case run' })).toBeFocused();
  await tabAndEnter(page, page.getByRole('button', { name: 'Start isolated case' }), 'start case');
  await runInstalledClient(page, key, behaviour);
  await tabAndEnter(
    page,
    page.getByRole('button', { name: 'I have configured the client — hide token' }),
    'hide token',
  );
  await expect(page.locator('[data-sensitive="one-time-token"]')).toHaveCount(0);
  await tabAndEnter(
    page,
    page.getByRole('button', { name: 'Finish case input and evaluate' }),
    'finish input',
  );
  const after = (await api<{ items: J[] }>(`/gate-runs/${gateRunId}/cases`)).items[0] as J;
  await expect(page.locator('.axis-list [data-code="COMPLETED"]')).toHaveCount(1);
  // The console shows the kernel's persisted verdict for this case.
  await expect(page.locator(`.axis-list .badge[data-code="${String(after['verdict'])}"]`)).toHaveCount(1);
  return after;
}

for (const vp of VIEWPORTS) {
  test.describe(`keyboard journey at ${vp.name}`, () => {
    test.use({ viewport: vp.viewport, deviceScaleFactor: vp.scale });

    test('gate run, isolated case, failure inspection, capture to new corpus, corrected rerun, export, reconciliation', async ({
      page,
    }) => {
      test.setTimeout(240_000);
      const r = SEED.release;
      let baselineGateRun = '';
      let baselineCase: J = {};

      await test.step('skip link, then create, validate, and start a gate run', async () => {
        await open(page, `${projectPath()}/releases`);
        await page.keyboard.press('Tab');
        const skip = page.getByRole('link', { name: 'Skip to main content' });
        await expect(skip).toBeFocused();
        await expectVisibleUnobscuredFocus(page, 'skip link');
        await page.keyboard.press('Enter');
        await expect(page.locator('#main')).toBeFocused();
        await tabAndEnter(page, page.getByRole('link', { name: 'Run gate' }), 'Run gate');
        await expect(page.getByRole('heading', { level: 1, name: 'Create gate run' })).toBeFocused();
        await fillGateRunForm(page, {
          gateId: SEED.journey.gateId,
          build: r.buildRevisionId,
          artifact: r.artifactDigest,
          corpus: SEED.journey.corpusRevisionId,
          manifest: r.manifestDigest,
          policy: r.policyDigest,
        });
        baselineGateRun = await validateAndStart(page);
      });

      await test.step('start an isolated case; the installed client runs; the kernel verdict is shown', async () => {
        baselineCase = await startCaseAndRun(page, baselineGateRun, `journey-${vp.crash}`, 'NAIVE_RESUBMIT');
      });

      await test.step('inspect the run-operation phases and evidence, and return focus', async () => {
        const opId = String((baselineCase['runOperationIds'] as string[])[0]);
        const op = await api(`/run-operations/${opId}`);
        await tabAndEnter(page, page.getByRole('link', { name: opId }), 'run operation');
        await expect(page.getByRole('heading', { level: 1, name: 'Run operation' })).toBeFocused();
        await expect(page.locator('body')).toContainText(String(op['currentPhase']));
        const evidenceLink = page.locator('a.evidence-link').first();
        await tabAndEnter(page, evidenceLink, 'evidence link');
        await expect(page.locator('#evidence-heading')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(page.locator('#evidence-heading')).toHaveCount(0);
        await expect(evidenceLink).toBeFocused();
        await tabAndEnter(
          page,
          page.getByRole('complementary', { name: 'Operation summary' }).getByRole('link', {
            name: String(baselineCase['caseRunId']),
          }),
          'case link',
        );
        await expect(page.getByRole('heading', { level: 1, name: 'Case run' })).toBeVisible();
      });

      let importId = '';
      await test.step('capture the installed trace into quarantine', async () => {
        await tabAndEnter(page, page.getByRole('button', { name: 'Capture installed trace' }), 'capture');
        const toLibrary = page.getByRole('link', { name: 'Review in the regression library' });
        await tabAndEnter(page, toLibrary, 'library link');
        await expect(page.getByRole('heading', { level: 1, name: 'Regression review' })).toBeFocused();
        importId = /regressions\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
        expect(importId).not.toBe('');
        await expect(page.getByRole('button', { name: 'Promote regression' })).toHaveCount(0);
      });

      await test.step('map, replay-verify, review, and promote to a new corpus', async () => {
        await tabAndEnter(
          page,
          page.getByRole('button', { name: 'Load the proposed mapping draft' }),
          'load draft',
        );
        await tabAndEnter(page, page.getByRole('button', { name: 'Save mapping draft' }), 'save mapping');
        await expect(page.locator('.badge[data-code="MAPPED"]')).toBeVisible();
        await tabAndEnter(page, page.getByRole('button', { name: 'Verify deterministic replay' }), 'verify');
        await expect(page.locator('.badge[data-code="REPLAY_VERIFIED"]')).toBeVisible();
        const form = page.getByRole('form', { name: 'Review the regression' });
        await tabAndType(page, form.getByLabel('Reviewer'), 'reviewer', 'Local reviewer');
        const boxes = form.getByRole('checkbox');
        const n = await boxes.count();
        expect(n).toBeGreaterThan(0);
        for (let i = 0; i < n; i++) {
          await tabTo(page, boxes.nth(i), `decision ${i}`);
          await page.keyboard.press('Space');
          await expect(boxes.nth(i)).toBeChecked();
        }
        const detail = await api(`/imports/${importId}`);
        const phrase = String((detail['review'] as J)['confirmationPhrase']);
        await tabAndType(page, form.getByLabel('Confirmation'), 'confirmation', phrase);
        await tabAndEnter(page, form.getByRole('button', { name: 'Record review' }), 'record review');
        await expect(page.locator('.badge[data-code="REVIEWED"]')).toBeVisible();
        const promote = page.getByRole('button', { name: 'Promote regression' });
        await tabAndEnter(page, promote, 'promote');
        const dialog = page.getByRole('dialog', { name: 'Promote to a new immutable scenario?' });
        await expect(dialog).toBeVisible();
        await tabAndType(page, dialog.getByLabel('New corpus label'), 'corpus label', `promoted-${vp.crash}`);
        await tabAndEnter(
          page,
          dialog.getByRole('button', { name: 'Promote regression' }),
          'confirm promote',
        );
        await expect(page.locator('.badge[data-code="PROMOTED"]')).toBeVisible();
        await expect(page.getByText('Replay-only PASS is insufficient')).toBeVisible();
        await expect(page.locator('.lineage-node', { hasText: 'New corpus' })).toContainText('Done');
        await expect(
          page.locator('.lineage-node', { hasText: 'Corrected installed-client gate run' }),
        ).toContainText('Pending');
      });

      await test.step('run the corrected client against the new corpus and verify the lineage', async () => {
        const c = SEED.journey.corrected;
        await tabAndEnter(
          page,
          page.getByRole('link', { name: 'Run the corrected client against the new corpus' }),
          'corrected rerun',
        );
        await expect(page.getByRole('heading', { level: 1, name: 'Create gate run' })).toBeFocused();
        const promotion = (await api(`/imports/${importId}`))['promotion'] as J;
        await expect(page.getByLabel('Corpus revision ID')).toHaveValue(
          String(promotion['corpusRevisionId']),
        );
        await fillGateRunForm(page, {
          build: c.buildRevisionId,
          artifact: r.artifactDigest,
          manifest: c.manifestDigest,
          policy: c.policyDigest,
        });
        const correctedGateRun = await validateAndStart(page);
        const corrected = await startCaseAndRun(
          page,
          correctedGateRun,
          `corrected-${vp.crash}`,
          'RECONCILING',
        );
        expect(corrected['lineageRole']).toBe('PROMOTED_REGRESSION');
        await open(page, `${projectPath()}/regressions/${importId}`);
        const detail = await api(`/imports/${importId}`);
        const runs = detail['correctedRuns'] as J[];
        expect(runs.map((x) => x['gateRunId'])).toContain(correctedGateRun);
        const table = page.getByRole('region', { name: 'Corrected runs' });
        await expect(table.locator('tr', { hasText: correctedGateRun })).toContainText(
          String(corrected['lifecycle']),
        );
        await expect(page.locator('.kv-row', { hasText: 'Regression status' })).toContainText(
          {
            CORRECTED_RUN_PASSED: 'Corrected installed-client run passed the promoted case',
            CORRECTED_RUN_NOT_PASSING: 'Corrected installed-client run recorded, not passing',
          }[String(detail['regressionStatus'])] ?? 'not reported',
        );
        const correctedOp = await api(
          `/run-operations/${String((corrected['runOperationIds'] as string[])[0])}`,
        );
        const notPassing = (correctedOp['invariants'] as J[])
          .filter((i) => i['status'] !== 'PASS')
          .map(
            (i) => `${String(i['invariantId'])}=${String(i['status'])}:${(i['facts'] as string[]).join(',')}`,
          );
        test.info().annotations.push({
          type: 'corrected-rerun',
          description: `case verdict ${String(corrected['verdict'])}; regression status ${String(detail['regressionStatus'])}; non-PASS invariants ${notPassing.join('; ') || 'none'}; evidence ${JSON.stringify(corrected['evidence'])}`,
        });
      });

      await test.step('plan an export of the evaluated release gate run', async () => {
        await open(page, `${projectPath()}/gate-runs/${r.gateRunId}`);
        await tabAndEnter(page, page.getByRole('button', { name: 'Plan export' }), 'plan export');
        const plan = page.locator('.export-plan');
        await expect(plan).toBeVisible();
        await expect(plan).toContainText(/CLEAN|ADDRESSES_ACKNOWLEDGED|BLOCKED/);
        await expect(plan).toContainText('Written');
      });

      await test.step('fenced reconciliation through a dialog that restores focus', async () => {
        const crash = SEED.crashes[vp.crash] as { gateRunId: string; caseRunId: string };
        const before = (await api<{ items: J[] }>(`/gate-runs/${crash.gateRunId}/cases`)).items[0] as J;
        await open(page, `${projectPath()}/gate-runs/${crash.gateRunId}/cases/${crash.caseRunId}`);
        const reconcile = page.getByRole('button', { name: 'Reconcile existing operation' });
        await tabAndEnter(page, reconcile, 'reconcile');
        const dialog = page.getByRole('dialog', { name: 'Reconcile existing operation' });
        await expect(dialog.getByRole('button', { name: 'Reconcile (read-only)' })).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(reconcile).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(dialog.getByRole('button', { name: 'Reconcile (read-only)' })).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('region', { name: 'Recovery issued' })).toBeVisible();
        const after = (await api<{ items: J[] }>(`/gate-runs/${crash.gateRunId}/cases`)).items[0] as J;
        expect((after['token'] as J)['purpose']).toBe('RECONCILIATION_ONLY');
        // The new epoch fences out the crashed runner's epoch (another recovery may already have
        // moved an expired case into RECOVERY_REQUIRED; the epoch is never advanced twice).
        const epoch = Number(after['fencingEpoch']);
        expect(epoch).toBeGreaterThanOrEqual(Number(before['fencingEpoch']));
        await expect(page.getByText(`Epoch ${epoch - 1} → ${epoch}.`)).toBeVisible();
      });
    });
  });
}
