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
  h = await startHarness({ leaseTtlMs: 5_000 });
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
    h.clock.advance(6_000);
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
});
