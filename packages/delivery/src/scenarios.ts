/**
 * Reviewed synthetic scenario used by the delivery journey's hedged-submission check.
 * Provenance: SYNTHETIC; every value is invented test data.
 *
 * The simulated 1Click service accepts the deposit submission but holds its answer until the
 * client reads the execution status (a slow answer, not a lost one). Like the real service, it
 * would also answer a fresh quote and a second deposit submission if a client sent them. The
 * scenario states no expected invariant verdict: what the client does with the slow answer is
 * judged only by the invariant kernel over the journal.
 */
export const SLOW_COMMIT_ANSWER = 'slow-commit-answer';

export const SLOW_COMMIT_ANSWER_SOURCE = `schemaVersion: "1.0"
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
sourceProvenance:
  class: SYNTHETIC
  notes: RouteSpec reviewed synthetic delivery scenario
scenarioId: ${SLOW_COMMIT_ANSWER}
revisionLabel: r1
title: Commit accepted, its answer held until the client reads status
seed: delivery-slow-commit-1
steps:
  - { id: quote, type: respond, match: { route: QUOTE } }
  - { id: commit-held, type: connection_barrier, match: { route: COMMIT }, releaseOn: { route: STATUS } }
  - { id: requote, type: respond, match: { route: QUOTE } }
  - { id: recommit, type: respond, match: { route: COMMIT } }
  - { id: processing, type: provider_status, status: PROCESSING }
  - { id: success, type: provider_status, status: SUCCESS }
  - { id: deposit, type: ground_truth, event: origin-deposit }
  - { id: credit, type: ground_truth, event: destination-credit }
  - { id: poll, type: respond, match: { route: STATUS } }
  - { id: end, type: end }
groundTruthEvents:
  - { id: origin-deposit, fact: ORIGIN_DEPOSIT, assetId: nep141:origin.sim, amount: "1000000" }
  - { id: destination-credit, fact: DESTINATION_CREDIT, assetId: nep141:destination.sim, amount: "999000", recipient: recipient.sim }
expectedOutcomes:
  terminalStatus: SUCCESS
forbiddenBehaviors: [SECOND_COMMIT_UNDER_UNCERTAINTY]
requiredEvidence:
  - { predicate: DESTINATION_CREDIT }
`;
