# ADR-0005 — Raw status normalization and terminal precedence (profile oneclick-v0@1.0.0)

- Date: 2026-11-11. Decision owner: implementing agent (M00 stage), pending user review.
- Status: ACCEPTED
- Related: FR-09, FR-10, FR-16, NFR-08, INV-06; modules M00, M01 (T-006), M04, M07 (T-018).

## Context

TDD.md section 9 lists the seven raw statuses and the normalized facts but does not state which raw statuses are terminal. The pinned SDK (ADR-0002) enumerates the same seven values without terminal semantics.

## Decision

| Raw status         | Normalized fact     | Terminal                                     |
| ------------------ | ------------------- | -------------------------------------------- |
| PENDING_DEPOSIT    | AWAITING_DEPOSIT    | no                                           |
| KNOWN_DEPOSIT_TX   | DEPOSIT_OBSERVED    | no                                           |
| PROCESSING         | PROCESSING          | no                                           |
| INCOMPLETE_DEPOSIT | INCOMPLETE_REPORTED | no                                           |
| SUCCESS            | SUCCESS_REPORTED    | yes                                          |
| REFUNDED           | REFUND_REPORTED     | yes                                          |
| FAILED             | FAILED_REPORTED     | yes                                          |
| any other value    | UNKNOWN (raw kept)  | no — REVIEW until a reviewed profile maps it |

`INCOMPLETE_DEPOSIT` is treated as non-terminal because the SDK documentation describes deposits below the minimum being refunded later (a following `REFUNDED`). Provider `SUCCESS` is only `SUCCESS_REPORTED`; `SUCCESS_PROVEN`/`REFUND_PROVEN` require independent scenario/adapter evidence (M04).

Fold (`foldOutcome`): the first terminal raw status becomes `acceptedTerminal` and is never replaced; later non-terminal observations are appended but counted as ignored regressions; a different terminal status sets `CONTRADICTORY` (REVIEW). Raw observations are always persisted unchanged next to the derived fact.

## Invalidation

Provider documentation or observed compatibility evidence that changes terminal semantics requires a new profile revision; it never rewrites stored facts.
