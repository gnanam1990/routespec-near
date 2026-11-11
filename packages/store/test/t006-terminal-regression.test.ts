/**
 * T-006 — Terminal outcomes cannot silently regress. Covers INV-06 (owned by M01; M04 also
 * evaluates INV-06 in the kernel).
 *
 * The oracle below is written independently from the product fold: it states the property
 * directly over the generated raw sequence.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { foldOutcomes } from '@routespec/contracts';
import type { CaseAuth, RouteSpecStore } from '../src/index.ts';
import {
  ManualClock,
  createGate,
  openStore,
  quoteAndFinalize,
  startCase,
  tempDir,
} from './support/fixture.ts';

const TERMINAL = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);
const MAP: Record<string, string> = {
  PENDING_DEPOSIT: 'AWAITING_DEPOSIT',
  KNOWN_DEPOSIT_TX: 'DEPOSIT_OBSERVED',
  PROCESSING: 'PROCESSING',
  INCOMPLETE_DEPOSIT: 'INCOMPLETE_REPORTED',
  SUCCESS: 'SUCCESS_REPORTED',
  REFUNDED: 'REFUND_REPORTED',
  FAILED: 'FAILED_REPORTED',
};

function expectedOutcome(seq: readonly string[]): { terminal: string | null; outcome: string | null } {
  const terminals = seq.filter((s) => TERMINAL.has(s));
  if (terminals.length > 0) {
    const first = terminals[0]!;
    return { terminal: first, outcome: new Set(terminals).size > 1 ? 'CONTRADICTORY' : MAP[first]! };
  }
  if (seq.length === 0) return { terminal: null, outcome: null };
  return { terminal: null, outcome: MAP[seq.at(-1)!] ?? 'UNKNOWN' };
}

const rawStatus = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.constantFrom(
      'PENDING_DEPOSIT',
      'KNOWN_DEPOSIT_TX',
      'PROCESSING',
      'INCOMPLETE_DEPOSIT',
      'SUCCESS',
      'REFUNDED',
      'FAILED',
    ),
  },
  { weight: 1, arbitrary: fc.constantFrom('SETTLED', 'success', 'UNKNOWN_FUTURE_STATUS') },
);

let tmp: ReturnType<typeof tempDir>;
let store: RouteSpecStore;
let auth: CaseAuth;
let jobCounter = 0;

beforeAll(() => {
  tmp = tempDir();
  store = openStore(tmp.dir, { clock: new ManualClock() });
  const gate = createGate(store, { label: 't006' });
  auth = startCase(store, gate.caseRunIds[0]!).auth;
});
afterAll(() => {
  store.close();
  tmp.cleanup();
});

describe('T-006 — Terminal outcomes cannot silently regress', () => {
  it('pure fold: later non-terminal values never replace the first terminal; contradictions are explicit', () => {
    fc.assert(
      fc.property(fc.array(rawStatus, { maxLength: 20 }), (seq) => {
        const state = foldOutcomes(seq);
        const want = expectedOutcome(seq);
        return state.acceptedTerminal === want.terminal && state.outcome === want.outcome;
      }),
      { numRuns: 2000 },
    );
  });

  it('journal: generated raw sequences preserve raw history and never regress the stored terminal', () => {
    fc.assert(
      fc.property(fc.array(rawStatus, { minLength: 1, maxLength: 12 }), (seq) => {
        const job = `job-${jobCounter++}`;
        const runOperationId = quoteAndFinalize(store, auth, { job, tx: `q-${job}` });
        let sawTerminal: string | null = null;
        seq.forEach((raw, i) => {
          const ack = store.recordStatusObservation(auth, {
            transportRequestId: `s-${job}-${i}`,
            runOperationId,
            query: { depositAddress: 'deposit.sim' },
            rawStatus: raw,
          });
          if (sawTerminal === null && TERMINAL.has(raw)) sawTerminal = raw;
          // After every observation the stored terminal is the first terminal seen so far.
          if (ack.acceptedTerminal !== sawTerminal) throw new Error('terminal regressed');
        });
        const op = store.getRunOperation(runOperationId)!;
        const want = expectedOutcome(seq);
        expect(op['accepted_terminal_status']).toBe(want.terminal);
        expect(op['normalized_outcome']).toBe(want.outcome);
        const events = store
          .listEvents(auth.sessionId, 1000)
          .filter((e) => e['run_operation_id'] === runOperationId && e['raw_status'] !== null);
        expect(events.map((e) => e['raw_status'])).toEqual(seq);
        expect(events.map((e) => e['normalized_fact'])).toEqual(seq.map((s) => MAP[s] ?? 'UNKNOWN'));
        return true;
      }),
      { numRuns: 40 },
    );
  });

  it('a contradictory terminal is REVIEW-bound (CONTRADICTORY) and cannot later revert', () => {
    const runOperationId = quoteAndFinalize(store, auth, { job: 'contradiction', tx: 'q-contra' });
    const obs = (raw: string, i: number) =>
      store.recordStatusObservation(auth, {
        transportRequestId: `sc-${i}`,
        runOperationId,
        query: { depositAddress: 'deposit.sim' },
        rawStatus: raw,
      });
    expect(obs('SUCCESS', 1).outcome).toBe('SUCCESS_REPORTED');
    expect(obs('PROCESSING', 2).outcome).toBe('SUCCESS_REPORTED');
    expect(obs('REFUNDED', 3).outcome).toBe('CONTRADICTORY');
    expect(obs('SUCCESS', 4).outcome).toBe('CONTRADICTORY');
    expect(store.getRunOperation(runOperationId)!['accepted_terminal_status']).toBe('SUCCESS');
  });

  it('the database refuses to overwrite an accepted terminal or rewrite raw events', () => {
    const runOperationId = quoteAndFinalize(store, auth, { job: 'db-guard', tx: 'q-guard' });
    store.recordStatusObservation(auth, {
      transportRequestId: 'sg-1',
      runOperationId,
      query: { depositAddress: 'deposit.sim' },
      rawStatus: 'FAILED',
    });
    store.close();
    const raw = new DatabaseSync(join(tmp.dir, 'journal.db'));
    try {
      expect(() =>
        raw.exec(
          `UPDATE run_operations SET accepted_terminal_status = 'SUCCESS' WHERE run_operation_id = '${runOperationId}'`,
        ),
      ).toThrow(/RS_IMMUTABLE_RECORD/);
      expect(() =>
        raw.exec(
          `UPDATE run_operations SET normalized_outcome = 'PROCESSING' WHERE run_operation_id = '${runOperationId}'`,
        ),
      ).toThrow(/RS_IMMUTABLE_RECORD/);
      expect(() => raw.exec(`UPDATE lifecycle_events SET raw_status = 'SUCCESS'`)).toThrow(
        /RS_IMMUTABLE_RECORD/,
      );
      expect(() => raw.exec(`DELETE FROM lifecycle_events`)).toThrow(/RS_IMMUTABLE_RECORD/);
    } finally {
      raw.close();
      store = openStore(tmp.dir, { clock: new ManualClock() });
    }
  });
});
