/**
 * Console contract parity (ADR-0008): responses of the real control API over real persisted
 * records parse against the console's own closed response schemas (apps/console/src/api/
 * schemas.ts). This replaces the M09 shell fixture as the source of these shapes for the routes
 * listed here; routes whose shape is not yet aligned are listed in docs/status/M08.md.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import {
  expectOk,
  gateRunBody as gateRunBodyFor,
  quoteBody,
  setupProject,
  startHarness,
  startedGateRun,
  Subject,
  type Harness,
  type ProjectSetup,
} from './support/fixture.ts';

type J = Record<string, unknown>;
let schemas: Record<string, ZodTypeAny>;
let h: Harness;
let p: ProjectSetup;
let subject: Subject | null = null;

function parses(name: string, value: unknown): void {
  const schema = schemas[name] as ZodTypeAny;
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`${name}: ${JSON.stringify(r.error.issues.slice(0, 5))}`);
  expect(r.success).toBe(true);
}

beforeAll(async () => {
  const path = fileURLToPath(new URL('../../../apps/console/src/api/schemas.ts', import.meta.url));
  schemas = (await import(pathToFileURL(path).href)) as Record<string, ZodTypeAny>;
  h = await startHarness({ leaseTtlMs: 60_000 });
  p = await setupProject(h, 'parity');
});

afterAll(async () => {
  await subject?.close().catch(() => undefined);
  await h?.close();
});

describe('console contract parity with the real control API', () => {
  it('settings, projects, matrix, gate run, cases, case start, session, events, recovery, and imports parse', async () => {
    parses('zSettings', expectOk(await h.api('GET', '/settings'), 200));
    const projects = expectOk(await h.api('GET', '/projects'), 200);
    for (const it of projects['items'] as J[]) parses('zProject', it);
    const run = await startedGateRun(h, p);
    parses('zGateRun', expectOk(await h.api('GET', `/gate-runs/${run.gateRunId}`), 200));
    parses('zCaseRunPage', expectOk(await h.api('GET', `/gate-runs/${run.gateRunId}/cases`), 200));
    const start = expectOk(await h.api('POST', `/case-runs/${run.caseRunId}/start`, {}), 201);
    parses('zCaseStart', start);
    subject = await Subject.launch();
    await subject.attach(run.proxyBaseUrl, start);
    await subject.send({ type: 'logicalJob', key: 'order-parity' });
    const q = await subject.call('getQuote', quoteBody());
    const depositAddress = String(((q['value'] as J)['quote'] as J)['depositAddress']);
    await subject.call('submitDepositTx', { txHash: 'sim-tx-parity', depositAddress });
    await subject.call('getExecutionStatus', depositAddress);
    const sessionId = String(start['sessionId']);
    parses('zSession', expectOk(await h.api('GET', `/sessions/${sessionId}`), 200));
    const events = expectOk(await h.api('GET', `/sessions/${sessionId}/events?limit=50`), 200);
    expect((events['items'] as J[]).length).toBeGreaterThan(0);
    parses('zEventPage', events);
    parses('zCaseRunPage', expectOk(await h.api('GET', `/gate-runs/${run.gateRunId}/cases`), 200));
    h.clock.advance(61_000);
    parses('zRecoveryResult', expectOk(await h.api('POST', `/case-runs/${run.caseRunId}/recover`, {}), 200));
    await subject.close();
    subject = null;
    expectOk(await h.api('POST', `/case-runs/${run.caseRunId}/finish-input`, {}), 200);
    expectOk(await h.api('POST', `/gates/${p.gateId}/evaluate`, { gateRunId: run.gateRunId }), [200, 201]);
    parses('zGateRun', expectOk(await h.api('GET', `/gate-runs/${run.gateRunId}`), 200));
    parses('zMatrix', expectOk(await h.api('GET', `/projects/${p.projectId}/matrix`), 200));
    expectOk(await h.api('POST', `/case-runs/${run.caseRunId}/captures`, {}), 201);
    parses('zImportPage', expectOk(await h.api('GET', `/projects/${p.projectId}/imports`), 200));
    parses(
      'zImportRow',
      (expectOk(await h.api('GET', `/projects/${p.projectId}/imports`), 200)['items'] as J[])[0],
    );
  });

  it('run-operation detail, import detail, and every console mutation reply parse (M09 wiring)', async () => {
    const created = expectOk(await h.api('POST', '/gate-runs', gateRunBodyFor(p)), 201);
    parses('zGateRun', created);
    const gateRunId = String(created['gateRunId']);
    const v = expectOk(
      await h.api('POST', `/gate-runs/${gateRunId}/validate`, {}, { ifMatch: Number(created['revision']) }),
      200,
    );
    parses('zValidateResult', v);
    const st = expectOk(
      await h.api(
        'POST',
        `/gate-runs/${gateRunId}/start`,
        {},
        { ifMatch: Number((v['gateRun'] as J)['revision']) },
      ),
      200,
    );
    parses('zStartResult', st);
    const caseRunId = String(
      ((expectOk(await h.api('GET', `/gate-runs/${gateRunId}/cases`), 200)['items'] as J[])[0] as J)[
        'caseRunId'
      ],
    );
    const start = expectOk(await h.api('POST', `/case-runs/${caseRunId}/start`, {}), 201);
    const s2 = await Subject.launch();
    try {
      await s2.attach(String(st['proxyBaseUrl']), start);
      await s2.send({ type: 'logicalJob', key: 'order-detail' });
      const q = await s2.call('getQuote', quoteBody());
      const depositAddress = String(((q['value'] as J)['quote'] as J)['depositAddress']);
      await s2.call('submitDepositTx', { txHash: 'sim-tx-detail', depositAddress });
      await s2.call('getExecutionStatus', depositAddress);
    } finally {
      await s2.close();
    }
    const finished = expectOk(await h.api('POST', `/case-runs/${caseRunId}/finish-input`, {}), 200);
    parses('zCaseRun', finished);
    const evaluation = expectOk(
      await h.api('POST', `/gates/${p.gateId}/evaluate`, { gateRunId }),
      [200, 201],
    );
    parses('zGateEvaluation', evaluation);
    const gate = expectOk(await h.api('GET', `/gate-runs/${gateRunId}`), 200);
    parses('zGateRun', gate);
    expect(gate['gateId']).toBe(p.gateId);
    const plan = expectOk(
      await h.api('POST', '/exports', { gateEvaluationId: String(evaluation['gateEvaluationId']) }),
      [200, 201],
    );
    parses('zExportPlan', plan);
    const cases = expectOk(await h.api('GET', `/gate-runs/${gateRunId}/cases`), 200);
    const opId = String((((cases['items'] as J[])[0] as J)['runOperationIds'] as string[])[0]);
    const op = expectOk(await h.api('GET', `/run-operations/${opId}`), 200);
    parses('zRunOperation', op);
    // The operation outcome is the kernel's persisted case verdict, not a recomputation.
    expect((op['evaluatedOutcome'] as J)['verdict']).toBe(((cases['items'] as J[])[0] as J)['verdict']);
    expect(JSON.stringify(op)).not.toContain('sim-tx-detail');

    const cap = expectOk(await h.api('POST', `/case-runs/${caseRunId}/captures`, {}), 201);
    parses('zCaptureResult', cap);
    const importId = String(cap['importId']);
    parses('zImportDetail', expectOk(await h.api('GET', `/imports/${importId}`), 200));
    const proposed = expectOk(await h.api('GET', `/imports/${importId}/proposed-mapping`), 200);
    parses('zProposedMapping', proposed);
    const mapped = expectOk(
      await h.api(
        'POST',
        `/imports/${importId}/mapping`,
        { mapping: proposed['mapping'] },
        { ifMatch: Number(proposed['revision']) },
      ),
      201,
    );
    parses('zImportAck', mapped);
    const afterMap = expectOk(await h.api('GET', `/imports/${importId}`), 200);
    parses('zImportDetail', afterMap);
    const verified = expectOk(
      await h.api(
        'POST',
        `/imports/${importId}/verify-replay`,
        {},
        { ifMatch: Number(afterMap['revision']) },
      ),
      200,
    );
    parses('zImportAck', verified);
    const afterVerify = expectOk(await h.api('GET', `/imports/${importId}`), 200);
    parses('zImportDetail', afterVerify);
    const review = afterVerify['review'] as { decisions: string[]; confirmationPhrase: string };
    const reviewed = expectOk(
      await h.api(
        'POST',
        `/imports/${importId}/reviews`,
        {
          reviewer: 'local reviewer',
          decisions: Object.fromEntries(review.decisions.map((k) => [k, true])),
          confirmation: review.confirmationPhrase,
        },
        { ifMatch: Number(afterVerify['revision']) },
      ),
      201,
    );
    parses('zReviewResult', reviewed);
    const afterReview = expectOk(await h.api('GET', `/imports/${importId}`), 200);
    parses('zImportDetail', afterReview);
    expect(afterReview['promotable']).toBe(true);
    const promoted = expectOk(
      await h.api(
        'POST',
        `/imports/${importId}/promote`,
        {
          reviewId: String((afterReview['review'] as J)['latestReviewId']),
          baseCorpusRevisionId: null,
          corpusLabel: 'parity-promoted',
          severity: 'HIGH',
          // An unconfined capture is never release evidence (M16): diagnostic only, ADVISORY.
          gatePolicy: 'ADVISORY',
          evidenceUse: 'DIAGNOSTIC_ONLY',
        },
        { ifMatch: Number(afterReview['revision']) },
      ),
      201,
    );
    parses('zPromoteResult', promoted);
    const final = expectOk(await h.api('GET', `/imports/${importId}`), 200);
    parses('zImportDetail', final);
    expect(final).toMatchObject({
      regressionStatus: 'PROMOTED_AWAITING_CORRECTED_RUN',
      replayOnlyPass: true,
    });
    // A gate run on the promotion corpus runs the promoted scenario as PROMOTED_REGRESSION.
    const rerun = expectOk(
      await h.api('POST', '/gate-runs', {
        ...gateRunBodyFor(p),
        gateId: null,
        corpusRevisionId: String(promoted['corpusRevisionId']),
      }),
      201,
    );
    const rerunCases = expectOk(await h.api('GET', `/gate-runs/${String(rerun['gateRunId'])}/cases`), 200);
    expect(((rerunCases['items'] as J[])[0] as J)['lineageRole']).toBe('PROMOTED_REGRESSION');
  });

  it('a user trace upload is quarantined, and a secret-bearing one is rejected without echoing it', async () => {
    const secret = `sk_live_${'Z'.repeat(32)}`;
    const blocked = expectOk(
      await h.api('POST', '/imports', {
        projectId: p.projectId,
        fileName: 'trace.json',
        content: JSON.stringify({ format: 'routespec.trace/1', apiKey: secret }),
      }),
      201,
    );
    parses('zImportRow', blocked);
    expect(JSON.stringify(blocked)).not.toContain(secret);
    expect((blocked['findings'] as J)['secret']).toBeGreaterThan(0);
    parses('zImportDetail', expectOk(await h.api('GET', `/imports/${String(blocked['importId'])}`), 200));
  });
});
