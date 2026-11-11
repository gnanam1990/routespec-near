# RouteSpec CI provenance and SBOM

Status: the commands below ran locally on win32/x64 (see `docs/status/M10.md`). No hosted CI run,
artifact attestation, signature, or registry publication exists. Every remote item is NOT_RUN.

## What identifies a CI gate run

The gate action records, inside the journal and every report:

- the workspace commit (`git rev-parse HEAD`, which must equal `GITHUB_SHA`) and a digest of
  `git status --porcelain` when the tree is dirty;
- the artifact digest (SHA-256 over the configured artifact files, in order), the lockfile,
  effect manifest, client launch module, and CI configuration digests;
- the toolchain digest (Node version, platform, architecture);
- the CI run identity `runId/runAttempt`, repository, ref, and workflow ref;
- the build attestation class, which is always `USER_ASSERTED_LOCAL` in CI (ADR-0015 decision
  10), and the enforcement mode, which is never verified and never blocking.

## Dependency pinning

- `pnpm-lock.yaml` is committed and installed with `pnpm install --frozen-lockfile`; pnpm itself
  is pinned through the `packageManager` field and activated with corepack.
- Node is pinned to an exact version in every workflow (`22.23.1`).
- Third-party actions are pinned to full commit SHAs (listed in ADR-0015). The SHAs were recorded
  from the upstream release tags and must be verified against GitHub before the first push.

## SBOM

```
node --no-warnings packages/ci/bin/routespec-ci.mjs sbom --lock pnpm-lock.yaml --out sbom.cdx.json
```

Writes a deterministic CycloneDX 1.5 document: one component per lockfile package (name,
version, purl, integrity hash in hex), the lockfile digest, and the Node and pnpm versions. No
timestamp, serial number, or host path is included, so the same lockfile and toolchain give the
same bytes. It is an inventory only: license review and vulnerability scanning stay separate,
reviewed steps (SECURITY.md section 11), and no signature is claimed.

## Not done here (needs a user action)

1. Verify the three action SHAs against their upstream tags, then push the branch.
2. Watch the first `ci` run on Linux, macOS, and Windows; record the T-027 and T-009 parity
   results per OS in `docs/status/M10.md`.
3. Decide whether to publish SBOMs as workflow artifacts and whether to add an artifact
   attestation (a separate signing ADR is required before any signed-manifest claim).
