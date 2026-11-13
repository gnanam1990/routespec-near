# @routespec/incident-corpus

Owner module: M50. Status: importer, sanitisation, templates, corpus and gate run verified on the
documented-shape fixture; **the live import is pending** (it needs the owner's Explorer API key).
See `docs/status/M50.md` and `docs/adr/0028-observed-incident-corpus-and-explorer-importer.md`.

It turns swaps listed by the Intents Explorer API into scenarios a RouteSpec gate can run:

| Class          | What was seen                                                             |
| -------------- | ------------------------------------------------------------------------- |
| `STUCK`        | still `PROCESSING` or `INCOMPLETE_DEPOSIT` at least 15 min after creation |
| `REFUNDED`     | `REFUNDED`, with the documented refund reason                             |
| `FAILED`       | `FAILED`, with or without a listed deposit transaction                    |
| `LATE_SUCCESS` | held at one look, `SUCCESS` at a later look                               |

## What is kept and what is not

Kept: the class, the held status, the refund reason (documented values only), a delay lower bound
as a bucket (15 min to 24 h), whether a deposit transaction was listed, and counts.

Not kept: deposit addresses, memos, recipients, senders, refund accounts, asset identifiers,
transaction and intent hashes, referrals, fees, amounts, exact times. Raw records are never
written to disk. Every scenario uses the same invented `.sim` assets, accounts and amounts as the
core scenarios.

## Commands

`bin/routespec-incidents.mjs` prints one JSON document on stdout. Exit codes: 0 ok, 4 usage or
configuration, 5 internal, 6 policy denial.

| Command         | What it does                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `import`        | reads the real service (needs `ROUTESPEC_EXPLORER_JWT`), writes the `mainnet-observed-YYYY-MM` corpus |
| `build-fixture` | builds the `explorer-shape-fixture` corpus from the recording in `fixtures/`                          |
| `verify`        | verifies a corpus directory (digest, counts, every scenario re-rendered)                              |
| `register`      | registers a verified corpus in a RouteSpec data directory                                             |

Only `import` opens a network connection, and only to `https://explorer.near-intents.org`: GET
requests to `/api/v0/transactions`, at most one every five seconds.

```sh
# Offline: build, verify and register the shape-fixture corpus (no key, no network).
node --no-warnings packages/incident-corpus/bin/routespec-incidents.mjs build-fixture \
  --recording packages/incident-corpus/fixtures/explorer-documented-shape.json \
  --out .data/shape-corpus --recheck-after-sec 3600
node --no-warnings packages/incident-corpus/bin/routespec-incidents.mjs verify --corpus .data/shape-corpus
node --no-warnings packages/incident-corpus/bin/routespec-incidents.mjs register \
  --corpus .data/shape-corpus --data .data/journal
```

`register` prints a `corpusRevisionId`; pass it to `routespec gate create --corpus`.

## Files

- `fixtures/explorer-documented-shape.json`: 14 hand-authored records in the documented shape,
  seen twice an hour apart. Invented values. Not mainnet data.
- `corpora/mainnet-observed-2026-11/manifest.json`: `PENDING_LIVE_IMPORT`, zero records, zero
  cases, until the live import has run.
