/**
 * T-019 — Provider SUCCESS without required delivery proof remains REVIEW.
 * Covers FR-09, FR-10, NFR-12 (kernel scope).
 *
 * The real networkless proxy, case supervisor, scenario runtime, and journal run each case end to
 * end over loopback HTTP: quote, commit, status poll (the provider reports SUCCESS), teardown
 * (ground truth recorded as evidence by the supervisor), then the pure kernel evaluates the
 * journal snapshot and the result is persisted through the fenced evaluation transaction.
 *
 * - positive control: SUCCESS with proven destination credit (happy-path) -> PASS, SUCCESS_PROVEN;
 * - SUCCESS with the destination leg private (private-not-visible) -> REVIEW, NOT_VISIBLE;
 * - SUCCESS with the destination leg withheld (no credit ground truth) -> REVIEW, missing.
 *
 * API (M08) and UI (M09) surfaces are not part of this module; they are NOT_RUN here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CORE_SCENARIO_SOURCES, compileScenario, type CompiledScenario } from '@routespec/scenario';
import { deriveProviderFacts } from '../src/index.ts';
import {
  Harness,
  compileCore,
  createGate,
  evaluateFromJournal,
  openStore,
  persistEvaluation,
  pollStatus,
  quoteAndCommit,
  tempDir,
} from './support/journal.ts';

const REQUIRED = ['INV-03', 'INV-05', 'INV-06', 'INV-07', 'INV-08'];

function withheldScenario(): CompiledScenario {
  const source = (CORE_SCENARIO_SOURCES['happy-path'] as string)
    .replace('scenarioId: happy-path', 'scenarioId: success-delivery-withheld')
    .replace('  - { id: credit, type: ground_truth, event: destination-credit }\n', '');
  return compileScenario(source);
}

let tmp: ReturnType<typeof tempDir>;
let store: ReturnType<typeof openStore>;
let h: Harness;

beforeEach(async () => {
  tmp = tempDir();
  store = openStore(tmp.dir);
  h = await Harness.start(store);
});
afterEach(async () => {
  await h.close();
  store.close();
  tmp.cleanup();
});

async function runCase(compiled: CompiledScenario, label: string) {
  const gate = createGate(store, compiled, { label, requiredInvariants: REQUIRED });
  const caseRunId = gate.caseRunIds[0] as string;
  h.startCase(caseRunId, compiled);
  const op = await quoteAndCommit(h, caseRunId, label);
  expect(op.commit.status).toBe(200);
  // The scenario queues PROCESSING then SUCCESS; each read-only poll serves the next one.
  const seen: string[] = [];
  for (let i = 1; i <= 3 && seen.at(-1) !== 'SUCCESS'; i++) {
    const status = await pollStatus(h, caseRunId, op, `${label}-s${i}`);
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    seen.push((status.body as { status: string }).status);
  }
  expect(seen.at(-1)).toBe('SUCCESS');
  h.supervisor.teardown(caseRunId);
  const { input, evaluation } = evaluateFromJournal(store, caseRunId);
  const persisted = persistEvaluation(store, h.supervisor.fenceFor(caseRunId), input, evaluation);
  return { caseRunId, op, input, evaluation, persisted };
}

describe('T-019 — Provider SUCCESS without required delivery proof remains REVIEW', () => {
  it('positive control: provider SUCCESS with proven destination credit passes (proven within scenario)', async () => {
    const r = await runCase(compileCore('happy-path'), 'proven');
    const summary = Object.fromEntries(r.evaluation.summaries.map((s) => [s.invariantId, s.verdict]));
    expect(summary).toMatchObject({
      'INV-03': 'PASS',
      'INV-05': 'PASS',
      'INV-06': 'PASS',
      'INV-07': 'PASS',
      'INV-08': 'PASS',
    });
    expect(r.evaluation.verdict).toBe('PASS');
    const facts = deriveProviderFacts(r.input).operations[0]!;
    expect(facts.providerOutcome.outcome).toBe('SUCCESS_REPORTED');
    expect(facts.derivedFacts.map((f) => f.fact)).toEqual(['SUCCESS_REPORTED', 'SUCCESS_PROVEN']);
    expect(store.getCaseRun(r.caseRunId)).toMatchObject({
      execution_lifecycle: 'COMPLETED',
      verdict: 'PASS',
    });
  });

  it('provider SUCCESS with a private destination leg is REVIEW, never PASS', async () => {
    const r = await runCase(compileCore('private-not-visible'), 'private');
    const inv05 = r.evaluation.invariantResults.find((x) => x.invariantId === 'INV-05')!;
    expect(inv05.verdict).toBe('REVIEW');
    expect(inv05.explanationCode).toBe('INV05_LEG_NOT_VISIBLE');
    expect(inv05.reasons).toContain('NOT_VISIBLE');
    const inv08 = r.evaluation.invariantResults.find((x) => x.invariantId === 'INV-08')!;
    expect(inv08.verdict).toBe('REVIEW');
    expect(inv08.missingPredicates).toContain('DESTINATION_CREDIT');
    expect(r.evaluation.verdict).toBe('REVIEW');
    const facts = deriveProviderFacts(r.input).operations[0]!;
    expect(facts.derivedFacts.map((f) => f.fact)).toEqual(['SUCCESS_REPORTED', 'NOT_VISIBLE']);
    expect(store.getCaseRun(r.caseRunId)).toMatchObject({
      execution_lifecycle: 'COMPLETED',
      verdict: 'REVIEW',
    });
    expect(String(store.getCaseResult(r.caseRunId)?.['verdict'])).toBe('REVIEW');
  });

  it('provider SUCCESS with destination evidence withheld is REVIEW, never PASS', async () => {
    const r = await runCase(withheldScenario(), 'withheld');
    const inv05 = r.evaluation.invariantResults.find((x) => x.invariantId === 'INV-05')!;
    expect(inv05.verdict).toBe('REVIEW');
    expect(inv05.missingPredicates).toContain('DESTINATION_CREDIT');
    const inv08 = r.evaluation.invariantResults.find((x) => x.invariantId === 'INV-08')!;
    expect(inv08.explanationCode).toBe('INV08_REQUIRED_EVIDENCE_MISSING');
    expect(r.evaluation.verdict).toBe('REVIEW');
    const facts = deriveProviderFacts(r.input).operations[0]!;
    expect(facts.derivedFacts.map((f) => f.fact)).toEqual(['SUCCESS_REPORTED']);
    expect(store.getCaseRun(r.caseRunId)).toMatchObject({ verdict: 'REVIEW' });
  });
});
