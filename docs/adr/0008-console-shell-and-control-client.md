# ADR-0008 — Console shell, typed control client, and contract fixture

- Date: 2026-11-11. Decision owner: M09 console shell stage, pending user review.
- Status: ACCEPTED (shell scope; the API contract below is a proposal M08 must confirm or amend)
- Related: FR-15, FR-17, NFR-04, NFR-07, NFR-12; module M09 (owned tests T-047–T-051); depends on M08.

## Context

M09 depends on M01, M05, M06, and M08. When this stage started only M00–M03 were on `main` (M02
merged during the stage); there is no control API, evaluator, runner, or export service yet. The
assignment was to prepare the console shell early, against a typed client for the API in
`API-SPEC.md`, without rendering fabricated verdicts or browser-computed results.

`API-SPEC.md` describes endpoints in prose. It does not fix JSON response shapes, and several
console views need read endpoints it does not list.

## Decisions

1. **Stack.** React 18.3.1 + react-router-dom 6.30.6, built with Vite 7.3.7 (`@vitejs/plugin-react`
   5.2.0) into `apps/console/dist` as same-origin static assets (no inline script, no remote origin,
   `assetsInlineLimit: 0`). Fonts are bundled from `@fontsource/ibm-plex-sans` and
   `@fontsource/jetbrains-mono` 5.3.0 (SIL OFL 1.1) with `font-display: swap` and system fallbacks.
   Tests: Playwright 1.65.0 (matches the installed Chromium build 1254) and `@axe-core/playwright`
   4.14.0. All are MIT/ISC/OFL. No CSS framework, no component library, no icon pack: one local
   SVG stroke-icon set.
2. **Shared vocabulary.** `@routespec/contracts` gains a browser-safe `./enums` subpath export
   (`src/enums.ts` has no imports). The console uses those closed tuples for every axis, so the UI,
   CLI, and API share one vocabulary (NFR-12). The package root still imports `node:crypto` and is
   not bundled.
3. **Closed response schemas, fail closed.** `apps/console/src/api/schemas.ts` defines the response
   shapes the console expects (zod). Unknown additive object fields are stripped (API minor versions
   may add fields); an unknown enumerated value, or a misleading combination (declared hooks shown as
   complete coverage, a recovery that issues anything but `RECONCILIATION_ONLY`, committed live mode
   marked supported, a non-loopback bind address), fails validation and the page shows
   “Unsupported record schema” instead of rendering a guess.
4. **No browser verdicts.** Every status badge is looked up from a typed API value in one content map
   (`src/content/status-content.ts`). No function derives one axis from another. Action availability
   (Validate, Start, Start case, Reconcile, Capture, Promote) follows the persisted record, and the
   server remains authoritative: Promote appears only when the API says `promotable: true`; recovery
   appears only when the API offers `RECONCILE_EXISTING_OPERATION` with `readOnly: true`.
5. **Control token handoff.** The local service opens the console with `#token=<control token>`.
   The console moves it into the `ControlClient` instance and removes it from the address bar and
   history with `history.replaceState`. It is never written to localStorage, sessionStorage,
   IndexedDB, cookies, or URLs, and requests use `credentials: 'omit'`. A Connect page accepts a
   pasted token (password input) as a fallback. Reloading the page forgets the token. The only
   browser-storage use is the theme preference.
6. **Transport rules.** GETs retry at most 3 times on transport failure and report the attempt count.
   Mutations are never retried automatically; a transport failure after send is “outcome unknown” and
   the UI reloads the authoritative record instead of resending. Mutations send `Idempotency-Key`;
   gate-run validate/start send `If-Match` with the record revision.
7. **Live updates by polling.** `EventSource` cannot carry a bearer header, so live session updates
   poll the cursor-paginated events endpoint every 2 s while enabled. The stream endpoint is not used.
8. **Pagination, not virtualization.** Timelines and case tables page by cursor (50/100/200 rows)
   so focus and screen-reader position are preserved (UI-SPEC 6.3).
9. **Contract fixture for tests.** `apps/console/e2e/fixture/server.ts` is a loopback-only Node
   server that serves `dist/` with the strict CSP the real API must send and implements the console's
   expected API shapes with simulated, hand-written records. Every fixture response is validated
   against the console schemas before sending. It is labelled SIMULATED everywhere and is not
   acceptance evidence for T-047–T-051 or any `WORKING_*` level.

## API contract proposed to M08

Endpoints the console calls that `API-SPEC.md` already names: project matrix, gate-run create /
validate / start / detail / cases, case start / abort / recover / captures, session events, run
operation, imports create / verify-replay / promote.

Read endpoints the console needs that `API-SPEC.md` does not list (M08 to add, or the console shows
“Not provided by this control API revision”):

| Endpoint                                    | Used by                      |
| ------------------------------------------- | ---------------------------- |
| `GET /__routespec/v1/projects`              | project selector, home       |
| `GET /__routespec/v1/projects/{id}/imports` | regression quarantine queue  |
| `GET /__routespec/v1/imports/{importId}`    | review workbench and lineage |
| `GET /__routespec/v1/settings`              | Safety & Settings            |

Response shapes are those in `schemas.ts`. Error envelopes follow API-SPEC section 3; field errors are
expected at `error.details.fields[] = { field, code, message }`.

## Consequences

- When M08 lands, its responses must parse against `schemas.ts` (or the schemas are amended in the
  same change, with the fixture updated); a parity test against the real API replaces the fixture for
  acceptance.
- `localStorage` holds only `routespec.console.theme`.
- CSS tokens for the dark status colors were chosen here (the spec lists light values only) and pass
  automated axe contrast checks in both themes; manual high-contrast review remains open.

## Invalidation

Revisit if M08 serves the console from a different origin, chooses cookie or header-based token
transport, adds SSE with authentication, or changes any response shape.
