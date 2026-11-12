# SEC vuln-0002 — Credential shapes missed after a word character: status evidence

- Source: external automated scan, finding vuln-0002 (LOW, CWE-693). Verified independently on
  the real modules before any change.
- State: **FIXED** on `feat/routespec-m21-secret-pattern-anchors` (base `f20917f`).
- No new ADR: the change tightens existing detectors within ADR-0016 (security hardening) and
  does not change any interface, schema or stored format.

## Finding (verified)

The provider-JWT, case-token (`rsct_`) and control-token (`rsctl_`) value patterns began with a
`\b` word-boundary anchor. A credential directly preceded by a letter, digit or underscore (for
example `x<jwt>`, `jwt_<jwt>`, `case_rsct_...`) was not detected, so it passed the proxy redactor
and both store guards (`assertNoSecrets` and the journal-boundary `persistedSecretRule`). Free
quote fields such as `customRecipientMsg` could carry such a value into the journal.

The same anchored shapes were present in two further detectors, fixed in the same way:

| Detector                                   | File                               | Shapes fixed             |
| ------------------------------------------ | ---------------------------------- | ------------------------ |
| Proxy redactor (`findIn`, `redactText`)    | `packages/proxy/src/redact.ts`     | jwt, case-token, control |
| Store value guard (`assertNoSecrets`)      | `packages/store/src/guards.ts`     | jwt, case-token, control |
| Journal boundary (`persistedSecretRule`)   | `packages/store/src/guards.ts`     | case-token, control      |
| Runner structured log redaction (`Logger`) | `packages/runner/src/log.ts`       | jwt, case-token, control |
| Trace scan (`scanSecretsInString`)         | `packages/regressions/src/scan.ts` | jwt, case-token          |

The fix removes only the leading `\b` from these shapes. The shapes themselves (`eyJ...` three
segments of 8+ characters; `rsct_`/`rsctl_` plus 20+ token characters) are unchanged, so
ordinary identifiers and digests remain unflagged (covered by the test). The repository
file scan (`scripts/secret-scan.mjs`) is a development-time check and is unchanged.

## Test (red, green)

`packages/security-suite/test/sec-secret-pattern-anchors.test.ts`: synthetic values assembled at
runtime, each shape with the prefixes `""`, `x`, `7`, `_`, `jwt_`, `case_`, against every
detector above, plus a negative case for ordinary text.

| Step                                                                                     | Exit | Result                                                                  |
| ---------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------- |
| `npx vitest run packages/security-suite/test/sec-secret-pattern-anchors.test.ts`, before | 1    | 65 failed, 14 passed (79): every prefixed form missed by every detector |
| same command, after the fix                                                              | 0    | 79 passed                                                               |

## Full suite (after `git merge main`, already up to date at `f20917f`)

| Command                                        | Exit | Result                                                                                        |
| ---------------------------------------------- | ---- | --------------------------------------------------------------------------------------------- |
| `ROUTESPEC_TEST_PORT_BASE=9550 pnpm run check` | 0    | typecheck, lint, format clean; 79 files, 697 passed, 1 skipped; secret scan clean (505 files) |

Delivery and browser e2e suites were not rerun: the change only widens string detection in
library functions, which the unit and security suites above exercise directly; no route,
console, container or delivery code changed.

## Not done (recorded)

- The scan suggested moving the shapes into one shared module. Each detector lives in a
  different package with its own dependency set; a shared module would add a cross-package
  dependency for five regular expressions. The new cross-detector test pins the shapes in all
  five places instead, so a drift fails the suite.
