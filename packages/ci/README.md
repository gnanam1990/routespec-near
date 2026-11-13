# @routespec/ci

Owner module: M10. Status: **VERIFIED_BOUNDED** on win32/x64 for the local action entry point
(see `docs/status/M10.md`). Remote GitHub Actions runs are **NOT_RUN**. Decisions:
`docs/adr/0015-ci-action-trust-and-uploads.md`.

## Entry point

```
routespec-ci run --config <path-in-workspace> [--workspace <dir>] [--work-dir <dir>]
routespec-ci certificate --bundle <file> --journal <dir> --decision <decision> --project-key <key> --registry <account> --network testnet
routespec-ci sbom --lock pnpm-lock.yaml --out sbom.cdx.json
```

`run` prints one JSON document (`routespec.ci-result/1`) on stdout, appends step outputs to
`GITHUB_OUTPUT` and a summary to `GITHUB_STEP_SUMMARY` when present, and exits with the RouteSpec
exit code: 0 only for a PASS decision, 2 FAIL, 3 REVIEW/NOT_RUN, 4 configuration or identity
mismatch, 5 internal, 6 policy denial. The workspace defaults to `GITHUB_WORKSPACE`, the work
directory to `$RUNNER_TEMP/routespec-ci` (it must be outside the workspace).

The composite action is `.github/actions/routespec-gate`; the self-gate workflow is
`.github/workflows/routespec-gate.yml`; a reusable workflow example for integrator repositories is
`docs/ci/routespec-gate.reusable.example.yml`.

## Configuration (`routespec.ci-config/1`)

```json
{
  "schema": "routespec.ci-config/1",
  "project": "my integration",
  "revisionLabel": "r1",
  "subject": {
    "artifactFiles": ["dist/client.js"],
    "lockFile": "pnpm-lock.yaml",
    "manifestFile": "routespec/hooks.json",
    "clientModule": "routespec/launch-client.mjs",
    "expectedArtifactDigest": "sha256:… (optional pin)"
  },
  "scenarios": [{ "file": "routespec/happy-path.yaml", "policy": "REQUIRED" }],
  "requiredInvariants": ["INV-01", "INV-02", "INV-03"],
  "effect": { "sinks": ["fulfilment-webhook"], "basis": "DECLARED_HOOKS_ONLY" },
  "gate": { "name": "release gate", "enforcement": "CI_CHECK", "requireAttestedBuild": false },
  "uploads": { "include": ["gate-report-json", "junit", "sarif"], "extraPaths": [], "retentionDays": 7 },
  "liveDry": { "requested": false },
  "trustedRefs": ["refs/heads/main"],
  "pinnedIdentity": {
    "repository": "owner/repo",
    "workflowRef": "owner/repo/.github/workflows/x.yml@refs/heads/main"
  }
}
```

The client module exports `onCase(handoff, control, { workspace, artifactFiles })` and connects
its separately started client to `handoff.proxyOrigin` with `handoff.credentials` (see
`test/support/sample-client.ts`). Unknown fields fail closed; any branch-protection, ruleset,
screenshot, "verified", or "blocking" key is refused with `RS_ENFORCEMENT_CLAIM_REJECTED`.

## What a job may do, by trust

| Trust                         | Provider secrets | Evidence bundle / extra files | Scenarios marked reviewed | Live-dry request   |
| ----------------------------- | ---------------- | ----------------------------- | ------------------------- | ------------------ |
| LOCAL, TRUSTED                | withheld         | staged after scanning         | yes                       | `ELIGIBLE_NOT_RUN` |
| PULL_REQUEST, FORK, UNTRUSTED | withheld         | refused (`UNTRUSTED_CONTEXT`) | no                        | refused (exit 6)   |

"Withheld" means the composite action's step shell removes provider secrets and CI credentials
before the entry point starts, so they are in no environment block of the action process (not
even `/proc/<pid>/environ`), and passes the values to it over a pipe for the upload leak scan
only (ADR-0025). The client module runs inside the action process, so withholding cannot contain
hostile client code; do not expose provider secrets to the gate step. Running `routespec-ci run`
directly, without the action's step script, removes them from `process.env` only.

Every job keeps its decision and its `CI_CHECK` / `REQUIRED_CHECK_UNVERIFIED` label, always with
`enforcement-verified=false` and `blocking=false`. CI attestation is `UNAVAILABLE`
(`HOSTED_ISSUER_CANNOT_BIND_NONCE`); builds stay `USER_ASSERTED_LOCAL`.

## Certificate step (M47)

`routespec-ci certificate` is a separate step after the gate step (composite action
`.github/actions/routespec-certificate`, workflow `.github/workflows/routespec-certificate.yml`,
which runs on push to `main` and by hand only). It signs the certificate of the staged evidence
bundle and submits it to the `routespec-registry` contract. It prints one JSON document
(`routespec.ci-certificate/1`) and writes the step outputs `certificate-status`,
`certificate-id`, `certificate-transaction`, `certificate-attester` and
`certificate-bundle-digest`.

| Situation                                                        | Status                      | Exit  |
| ---------------------------------------------------------------- | --------------------------- | ----- |
| gate decision is not PASS                                        | `SKIPPED_DECISION_NOT_PASS` | 0     |
| job is not trusted (pull request, fork, other ref, other event)  | `SKIPPED_UNTRUSTED_CONTEXT` | 0     |
| no signer configured                                             | `SKIPPED_NO_SIGNER`         | 0     |
| signer only partly configured                                    | `FAILED`                    | 4     |
| certificate submitted                                            | `PUBLISHED`                 | 0     |
| this attester already published this bundle (rerun)              | `ALREADY_PUBLISHED`         | 0     |
| registry unreachable / registry refused (unknown or revoked key) | `FAILED`                    | 5 / 6 |

The signer is `ROUTESPEC_ATTESTER_KEY`, `ROUTESPEC_NEAR_SIGNER_ACCOUNT` and
`ROUTESPEC_NEAR_SIGNER_KEY` in the step environment. The job trust is read from the runner
environment, never from an input, and the decision is read again from the verified bundle. The
gate step withholds the two secret values like every other credential, so it never has them in
its environment block. The gate step's new outputs `certificate-bundle` and `certificate-journal`
name what the certificate step certifies; they are empty unless a trusted job staged the evidence
bundle (`uploads.include` must list `evidence-bundle`). Decisions:
`docs/adr/0029-onchain-release-certificates.md`. Remote runs of this step are **NOT_RUN**.
