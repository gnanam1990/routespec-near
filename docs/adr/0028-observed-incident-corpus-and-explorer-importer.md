# ADR-0028 — Observed-incident corpus and the read-only Explorer importer

- Status: accepted
- Date: 2026-11-13
- Module: M50 (scenarios from real mainnet incidents). Related: FR-05, FR-11, FR-12, NFR-08,
  INV-05, INV-06, INV-08, INV-11; ADR-0006 (scenario DSL), ADR-0010 (trace quarantine),
  ADR-0011 (live dry adapter).
- Goes beyond the specification pack: yes, in two places, both named below (decisions 1 and 5).

## Context

The reviewed scenarios are synthetic or derived from two public issues. The Intents Explorer API
lists real 1Click swaps with their status and refund reason, so it can show which failure shapes
actually occur: swaps that stay held, swaps that are refunded and why, swaps that fail, and swaps
that succeed late. M50 turns those shapes into scenarios a gate can run.

Three constraints shape the design:

1. The Explorer API needs a partner key. None existed while this module was built, so nothing here
   was run against the real service.
2. Explorer records contain deposit addresses, recipients, senders, transaction hashes, asset
   identifiers and amounts of real people. None of that may enter the repository.
3. A record carries a creation time and a current status. It does not carry a settlement time or
   a status history.

## Decision

1. **A separate tool, outside the specification's network boundary (beyond the spec).** The pack
   allows one network-capable component, the separately launched live-dry adapter. The importer
   is a second one. It lives in its own package (`packages/incident-corpus`) with its own command
   (`routespec-incidents`). The `routespec` CLI, the control API, the proxy, the runner and the
   kernel do not import it and stay networkless. It only reads: one method (GET), one path
   (`/api/v0/transactions`), one pinned HTTPS origin, redirects refused. It never moves value and
   never calls 1Click.
2. **The documented shape is pinned, not assumed.** `EXPLORER_API_SPEC` records the public OpenAPI
   document's URL, the date it was read, and its SHA-256. A record must pass a small schema of
   the fields the importer reads, or it is counted as rejected. A second schema holds every field
   the document lists as required; a record that fails only that one is counted as a deviation
   from the documented shape, so a change in the real service shows up in the import counts.
3. **Sanitisation by construction.** A record becomes a closed descriptor: class (`STUCK`,
   `REFUNDED`, `FAILED`, `LATE_SUCCESS`), the held status, the refund reason if it is one of the
   documented values (otherwise `UNRECOGNISED`, never the text), a coarse delay bucket, and
   whether a deposit transaction was listed. The scenario text is a pure function of that
   descriptor and uses the same invented `.sim` assets, accounts and amounts as the core
   scenarios. Raw records exist only in the importer's memory. The manifest schema is closed and
   has no free-text field. A corpus directory is verified by rendering each descriptor again and
   comparing, so a hand-edited scenario or an extra file is refused.
4. **Timing is a proven lower bound or it is not claimed.** One look at a swap that is still in
   flight proves it has been held for at least its age. A late success, late refund or late
   failure is recorded only when the same swap was seen held and later seen terminal (the import
   looks held swaps up again after a wait). The delay bucket is the age at the first look. A
   terminal record seen once has delay `not-observed` and its scenario uses a neutral 60 s.
   Buckets: 15 min, 30 min, 1 h, 3 h, 6 h, 12 h, 24 h.
5. **Provenance class (beyond the spec).** `DATA-MODEL.md` has no class for "reported by the
   provider's own index, not reproduced". The closest is `ISSUE_DERIVED_NOT_REPRODUCED`, and
   mainnet templates use it, with the restrictions the trace-mapping step applies to that class:
   no visible destination credit, no expected `SUCCESS`, no `*_PROVEN` outcome, both safety
   behaviours forbidden, a provenance locator. Templates built from the documented-shape fixture
   use `OFFICIAL_SPEC_DERIVED`. No enum value was added.
6. **Labels cannot lie.** `mainnet-observed-YYYY-MM` is accepted only for records read from the
   pinned origin; a file or a loopback stand-in can only produce a shape-fixture corpus, and
   fixture data cannot carry a label containing `mainnet`. The committed
   `corpora/mainnet-observed-2026-11/manifest.json` is `PENDING_LIVE_IMPORT` with zero records
   and zero cases, and registration refuses it, until the owner runs the import.
7. **What a class cannot decide is not required of the client.** For some classes an invariant's
   verdict is fixed by what the observation could not show, whatever the client does: a stuck
   swap has no terminal status (INV-05, INV-06); where a failed swap's deposit is was not
   observed (INV-05); a late success's destination credit was not verified (INV-05, INV-08).
   Registration leaves those invariants out of the case's required set by default and reports
   which ones. They are still evaluated and stored. `--require-all` keeps everything required;
   those cases then stay REVIEW for any client. INV-06 stays required for a late success, because
   whether a terminal status is reached there depends on the client continuing to read status.
8. **A failed swap's deposit is held and not visible.** Scripting a deposit and then `FAILED`
   with nothing else makes the kernel report an unexplained loss (FAIL) for every client. That
   would assert something the record does not show. The template adds a `LOCKED_VALUE` event with
   `visibility: PRIVATE` for the deposited amount.
9. **Key handling.** The key is read from `ROUTESPEC_EXPLORER_JWT` after all arguments were
   accepted, removed from the environment, kept in a private field, and sent only as the
   `Authorization` header to the pinned origin. It is not printed, logged, serialised, or placed
   in an error. Requests are spaced by the documented five seconds; 429 is honoured.

## Consequences and limits

- Nothing was verified against the real service. The shape, the pagination, the `search` lookup
  and the rate limit are implemented from the document and tested against a loopback server that
  follows the document. The first real import may show deviations; the counts are built to show
  them.
- The corpus says what the provider's index reported. It does not prove that any swap was lost,
  delayed for the reason given, or delivered.
- A descriptor keeps one swap's shape, not its place in a sequence of swaps. Volumes are counts
  per descriptor; rates per route or per asset are deliberately not kept.
- The second look costs one request per held swap (five seconds each), capped by `--recheck-max`.
  Held swaps beyond the cap are classified from one look and counted as `recheckSkipped`.
- The kernel has no invariant for "a second order while the first swap is still held". These
  scenarios therefore test that a client keeps reading status until a terminal status and gets
  through a refund, a failure and a held swap without breaking an invariant; they do not detect
  a client that opens a second order under a new job key.
