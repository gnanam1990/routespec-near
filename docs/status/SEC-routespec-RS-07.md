# SEC RS-07 — Gate aggregation kept PASS for a revoked build attester: status evidence

- Source: external security audit, finding RS-07 (LOW; likelihood low, impact medium; verdict
  integrity only, enforcement is advisory). Re-confirmed with failing tests on the real code
  before any change.
- State: **FIXED** on `feat/routespec-m29-aggregate-attester-revocation` (`main` merged in before
  the final runs).
- ADR: none. No protocol, wire format or schema changes. The aggregation rule changes, so the
  aggregator revision goes from `routespec-gate@1.1.0` to `routespec-gate@1.2.0`.

## Finding (verified)

TB-07 (TDD section 4) says that disabling or revoking an attester principal makes it unusable
for new or in-progress evaluation (REVIEW), without rewriting historical evidence. The selected
build attestation was checked only once, by `attestationUsable` when the gate run was created
(`packages/control-api/src/routes.ts`). After that:

- `readGateSnapshot` (`packages/store/src/gates.ts`) read no attestation or principal rows;
- `gateInputFromSnapshot` (`packages/runner/src/gate-snapshot.ts`) passed only the stored class,
  id and policy to the aggregator;
- `aggregateGate` (`packages/runner/src/aggregate.ts`) added a gate-level attestation finding
  only for `USER_ASSERTED_LOCAL`.

Kernel INV-04 does see revocation, but only for cases that require INV-04, and only at
case-evaluation time. So if a principal was revoked after the gate run was created, a later gate
evaluation still returned PASS with no attester finding, and that PASS was persisted.

## Change

1. `readGateSnapshot` reads the selected build attestation joined with its principal (current
   `enabled`, `revocation_epoch`, `policy_digest`) in the same read transaction as the cases.
2. `gateInputFromSnapshot` maps it to `GateInput.buildAttestation`
   (`GateBuildAttestationState`).
3. `aggregateGate` re-checks every trusted class (`TRUSTED_LAUNCHER`, `CI_ATTESTED`) at each
   evaluation, whatever the build attestation policy. These are blocking gate findings (REVIEW;
   FAIL still dominates):
   `BUILD_ATTESTATION_NOT_FOUND` (missing record, id mismatch, or no state in the input: fails
   closed), `BUILD_ATTESTER_DISABLED`, `BUILD_ATTESTER_REVOKED`,
   `BUILD_ATTESTER_POLICY_CHANGED`, `BUILD_ATTESTATION_BUILD_MISMATCH`,
   `BUILD_ATTESTATION_SCOPE_MISMATCH`, `BUILD_ATTESTATION_CLASS_MISMATCH`. Findings are part of
   the decision digest, so a post-revocation evaluation is a new immutable evaluation row.
   Earlier evaluations are not touched.
4. `persistGateEvaluation` re-reads the principal state inside the write transaction and returns
   `RS_REVISION_CONFLICT` if it changed since the snapshot. `evaluateGate` already retries that,
   so a revocation that races an evaluation cannot persist a stale PASS.

Expiry is not re-checked at gate level: the aggregator is pure and has no clock. Freshness is
still enforced when the gate run is created and, per case, at input-close time by INV-04.
User-asserted builds behave as before.

## Tests (red, then green)

- `packages/cli/test/t034-release-aggregation.test.ts`, "a trusted build attestation is re-checked
  at every evaluation ...": all-PASS cases with `TRUSTED_LAUNCHER` / `CI_ATTESTED` under
  `REQUIRE_TRUSTED` and `ALLOW_USER_ASSERTED`. A usable attester gives PASS; revoked, disabled,
  policy-changed, build/scope-mismatched, missing, or absent state gives REVIEW with the named
  finding and a different decision digest; FAIL still dominates.
- `packages/control-api/test/t044-control-mutations.test.ts`, "revocation needs local
  confirmation ...": real control API and journal. The test evaluates a gate run that selected a
  `TRUSTED_LAUNCHER` attestation, revokes the principal with local confirmation, and evaluates
  again. The second evaluation is a new row (201) with `BUILD_ATTESTER_DISABLED` and
  `BUILD_ATTESTER_REVOKED` and a different digest. The first evaluation row is unchanged.

| Step                                                                                                       | Exit | Result                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run packages/cli/test/t034-release-aggregation.test.ts -t "re-checked"`, before                | 1    | 1 failed: `TRUSTED_LAUNCHER/REQUIRE_TRUSTED/BUILD_ATTESTER_REVOKED: expected 'PASS' to be 'REVIEW'`                                |
| `npx vitest run packages/control-api/test/t044-control-mutations.test.ts -t "attester enrollment"`, before | 1    | 1 failed: post-revocation evaluate returned `200`, `created: false`, `findings: []`, the same decision digest as before revocation |
| `npx vitest run` of t034, t044 and t012, after                                                             | 0    | 3 files, 26 passed                                                                                                                 |

## Full regression (after `git merge main`, main at `b80b83e`)

Environment: `ROUTESPEC_TEST_PORT_BASE=9760`, `ROUTESPEC_DELIVERY_PORT=9765`, `FIXTURE_PORT=9768`
(ports 9760-9769). `ROUTESPEC_CONTAINER_CLI` is
`["wsl.exe","-d","Ubuntu-24.04","-u","root","--exec","docker"]`. The change touches
`packages/runner`, so the containment and delivery suites were run as well.

| Command                     | Exit | Result                                                                            |
| --------------------------- | ---- | --------------------------------------------------------------------------------- |
| `pnpm run check`            | 0    | typecheck, lint, format clean; 83 files, 710 passed, 2 skipped; secret scan clean |
| `pnpm run test:containment` | 0    | 4 files, 19 passed                                                                |
| `pnpm run test:delivery`    | 0    | 2 files, 21 passed                                                                |

After a further `git merge main` (main at `b4b74df`, containment framing only, RS-02):
`pnpm run check` exit 0 (84 files, 715 passed, 2 skipped; secret scan clean) and
`pnpm run test:containment` exit 0 (4 files, 19 passed).

Note: the host was heavily loaded by other suites running in parallel (CPU about 87%). Under that
load, some earlier `pnpm run check` runs had one or two timing failures in tests this change does
not touch: T-057 (`export write --overwrite` gave `RS_EXPORT_WRITE_FAILED` from the Windows
rename-replace), T-025 (no `KILLING` event before the child exited), and a T-022/T-023 crash test
that timed out at 60 s. An earlier `test:delivery` run also had one failure in the T-054
clean-clone regression step. Each of these passed when run alone, the same T-054 regression set
passed 3 of 3 later runs, and the final runs above passed in full.
