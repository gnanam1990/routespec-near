/**
 * T-013 — Valid scenario compiles to a closed execution plan.
 *
 * Covers FR-05. Every allowed step type and every explicit default is validated, the canonical
 * compiled JSON and revision digest are asserted against a committed golden vector, YAML and
 * JSON authoring of the same scenario produce one identity, and the compiler's digest equals the
 * digest the M01 journal assigns to the stored scenario revision.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, resolveProfileRoute } from '@routespec/contracts';
import { RouteSpecStore } from '@routespec/store';
import {
  COMPILER_REVISION,
  CORE_SCENARIO_SOURCES,
  DEFAULT_BUDGET,
  STEP_TYPES,
  compileScenario,
  parseScenarioSource,
  type CompiledStep,
} from '../src/index.ts';

const ALL_STEPS_YAML = `schemaVersion: "1.0"
scenarioId: all-steps
revisionLabel: r1
title: Every closed step type with explicit defaults
protocolProfile: oneclick-v0@1.0.0
seed: t013-seed
initialState: {}
operationTemplate:
  originAsset: nep141:origin.sim
  destinationAsset: nep141:destination.sim
  amountIn: "1000000"
  amountOut: "999000"
  minAmountOut: "989010"
steps:
  - { id: s-assert, type: assert_request, match: { route: QUOTE, fields: { dry: false, amount: "1000000" } } }
  - { id: s-reset, type: transport_error, match: { route: QUOTE } }
  - { id: s-quote, type: respond, match: { route: QUOTE } }
  - { id: s-barrier, type: connection_barrier, match: { route: COMMIT } }
  - { id: s-delay, type: delay_virtual, ms: 250 }
  - { id: s-status, type: provider_status, status: PROCESSING }
  - { id: s-gt, type: ground_truth, event: deposit }
  - { id: s-dup, type: duplicate, of: LAST_GROUND_TRUTH }
  - { id: s-reorder, type: reorder, statuses: [PROCESSING, KNOWN_DEPOSIT_TX] }
  - { id: s-late, type: late_success, afterMs: 1000 }
  - { id: s-poll, type: respond, match: { route: STATUS }, delayMs: 10, status: PROCESSING }
  - { id: s-drop, type: drop_response, match: { route: STATUS } }
  - { id: s-incomplete, type: incomplete_deposit, event: deposit }
  - { id: s-refund, type: refund, event: refund }
  - { id: s-end, type: end }
groundTruthEvents:
  - { id: deposit, fact: ORIGIN_DEPOSIT, assetId: nep141:origin.sim, amount: "1000000" }
  - { id: refund, fact: REFUND, assetId: nep141:origin.sim, amount: "1000000", visibility: PRIVATE, singleUse: false }
expectedOutcomes: {}
forbiddenBehaviors: [SECOND_COMMIT_UNDER_UNCERTAINTY, COMMIT_WITHOUT_FINALIZATION, SECOND_COMMIT_UNDER_UNCERTAINTY]
requiredEvidence:
  - { predicate: DESTINATION_CREDIT }
  - { predicate: ORIGIN_DEBIT, classes: [PROVEN], scopes: [PUBLIC_CHAIN_OBSERVATION] }
resourceBudget: {}
sourceProvenance: { class: SYNTHETIC }
`;

const golden = JSON.parse(readFileSync(new URL('./vectors/t013-golden.json', import.meta.url), 'utf8')) as {
  revisionDigest: string;
  canonicalJsonDigest: string;
  compilerRevision: string;
};

describe('T-013 — Valid scenario compiles to a closed execution plan', () => {
  const compiled = compileScenario(ALL_STEPS_YAML);
  const plan = compiled.plan;

  it('accepts every closed step type exactly as declared', () => {
    expect(new Set(plan.steps.map((s) => s.type))).toEqual(new Set(STEP_TYPES));
    expect(plan.steps.map((s) => s.ordinal)).toEqual(plan.steps.map((_, i) => i));
  });

  it('resolves every default explicitly in the compiled plan', () => {
    expect(plan.initialState).toEqual({
      virtualStartMs: 0,
      clientClock: 'EXTERNAL_WALL',
      providerStatus: 'PENDING_DEPOSIT',
      statusPollIntervalMs: 1000,
    });
    expect(plan.operationTemplate).toMatchObject({
      recipient: null,
      refundTo: null,
      timeEstimateSec: 60,
      refundFee: null,
      withdrawFee: null,
      maxLogicalJobs: 1,
    });
    const byId = new Map<string, CompiledStep>(plan.steps.map((s) => [s.id, s]));
    expect(byId.get('s-quote')).toEqual({
      ordinal: 2,
      id: 's-quote',
      type: 'respond',
      match: { route: 'QUOTE', fields: {} },
      delayMs: 0,
      status: null,
    });
    expect(byId.get('s-barrier')).toMatchObject({ releaseOn: null });
    expect(byId.get('s-reset')).toMatchObject({ error: 'CONNECTION_RESET' });
    expect(byId.get('s-assert')).toMatchObject({ match: { fields: { amount: '1000000', dry: false } } });
    expect(plan.groundTruthEvents[0]).toEqual({
      id: 'deposit',
      fact: 'ORIGIN_DEPOSIT',
      assetId: 'nep141:origin.sim',
      amount: '1000000',
      recipient: null,
      visibility: 'VISIBLE',
      singleUse: true,
    });
    expect(plan.groundTruthEvents[1]).toMatchObject({ visibility: 'PRIVATE', singleUse: false });
    expect(plan.expectedOutcomes).toEqual({ terminalStatus: null, normalizedOutcome: null, invariants: {} });
    expect(plan.forbiddenBehaviors).toEqual([
      'COMMIT_WITHOUT_FINALIZATION',
      'SECOND_COMMIT_UNDER_UNCERTAINTY',
    ]);
    expect(plan.requiredEvidence).toEqual([
      {
        predicate: 'DESTINATION_CREDIT',
        classes: ['PROVEN'],
        scopes: ['PUBLIC_CHAIN_OBSERVATION', 'SIMULATED_GROUND_TRUTH'],
      },
      { predicate: 'ORIGIN_DEBIT', classes: ['PROVEN'], scopes: ['PUBLIC_CHAIN_OBSERVATION'] },
    ]);
    expect(plan.resourceBudget).toEqual(DEFAULT_BUDGET);
    expect(plan.sourceProvenance).toEqual({ class: 'SYNTHETIC', locator: null, notes: null });
    expect(plan.totalDeclaredVirtualMs).toBe(250 + 1000 + 10);
    expect(plan.compilerRevision).toBe(COMPILER_REVISION);
  });

  it('produces a static route plan limited to enumerated profile routes', () => {
    expect(plan.routePlan.map((r) => `${r.stepId}:${r.method} ${r.path}`)).toEqual([
      's-reset:POST /v0/quote',
      's-quote:POST /v0/quote',
      's-barrier:POST /v0/deposit/submit',
      's-poll:GET /v0/status',
      's-drop:GET /v0/status',
    ]);
    for (const r of plan.routePlan) expect(resolveProfileRoute(r.method, r.path).path).toBe(r.path);
  });

  it('matches the committed canonical JSON and revision digest (golden vector)', () => {
    expect(compiled.canonicalJson).toBe(canonicalJson(plan));
    expect(JSON.parse(compiled.canonicalJson)).toEqual(plan);
    expect(compiled.revisionDigest).toBe(golden.revisionDigest);
    expect(`sha256:${createHash('sha256').update(compiled.canonicalJson, 'utf8').digest('hex')}`).toBe(
      golden.canonicalJsonDigest,
    );
    expect(golden.compilerRevision).toBe(COMPILER_REVISION);
  });

  it('gives YAML and JSON authoring, and reordered keys, one identity', () => {
    const authored = parseScenarioSource(ALL_STEPS_YAML, 'yaml', {
      maxSourceBytes: DEFAULT_BUDGET.maxSourceBytes,
      maxDepth: DEFAULT_BUDGET.maxDepth,
      maxAliases: 0,
      maxStringLength: DEFAULT_BUDGET.maxStringLength,
    }) as Record<string, unknown>;
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(authored).reverse()));
    const fromJson = compileScenario(reordered, { format: 'json' });
    expect(fromJson.revisionDigest).toBe(compiled.revisionDigest);
    expect(fromJson.canonicalJson).toBe(compiled.canonicalJson);
    expect(compileScenario(authored).revisionDigest).toBe(compiled.revisionDigest);
  });

  it('compiles every reviewed core scenario and every revision digest is distinct', () => {
    const digests = Object.values(CORE_SCENARIO_SOURCES).map((src) => compileScenario(src).revisionDigest);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it('shares its revision digest with the journal-stored scenario revision (M01)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routespec-t013-'));
    try {
      const store = RouteSpecStore.open({ path: join(dir, 'journal.db') });
      try {
        const stored = store.createScenarioRevision(compiled.revisionInput);
        expect(stored.revisionDigest).toBe(compiled.revisionDigest);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
