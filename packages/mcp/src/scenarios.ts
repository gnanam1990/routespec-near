/**
 * Reviewed synthetic scenario of the MCP gate corpus (M52). Provenance: SYNTHETIC; every value
 * is invented test data.
 *
 * The simulated 1Click service accepts the deposit submission but holds its answer until the
 * client reads the execution status (a slow answer, not a lost one). It differs from the
 * delivery journey's `slow-commit-answer` (M41) only in step order: the provider statuses and
 * ground truth come before the scripted second quote and second deposit submission, so a client
 * that reconciles through status reaches the terminal status without ever sending them, while a
 * client that places a second order still gets it answered. The scenario states no expected
 * invariant verdict; what the client does is judged only by the invariant kernel.
 */
export const SLOW_DEPOSIT_ANSWER = 'slow-deposit-answer';

export const SLOW_DEPOSIT_ANSWER_SOURCE = `schemaVersion: "1.0"
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
  notes: RouteSpec reviewed synthetic scenario for the coding agent gate
scenarioId: ${SLOW_DEPOSIT_ANSWER}
revisionLabel: r1
title: Deposit submission accepted, its answer held until the client reads status
seed: mcp-slow-deposit-1
steps:
  - { id: quote, type: respond, match: { route: QUOTE } }
  - { id: commit-held, type: connection_barrier, match: { route: COMMIT }, releaseOn: { route: STATUS } }
  - { id: processing, type: provider_status, status: PROCESSING }
  - { id: success, type: provider_status, status: SUCCESS }
  - { id: deposit, type: ground_truth, event: origin-deposit }
  - { id: credit, type: ground_truth, event: destination-credit }
  - { id: requote, type: respond, match: { route: QUOTE } }
  - { id: recommit, type: respond, match: { route: COMMIT } }
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
