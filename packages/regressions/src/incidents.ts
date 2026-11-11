/**
 * Source-derived incident scenarios (M05 deliverable 6; SOURCES.md S-07 and S-08).
 *
 * Both are encoded as data and compiled by the same bounded M03 compiler as any other source.
 * Every value is invented test data; no address, asset, or amount refers to a real account.
 *
 * - issue-383 (`ISSUE_DERIVED_NOT_REPRODUCED`): a committed deposit whose response is lost and
 *   which is later refunded. It is derived from a community report and was not independently
 *   reproduced. A PASS means safe refund/failure handling — reconciliation without a second
 *   mutation and no protected-effect release — never successful settlement: the scenario has no
 *   destination credit and expects a REFUNDED terminal.
 * - issue-384 (`DISPUTED_AMBIGUITY_CASE`): a public origin debit consistent with a private step
 *   while destination credit is not visible. It asserts neither loss nor success: the credit leg
 *   is PRIVATE, so the kernel must return REVIEW with `PRIVATE_NOT_VISIBLE` scope and the
 *   `NOT_VISIBLE` evidence reason. `NOT_VISIBLE` is never a verdict.
 */
import { compileScenario, type CompiledScenario } from '@routespec/scenario';

const COMMON = `schemaVersion: "1.0"
protocolProfile: oneclick-v0@1.0.0
initialState:
  clientClock: INJECTED
operationTemplate:
  originAsset: nep141:origin.sim
  destinationAsset: nep141:destination.sim
  amountIn: "1000000"
  amountOut: "999000"
  minAmountOut: "989010"
  recipient: recipient.sim
  refundTo: refund.sim
resourceBudget: {}
`;

export const INCIDENT_SCENARIO_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  'issue-383-lost-commit-refund': `${COMMON}scenarioId: issue-383-lost-commit-refund
revisionLabel: r1
title: Commit accepted, response lost, deposit later refunded (issue-383-derived)
seed: issue-383-1
steps:
  - { id: quote, type: respond, match: { route: QUOTE } }
  - { id: commit-lost, type: drop_response, match: { route: COMMIT } }
  - { id: settle, type: delay_virtual, ms: 5000 }
  - { id: deposit, type: ground_truth, event: origin-deposit }
  - { id: processing, type: provider_status, status: PROCESSING }
  - { id: poll-processing, type: respond, match: { route: STATUS } }
  - { id: refunded, type: refund, event: refund-settled }
  - { id: poll-refunded, type: respond, match: { route: STATUS } }
  - { id: end, type: end }
groundTruthEvents:
  - { id: origin-deposit, fact: ORIGIN_DEPOSIT, assetId: nep141:origin.sim, amount: "1000000" }
  - { id: refund-settled, fact: REFUND, assetId: nep141:origin.sim, amount: "1000000", recipient: refund.sim }
expectedOutcomes:
  terminalStatus: REFUNDED
  normalizedOutcome: REFUND_REPORTED
  invariants: { INV-03: PASS }
forbiddenBehaviors: [SECOND_COMMIT_UNDER_UNCERTAINTY, EFFECT_RELEASE_BEFORE_COMPLETION]
requiredEvidence:
  - { predicate: REFUND_SETTLEMENT }
sourceProvenance:
  class: ISSUE_DERIVED_NOT_REPRODUCED
  locator: near/intents issue 383 (SOURCES.md S-07)
  notes: Source-derived from a community report; not independently reproduced. PASS means safe refund handling, never settlement.
`,
  'issue-384-disputed-private-credit': `${COMMON}scenarioId: issue-384-disputed-private-credit
revisionLabel: r1
title: Public origin debit, destination credit not visible (issue-384 disputed ambiguity)
seed: issue-384-1
steps:
  - { id: quote, type: respond, match: { route: QUOTE } }
  - { id: commit, type: respond, match: { route: COMMIT } }
  - { id: deposit, type: ground_truth, event: origin-deposit }
  - { id: success, type: provider_status, status: SUCCESS }
  - { id: credit, type: ground_truth, event: destination-credit }
  - { id: poll, type: respond, match: { route: STATUS } }
  - { id: end, type: end }
groundTruthEvents:
  - { id: origin-deposit, fact: ORIGIN_DEPOSIT, assetId: nep141:origin.sim, amount: "1000000" }
  - { id: destination-credit, fact: DESTINATION_CREDIT, assetId: nep141:destination.sim, amount: "999000", recipient: recipient.sim, visibility: PRIVATE }
expectedOutcomes:
  terminalStatus: SUCCESS
  normalizedOutcome: SUCCESS_REPORTED
  invariants: { INV-05: REVIEW, INV-08: REVIEW }
forbiddenBehaviors: [SECOND_COMMIT_UNDER_UNCERTAINTY]
requiredEvidence:
  - { predicate: DESTINATION_CREDIT }
sourceProvenance:
  class: DISPUTED_AMBIGUITY_CASE
  locator: near/intents issue 384 (SOURCES.md S-08)
  notes: Disputed ambiguity only. Neither loss nor success is ground truth; private evidence stays REVIEW.
`,
});

export function compileIncident(id: keyof typeof INCIDENT_SCENARIO_SOURCES | string): CompiledScenario {
  const source = INCIDENT_SCENARIO_SOURCES[id];
  if (source === undefined) throw new RangeError(`unknown incident scenario ${id}`);
  return compileScenario(source);
}
