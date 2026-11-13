# M62 — Console redesign: status evidence

- Module state: **VERIFIED_BOUNDED** on win32/x64 for the console surface. No product claim level
  changes; nothing is published and no network, provider, credential or chain action is involved.
- Branch: `feat/routespec-m62-console-redesign` (base `796c548` on `main`).
- Decision: `docs/adr/0034-console-inspection-docket-redesign.md`.
- Environment: Windows 11 Home 10.0.26300 x64, Node v22, pnpm 10.34.9, Playwright Chromium.

## What changed

| Area               | Change                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------- |
| Shell              | Ink instrument band in both themes; evidence-chain navigation 01–04 with a rail             |
| Status axis group  | Hairline axis ledger (container query), tone rule per axis, verdict reason at body size     |
| Releases, Gate run | Full-width summary; Counts with a proportional case tally (SVG, `aria-hidden`), side blocks |
| Case run           | Four case axes as one ledger row on wide screens                                            |
| Tables             | Verdict edge on FAIL / REVIEW / PASS rows (CSS `:has`)                                      |
| Timeline, phases   | Ordered rail with event nodes; phase cards numbered 01–04 (CSS counters, hidden from AT)    |
| Lineage            | Rail joining the stage icons                                                                |
| Motion             | 160 ms transform-only settle, 180 ms tally fill; removed under reduced motion               |
| Touch              | 44 px controls on phones restored; digest controls 44 px; header wraps at 320 px            |

No route, API call, asserted copy, role, label or `data-testid` changed. No dependency added.

## Checks run on this host

| Check                                                 | Result                                    |
| ----------------------------------------------------- | ----------------------------------------- |
| `pnpm run check`                                      | pass (see stage handoff for final counts) |
| `pnpm run test:e2e` (contract fixture, axe)           | 26 passed                                 |
| `pnpm run test:e2e:real` (real service, T-047..T-052) | 63 passed                                 |

Rendered review: every console route at 1440 and 390 CSS px, light and dark, device scale 2,
inspected and iterated (tally stroke artefact, dark verdict wash and header contrast, mobile
counts density, case axes, 320 px header overflow, shadowed touch sizes fixed after inspection).

## Not checked

- Firefox, WebKit, real touch devices, and screen readers other than the automated tree checks.
- Performance on reference hardware beyond the suites' CLS and feedback assertions.
