/**
 * Reviewed synthetic core scenarios (M03 deliverable 5). Provenance: SYNTHETIC. Every value is
 * invented test data; no address, asset, or amount refers to a real account or transfer.
 *
 * They are embedded as source text (YAML) so the product never opens scenario files from a
 * user-controlled path; they go through exactly the same bounded compiler as untrusted input.
 */
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
sourceProvenance:
  class: SYNTHETIC
  notes: RouteSpec reviewed synthetic core scenario
`;

export const CORE_SCENARIO_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  'happy-path': `${COMMON}scenarioId: happy-path
revisionLabel: r1
title: Quote, commit, and a proven delivered swap
seed: core-happy-1
steps:
  - { id: quote, type: respond, match: { route: QUOTE } }
  - { id: commit, type: respond, match: { route: COMMIT } }
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
  normalizedOutcome: SUCCESS_REPORTED
forbiddenBehaviors: [SECOND_COMMIT_UNDER_UNCERTAINTY]
requiredEvidence:
  - { predicate: ORIGIN_DEBIT }
  - { predicate: DESTINATION_CREDIT }
`,
  'accepted-then-lost-response': `${COMMON}scenarioId: accepted-then-lost-response
revisionLabel: r1
title: Commit accepted locally, response deterministically lost
seed: core-lost-1
steps:
  - { id: quote, type: respond, match: { route: QUOTE } }
  - { id: commit-lost, type: drop_response, match: { route: COMMIT } }
  - { id: settle, type: delay_virtual, ms: 5000 }
  - { id: processing, type: provider_status, status: PROCESSING }
  - { id: success, type: provider_status, status: SUCCESS }
  - { id: deposit, type: ground_truth, event: origin-deposit }
  - { id: credit, type: ground_truth, event: destination-credit }
  - { id: reconcile, type: respond, match: { route: STATUS } }
  - { id: end, type: end }
groundTruthEvents:
  - { id: origin-deposit, fact: ORIGIN_DEPOSIT, assetId: nep141:origin.sim, amount: "1000000" }
  - { id: destination-credit, fact: DESTINATION_CREDIT, assetId: nep141:destination.sim, amount: "999000", recipient: recipient.sim }
expectedOutcomes:
  terminalStatus: SUCCESS
  invariants: { INV-03: PASS }
forbiddenBehaviors: [SECOND_COMMIT_UNDER_UNCERTAINTY]
requiredEvidence:
  - { predicate: DESTINATION_CREDIT }
`,
  'duplicate-retry': `${COMMON}scenarioId: duplicate-retry
revisionLabel: r1
title: Quote response lost, exact client retry joins; duplicate deposit observation
seed: core-dup-1
steps:
  - { id: quote-lost, type: drop_response, match: { route: QUOTE } }
  - { id: quote-retry, type: respond, match: { route: QUOTE } }
  - { id: commit, type: respond, match: { route: COMMIT } }
  - { id: deposit, type: ground_truth, event: origin-deposit }
  - { id: deposit-again, type: duplicate, of: LAST_GROUND_TRUTH }
  - { id: success, type: provider_status, status: SUCCESS }
  - { id: credit, type: ground_truth, event: destination-credit }
  - { id: poll, type: respond, match: { route: STATUS } }
  - { id: end, type: end }
groundTruthEvents:
  - { id: origin-deposit, fact: ORIGIN_DEPOSIT, assetId: nep141:origin.sim, amount: "1000000" }
  - { id: destination-credit, fact: DESTINATION_CREDIT, assetId: nep141:destination.sim, amount: "999000", recipient: recipient.sim }
expectedOutcomes:
  terminalStatus: SUCCESS
  invariants: { INV-01: PASS, INV-07: PASS }
forbiddenBehaviors: [SECOND_COMMIT_UNDER_UNCERTAINTY, QUOTE_MATERIAL_CHANGE]
requiredEvidence:
  - { predicate: DESTINATION_CREDIT }
`,
  'incomplete-deposit-refund': `${COMMON}scenarioId: incomplete-deposit-refund
revisionLabel: r1
title: Deposit below minimum is reported incomplete and later refunded
seed: core-refund-1
steps:
  - { id: quote, type: respond, match: { route: QUOTE } }
  - { id: commit, type: respond, match: { route: COMMIT } }
  - { id: short-deposit, type: incomplete_deposit, event: partial-deposit }
  - { id: poll-incomplete, type: respond, match: { route: STATUS } }
  - { id: wait, type: delay_virtual, ms: 60000 }
  - { id: refunded, type: refund, event: refund-settled }
  - { id: poll-refund, type: respond, match: { route: STATUS } }
  - { id: end, type: end }
groundTruthEvents:
  - { id: partial-deposit, fact: ORIGIN_DEPOSIT, assetId: nep141:origin.sim, amount: "400000" }
  - { id: refund-settled, fact: REFUND, assetId: nep141:origin.sim, amount: "400000", recipient: refund.sim }
expectedOutcomes:
  terminalStatus: REFUNDED
  normalizedOutcome: REFUND_REPORTED
forbiddenBehaviors: [SECOND_COMMIT_UNDER_UNCERTAINTY, EFFECT_RELEASE_BEFORE_COMPLETION]
requiredEvidence:
  - { predicate: REFUND_SETTLEMENT }
`,
  'terminal-contradiction': `${COMMON}scenarioId: terminal-contradiction
revisionLabel: r1
title: Provider reports SUCCESS and later a contradictory REFUNDED terminal
seed: core-contradiction-1
steps:
  - { id: quote, type: respond, match: { route: QUOTE } }
  - { id: commit, type: respond, match: { route: COMMIT } }
  - { id: success, type: provider_status, status: SUCCESS }
  - { id: poll-success, type: respond, match: { route: STATUS } }
  - { id: refunded, type: provider_status, status: REFUNDED }
  - { id: poll-refunded, type: respond, match: { route: STATUS } }
  - { id: end, type: end }
groundTruthEvents: []
expectedOutcomes:
  normalizedOutcome: CONTRADICTORY
  invariants: { INV-06: REVIEW }
forbiddenBehaviors: [SECOND_COMMIT_UNDER_UNCERTAINTY]
requiredEvidence: []
`,
  'private-not-visible': `${COMMON}scenarioId: private-not-visible
revisionLabel: r1
title: Provider reports SUCCESS while destination delivery is private
seed: core-private-1
steps:
  - { id: quote, type: respond, match: { route: QUOTE } }
  - { id: commit, type: respond, match: { route: COMMIT } }
  - { id: success, type: provider_status, status: SUCCESS }
  - { id: deposit, type: ground_truth, event: origin-deposit }
  - { id: credit, type: ground_truth, event: destination-credit }
  - { id: poll, type: respond, match: { route: STATUS } }
  - { id: end, type: end }
groundTruthEvents:
  - { id: origin-deposit, fact: ORIGIN_DEPOSIT, assetId: nep141:origin.sim, amount: "1000000" }
  - { id: destination-credit, fact: DESTINATION_CREDIT, assetId: nep141:destination.sim, amount: "999000", recipient: recipient.sim, visibility: PRIVATE }
expectedOutcomes:
  terminalStatus: SUCCESS
  normalizedOutcome: SUCCESS_REPORTED
forbiddenBehaviors: []
requiredEvidence:
  - { predicate: DESTINATION_CREDIT }
`,
});

export const CORE_SCENARIO_IDS = Object.freeze(Object.keys(CORE_SCENARIO_SOURCES));
