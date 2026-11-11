/**
 * T-018 — Raw provider status and normalized fact remain distinct. Covers FR-09, FR-10, NFR-08.
 *
 * Under the implementation-intake profile pinned to the official SDK 0.1.26 / API 0.1.10 schema
 * (oneclick-v0@1.0.0), each of the seven raw values and several unknown values is journaled
 * through the real store's read-only reconciliation path for its own committed run operation.
 * The raw text stays verbatim; the seven mappings, unknown fail-closed behaviour, normalized
 * facts, provider facts, independent proof facts, probe results, and mapping revision are each
 * independently inspectable and never merged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ONECLICK_PROFILE_ID,
  ONECLICK_SDK_PIN,
  digestValue,
  CLIENT_INSTANCE_DIGEST_DOMAIN,
} from '@routespec/contracts';
import {
  STATUS_MAPPING_REVISION,
  deriveProviderFacts,
  evaluateCase,
  snapshotFromJournal,
  toCanonicalCaseResult,
} from '../src/index.ts';
import { baseInput, mutate } from './support/pure.ts';
import { compileCore, createGate, openStore, quoteBody, tempDir } from './support/journal.ts';

/** Independently written expectation of the pinned profile's mapping. */
const EXPECTED: Record<string, { fact: string; terminal: boolean }> = {
  PENDING_DEPOSIT: { fact: 'AWAITING_DEPOSIT', terminal: false },
  KNOWN_DEPOSIT_TX: { fact: 'DEPOSIT_OBSERVED', terminal: false },
  PROCESSING: { fact: 'PROCESSING', terminal: false },
  SUCCESS: { fact: 'SUCCESS_REPORTED', terminal: true },
  INCOMPLETE_DEPOSIT: { fact: 'INCOMPLETE_REPORTED', terminal: false },
  REFUNDED: { fact: 'REFUND_REPORTED', terminal: true },
  FAILED: { fact: 'FAILED_REPORTED', terminal: true },
};
const UNKNOWN_VALUES = ['success', 'SUCCESS ', 'PARTIALLY_REFUNDED', 'ÉTAT_INCONNU'];

let tmp: ReturnType<typeof tempDir>;
afterEach(() => tmp.cleanup());

describe('T-018 — Raw provider status and normalized fact remain distinct', () => {
  it('journals every raw value verbatim and keeps mapping, normalized, provider, and proof facts separate', () => {
    expect(ONECLICK_SDK_PIN).toMatchObject({ version: '0.1.26' });
    tmp = tempDir();
    const store = openStore(tmp.dir);
    try {
      const raws = [...Object.keys(EXPECTED), ...UNKNOWN_VALUES];
      const compiled = compileCore('happy-path');
      const gate = createGate(store, compiled, { label: 't018', cases: raws.length, maxParallelCases: 16 });
      const results = raws.map((raw, i) => {
        const caseRunId = gate.caseRunIds[i] as string;
        const started = store.startCase({
          caseRunId,
          leaseOwnerDigest: digestValue('routespec.runner-owner/1', 't018'),
          clientInstanceDigest: digestValue(CLIENT_INSTANCE_DIGEST_DOMAIN, `client-${i}`),
          mode: 'SIMULATE',
          seed: compiled.plan.seed,
          leaseTtlMs: 300_000,
          tokenTtlMs: 600_000,
        });
        const q = store.recordQuoteRequest(started.auth, {
          transportRequestId: `q${i}`,
          logicalJobKey: `job-${i}`,
          material: quoteBody(),
        });
        store.finalizeQuote(started.auth, {
          transportRequestId: `q${i}`,
          runOperationId: q.runOperationId,
          response: {
            correlationId: `corr-${i}`,
            timestamp: '2026-11-11T11:00:00Z',
            signature: `sig-${i}`,
            quoteRequest: quoteBody(),
            quote: {
              depositAddress: `deposit-${i}.sim`,
              amountIn: '1000000',
              amountInFormatted: '1.0',
              amountInUsd: '1.00',
              minAmountIn: '1000000',
              amountOut: '999000',
              amountOutFormatted: '0.999',
              amountOutUsd: '0.99',
              minAmountOut: '989010',
              deadline: '2026-11-11T12:00:00Z',
              timeEstimate: 30,
            },
          },
        });
        store.markResponseDelivered(started.auth, q.exchangeId);
        const c = store.commitMutation(started.auth, {
          transportRequestId: `c${i}`,
          runOperationId: q.runOperationId,
          body: { txHash: `tx-${i}`, depositAddress: `deposit-${i}.sim` },
        });
        store.markResponseDelivered(started.auth, c.exchangeId);
        store.recordStatusObservation(started.auth, {
          transportRequestId: `s${i}`,
          runOperationId: q.runOperationId,
          query: { depositAddress: `deposit-${i}.sim` },
          rawStatus: raw,
        });
        return { raw, caseRunId, runOperationId: q.runOperationId, started };
      });

      for (const r of results) {
        const input = snapshotFromJournal(store.readEvaluationSnapshot(r.caseRunId));
        const view = deriveProviderFacts(input);
        expect(view.mappingRevision).toBe(STATUS_MAPPING_REVISION);
        expect(STATUS_MAPPING_REVISION.startsWith(`${ONECLICK_PROFILE_ID}#sha256:`)).toBe(true);
        const op = view.operations[0]!;
        expect(op.rawObservations).toHaveLength(1);
        const obs = op.rawObservations[0]!;
        expect(obs.rawStatus).toBe(r.raw); // verbatim, never rewritten
        expect(obs.mappingRevision).toBe(STATUS_MAPPING_REVISION);
        expect(obs.scope).toBe('PROVIDER_REPORTED');
        const expected = EXPECTED[r.raw];
        const inv06 = evaluateCase(input).invariantResults.find((x) => x.invariantId === 'INV-06')!;
        if (expected) {
          expect([obs.known, obs.mappedFact, obs.terminal, obs.evidenceClass]).toEqual([
            true,
            expected.fact,
            expected.terminal,
            'REPORTED',
          ]);
          expect(op.providerOutcome.unknownObserved).toBe(false);
          expect(op.providerOutcome.acceptedTerminal).toBe(expected.terminal ? r.raw : null);
          // A provider SUCCESS is only reported success: no proof fact without independent evidence.
          expect(op.derivedFacts.map((f) => [f.fact, f.basis])).toEqual([
            [expected.fact, 'PROVIDER_REPORTED'],
          ]);
          expect(inv06.explanationCode).toBe(
            expected.terminal ? 'INV06_TERMINAL_STABLE' : 'INV06_TERMINAL_NOT_REACHED',
          );
        } else {
          // Unknown values fail closed: preserved verbatim, UNKNOWN fact, REVIEW, never a known fact.
          expect([obs.known, obs.mappedFact, obs.terminal, obs.evidenceClass]).toEqual([
            false,
            'UNKNOWN',
            false,
            'UNKNOWN',
          ]);
          expect(op.providerOutcome).toMatchObject({
            acceptedTerminal: null,
            outcome: 'UNKNOWN',
            unknownObserved: true,
          });
          expect(inv06).toMatchObject({ verdict: 'REVIEW', explanationCode: 'INV06_UNKNOWN_RAW_STATUS' });
          const stored = store
            .listEvents(String(r.started.sessionId))
            .find((e) => e['raw_status'] === r.raw)!;
          expect(stored).toMatchObject({ event_kind: 'PROVIDER_STATUS_UNKNOWN', normalized_fact: 'UNKNOWN' });
        }
      }

      // Independent proof is a separate derived fact; the raw text and provider outcome are unchanged.
      const success = results.find((r) => r.raw === 'SUCCESS')!;
      store.recordEvidence(
        {
          caseRunId: success.caseRunId,
          leaseOwnerDigest: digestValue('routespec.runner-owner/1', 't018'),
          fencingEpoch: success.started.fencingEpoch,
        },
        {
          runOperationId: success.runOperationId,
          evidenceClass: 'PROVEN',
          evidenceScope: 'SIMULATED_GROUND_TRUTH',
          reasons: [],
          subject: 'destination_credit',
          sourceKind: 'SCENARIO_GROUND_TRUTH',
          assetId: 'nep141:destination.sim',
          amount: '999000',
          singleUse: true,
          recipient: 'recipient.sim',
          payload: { eventId: 'destination-credit' },
        },
      );
      const proven = snapshotFromJournal(store.readEvaluationSnapshot(success.caseRunId));
      const op = deriveProviderFacts(proven).operations[0]!;
      expect(op.rawObservations[0]!.rawStatus).toBe('SUCCESS');
      expect(op.providerOutcome.outcome).toBe('SUCCESS_REPORTED');
      expect(op.derivedFacts.map((f) => [f.fact, f.basis])).toEqual([
        ['SUCCESS_REPORTED', 'PROVIDER_REPORTED'],
        ['SUCCESS_PROVEN', 'INDEPENDENT_PROOF'],
      ]);
      const canonical = toCanonicalCaseResult(proven, evaluateCase(proven));
      expect(canonical.facts.map((f) => [f.factKind, f.evidenceClass, f.evidenceScope])).toEqual([
        ['SUCCESS_REPORTED', 'REPORTED', 'PROVIDER_REPORTED'],
        ['SUCCESS_PROVEN', 'PROVEN', 'SIMULATED_GROUND_TRUTH'],
      ]);
      expect(proven.runOperations[0]!.normalizedOutcome).toBe('SUCCESS_REPORTED'); // the journal never upgrades
    } finally {
      store.close();
    }
  });

  it('live-probe compatibility results are carried separately and never change a verdict', () => {
    tmp = tempDir();
    const without = evaluateCase(baseInput());
    const withProbe = mutate(baseInput(), (dr) => {
      dr.probeResults = [
        {
          probeId: 'probe-1',
          compatibility: 'INCOMPATIBLE',
          resultDigest: digestValue('routespec.test/1', 'p'),
        },
      ];
    });
    const e = evaluateCase(withProbe);
    expect(e.summaries).toEqual(without.summaries);
    expect(e.verdict).toBe(without.verdict);
    expect(deriveProviderFacts(withProbe).probeResults).toEqual(withProbe.probeResults);
  });
});
