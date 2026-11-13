# ADR-0034 — Verify page redesign: answer first, and the check as a ledger

- Status: accepted
- Date: 2026-11-13
- Module: M62 (verify page redesign; amends the presentation of ADR-0031 only)
- Goes beyond the sealed specification: no further than ADR-0031. `docs/spec/` is not edited; the
  page now follows UI-SPEC 5 (typography, tokens, motion, iconography) as the console does
  (ADR-0026).

## Context

The M49 verify page was correct but read as a generic form. Its verdict sat below a 600 px form,
so a judge opening a `?project=` or `?digest=` link saw the question but not the answer. The
progress text ("Reading the registry and checking signatures…") did not say which check was
running, although UI-SPEC 5.4 asks for stage-based progress for operations longer than a second
(a public RPC call often is). The page used system fonts while UI-SPEC 5.1 names IBM Plex Sans
and JetBrains Mono, and status relied on colour and text without the icon UI-SPEC 4 requires.

The direction was chosen with the design workflow: three compositions were compared (incumbent
single column; a full-width "certificate document"; two columns with the check beside the
request). A public UI/UX rules dataset was consulted: its "Micro-Credentials/Badges" product row
recommends Minimalism and Swiss style with trust blue, its "Developer Mono" pairing is the
UI-SPEC pair, and its feedback rows ask for step progress on multi-step work and for no flashing
or decorative loops.

## Decision

1. **Answer first.** At 1024 px and wider the page has two columns: the question, lede and request
   form on the left; the result and the check ledger on the right, so the verdict is in the first
   viewport. Below 1024 px the order is question, result, form; with no result yet the ledger
   shows titles only on phones so the form stays close.
2. **The check as a ledger.** Five numbered steps on one route line (the product mark's motif):
   bundle digest, network, registry contract, certificates, signatures and attesters. Idle, each
   step says what will be checked. Running, the step in progress is the one whose JSON-RPC call is
   in flight: the page passes a `fetch` wrapper to `verifyDigestOnChain`/`latestProjectDigest`
   that reads only the outgoing method name (`status`, `view_account`, `get_info`,
   `get_certificates_by_bundle`, `get_attester`). Done, each step shows what was read (the full
   digest, the chain id, registry account, owner, code hash and whether it is a known build, the
   certificate count and block height, accepted count, pinned keys and findings); this replaces
   the separate "What was read" list. On an error the ledger stops at the step in flight and
   marks later steps "Not reached". Nothing on it is simulated, and steps are marked done only
   from the returned verification.
3. **Verdict.** Icon plus text per UI-SPEC 4 (check, cross, alert, hollow circle; slash and
   question for revoked/not certified and unknown code; disconnected for not verified), the
   headline texts unchanged, the release decision and status codes in text, and the README badge
   for this result rendered locally from `v.badge` (no request to shields.io; the CSP is unchanged
   for connections and images).
4. **Typography and tokens.** IBM Plex Sans 400/500/600 and JetBrains Mono 400/500 from
   `@fontsource` 5.3.0 (OFL-1.1; the versions the console already pins), imported in
   `styles.css` and emitted as same-origin files. The meta CSP gains `font-src 'self'` (the
   same directive the control service sends for the console); nothing else in it changes.
   Colours are the UI-SPEC 5.2 tokens with the console's border additions; radii 4/6/8 px;
   borders, not shadows. Digests are shown in 8-character groups made of spans spaced by CSS, so
   copied text and `textContent` remain the exact digest.
5. **Interaction.** The submit button is disabled only while a check runs. A rejected form input
   moves focus to the verdict and keeps every input. Attester keys in the certificate table and
   the link to this check have copy buttons that announce the result in a polite live region
   without moving focus, so full values never depend on hover. The verdict region stays the
   `aria-live` region; the ledger and certificates are not live.
6. **Motion.** Verdict and notices rise 8 px with opacity over 180 ms, a step's icon settles over
   160 ms, step values fade in; opacity and transform only, no loop, no celebration for PASS.
   Under `prefers-reduced-motion: reduce` no animation runs (verified with
   `document.getAnimations()`).

## Consequences

- No behaviour, route, decision, request, link rule, or test hook changed: `#verify-form`,
  `#bundle-file`, `#bundle-digest`, `#digest`, `#project`, `#network`, `#registry`,
  `#attesters`, `#verify`, `#result .verdict` with its `data-*` attributes, `[data-notice]`,
  `data-certificate` and `data-link` are kept. The certificate id cell is now a row header.
- `apps/verify` adds two dependencies already in the lockfile; the built page ships about 250 KB
  of fonts (woff2 and woff fallbacks), loaded with `font-display: swap`.
- The busy text no longer appears inside `#result`; it is in the placeholder above the ledger, and
  `#result` is shown only with a verdict.
- Screenshots of verdict states were taken against a local review fixture (a loopback JSON-RPC
  endpoint answering the registry views with certificates signed by real Ed25519 keys, so the
  page's own WebCrypto check and aggregation ran). The "not verified" state was taken against
  the real NEAR testnet RPC, where the configured registry account is not deployed yet. The
  fixture is not part of the repository.
