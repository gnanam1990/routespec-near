# What is left for you to do

These steps need your accounts, your credentials, or your explicit decision, so the build did
not do them. Each one says what to run and what to record. Nothing here moves funds: RouteSpec
has no funded mode.

## 1. Official live dry probe (RP-07, `OFFICIAL_ENDPOINT_COMPATIBLE`)

Optional. It is separate from `WORKING_LOCAL` and never changes a local verdict. It sends one
`dry: true` quote to the pinned official endpoint; committed quotes, deposits, signatures, and
transfers are refused before any credential, DNS lookup, or socket.

1. Obtain your own 1Click API JWT through the provider's partner process. RouteSpec does not
   create accounts or tokens. (Without a JWT the probe still runs as `OPTIONAL_ABSENT`, but the
   provider may reject or rate-limit it, which is recorded as `UNKNOWN`.)
2. Write `dry-quote.json` with real asset IDs from the provider's token list, a future
   `deadline`, and `"dry": true`. The full template is in `docs/status/M07.md` ("BLOCKED: RP-07
   real official dry probe").
3. In PowerShell, keep the token out of history and argv:

   ```powershell
   $s = Read-Host -AsSecureString 'Provider JWT'
   $env:ROUTESPEC_PROVIDER_JWT = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
     [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
   pnpm --filter @routespec/live-dry-adapter probe:official -- --confirm-official-endpoint `
     --request C:\path\to\dry-quote.json --ledger C:\path\to\compat.sqlite
   Remove-Item Env:ROUTESPEC_PROVIDER_JWT
   ```

4. Exit 0 means `OFFICIAL_ENDPOINT_COMPATIBLE`; 1 means `UNKNOWN` or `INCOMPATIBLE` (see
   `reasonCode`); 2 means the confirmation flag or the request file was missing. The printed JSON
   holds only the redacted shape, reason, HTTP status, timing, and token state. Add it to
   `docs/status/M07.md` and the RP-07 row of `BUILD-STATUS.md`.

## 2. First remote CI run (RP-05 CI part, M10)

1. Check the three pinned action SHAs against their upstream release tags:
   `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683` (v4.2.2),
   `actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af` (v4.1.0),
   `actions/upload-artifact@b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882` (v4.4.3).
2. Decide whether the repository `gnanam1990/routespec-near` should exist and stay private, then
   push `main` yourself. No module pushed or created anything remotely.
3. Let `ci` (ubuntu, macos, windows: `pnpm run check`, the T-027/T-009 parity step, the SBOM) and
   `routespec-gate` run. Record per-OS results, run URLs, and the uploaded report names in
   `docs/status/M10.md`. This also gives the first Linux/macOS evidence for T-009, T-027, and the
   rest of the suite.
4. For the clean-install check on those systems, also run `pnpm run test:delivery` on a Linux and
   a macOS machine and record the result in `docs/status/M12.md`.
5. If you configure a required status check, RouteSpec still reports
   `REQUIRED_CHECK_UNVERIFIED`; it has no adapter that can verify repository settings.

## 3. Demo recording (only after the gates it shows)

1. Record only the normal product path that has passed. Today that is the local, user-asserted,
   declared-hooks-only diagnostic journey: say on screen that `WORKING_LOCAL` is not reached and
   that INV-04 is REVIEW for lack of a sandbox and interceptor.
2. A safe script: `pnpm run test:delivery`, then start
   `node packages/control-api/src/main.ts --data <dir> --console apps/console/dist` on a data
   directory produced by `pnpm run delivery:journey -- --work <dir> --out <file>` and walk the
   gate runs, the case, the run operation and evidence drawer, the regression review, and the
   exported bundle. Do not show tokens, the terminal hand-off URL, or your home path.
3. A recording is a submission artifact; it never creates or upgrades evidence. Never describe a
   dry quote as a deposit, swap, delivery, or settlement.

## 4. Before any publication or event submission

1. Refresh the official event rules and deadlines immediately before you publish or submit
   (not done by the build; `docs/spec/EVENT-NOTES.md` is the last recorded copy).
2. Keep the sibling-project disclosure from `docs/spec/EVENT-NOTES.md`: RouteSpec and Dockside are
   independent products with separate repositories, code, state, demos, and submissions. The M12
   check found no reference to Dockside outside the sealed specification.
3. Publishing, posting, making the repository public, and submitting are your actions.

## 5. Independent security review

Arrange a reviewer outside this team for the areas listed in `docs/spec/SECURITY.md` section 15
and ADR-0016. Record findings before any production use. Until then production readiness is
blocked.

## 6. Dependency follow-ups

- After 2026-11-18, upgrade `node-forge` to 1.4.3 in `packages/live-dry-adapter` (dev only) and
  rerun `pnpm audit`.
- Plan zod 4, react-router 7, and vitest 4 as separate changes (13 advisories are triaged in
  `docs/status/M11.md`).

## 7. What `WORKING_LOCAL` still needs (engineering, not a user action)

- A process-tree sandbox and an independent interceptor process that observes the required sink
  through its private channel, launched and attested per case.
- A trust-rooted launcher path for the standalone service (today local launcher attestation
  exists only for a launcher the control host forks in-process), or a CI issuer that can bind the
  challenge nonce.
- Per-case effect-coverage policy selection for corpora with several scenarios
  (ADR-0017 §12), and refusal of declared-hooks-only captures as release evidence (RP-08).

When these exist, rerun `pnpm run test:delivery`; the T-055 assertions about INV-04 must then be
changed together with the new runtime evidence, never before it.
