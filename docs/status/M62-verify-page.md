# M62 — Verify page redesign: status evidence

- Module state: **DONE (presentation only)**. The verify page (`apps/verify`) is redesigned; its
  decision logic, link rules, configuration and requests are unchanged. Publishing is still
  pending as recorded in M49 and M54. No `WORKING_*` level is claimed and none changes.
- Branch: `feat/routespec-m62-verify-redesign` (base `796c548`).
- Decision: `docs/adr/0034-verify-page-check-ledger.md`.
- Environment observed 2026-11-13: Windows 11 Home 10.0.26300 x64, Node v22.23.1, pnpm 10.34.9,
  Playwright 1.65.0 Chromium. No container engine on this host.

## What changed

| Part         | Where                        | Notes                                                                                        |
| ------------ | ---------------------------- | -------------------------------------------------------------------------------------------- |
| Markup       | `apps/verify/index.html`     | two-column layout, check ledger, details section, about split in two; CSP adds `font-src`    |
| Behaviour    | `apps/verify/src/main.ts`    | ledger driven by the page's own JSON-RPC calls; verdict icon, badge preview, copy buttons    |
| Icons        | `apps/verify/src/icons.ts`   | the console's stroke icons (same path data) for plain DOM                                    |
| Styles       | `apps/verify/src/styles.css` | UI-SPEC 5 tokens, bundled Plex Sans and JetBrains Mono, reduced-motion aware animation       |
| Dependencies | `apps/verify/package.json`   | `@fontsource/ibm-plex-sans` and `@fontsource/jetbrains-mono` 5.3.0 (OFL-1.1, already pinned) |

## Checks

| Check                                        | Result                                                                                                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run typecheck`, `lint`, `format:check` | pass                                                                                                                                                                                                            |
| `apps/verify` unit tests (16)                | pass                                                                                                                                                                                                            |
| `pnpm run test` (full)                       | see "Suite record" below                                                                                                                                                                                        |
| `pnpm run test:registry` (near-sandbox)      | **NOT_RUN** on this host: no container engine, every test reports its reason; the page's DOM hooks it reads were exercised against the review fixture instead                                                   |
| Rendered review                              | Chromium, deviceScaleFactor 2, 1440 and 390 px, light and dark, ten states; overflow checked at 320, 375, 640, 768, 1024 and 1440 px: none                                                                      |
| Accessibility                                | axe (WCAG 2.0/2.1/2.2 A and AA tags) on idle, PASS, FAIL, revoked and testnet "not verified", both schemes: no violations; keyboard order and 2 px focus ring checked                                           |
| Motion                                       | animations present with no preference; none with `prefers-reduced-motion: reduce`                                                                                                                               |
| Flows                                        | link by digest and by project; bundle file digest computed in the browser and checked; invalid digest moves focus to the error and keeps the input; copy announces without moving focus; `RPC_FROM_LINK` notice |

Verdict states were rendered against a local review fixture: a loopback JSON-RPC endpoint that
answers the registry views with certificates signed by real Ed25519 keys, so the page's WebCrypto
signature check and the shared aggregation ran unchanged. The testnet state was read from the real
NEAR testnet RPC, where `gnanam1990-routespec.testnet` is not deployed yet (`UNKNOWN_ACCOUNT`). The
fixture is not in the repository and no screenshot claims a testnet certificate.

## Suite record

After merging `main` (already up to date at `796c548`), `pnpm run check` ran on 2026-11-13:
typecheck, lint, format check and the secret scan pass. The full `vitest run` had 12 failing files
out of 122 while about 30 other Node processes were running on the host; the failures were
60-second test timeouts, an elapsed-time bound (27.6 s against 20 s), and a locked journal file,
all in CLI, control-API, MCP, incident-corpus and security-suite tests this module does not touch.
Run again serially (`vitest run --no-file-parallelism` on those 12 files) they pass: 60 passed,
1 skipped. An earlier full run in a quieter moment failed only `t025` and `t057` in the same way;
both passed alone (`t057` takes 44 s of its 60 s budget on this host). The `apps/verify` tests
(16) pass.
