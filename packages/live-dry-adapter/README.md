# @routespec/live-dry-adapter

Owner module: M07. The separately launched `LIVE_DRY_PROBE` adapter: the only RouteSpec process
that may reach the network, and only for one dry quote to the pinned official origin.

- `src/policy.ts` — pure classifier. Only `POST /v0/quote` with a strict, unambiguous JSON body
  whose `dry` is boolean `true`, no request-side deposit address, no commit/reconciliation
  material and no field outside the pinned profile passes. Runs before the credential, DNS,
  sockets and the upstream client.
- `src/address-policy.ts` — only the pinned `https://1click.chaindefuser.com` origin compiles;
  every resolved address must be global unicast.
- `src/egress.ts` — resolve once, pin the validated address, real TLS with SNI and certificate
  validation, credential attached only after the handshake is authorized, fixed header set, no
  redirects, no decompression, bounded size/time, no agent (proxy variables cannot apply), no retry.
- `src/credential.ts` — memory-only provider JWT read from the adapter's own
  `ROUTESPEC_PROVIDER_JWT` after preflight; states `NOT_REQUIRED | OPTIONAL_ABSENT |
PRESENT_IN_MEMORY | EXPIRED`.
- `src/compatibility.ts`, `src/ledger.ts` — type-only response shape, compatibility label, and a
  separate append-only SQLite ledger with no gate-run linkage.
- `src/main.ts` / `src/launch.ts` — production entry and launcher (sanitized child environment).
- `src/probe-cli.ts` — operator command for the real RP-07 probe (explicit user action only).
- `src/matrix-*.ts`, `fidelity-baseline.json` — the fidelity matrix (M51): one opt-in, credential-free
  read of the official token list, then one `dry: true` quote per route (24 or more), at most 40
  upstream requests per session, a redacted matrix with a response shape digest per route, and a
  drift verdict against the reviewed baseline. Command: `fidelity:matrix` (explicit
  `--confirm-official-endpoint` only). Scheduled job: `.github/workflows/fidelity-matrix.yml`.

Status and evidence: `docs/status/M07.md`, `docs/status/M51.md`. Decisions:
`docs/adr/0011-live-dry-adapter.md`, `docs/adr/0027-fidelity-matrix-token-list-and-request-cap.md`.
