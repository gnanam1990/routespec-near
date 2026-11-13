/**
 * The reviewed synthetic `slow-commit-answer` scenario of the delivery journey
 * (`packages/delivery/src/scenarios.ts`), repeated here so the CLI tests do not depend on the
 * delivery package. M53 checks that this text is identical to the delivery source.
 * Provenance: SYNTHETIC; every value is invented test data.
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

/**
 * M53 test variant (SYNTHETIC): the same held commit answer, but the simulated service settles
 * the first order without a second one. In `slow-commit-answer` the status only progresses after
 * a fresh quote and a second deposit submission, so a client that never places a second order
 * cannot reach a terminal status there; this variant is where such a client can be gated.
 */
export const SLOW_COMMIT_SETTLES = 'slow-commit-settles';

export const SLOW_COMMIT_SETTLES_SOURCE = SLOW_COMMIT_ANSWER_SOURCE.replace(
  `scenarioId: ${SLOW_COMMIT_ANSWER}`,
  `scenarioId: ${SLOW_COMMIT_SETTLES}`,
)
  .replace(
    'title: Commit accepted, its answer held until the client reads status',
    'title: Commit answer held until a status read; the first order settles',
  )
  .replace('seed: delivery-slow-commit-1', 'seed: m53-slow-commit-settles-1')
  .replace('  - { id: requote, type: respond, match: { route: QUOTE } }\n', '')
  .replace('  - { id: recommit, type: respond, match: { route: COMMIT } }\n', '');
