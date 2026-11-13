# What is left for you to do

These steps need your accounts, your credentials, another person, or your explicit decision, so
the build did not do them. Each one says what to run and what to record. Nothing here moves
funds: RouteSpec has no funded mode. Updated by the M18 consolidation on 2026-11-12.

## 0. What `WORKING_LOCAL` still needs (read this first)

Done on this host (M14, M16, M17): process-tree containment with a required seccomp filter,
attested launches and interceptors, complete-effect INV-04 PASS for the corrected client,
refusal of ineligible captures as release evidence (RP-08), a signed profile review workflow
used by INV-04, and the container-host part of T-036. No `WORKING_*` level is claimed. Exactly
these remain:

1. ~~RP-05 — a green clean-checkout run on a real CI service~~ (section 1): **done**. GitHub
   Actions `ci` [run 43272644091](https://github.com/gnanam1990/routespec-near/actions/runs/43272644091) on `ab9b89f` passed on ubuntu-24.04, windows-2022, and
   macos-15 (observed by M41 on 2026-11-13). Keep pushing `main` so later commits get their own
   green runs.
2. **RP-02/RP-06 — an independent review of the canary interceptor profile** (section 2). The
   journeys review the profile with a locally generated test key held by the same operator,
   which proves the mechanics but not independence.
3. After both: rerun `pnpm run test:delivery` with the engine configured on the same commit,
   record the results, and only then reconsider the claim from that runtime evidence.

RP-07 (section 3) and the independent security review (section 5) are outside `WORKING_LOCAL`.

Reviewer kits (M19): hand these to the people doing the reviews; each is self-contained
(`docs/review-kits/README.md`):

- [interceptor profile review](review-kits/interceptor-profile-review.md) (section 2);
- [security review](review-kits/security-review.md) (section 5);
- [console accessibility review](review-kits/accessibility-review.md) (screen readers and
  200 percent zoom, the NOT_RUN manual parts of T-047 to T-052).

## 1. Remote CI run (RP-05, M10, M15)

1. Check the three pinned action SHAs against their upstream release tags:
   `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683` (v4.2.2),
   `actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af` (v4.1.0),
   `actions/upload-artifact@b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882` (v4.4.3).
2. Push `main` yourself (repository `gnanam1990/routespec-near`; keep it private unless you
   decide otherwise). No module pushed or created anything remotely.
3. `ci` runs on ubuntu-24.04, macos-15, and windows-2022: frozen install, the pinned Playwright
   Chromium install (M15), `pnpm run check`, the T-027/T-009 parity step, and the SBOM.
   `routespec-gate` runs on ubuntu-24.04. Record per-OS results, run URLs, and uploaded report
   names in `docs/status/M10.md` and the RP-05 row of `BUILD-STATUS.md`. A green run also gives
   the first Linux/macOS evidence for T-009, T-027, and the rest of the suite.
4. For the clean-install check on those systems, also run `pnpm run test:delivery` on a Linux and
   a macOS machine and record the result in `docs/status/M12.md`.
5. Hosted runners have no WSL. For the contained journey on a Linux runner set
   `ROUTESPEC_CONTAINER_CLI='["docker"]'`, pull `node:22-bookworm-slim` in a setup step, and run
   `pnpm run test:containment` and `pnpm run test:delivery`. Without an engine those tests report
   NOT_RUN, which is not a pass.
6. If you configure a required status check, RouteSpec still reports
   `REQUIRED_CHECK_UNVERIFIED`; it has no adapter that can verify repository settings.

## 2. Independent interceptor profile review (RP-02, RP-06)

RouteSpec cannot tell whether a reviewer is a different person; you must arrange one. Give the
reviewer `docs/review-kits/interceptor-profile-review.md` (verified commands for both sides,
checklist, findings template). The runbook is `docs/runbooks/interceptor-profile-review.md`. In
short:

1. Prepare a data directory with the contained setup: either keep the work directory of
   `node --no-warnings packages/delivery/src/journey.ts --work <dir> --out <file> --contained`
   (its data is in `<dir>/data`), or set one up by hand as in
   `docs/runbooks/container-containment.md` ("Run the control service with containment
   yourself").
2. Start the service on that data directory with containment
   (`node --no-warnings packages/control-api/src/main.ts --data <dir>/data --subject-root ...
--container-cli ... --launcher ... --launcher-key ...`).
3. If you reuse a journey directory, revoke its test reviewer first
   (`POST /__routespec/v1/profile-reviewers/{reviewerId}/revoke` with the local confirmation), so
   only the independent review can make the profile `REVIEWED`.
4. The reviewer creates their own Ed25519 key on their own machine and sends only the public
   `x` value; you enroll it (local confirmation; a launcher key is refused with
   `RS_REVIEWER_NOT_INDEPENDENT`).
5. Request a challenge for the canary interceptor profile, give `challenge.json` to the
   reviewer, who checks the artifact digest and the checklist and signs offline with
   `node packages/cli/src/main.ts profile review-sign --challenge challenge.json --key reviewer.pem`.
   Complete the challenge with the signature; `GET /interceptor-profiles/{profileId}` (or
   `profile review-status` with the service stopped) must report `REVIEWED`.
6. Run a new contained gate run in that data directory **after** the review (a review recorded
   after a case's input closed does not count for that case). Check that every case's INV-04 is
   PASS, the capture classification has no refusal reasons, and the exported
   `routespec.bundle/2` verifies with `profile-review-signatures`.
7. Record the reviewer (role, not private details), review id and digest, the reviewed artifact
   digest, findings, and the gate run in `docs/status/M16.md` ("Independent profile review").

Known limit: the delivery journey always enrolls its own test reviewer and has no mode that
waits for an external reviewer's signature, so step 6 is a manual run through the service or
CLI, not `pnpm run test:delivery`.

## 3. Official live dry probe (RP-07, `OFFICIAL_ENDPOINT_COMPATIBLE`)

Done once on 2026-11-13 (`OFFICIAL_ENDPOINT_COMPATIBLE`, `docs/status/M42.md`). Repeat it to
recheck the endpoint later; add `--debug-echo-diff` to see a redacted field-level diff if the
result is ever `RS_FINALIZATION_REQUEST_MISMATCH`.

Optional. It is separate from `WORKING_LOCAL` and never changes a local verdict. It sends one
`dry: true` quote to the pinned official endpoint; committed quotes, deposits, signatures, and
transfers are refused before any credential, DNS lookup, or socket.

1. Obtain your own 1Click API JWT through the provider's partner process. RouteSpec does not
   create accounts or tokens. (Without a JWT the probe still runs as `OPTIONAL_ABSENT`, but the
   provider may reject or rate-limit it, which is recorded as `UNKNOWN`.)
2. Write `dry-quote.json` with real asset IDs from the provider's token list, a future
   `deadline`, and `"dry": true`. The full template is in `docs/status/M07.md` ("RP-07
   official dry probe (exact user steps to repeat it)").
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

## 4. Demo recording (only after the gates it shows)

1. Record only the normal product path that has passed. Today that is the contained local
   journey (`pnpm run delivery:journey -- --work <dir> --out <file> --contained` with the engine
   configured): confined subjects, attested launches, the capture accepted as release evidence,
   the corrected client's gate PASS, and the uncontained capture refused as release evidence.
   Say on screen that `WORKING_LOCAL` is still not claimed (the interceptor profile is reviewed
   only with a local test key).
2. A safe script: `pnpm run test:delivery`, then start
   `node packages/control-api/src/main.ts --data <dir>/data --console apps/console/dist` on a data
   directory produced by the journey and walk the gate runs, the case, the run operation and
   evidence drawer, the regression review ("Not release evidence" for the uncontained capture),
   and the exported bundle. Do not show tokens, the terminal hand-off URL, or your home path.
3. A recording is a submission artifact; it never creates or upgrades evidence. Never describe a
   dry quote as a deposit, swap, delivery, or settlement.

## 5. Independent security review

Give the reviewer `docs/review-kits/security-review.md` (scope, questions per requirement, how
to run the suites, findings template).

Arrange a reviewer outside this team for the areas listed in `docs/spec/SECURITY.md` section 15,
ADR-0016, ADR-0019, ADR-0020 (container-host access, seccomp), and ADR-0021 (review signatures,
release-evidence classification). Record findings before any production use. Until then
production readiness is blocked.

## 6. Dependency follow-ups

- Done: zod 4.6.7, react-router 7.18.5, vitest 4.1.12 (M13); the minimatch advisory
  GHSA-g3hv-75wg-m249 is resolved by the scoped override to 11.0.3 (M17, ADR-0020).
- `pnpm audit` on 2026-11-12: 4 advisories (1 low, 3 moderate), all node-forge 1.4.2, dev only.
  On or after 2026-11-18, set `node-forge` to `1.4.3` in `packages/live-dry-adapter/package.json`,
  run `pnpm install`, `pnpm run check`, and `pnpm audit` (expected afterwards: 0 advisories).
- When typescript-eslint releases a version that depends on minimatch `>=11.0.1`, upgrade it and
  drop the three `pnpm.overrides` entries in `package.json`.
- A lockfile-wide release-age policy (pnpm `minimumReleaseAge`) is not enabled: it refuses the
  current lockfile (`@rollup/rollup-win32-x64-msvc` 4.68.2 via vite). Decide whether to adopt it
  after that package ages past the window.

## 7. Container containment (M14, M17)

- This machine is already set up: Docker Engine 29.1.3 in the WSL 2 distribution Ubuntu-24.04,
  image `node:22-bookworm-slim` pulled. Keep the distribution's Docker service enabled. Before a
  run, set `ROUTESPEC_CONTAINER_CLI='["wsl.exe","-d","Ubuntu-24.04","-u","root","--exec","docker"]'`.
- On another machine follow `docs/runbooks/container-containment.md`. RouteSpec never installs
  an engine, changes Windows features, or pulls images by itself.
- Keep the engine's default seccomp profile on: since M17 a container without an active seccomp
  filter is reported `DECLARED_HOOKS_ONLY` (`SELF_SECCOMP_NOT_FILTERED`).
- When you update the image tag, rerun `pnpm run test:containment` and `pnpm run test:delivery`:
  the image id is part of every contained build's toolchain identity, so builds registered with
  the old id no longer attest.
- Not run here: WSL `mirrored` networking mode, plain Linux Docker, rootless or user-namespaced
  engines. If you use one of them, rerun `pnpm run test:containment` (it includes T-036
  container-host access) there and record the result.
- To run the runtime and delivery suites beside other jobs on one machine, give them a host port
  window: `ROUTESPEC_TEST_PORT_BASE=<base>` (50 ports from the base, default 9350) and
  `ROUTESPEC_DELIVERY_PORT=<port>` (the contained journey uses the next port).

## 8. Before any publication or event submission

1. Refresh the official event rules and deadlines immediately before you publish or submit
   (not done by the build; `docs/spec/EVENT-NOTES.md` is the last recorded copy).
2. Keep the sibling-project disclosure from `docs/spec/EVENT-NOTES.md`: RouteSpec and Dockside are
   independent products with separate repositories, code, state, demos, and submissions.
3. Publishing, posting, making the repository public, and submitting are your actions.

## 9. Release certificate registry (M47)

Nothing is deployed yet. The steps, with exact PowerShell commands, are in
`docs/runbooks/release-certificates.md`:

1. Build the deployable wasm (`pnpm run registry:reproduce`) and check that its SHA-256 is
   `bc6d8b9dcf69e94fb5d4ef74182da92b394a0de4562a4b5e35d2b60a8807b656`.
2. Create `gnanam1990-routespec.testnet`, deploy and initialise in one transaction, and check
   `get_info`.
3. Create an attester key (`certificate keygen`) and enrol its public key.
4. Run the contained journey, sign the certificate of its PASS bundle, submit the envelope, and
   run `certificate verify`. Record the transaction hash and the certificate id in
   `docs/status/M47.md`.
5. Optional: configure the two secrets and three variables so the `routespec-certificate`
   workflow publishes on every PASS on `main`; record the first green run.
6. Mainnet: the same steps with a mainnet account, after the contract audit.

## 10. Certified badge and verify page (M49)

After the first certificate is published (section 9), enable GitHub Pages with GitHub Actions as
the source and run the `routespec-pages` workflow; optionally pin the attester key with the
`ROUTESPEC_BADGE_ATTESTERS` variable. Exact commands: `docs/runbooks/certified-badge.md`. Until
then the badge says "unverified" and the page says the registry account does not exist.
