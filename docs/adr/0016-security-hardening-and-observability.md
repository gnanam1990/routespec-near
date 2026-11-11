# ADR-0016 — Security hardening: persistence boundary, path policy, resource limits, observability

- Date: 2026-11-12. Decision owner: RouteSpec engineering (M11 stage), pending user review.
- Status: ACCEPTED
- Related: FR-02, FR-04, FR-17, FR-18, NFR-02, NFR-03, NFR-06, NFR-09, NFR-11, INV-10, INV-11;
  module M11 (T-011, T-036, T-040, T-042). Builds on ADR-0004 (journal), ADR-0007 (proxy),
  ADR-0012 (bundles), ADR-0013 (control API), ADR-0015 (CI uploads).

## Context

M11 hardens the assembled system. Attacks on the real product found these gaps (red runs in
`docs/status/M11.md`):

- configured secrets were never given to the control service, so a canary in a project name,
  an idempotency key, a quote field, or a logical-job header was persisted (database, WAL) and
  shown in the console DOM; a pasted control token (`rsctl_`) was persisted too;
- the proxy wrote the raw request path of a denied request to the audit table and the log;
- an export could be written to `NUL`, `con.tar`, `COM1.json`, names with a trailing dot or
  space, and names with bidirectional override characters; a dangling junction at the target
  bypassed the overwrite check; bundle extraction followed a junction out of the chosen
  directory; archive entries named `nul`, `con.json`, `aux/…`, or `a.json.` were extracted;
  CLI input paths and bundle paths were opened on UNC hosts;
- the control service had no connection cap, checked slow-client timeouts only every 30 s, and
  drained an endless chunked upload until the request timeout; the proxy journaled every
  denial, so a junk-request flood grew the journal without bound;
- `yaml@2.8.1` overflowed the stack on deeply nested flow collections (GHSA-48c2-rrv3-qjmp),
  which surfaced as `RS_INTERNAL` from scenario validation.

## Decisions

1. **One persistence boundary for secrets.** Configured secret values reach the service once,
   through `ROUTESPEC_CONFIGURED_SECRETS` (one per line), which the entry point reads and deletes
   before anything else runs (no child inherits it; it is never an argument). They live only in
   memory. Every layer uses them:
   - the control API refuses a configured value, the control token, or a RouteSpec credential
     shape in any request body (keys and values), query string, or idempotency key
     (`RS_SECRET_FIELD_REJECTED`, 422, location only), before any handler, idempotency record,
     or log line; `POST /imports` is the one exception, because the import pipeline must record
     a secret as a quarantine finding instead;
   - the journal wraps the writer connection inside write transactions: every bound parameter of
     every `statement.run(...)` is checked for configured values and for `rsctl_`, `rsct_`, and
     PEM private-key shapes. This catches plain text columns that never pass `assertNoSecrets`;
   - the proxy's redactor, the import scanner, the export privacy scan, and the runner logger get
     the same values; the proxy also refuses them in persisted RouteSpec-local headers;
   - all redaction rule sets now include the control-token shape.
2. **The proxy keeps no raw path.** Logs and denial audits record the matched profile route or
   `UNROUTED`, never the request path.
3. **One local path policy** (`@routespec/hardening`, `checkLocalPathSyntax`), platform
   independent on purpose: refuse UNC and `//host`, Win32 device and extended-length namespaces
   (`\\.\`, `\\?\`, `\??\`), drive-relative paths, alternate data streams, reserved device names
   in any component, trailing dots and spaces, control and bidi characters, and paths over 1024
   characters. It applies to reads as well as writes (opening a UNC path can send the user's
   NTLM credentials to a remote host): export output, bundle input, extraction directory, CLI
   input files. Imports never touch the file system; their stored names follow the same rules.
4. **Writes stay in the explicitly chosen target.** The final component must be absent or a
   regular file (`lstat`, so dangling links and junctions are refused). Without an overwrite
   confirmation the bundle is published with an exclusive hard link (fails on anything that
   appeared after the check); a confirmed overwrite renames over the checked regular file. An
   explicit parent path through a junction is the operator's choice and is allowed. Extraction
   needs a new or empty real directory (not a link); every entry is checked against its
   canonical real path. Archive entry segments must be portable on Windows.
5. **Resource limits on every listener** (explicit, configurable, safe defaults): control API
   `headersTimeout 10 s`, `requestTimeout 30 s`, `keepAliveTimeout 5 s`, `maxConnections 128`,
   timeout check interval `min(1 s, headersTimeout / 2)`; a refused request with an unread body
   is answered, half-closed, and destroyed after 1 s (bounded lingering close) instead of
   drained; the body reader pauses at the cap rather than destroying the request, so the client
   still receives 413. The proxy gets the same check interval and configurable limits, and
   journals at most 600 denials per minute plus one `RS_RATE_LIMITED` marker; the rest are
   counted (`denialsNotJournaled`). Scenario YAML is pre-scanned for flow-collection depth
   before the parser runs, and `yaml` is upgraded to 2.8.4.
6. **Loopback is verified from the OS.** T-036 reads listening sockets with
   `Get-NetTCPConnection` (or `lsof`) and connects through every non-loopback interface. Bind
   requests other than the literal `127.0.0.1` / `::1` are refused before a socket opens.
7. **One-time secrets never go to a captured stream.** The entry point hands the console URL
   (control token) and local confirmation codes only to an interactive terminal (default when
   stderr is a TTY) or over the parent's IPC pipe (`--handoff ipc`, default when forked
   without a TTY); otherwise they are withheld. Previously they were always printed to stderr,
   which ends up in CI logs and log files.
8. **Local observability, telemetry off.** The entry point appends structured JSON lines (codes,
   shortened identifiers, epochs; never values) to `<data>/logs/control.jsonl` (owner-only).
   `GET /__routespec/v1/metrics` (control token) returns refusal counts by code, connection and
   process gauges, runner and proxy counters, configured limits, `telemetry: "OFF"`, and the
   tracked effect-coverage gaps (interceptor findings by kind, `DECLARED_HOOKS_ONLY`
   interceptors and policies). Nothing leaves the machine.
9. **Safe deletion of quarantine content.** `POST /projects/{id}/retention-purge` is a dry run
   without `confirmDigest`; with it, exactly the confirmed plan is purged (`PURGED`, sanitized
   content cleared) in one transaction with SQLite `secure_delete` on, followed by a truncating
   WAL checkpoint. Due: REJECTED after `rejectedImportHours`; unmapped quarantine content after
   `sessionPayloadDays`; everything purgeable of a logically deleted project at once. MAPPED,
   REPLAY_VERIFIED, REVIEWED, and PROMOTED imports are retained, because their mapping, replay,
   review, and promotion records are immutable evidence. Physical media erasure is not claimed.
10. **Supply chain.** `pnpm run audit:supply-chain` reviews the lockfile and installed manifests
    offline: license allowlist plus recorded exceptions, install scripts (none may run; pnpm 10
    blocked `esbuild`'s postinstall), exact package-manager pin. The registry advisory audit
    (`pnpm audit`) found 32 advisories; patch-level upgrades (`yaml` 2.8.4, `vitest` 3.2.7,
    `node-forge` 1.4.2) removed 19. The remaining 13 need major upgrades or are inside the
    two-week cool-down, and are recorded in `docs/status/M11.md` with their exposure.

## Consequences

- A request that merely contains a configured value is refused, even when the value would be
  harmless there; configured values must be at least 8 characters long.
- `/imports` stays the only route whose body may carry secrets, and only into the quarantine
  scanner, which keeps digest and finding metadata only.
- The journal write guard adds a string scan to every write; the cost is linear in parameter
  size and was not measurable in the suite.
- Not claimed: a process-tree sandbox, complete-effect coverage, physical erasure, protection
  against a same-user process reading process memory, or any WORKING\_\* level.
