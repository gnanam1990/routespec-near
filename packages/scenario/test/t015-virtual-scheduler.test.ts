/**
 * T-015 — Virtual scheduler reproduces delays and failures exactly.
 *
 * Covers FR-06, NFR-01. Seeded transport-error, response-drop, connection-barrier, reorder,
 * duplicate, late-success, and refund schedules are replayed repeatedly against the same client
 * request sequence: event order, virtual times, and generated protocol values match exactly. A
 * retry under an uncontrolled external wall timer is recorded as noncanonical (REVIEW evidence);
 * the same retry under an injected clock is canonical. A journal-denied request consumes no step.
 */
import { describe, expect, it } from 'vitest';
import { compileScenario, ScenarioRuntime, type Decision, type ScenarioRequest } from '../src/index.ts';
import { commit, quote, status } from './support/material.ts';

function source(seed: string, clientClock: 'INJECTED' | 'EXTERNAL_WALL'): string {
  return `schemaVersion: "1.0"
scenarioId: scheduler-faults
revisionLabel: r1
title: Seeded fault schedule
protocolProfile: oneclick-v0@1.0.0
seed: ${seed}
initialState: { clientClock: ${clientClock}, statusPollIntervalMs: 1000 }
operationTemplate:
  originAsset: nep141:origin.sim
  destinationAsset: nep141:destination.sim
  amountIn: "1000000"
  amountOut: "999000"
  minAmountOut: "989010"
steps:
  - { id: q-reset, type: transport_error, match: { route: QUOTE } }
  - { id: q, type: respond, match: { route: QUOTE }, delayMs: 100 }
  - { id: c-barrier, type: connection_barrier, match: { route: COMMIT }, releaseOn: { route: STATUS } }
  - { id: settle, type: delay_virtual, ms: 500 }
  - { id: shuffle, type: reorder, statuses: [PENDING_DEPOSIT, KNOWN_DEPOSIT_TX, PROCESSING, INCOMPLETE_DEPOSIT, FAILED] }
  - { id: deposit, type: ground_truth, event: deposit }
  - { id: deposit-dup, type: duplicate, of: LAST_GROUND_TRUTH }
  - { id: poll-1, type: respond, match: { route: STATUS } }
  - { id: late, type: late_success, afterMs: 3000 }
  - { id: poll-lost, type: drop_response, match: { route: STATUS } }
  - { id: wait, type: delay_virtual, ms: 10000 }
  - { id: refunded, type: refund, event: refund }
  - { id: end, type: end }
groundTruthEvents:
  - { id: deposit, fact: ORIGIN_DEPOSIT, assetId: nep141:origin.sim, amount: "1000000" }
  - { id: refund, fact: REFUND, assetId: nep141:origin.sim, amount: "1000000" }
expectedOutcomes: {}
forbiddenBehaviors: []
requiredEvidence: []
resourceBudget: {}
sourceProvenance: { class: SYNTHETIC }
`;
}

interface Run {
  readonly decisions: Decision[];
  readonly eventsJson: string;
  readonly eventLogDigest: string;
  readonly canonicalTimer: boolean;
}

/** Drive the runtime as the proxy would: plan, then commit (or deny) each client request. */
function run(seed: string, clientClock: 'INJECTED' | 'EXTERNAL_WALL', denyIndex: number | null = null): Run {
  const runtime = new ScenarioRuntime(compileScenario(source(seed, clientClock)).plan);
  const decisions: Decision[] = [];
  const send = (req: ScenarioRequest, index: number): Decision | null => {
    if (index === denyIndex) {
      runtime.deny(req, 'RS_TOKEN_REVOKED');
      return null;
    }
    const d = runtime.commit(runtime.planRequest(req));
    decisions.push(d);
    return d;
  };
  send(quote(), 0); // transport error before acceptance
  const q = send(quote(), 1); // client retry of identical material
  const dep = String(q?.quoteResponse?.quote['depositAddress'] ?? 'none');
  send(commit(dep), 2);
  for (let i = 0; i < 7; i++) send(status(dep), 3 + i);
  const summary = runtime.finish();
  return {
    decisions,
    eventsJson: JSON.stringify(summary.events),
    eventLogDigest: summary.eventLogDigest,
    canonicalTimer: summary.canonicalTimer,
  };
}

describe('T-015 — Virtual scheduler reproduces delays and failures exactly', () => {
  it('repeats event order, virtual times, decisions, and generated values byte-for-byte', () => {
    const first = run('sched-seed-1', 'INJECTED');
    for (let i = 0; i < 5; i++) {
      const again = run('sched-seed-1', 'INJECTED');
      expect(again.eventsJson).toBe(first.eventsJson);
      expect(JSON.stringify(again.decisions)).toBe(JSON.stringify(first.decisions));
      expect(again.eventLogDigest).toBe(first.eventLogDigest);
    }
  });

  it('applies each fault at its exact virtual time and order', () => {
    const r = run('sched-seed-1', 'INJECTED');
    expect(r.decisions.map((d) => `${d.kind}@${d.virtualMs}`)).toEqual([
      'RESET_BEFORE_ACCEPT@0',
      'RESPOND@100',
      'HOLD_BARRIER@100',
      'RESPOND@600',
      'DROP_AFTER_ACCEPT@600',
      'RESPOND@11600',
      'RESPOND@12600',
      'RESPOND@13600',
      'RESPOND@14600',
      'RESPOND@15600',
    ]);
    // The barrier held at the commit is released by the next status request.
    expect(r.decisions[3]?.releasedBarriers).toEqual(['c-barrier']);
    const events = JSON.parse(r.eventsJson) as Array<{
      kind: string;
      virtualMs: number;
      stepId: string | null;
    }>;
    const at = (kind: string) =>
      events.filter((e) => e.kind === kind).map((e) => `${e.stepId}@${e.virtualMs}`);
    expect(at('TRANSPORT_ERROR_PLANNED')).toEqual(['q-reset@0']);
    expect(at('BARRIER_HELD')).toEqual(['c-barrier@100']);
    expect(at('BARRIER_RELEASED')).toEqual(['c-barrier@100']);
    expect(at('VIRTUAL_DELAY')).toEqual(['q@100', 'settle@600', 'wait@10600']);
    expect(at('GROUND_TRUTH')).toEqual(['deposit@600', 'refunded@10600']);
    expect(at('GROUND_TRUTH_DUPLICATE')).toEqual(['deposit-dup@600']);
    expect(at('LATE_SUCCESS_SCHEDULED')).toEqual(['late@600']);
    expect(at('RESPONSE_DROP_PLANNED')).toEqual(['poll-lost@600']);
    // Late SUCCESS only becomes visible once virtual time reaches 600 + 3000.
    const polls = r.decisions.filter((d) => d.rawStatus !== null && d.kind !== 'HOLD_BARRIER');
    const firstSuccess = polls.find((d) => d.rawStatus === 'SUCCESS');
    expect(firstSuccess?.virtualMs).toBeGreaterThanOrEqual(3600);
    expect(polls.filter((d) => d.virtualMs < 3600).every((d) => d.rawStatus !== 'SUCCESS')).toBe(true);
  });

  it('derives the reorder permutation from the seed, deterministically', () => {
    const a = run('sched-seed-1', 'INJECTED');
    const b = run('sched-seed-2', 'INJECTED');
    const reorder = (r: Run) =>
      (JSON.parse(r.eventsJson) as Array<{ kind: string; detail: string }>).find(
        (e) => e.kind === 'REORDER_APPLIED',
      )?.detail;
    expect(reorder(a)).toBe(reorder(run('sched-seed-1', 'INJECTED')));
    expect(reorder(a)).not.toBe(reorder(b));
    expect(a.eventLogDigest).not.toBe(b.eventLogDigest);
    expect(reorder(a)?.split(',').sort()).toEqual(
      ['FAILED', 'INCOMPLETE_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PENDING_DEPOSIT', 'PROCESSING'].sort(),
    );
  });

  it('labels a retry under an external wall timer noncanonical, but not under an injected clock', () => {
    const wall = run('sched-seed-1', 'EXTERNAL_WALL');
    const injected = run('sched-seed-1', 'INJECTED');
    expect(wall.canonicalTimer).toBe(false);
    expect(wall.eventsJson).toContain('CLIENT_TIMER_NONCANONICAL');
    expect(injected.canonicalTimer).toBe(true);
    expect(injected.eventsJson).not.toContain('CLIENT_TIMER_NONCANONICAL');
  });

  it('records a journal-denied request without consuming a scenario step', () => {
    const denied = run('sched-seed-1', 'INJECTED', 1);
    // With the quote retry denied, the commit no longer matches the next (quote) step.
    expect(denied.eventsJson).toContain('"kind":"REQUEST_DENIED"');
    expect(denied.decisions[1]).toMatchObject({
      kind: 'REJECT_UNEXPECTED',
      rejectCode: 'RS_SCENARIO_UNEXPECTED_REQUEST',
    });
    expect(run('sched-seed-1', 'INJECTED', 1).eventsJson).toBe(denied.eventsJson);
  });
});
