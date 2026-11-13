/**
 * Scenario templates for incident descriptors (M50).
 *
 * `renderScenario` is a pure function from a closed descriptor to scenario source text. Every
 * asset, account and amount in the text is the same invented `.sim` test data the reviewed core
 * scenarios use; the descriptor contributes only the status sequence, the delay lower bound and
 * the refund reason. Because the text is a function of the descriptor alone, a corpus directory
 * can be verified by rendering each descriptor again and comparing.
 *
 * Restrictions (ADR-0029). The source of a descriptor is a provider-reported record that
 * RouteSpec did not reproduce or verify on chain, so every template follows the rules the
 * trace-mapping step applies to `ISSUE_DERIVED_NOT_REPRODUCED` sources: no visible destination
 * credit, no expected SUCCESS, no `*_PROVEN` outcome, both safety behaviours forbidden, and a
 * provenance locator. A late success therefore scripts the provider reporting SUCCESS late while
 * the destination credit stays private (not visible to RouteSpec).
 */
import type { ProvenanceClass } from '@routespec/contracts';
import { EXPLORER_TRANSACTIONS_PATH, type ExplorerStatus } from './explorer-shape.ts';
import { DELAY_BUCKETS, type Delay, type HeldStatus, type TemplateDescriptor } from './sanitize.ts';

export type TemplateIdPrefix = 'obs' | 'shape';

export interface RenderContext {
  /** `obs` for records read from the real service, `shape` for the documented-shape fixture. */
  readonly idPrefix: TemplateIdPrefix;
  readonly provenanceClass: Extract<
    ProvenanceClass,
    'ISSUE_DERIVED_NOT_REPRODUCED' | 'OFFICIAL_SPEC_DERIVED'
  >;
  readonly corpusLabel: string;
}

/** Delay scripted when no delay was observed (a terminal record seen once). */
export const NEUTRAL_DELAY_MS = 60_000;
const MAX_POLL_INTERVAL_MS = 3_600_000;
const DEFAULT_POLL_INTERVAL_MS = 1000;

const HELD_SHORT: Readonly<Record<HeldStatus, string>> = { PROCESSING: 'proc', INCOMPLETE_DEPOSIT: 'incd' };

function slug(token: string): string {
  return token.toLowerCase().replace(/_/g, '-');
}

function bucket(delay: Delay): (typeof DELAY_BUCKETS)[number] | null {
  return DELAY_BUCKETS.find((b) => b.label === delay) ?? null;
}

export function delayMsOf(d: TemplateDescriptor): number {
  const b = bucket(d.delay);
  return b === null ? NEUTRAL_DELAY_MS : b.sec * 1000;
}

export function scenarioIdFor(d: TemplateDescriptor, prefix: TemplateIdPrefix): string {
  const held = d.heldStatus === null ? '' : `-${HELD_SHORT[d.heldStatus]}-${d.delay}`;
  switch (d.class) {
    case 'STUCK':
      return `${prefix}-stuck${held}`;
    case 'LATE_SUCCESS':
      return `${prefix}-late-success${held}`;
    case 'REFUNDED':
      return `${prefix}-refund-${slug(d.refundReason as string)}${held}`;
    case 'FAILED':
      return `${prefix}-failed-${d.depositObserved ? 'deposit-seen' : 'no-deposit-seen'}${held}`;
  }
}

/** True when the scenario scripts an incomplete (partial) deposit rather than a full one. */
function partialDeposit(d: TemplateDescriptor): boolean {
  return (
    d.heldStatus === 'INCOMPLETE_DEPOSIT' || (d.class === 'REFUNDED' && d.refundReason === 'PARTIAL_DEPOSIT')
  );
}

function terminalOf(d: TemplateDescriptor): ExplorerStatus | null {
  if (d.class === 'REFUNDED') return 'REFUNDED';
  if (d.class === 'FAILED') return 'FAILED';
  if (d.class === 'LATE_SUCCESS') return 'SUCCESS';
  return null;
}

/** Statuses the Explorer actually showed for this descriptor, in the order they were seen. */
export function observedStatusesOf(d: TemplateDescriptor): ExplorerStatus[] {
  const terminal = terminalOf(d);
  return [...(d.heldStatus === null ? [] : [d.heldStatus]), ...(terminal === null ? [] : [terminal])];
}

/**
 * Statuses the scenario makes the simulated provider report. Where only the terminal was seen,
 * the status before it is the documented lifecycle, not an observation.
 */
export function scriptedStatusesOf(d: TemplateDescriptor): ExplorerStatus[] {
  const terminal = terminalOf(d);
  const before: ExplorerStatus[] = partialDeposit(d)
    ? ['INCOMPLETE_DEPOSIT']
    : d.class === 'FAILED' && !d.depositObserved
      ? []
      : ['PROCESSING'];
  if (d.class === 'LATE_SUCCESS' && d.heldStatus === 'INCOMPLETE_DEPOSIT') before.push('PROCESSING');
  return [...before, ...(terminal === null ? [] : [terminal])];
}

function titleOf(d: TemplateDescriptor): string {
  const b = bucket(d.delay);
  const held = b === null ? '' : ` after at least ${b.text} in ${d.heldStatus as string}`;
  switch (d.class) {
    case 'STUCK':
      return `Swap held in ${d.heldStatus as string} for at least ${(b as { text: string }).text} with no terminal status`;
    case 'LATE_SUCCESS':
      return `Provider reports SUCCESS late${held}`;
    case 'REFUNDED':
      return `Swap refunded, reason ${d.refundReason as string}${held}`;
    case 'FAILED':
      return `Swap failed, ${d.depositObserved ? 'deposit listed' : 'no deposit listed'}${held}`;
  }
}

const EVENTS = Object.freeze({
  deposit: '{ id: origin-deposit, fact: ORIGIN_DEPOSIT, assetId: nep141:origin.sim, amount: "1000000" }',
  partial: '{ id: partial-deposit, fact: ORIGIN_DEPOSIT, assetId: nep141:origin.sim, amount: "400000" }',
  topUp: '{ id: deposit-top-up, fact: ORIGIN_DEPOSIT, assetId: nep141:origin.sim, amount: "600000" }',
  refundFull:
    '{ id: refund-settled, fact: REFUND, assetId: nep141:origin.sim, amount: "1000000", recipient: refund.sim }',
  refundPartial:
    '{ id: refund-settled, fact: REFUND, assetId: nep141:origin.sim, amount: "400000", recipient: refund.sim }',
  creditPrivate:
    '{ id: destination-credit, fact: DESTINATION_CREDIT, assetId: nep141:destination.sim, amount: "999000", recipient: recipient.sim, visibility: PRIVATE }',
  heldFull:
    '{ id: value-held, fact: LOCKED_VALUE, assetId: nep141:origin.sim, amount: "1000000", visibility: PRIVATE }',
  heldPartial:
    '{ id: value-held, fact: LOCKED_VALUE, assetId: nep141:origin.sim, amount: "400000", visibility: PRIVATE }',
});

/**
 * Invariants whose verdict for this class is fixed by what the observation could not show,
 * whatever the client does. They are still evaluated and recorded for every case; they are left
 * out of the case's required set by default so that the gate decision reflects the client.
 * - STUCK: no terminal status exists, so the swap outcome (INV-05) and a terminal status that
 *   does not regress (INV-06) cannot be decided.
 * - FAILED: where the deposited value is after FAILED was not observed (INV-05).
 * - LATE_SUCCESS: the destination credit was not verified, so value conservation (INV-05) and
 *   the strength of the delivery evidence (INV-08) stay REVIEW. INV-06 stays required: a client
 *   that stops reading status before the late SUCCESS never reaches a terminal status.
 * - REFUNDED: nothing is left out.
 */
export function undecidableInvariantsOf(d: TemplateDescriptor): string[] {
  switch (d.class) {
    case 'STUCK':
      return ['INV-05', 'INV-06'];
    case 'FAILED':
      return ['INV-05'];
    case 'LATE_SUCCESS':
      return ['INV-05', 'INV-08'];
    case 'REFUNDED':
      return [];
  }
}

/** Render the scenario source (YAML, schema 1.0) of one descriptor. Pure and deterministic. */
export function renderScenario(d: TemplateDescriptor, ctx: RenderContext): string {
  const id = scenarioIdFor(d, ctx.idPrefix);
  const delayMs = delayMsOf(d);
  const partial = partialDeposit(d);
  const noDeposit = d.class === 'FAILED' && !d.depositObserved;
  const pollIntervalMs =
    d.class === 'LATE_SUCCESS'
      ? Math.min(MAX_POLL_INTERVAL_MS, Math.ceil(delayMs / 3))
      : DEFAULT_POLL_INTERVAL_MS;
  const budgetMs = delayMs + 256 * pollIntervalMs + 3_600_000;

  const steps: string[] = [
    '{ id: quote, type: respond, match: { route: QUOTE } }',
    '{ id: commit, type: respond, match: { route: COMMIT } }',
  ];
  const events: string[] = [];
  if (partial) {
    steps.push('{ id: short-deposit, type: incomplete_deposit, event: partial-deposit }');
    events.push(EVENTS.partial);
  } else if (!noDeposit) {
    steps.push('{ id: deposit, type: ground_truth, event: origin-deposit }');
    steps.push('{ id: processing, type: provider_status, status: PROCESSING }');
    events.push(EVENTS.deposit);
  }
  if (!noDeposit) steps.push('{ id: poll-held, type: respond, match: { route: STATUS } }');

  let expected: string[];
  let evidence: string[];
  switch (d.class) {
    case 'STUCK':
      steps.push(`{ id: wait, type: delay_virtual, ms: ${delayMs} }`);
      steps.push('{ id: poll-still-held, type: respond, match: { route: STATUS } }');
      expected = [`  normalizedOutcome: ${partial ? 'INCOMPLETE_REPORTED' : 'PROCESSING'}`];
      evidence = [];
      break;
    case 'REFUNDED':
      steps.push(`{ id: wait, type: delay_virtual, ms: ${delayMs} }`);
      steps.push('{ id: refunded, type: refund, event: refund-settled }');
      steps.push('{ id: poll-refunded, type: respond, match: { route: STATUS } }');
      events.push(partial ? EVENTS.refundPartial : EVENTS.refundFull);
      expected = ['  terminalStatus: REFUNDED', '  normalizedOutcome: REFUND_REPORTED'];
      evidence = ['  - { predicate: REFUND_SETTLEMENT }'];
      break;
    case 'FAILED':
      steps.push(`{ id: wait, type: delay_virtual, ms: ${delayMs} }`);
      steps.push('{ id: failed, type: provider_status, status: FAILED }');
      if (!noDeposit) {
        // Where the deposited value is after a FAILED status was not observed: held, not visible.
        steps.push('{ id: held, type: ground_truth, event: value-held }');
        events.push(partial ? EVENTS.heldPartial : EVENTS.heldFull);
      }
      steps.push('{ id: poll-failed, type: respond, match: { route: STATUS } }');
      expected = ['  terminalStatus: FAILED', '  normalizedOutcome: FAILED_REPORTED'];
      evidence = [];
      break;
    case 'LATE_SUCCESS':
      if (partial) {
        steps.push('{ id: top-up, type: ground_truth, event: deposit-top-up }');
        steps.push('{ id: processing, type: provider_status, status: PROCESSING }');
        events.push(EVENTS.topUp);
      }
      steps.push(`{ id: late, type: late_success, afterMs: ${delayMs} }`);
      steps.push('{ id: credit, type: ground_truth, event: destination-credit }');
      events.push(EVENTS.creditPrivate);
      expected = [];
      evidence = ['  - { predicate: DESTINATION_CREDIT }'];
      break;
  }
  steps.push('{ id: end, type: end }');

  const lines = [
    'schemaVersion: "1.0"',
    'protocolProfile: oneclick-v0@1.0.0',
    `scenarioId: ${id}`,
    'revisionLabel: r1',
    `title: ${titleOf(d)}`,
    `seed: ${id}-1`,
    'initialState:',
    '  clientClock: INJECTED',
    ...(pollIntervalMs === DEFAULT_POLL_INTERVAL_MS ? [] : [`  statusPollIntervalMs: ${pollIntervalMs}`]),
    'operationTemplate:',
    '  originAsset: nep141:origin.sim',
    '  destinationAsset: nep141:destination.sim',
    '  amountIn: "1000000"',
    '  amountOut: "999000"',
    '  minAmountOut: "989010"',
    '  recipient: recipient.sim',
    '  refundTo: refund.sim',
    'resourceBudget:',
    `  maxVirtualDurationMs: ${budgetMs}`,
    'steps:',
    ...steps.map((s) => `  - ${s}`),
    ...(events.length === 0
      ? ['groundTruthEvents: []']
      : ['groundTruthEvents:', ...events.map((e) => `  - ${e}`)]),
    ...(expected.length === 0 ? ['expectedOutcomes: {}'] : ['expectedOutcomes:', ...expected]),
    'forbiddenBehaviors: [SECOND_COMMIT_UNDER_UNCERTAINTY, EFFECT_RELEASE_BEFORE_COMPLETION]',
    ...(evidence.length === 0 ? ['requiredEvidence: []'] : ['requiredEvidence:', ...evidence]),
    'sourceProvenance:',
    `  class: ${ctx.provenanceClass}`,
    `  locator: "intents-explorer-api:${EXPLORER_TRANSACTIONS_PATH}#${ctx.corpusLabel}"`,
    '  notes: Sanitised template. Status sequence, delay lower bound and refund reason only. Assets, accounts and amounts are invented test data.',
  ];
  return `${lines.join('\n')}\n`;
}
