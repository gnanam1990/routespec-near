/**
 * Raw provider status, normalized facts, and provider/probe records kept distinct (FR-10,
 * TDD.md section 9, T-018).
 *
 * - Raw observations keep the verbatim provider text (never rewritten) with the profile mapping
 *   revision that interpreted them.
 * - The normalized outcome is the profile fold (first accepted terminal wins; a different
 *   terminal is CONTRADICTORY; an unknown value is UNKNOWN and fails closed).
 * - A provider `SUCCESS` is only `SUCCESS_REPORTED`. `SUCCESS_PROVEN` / `REFUND_PROVEN` are
 *   separate derived facts and exist only when an independent proof item satisfies the
 *   delivery / refund predicate for that exact run operation.
 * - Live-probe compatibility results are carried through untouched and never consulted.
 */
import {
  ONECLICK_PROFILE_ID,
  RAW_STATUS_NORMALIZATION,
  digestValue,
  foldOutcomes,
  normalizeRawStatus,
  type NormalizedFact,
  type RawProviderStatus,
} from '@routespec/contracts';
import { evaluatePredicate, proofPredicate } from './evidence.ts';
import { deepFreeze } from './result.ts';
import type { KernelInput, ProbeResultRecord } from './types.ts';

/** Profile mapping revision: the profile ID plus the digest of its raw-to-fact table. */
export const STATUS_MAPPING_REVISION = `${ONECLICK_PROFILE_ID}#${digestValue(
  'routespec.status-mapping/1',
  RAW_STATUS_NORMALIZATION,
)}`;

export interface RawStatusObservation {
  readonly eventId: string;
  readonly sequence: number;
  readonly rawStatus: string;
  readonly known: boolean;
  readonly mappedFact: NormalizedFact;
  readonly terminal: boolean;
  readonly mappingRevision: string;
  readonly scope: 'PROVIDER_REPORTED';
  readonly evidenceClass: 'REPORTED' | 'UNKNOWN';
}

export interface DerivedFact {
  readonly fact: NormalizedFact;
  readonly basis: 'PROVIDER_REPORTED' | 'INDEPENDENT_PROOF';
  readonly evidenceIds: readonly string[];
}

export interface OperationProviderFacts {
  readonly runOperationId: string;
  readonly rawObservations: readonly RawStatusObservation[];
  readonly providerOutcome: {
    readonly acceptedTerminal: RawProviderStatus | null;
    readonly outcome: NormalizedFact | null;
    readonly contradictory: boolean;
    readonly unknownObserved: boolean;
  };
  readonly derivedFacts: readonly DerivedFact[];
}

export interface ProviderFactsView {
  readonly mappingRevision: string;
  readonly operations: readonly OperationProviderFacts[];
  readonly probeResults: readonly ProbeResultRecord[];
}

export function deriveProviderFacts(input: KernelInput): ProviderFactsView {
  const operations = input.runOperations.map((op): OperationProviderFacts => {
    const raw = input.events
      .filter(
        (e) =>
          e.runOperationId === op.runOperationId &&
          (e.kind === 'PROVIDER_STATUS' || e.kind === 'PROVIDER_STATUS_UNKNOWN') &&
          e.rawStatus !== null,
      )
      .sort((a, b) => a.sequence - b.sequence)
      .map((e): RawStatusObservation => {
        const n = normalizeRawStatus(e.rawStatus as string);
        return {
          eventId: e.eventId,
          sequence: e.sequence,
          rawStatus: e.rawStatus as string,
          known: n.known,
          mappedFact: n.fact,
          terminal: n.terminal,
          mappingRevision: STATUS_MAPPING_REVISION,
          scope: 'PROVIDER_REPORTED',
          evidenceClass: n.known ? 'REPORTED' : 'UNKNOWN',
        };
      });
    const fold = foldOutcomes(raw.map((r) => r.rawStatus));
    const derived: DerivedFact[] = [];
    if (fold.outcome !== null)
      derived.push({ fact: fold.outcome, basis: 'PROVIDER_REPORTED', evidenceIds: [] });
    const credit = evaluatePredicate(
      proofPredicate('DESTINATION_CREDIT', 'destination_credit', op.runOperationId),
      input.evidence,
      input.identity,
    );
    const refund = evaluatePredicate(
      proofPredicate('REFUND_SETTLEMENT', 'refund_settlement', op.runOperationId),
      input.evidence,
      input.identity,
    );
    if (!fold.contradictory && fold.acceptedTerminal === 'SUCCESS') {
      if (credit.status === 'SATISFIED') {
        derived.push({ fact: 'SUCCESS_PROVEN', basis: 'INDEPENDENT_PROOF', evidenceIds: credit.satisfiedBy });
      } else if (credit.reasons.includes('NOT_VISIBLE')) {
        derived.push({ fact: 'NOT_VISIBLE', basis: 'INDEPENDENT_PROOF', evidenceIds: credit.weak });
      }
    }
    if (!fold.contradictory && fold.acceptedTerminal === 'REFUNDED' && refund.status === 'SATISFIED') {
      derived.push({ fact: 'REFUND_PROVEN', basis: 'INDEPENDENT_PROOF', evidenceIds: refund.satisfiedBy });
    }
    return {
      runOperationId: op.runOperationId,
      rawObservations: raw,
      providerOutcome: {
        acceptedTerminal: fold.acceptedTerminal,
        outcome: fold.outcome,
        contradictory: fold.contradictory,
        unknownObserved: fold.unknownObserved,
      },
      derivedFacts: derived,
    };
  });
  return deepFreeze({
    mappingRevision: STATUS_MAPPING_REVISION,
    operations,
    probeResults: input.probeResults.map((p) => ({ ...p })),
  });
}
