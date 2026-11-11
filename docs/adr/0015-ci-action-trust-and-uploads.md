# ADR-0015 — CI action: trust classification, enforcement cap, secret withholding, and upload staging

- Date: 2026-11-12. Decision owner: RouteSpec engineering (M10 stage), pending user review.
- Status: ACCEPTED
- Related: FR-13, FR-14, FR-17, NFR-01, NFR-03, NFR-10, NFR-11, NFR-12, INV-09, INV-12; module
  M10 (T-056, T-058). Builds on ADR-0012 (CLI, launcher, exit codes, bundles) and ADR-0013
  (control API, CI OIDC verification). Number 0014 is left for the console stage running in
  parallel.

## Context

The pack asks for a GitHub Action that runs the local RouteSpec gate in CI, maps exit codes to CI
conclusions without turning REVIEW/NOT_RUN into success, uploads only redacted reports, keeps
secrets away from fork jobs, never claims repository enforcement, and records CI attestation
where possible. ADR-0013 left open whether a hosted CI issuer can carry the challenge nonce.
Nothing in this stage may push, create a remote run, or contact GitHub.

## Decisions

1. **Package and entry point.** `@routespec/ci` (`packages/ci`) with `routespec-ci run --config
<file>` and `routespec-ci sbom`. The composite action `.github/actions/routespec-gate` installs
   the pinned dependencies with the frozen lockfile and runs that entry point. Action inputs reach
   the shell only through `env:`; no `${{ }}` expression appears inside a script.
2. **The gate path is the reviewed launcher.** The action registers project, revision, build,
   manifest, scenarios, corpus, coverage policy, and gate definition through the real `routespec`
   CLI commands (in process, `runCli`) in a fresh journal outside the workspace, then runs
   `routespec gate run` through `runWithLauncher`. Each case handoff goes to the configured client
   module's `onCase(handoff, control, context)`, which is integrator code that starts the client.
   RouteSpec still runs no shell string or package script. Tokens cross only the launcher pipe and
   the in-memory handoff object.
3. **Identity is measured, not asserted.** Artifact digest = SHA-256 over the configured artifact
   files in order; lock, manifest, client module, and configuration digests are file digests;
   toolchain = node version, platform, arch. The workspace HEAD (`git rev-parse`, fixed arguments)
   must equal `GITHUB_SHA` (else `STALE_WORKFLOW_METADATA`); the run identity must be complete;
   optional `pinnedIdentity` (repository, repository id, workflow ref) and
   `expectedArtifactDigest` must match. The artifact is re-measured just before and just after the
   run; a change after the run keeps the persisted decision but sets exit 4 and conclusion
   `identity_mismatch`. All of these are `RS_IDENTITY_MISMATCH`. The build row stays
   `USER_ASSERTED_LOCAL`.
4. **Trust classification** (fail closed, from the runner environment and event payload only):
   `LOCAL` outside GitHub Actions; `TRUSTED` for push/workflow_dispatch/schedule/merge_group on a
   configured trusted ref (default `refs/heads/main`); `UNTRUSTED` for those events on other refs
   and for every other event; `PULL_REQUEST` for a same-repository pull request whose payload
   proves its head; `FORK` for a fork pull request, a payload that cannot prove its head, and
   `pull_request_target`. Only `LOCAL` and `TRUSTED` may stage evidence bundles or extra files,
   mark scenarios reviewed, or be eligible for a live-dry probe.
5. **Secrets are withheld in every context.** Before reading configuration or loading client code
   the action deletes provider credentials (`ROUTESPEC_PROVIDER_*`, `ONECLICK_*` key/token
   names) and CI credentials (`GITHUB_TOKEN`, `ACTIONS_RUNTIME_TOKEN`,
   `ACTIONS_ID_TOKEN_REQUEST_*`, `NPM_TOKEN`, ...) from its own environment, so neither the CLI
   child, the client module, nor the subject can read them. The values stay in memory only to scan
   upload candidates for exact leaks. A provider secret in an untrusted job is reported as
   `PROVIDER_SECRET_PRESENT_IN_UNTRUSTED_JOB`; the gate still runs and reports its own decision.
   The gate action never needs a provider secret, so a trusted job gets `PROVIDER_SECRET_WITHHELD`.
6. **Live dry.** The gate never launches the live-dry adapter. `liveDry.requested` in an untrusted
   job is refused before any registration (`RS_MODE_POLICY_DENIED`, exit 6,
   `DENIED_UNTRUSTED_CONTEXT`). In a trusted job it is recorded as `ELIGIBLE_NOT_RUN`: the RP-07
   probe remains the separately authorized M07 operator runbook.
7. **Enforcement cap.** `LOCAL_ADVISORY` outside CI (a stronger request is downgraded with a
   finding); `CI_CHECK` by default in CI; `REQUIRED_CHECK_UNVERIFIED` on request. Any other
   requested mode, and any configuration key or action input at any depth that asserts branch
   protection, rulesets, required-check verification, screenshots, or blocking, is refused with
   `RS_ENFORCEMENT_CLAIM_REJECTED` (exit 6) before anything runs. Every output says
   `enforcement-verified=false` and `blocking=false`. RouteSpec configures no repository setting.
8. **Conclusions.** The step exits with the RouteSpec exit code. Conclusion: 0 `success` (PASS
   only), 2 `failure`, 3 `review_required` or `not_run`, 4 `configuration_error` or
   `identity_mismatch`, 5 `internal_error`, 6 `policy_denied`. `continue-on-error` in a caller's
   workflow does not change the reported conclusion. Artifact readiness is a separate output.
9. **Upload staging.** The workflow uploads exactly one directory filled by `stageUploads`, plus
   `upload-manifest.json` (kind, short name, digest, size; refusals with a reason code only).
   Refused always: database files (by name or SQLite header), anything under the journal
   directory, raw or quarantined traces (by name or `routespec.trace/1` content), case/control/
   probe tokens, credential patterns, configured secret values, author-machine paths, symlinks,
   paths outside the workspace and reports directory, files over 16 MiB. Retention is 1–30 days
   (default 7). Untrusted jobs stage only the generated JSON/JUnit/SARIF reports.
10. **CI attestation is unavailable, not faked.** GitHub's hosted OIDC issuer lets a job choose
    only `aud`; it has no caller-controlled `nonce` claim, so it cannot satisfy the ADR-0013
    binding `nonce = digest(challengeId, nonce, observedDigests)`. A CI job also starts from an
    empty journal and may not enroll a principal. The action therefore never requests an OIDC
    token and reports `attestation: UNAVAILABLE (HOSTED_ISSUER_CANNOT_BIND_NONCE)`; a gate that
    requires an attested build is REVIEW (`BUILD_UNATTESTED`).
11. **Pins and permissions.** Workflows grant `contents: read` only, trigger on `push` to main and
    `pull_request` (never `pull_request_target`), reference no secrets, and check out with
    `persist-credentials: false`. Third-party actions are pinned to full commit SHAs:
    `actions/checkout` `11bd71901bbe5b1630ceea73d27597364c9af683` (v4.2.2),
    `actions/setup-node` `39370e3970a6d050c480ffad4ff0ed4d3fdee5af` (v4.1.0),
    `actions/upload-artifact` `b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882` (v4.4.3). These SHAs are
    recorded from the upstream release tags and were **not resolved against GitHub in this
    stage** (no remote access); verify them before the first push. pnpm comes from corepack and
    the `packageManager` pin, so no third-party pnpm action is used.
12. **SBOM.** `routespec-ci sbom` writes a deterministic CycloneDX 1.5 inventory from the pnpm v9
    lockfile (name, version, purl, integrity as hex hash, lockfile digest, toolchain). It is
    unsigned and is not a vulnerability or license verdict.

## Consequences

- The same action result is produced for a trusted push, a pull request, and a fork pull request:
  only privileges differ, never the decision or enforcement labelling.
- `CI_ATTESTED` builds need a CI issuer that can sign a caller-chosen nonce, or an enrolled
  self-hosted launcher (`LOCAL_LAUNCHER_KEY` over `attachLauncher`) with a persistent journal.
- Remote CI has never run: the workflow files, pins, and the Linux/macOS parity runs are
  NOT_RUN until a user pushes them.

## Invalidation

Revisit if GitHub adds a caller-controlled OIDC claim usable as a nonce, if RouteSpec gains a
repository-settings verification adapter (a separate ADR), if a self-hosted runner with an
enrolled launcher key becomes a supported target, or if the upload artifact service changes its
retention bounds.
