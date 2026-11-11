# ADR-0003 — Canonical encoding `rs-canon/1` and result/envelope separation

- Date: 2026-11-11. Decision owner: implementing agent (M00 stage), pending user review.
- Status: ACCEPTED
- Related: FR-08, NFR-01, NFR-10, INV-09; modules M00 (owner of T-027), M03, M04, M06, M10 (T-009, T-031).

## Context

TDD.md section 7 requires "versioned, typed, length-prefixed canonical fields and a pinned cryptographic algorithm". DATA-MODEL.md section 3 requires the result digest to exclude wall-clock, host, local path, and display labels, which are stored in a run envelope.

## Options

1. JSON canonicalization (RFC 8785-style). Readable, but number formatting and the absence of type tags make ambiguity easy (`"1"` vs `1`), and floats are allowed by default.
2. **Typed length-prefixed binary encoding (chosen).** Unambiguous, no float by default, explicit rejection of platform-dependent values.
3. CBOR deterministic encoding — would need a dependency and still requires a profile of allowed types.

## Decision

- Encoding `rs-canon/1`: tag byte + big-endian u32 length/count. Tags: null 00, false 01, true 02, integer 03 (canonical decimal; safe `number` or `bigint`), string 04 (well-formed UTF-8), bytes 05, array 06, object 07 (keys sorted by UTF-8 bytes), decimal 08 (finite non-integer `number`, only when explicitly allowed for raw provider payload digests; never economic logic). `undefined`, Date/Map/Set/class instances, symbols, holes, non-finite numbers, unsafe integers, and lone surrogates are rejected. Depth (64) and size (16 MiB) limits.
- Digest: `sha256("rs-canon/1" 0x00 domain 0x00 encoding)`, rendered `sha256:<hex>`. Domain tags separate record types (e.g. `routespec.case-result/1`). Behind a `Digester` interface; alternatives must reproduce the committed vectors.
- Canonical case result (`CanonicalCaseResult`) is a strict schema holding every mandatory identity (project, integration revision, build/artifact, build/case-launch attestation, gate/case/session, corpus/scenario, seed, profile/adapter/evaluator, configuration, effect policy/manifest, inventory/interceptor, fencing epoch), run-operation lineage, ordered exchanges/facts, invariant results, and verdict. Ordered collections are normalized by durable keys (journal sequence, invariant ID, run-operation ID); set-valued fields are sorted/deduplicated by code unit (never locale collation). Duplicate sequences are rejected.
- `RunEnvelope` (wall times, host, platform, arch, runtime, data/working directory, artifact paths, display labels) is stored and digested separately and cannot reach the result digest.

## Evidence

Hand-derived byte vectors in `packages/contracts/test/canonical-encoding.test.ts`; T-027 in `packages/contracts/test/t027-canonical-result.test.ts` with golden digest `packages/contracts/test/vectors/t027-golden.json` (generated on win32/x64). Cross-OS equality is proven only once the same suite is run on Linux and macOS (NOT_RUN at this stage; M10 CI matrix).

## Invalidation

Any change to tags, ordering, or domain construction requires `rs-canon/2`; prior digests remain verifiable under `/1`.
