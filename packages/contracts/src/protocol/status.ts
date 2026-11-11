/**
 * Raw-provider-status normalization and terminal-outcome folding (INV-06, TDD.md section 9).
 *
 * Raw status text is never rewritten: callers persist the raw observation and the derived fact
 * separately. Unknown raw values are preserved and map to `UNKNOWN` (REVIEW), never to a known
 * fact. Once an accepted terminal status is observed, a later non-terminal or lower-precedence
 * observation cannot replace it; a different terminal status makes the outcome CONTRADICTORY.
 * See docs/adr/0005-status-normalization.md.
 */
import { RAW_PROVIDER_STATUSES, isMember, type NormalizedFact, type RawProviderStatus } from '../enums.ts';

export const RAW_STATUS_NORMALIZATION: Readonly<Record<RawProviderStatus, NormalizedFact>> = Object.freeze({
  PENDING_DEPOSIT: 'AWAITING_DEPOSIT',
  KNOWN_DEPOSIT_TX: 'DEPOSIT_OBSERVED',
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCESS_REPORTED',
  INCOMPLETE_DEPOSIT: 'INCOMPLETE_REPORTED',
  REFUNDED: 'REFUND_REPORTED',
  FAILED: 'FAILED_REPORTED',
});

/** Accepted terminal raw statuses for the pinned profile. INCOMPLETE_DEPOSIT is not terminal. */
export const TERMINAL_RAW_STATUSES: readonly RawProviderStatus[] = Object.freeze([
  'SUCCESS',
  'REFUNDED',
  'FAILED',
]);

export interface NormalizedObservation {
  readonly rawStatus: string;
  readonly known: boolean;
  readonly fact: NormalizedFact;
  readonly terminal: boolean;
}

export function normalizeRawStatus(rawStatus: string): NormalizedObservation {
  if (isMember(RAW_PROVIDER_STATUSES, rawStatus)) {
    return {
      rawStatus,
      known: true,
      fact: RAW_STATUS_NORMALIZATION[rawStatus],
      terminal: TERMINAL_RAW_STATUSES.includes(rawStatus),
    };
  }
  return { rawStatus, known: false, fact: 'UNKNOWN', terminal: false };
}

export interface OutcomeState {
  /** First accepted terminal raw status, if any. Never replaced once set. */
  readonly acceptedTerminal: RawProviderStatus | null;
  /** Derived outcome fact. CONTRADICTORY when two different terminal statuses were observed. */
  readonly outcome: NormalizedFact | null;
  readonly contradictory: boolean;
  /** An unknown raw value was observed; the outcome requires REVIEW until a reviewed profile maps it. */
  readonly unknownObserved: boolean;
  /** Count of observations that arrived after the terminal and were not allowed to replace it. */
  readonly ignoredRegressions: number;
  readonly observations: number;
}

export const INITIAL_OUTCOME: OutcomeState = Object.freeze({
  acceptedTerminal: null,
  outcome: null,
  contradictory: false,
  unknownObserved: false,
  ignoredRegressions: 0,
  observations: 0,
});

/** Pure fold of one more raw observation into the outcome. */
export function foldOutcome(state: OutcomeState, rawStatus: string): OutcomeState {
  const obs = normalizeRawStatus(rawStatus);
  const observations = state.observations + 1;
  const unknownObserved = state.unknownObserved || !obs.known;
  if (state.acceptedTerminal !== null) {
    if (obs.terminal && obs.rawStatus !== state.acceptedTerminal) {
      return { ...state, outcome: 'CONTRADICTORY', contradictory: true, unknownObserved, observations };
    }
    if (obs.terminal) return { ...state, unknownObserved, observations };
    return { ...state, unknownObserved, ignoredRegressions: state.ignoredRegressions + 1, observations };
  }
  if (obs.terminal) {
    return {
      ...state,
      acceptedTerminal: obs.rawStatus as RawProviderStatus,
      outcome: state.contradictory ? 'CONTRADICTORY' : obs.fact,
      unknownObserved,
      observations,
    };
  }
  return { ...state, outcome: obs.fact, unknownObserved, observations };
}

export function foldOutcomes(rawStatuses: readonly string[]): OutcomeState {
  return rawStatuses.reduce(foldOutcome, INITIAL_OUTCOME);
}
