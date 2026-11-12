# Review kit: independent review of the canary interceptor profile

For: a reviewer who is **not** the RouteSpec operator, and the operator (repository owner) who
records the review. Read the whole kit before starting; it is self-contained.

What this closes: the last RouteSpec-side gap for `WORKING_LOCAL` on RP-02 and RP-06
(`docs/spec/REAL-PRODUCT-GATE.md`). Today the canary interceptor profile is `REVIEWED` only
through a key the operator generated for tests (`BUILD-STATUS.md`, "Interceptor profile review").
The workflow itself is real and enforced (M16, `docs/adr/0021-release-evidence-and-profile-review.md`,
`docs/status/M16.md`): INV-04 needs an effective signed review recorded **before** a case's
input closes, and captures are refused as release evidence without one.

RouteSpec cannot tell whether two keys belong to two people. Independence is something the
reviewer and the operator establish between themselves; the records only prove that a key that
is not a launcher key signed an exact statement.

The commands below were run against the M16 service and CLI while this kit was written (a
scratch data directory, loopback service, real Ed25519 keys, real signature). Shell examples are
POSIX `sh` (Linux, macOS, Git Bash on Windows).

## 1. Roles and what each side holds

| Role     | Holds                                                                                                  | Never holds                                      |
| -------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Reviewer | their own Ed25519 private key (`reviewer.pem`); a checkout of the same commit; `challenge.json`        | the control token, the launcher key, local codes |
| Operator | the control token, local confirmation codes, the launcher key, the data directory, the running service | the reviewer's private key                       |

The reviewer sends the operator exactly two things: the public key value `x` (step 3) and a
signature (step 6). Nothing else crosses between them. Neither value is secret.

## 2. Operator: prepare a contained data directory

Use the contained delivery journey so the project, builds, launcher principal, interceptor
profile, corpus, and gate already exist (engine configured as in
`docs/runbooks/container-containment.md`):

```sh
export ROUTESPEC_CONTAINER_CLI='["docker"]'   # or the WSL 2 form from the containment runbook
node --no-warnings packages/delivery/src/journey.ts --work <work> --out <work>/journey.json --contained --no-ui
```

Then start the service on the same data directory, in its own interactive terminal, with the
same containment settings the journey used (subject root = the checkout, launcher key written by
the journey):

```sh
node --no-warnings packages/control-api/src/main.ts --data <work>/data --handoff stderr \
  --subject-root <checkout> \
  --container-cli '["docker"]' --container-image node:22-bookworm-slim \
  --launcher packages/containment/src/attesting-launcher.ts \
  --launcher-key <work>/launcher/launcher-key.pem
```

stdout prints one JSON line with the origin. stderr (the operator channel) prints the console
URL, whose `#token=` fragment is the control token, and later every local confirmation code. Do
not paste either into tickets, chats, or recordings.

Timing: the journey enrolls its launcher principal for 24 hours with a 6-hour attestation
freshness window. Do the review and the gate run of step 8 within that window, or start again
from a fresh journey directory.

A small helper for the operator's terminal (the token is read from your own terminal output;
use a fresh `Idempotency-Key` for every mutation, including the second call of a confirmation):

```sh
TOKEN='<value after #token= in the console URL>'
B=http://127.0.0.1:<port>/__routespec/v1
api() { curl -s -X "$1" "$B$2" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: review-$(date +%s)-$RANDOM" ${3:+--data-binary "$3"}; echo; }
```

Find the identifiers:

```sh
api GET /projects                                     # projectId
api GET /projects/<projectId>/interceptor-profiles    # profileId, profileDigest, interceptorArtifactDigest, reviewState
api GET /projects/<projectId>/profile-reviewers       # the journey's "local test reviewer (not independent)"
```

Revoke the journey's test reviewer so that only the independent review can make the profile
`REVIEWED`. The first call returns `202 LOCAL_CONFIRMATION_REQUIRED`; the code appears on the
service's stderr as `local confirmation for PROFILE_REVIEWER_REVOKE ...: id=<id> code=<code>`.

```sh
api POST /profile-reviewers/<testReviewerId>/revoke '{"reasonCode":"REVIEWER_RETIRED"}'
api POST /profile-reviewers/<testReviewerId>/revoke \
  '{"reasonCode":"REVIEWER_RETIRED","confirmation":{"confirmationId":"<id>","code":"<code>"}}'
api GET /interceptor-profiles/<profileId>             # reviewState is now REVIEW_REVOKED
```

Allowed `reasonCode` values: `KEY_COMPROMISED`, `REVIEWER_RETIRED`, `OPERATOR_REQUEST`.
Confirmation codes expire after about two minutes.

Send the reviewer: the repository commit SHA, `profileDigest`, and the full profile as returned
by `GET /interceptor-profiles/<profileId>`.

## 3. Reviewer: create your key, on your own machine

With OpenSSL:

```sh
openssl genpkey -algorithm ed25519 -out reviewer.pem
openssl pkey -in reviewer.pem -pubout -outform DER | tail -c 32 | basenc --base64url | tr -d '='
```

Or with Node.js only (no OpenSSL or `basenc` needed):

```sh
node -e "const k=require('node:crypto').generateKeyPairSync('ed25519');require('node:fs').writeFileSync('reviewer.pem',k.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600})"
node -e "console.log(require('node:crypto').createPublicKey(require('node:fs').readFileSync('reviewer.pem')).export({format:'jwk'}).x)"
```

The printed value is 43 base64url characters. Send only that `x` value. Keep `reviewer.pem`
offline and owner-only; RouteSpec never needs it.

## 4. Operator: enroll the reviewer key (local confirmation)

```sh
NOW=$(node -e "console.log(Date.now())"); UNTIL=$((NOW + 30*24*3600*1000))
BODY='{"projectId":"<projectId>","label":"independent reviewer (<role>)","publicKeyJwk":{"kty":"OKP","crv":"Ed25519","x":"<x>"},"validFromMs":'$NOW',"validUntilMs":'$UNTIL
api POST /profile-reviewers "$BODY}"                                    # 202, code on stderr
api POST /profile-reviewers "$BODY,\"confirmation\":{\"confirmationId\":\"<id>\",\"code\":\"<code>\"}}"
```

The second call returns `201` with `reviewerId`, `keyDigest`, `kind: LOCAL_REVIEWER_KEY`, and
`independentOfLaunchers: true`. A key that is enrolled as a launcher key anywhere is refused
with `409 RS_REVIEWER_NOT_INDEPENDENT`. Send the reviewer the `keyDigest` so they can check it
against their own key in step 6.

## 5. Operator: request a challenge

The reviewer decides `APPROVED` or `REJECTED` first (after step 6's checks, or provisionally);
the decision and checklist are part of the signed statement, so a change of mind needs a new
challenge.

```sh
api POST /interceptor-profiles/<profileId>/review-challenges '{"reviewerId":"<reviewerId>","decision":"APPROVED","checklist":{"ARTIFACT_DIGEST_VERIFIED":true,"PROCESS_TREE_SCOPE_CONFINES_SUBJECT":true,"SUPPORTED_SINKS_COMPLETE":true,"DENIAL_MECHANISM_HAS_NO_EFFECT":true,"PRIVATE_CHANNEL_ISOLATED_FROM_SUBJECT":true}}' > challenge.json
```

The checklist must contain exactly those five items. An `APPROVED` review needs all five
`true` and is refused for a `DECLARED_HOOKS_ONLY` profile (`RS_PROFILE_REVIEW_INVALID`). A
`REJECTED` review records the items the reviewer could not confirm as `false`. The challenge is
single use and expires five minutes after issue (`expiresAt`), so request it when the reviewer is
ready to sign, and hand `challenge.json` over at once. It contains no secret.

## 6. Reviewer: inspect, check, and sign

### 6.1 Check that the statement names what you were shown

Open `challenge.json`. `statement` must name:

- `domain: routespec.interceptor-profile-review/1`;
- the `projectId`, `profileId`, and `profileDigest` the operator sent;
- `profile.interceptorArtifactDigest`, `containment: PROCESS_TREE_ENFORCED`,
  `processTreeScope`, `supportedSinks`, and `denialMechanism` exactly as in the profile you read;
- your `reviewerKeyDigest` (the `keyDigest` from step 4), the `decision`, and the checklist you
  agreed to.

`signingPayload` is the base64url form of exactly the bytes you will sign
(`routespec.interceptor-profile-review/1\n` followed by the canonical JSON of the statement).
Decode it to read it: `node -e "console.log(Buffer.from(require('./challenge.json').signingPayload,'base64url').toString())"`.

### 6.2 Recompute the artifact digest from your own checkout

Check out the commit the operator named, then, from the repository root:

```sh
node --no-warnings --input-type=module -e "import {interceptorArtifactDigest} from './packages/containment/src/identity.ts'; console.log(interceptorArtifactDigest('packages/proxy/src/interceptor/canary-interceptor.ts'))"
```

The output must equal `profile.interceptorArtifactDigest` in the statement. If it does not, stop:
the profile does not describe the code you reviewed.

### 6.3 Review the code against each checklist item

| Checklist item                          | What to read                                                                                                                                   | What must hold                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ARTIFACT_DIGEST_VERIFIED`              | 6.2; `packages/containment/src/identity.ts`                                                                                                    | the digest you computed matches the statement; the digest domain covers the whole interceptor source                                                                                                                                                                                                                   |
| `PROCESS_TREE_SCOPE_CONFINES_SUBJECT`   | `packages/containment/src/sandbox.ts`, `runtime.ts`, `verify.ts`, `shim.mjs`; ADR-0019 and ADR-0020                                            | every flag named in `processTreeScope` (no network, read-only root, all capabilities dropped, no new privileges, init) is actually applied and verified from the engine, a missing seccomp filter downgrades to `DECLARED_HOOKS_ONLY`, and the subject cannot reach any RouteSpec listener except its own proxy tunnel |
| `SUPPORTED_SINKS_COMPLETE`              | `packages/proxy/src/interceptor/canary-interceptor.ts`; the effect manifest the journey registers (`packages/delivery/src/journey.ts`, `SINK`) | every sink in `supportedSinks` is intercepted outside the subject process; no declared protected effect can leave through a path the interceptor does not see                                                                                                                                                          |
| `DENIAL_MECHANISM_HAS_NO_EFFECT`        | `canary-interceptor.ts`                                                                                                                        | `CANARY_REDIRECT` sends the effect only to a local no-effect canary; nothing is forwarded to a real email, webhook, file, process, queue, or API target                                                                                                                                                                |
| `PRIVATE_CHANNEL_ISOLATED_FROM_SUBJECT` | `packages/proxy/src/interceptor-channel.ts`, `packages/control-api/src/containment-host.ts`, `packages/kernel/src/invariants/inv04.ts`         | boundary observations arrive only over the inherited private channel; the subject's case token or the control token cannot write them; INV-04 rejects subject-written sources                                                                                                                                          |

Useful evidence to read rather than rerun: `packages/containment/runtime-test/`,
`packages/control-api/runtime-test/m14-contained-case.runtime.test.ts`,
`packages/security-suite/runtime-test/t036-container-host-access.runtime.test.ts`,
`packages/proxy/test/interceptor-channel.test.ts`, `packages/kernel/test/t004-protected-effect.test.ts`.
If you have a container engine you may run `pnpm run test:containment` yourself (it reports
`NOT_RUN` without an engine, which is not a pass).

Write your findings down (template in section 10) whether you approve or not.

### 6.4 Sign offline

The signing command opens no data directory and sends nothing anywhere:

```sh
node --no-warnings packages/cli/src/main.ts profile review-sign --challenge challenge.json --key reviewer.pem
```

On success (exit 0) stdout is one JSON object with `challengeId`, `statementDigest`,
`decision`, `profileDigest`, and `signature` (86 base64url characters). A key other than the one
the statement names is refused with `RS_IDENTITY_MISMATCH` (exit 4) and nothing is signed. Send
the operator the `signature` value. The command has no `--help`; its only flags are
`--challenge` and `--key`.

You may sign `signingPayload` with your own Ed25519 tooling instead (pure Ed25519, no prehash).

## 7. Operator: record the review

```sh
api POST /profile-review-challenges/<challengeId>/complete '{"signature":"<signature>"}'
```

`201` returns `reviewId`, `reviewDigest`, `decision`, `reviewedAt`, and the profile with
`reviewState: REVIEWED` and `effectiveReviewId` (for an approval). Submitting the same challenge
again is refused with `422 RS_PROFILE_REVIEW_INVALID`. While the service runs, check with
`api GET /interceptor-profiles/<profileId>`. The CLI reads the data directory directly and
needs the journal writer lock, so it works only while the service is stopped (otherwise exit 5,
`RS_WRITER_LOCKED`):

```sh
node --no-warnings packages/cli/src/main.ts profile review-status --data <work>/data \
  --project <projectId> --profile <profileDigest>
```

It reports `reviewState`, `effectiveReviewId`, every review record, and
`independentHumanReview: NOT_ESTABLISHED_BY_RECORDS` (records alone never prove independence).

A rejection: an effective `REJECTED` review wins over any approval, so the profile stays out of
`REVIEWED` until the review is revoked (`POST /interceptor-profile-reviews/<reviewId>/revoke`,
reason `PROFILE_DEFECT_FOUND`, `REVIEW_IN_ERROR`, or `OPERATOR_REQUEST`, with local
confirmation) after the defect is fixed and a new profile is reviewed.

## 8. Operator: a contained gate run that rests on this review

A review counts for a case only if it was recorded before that case's input closed. The journey's
own cases ran under the revoked test review, so run new cases now, in the same data directory,
through the running service. The delivery journey has no mode that waits for an external
signature, so this is a manual API run; `packages/delivery/src/journey.ts` (gate-run creation
and `runContainedCase`) is the reference implementation of the same calls:

1. `POST /gate-runs` for the corrected build on the promoted corpus, with the same build,
   artifact, manifest, policy (`casePolicies` per scenario), `interceptorProfileDigest`, and
   `buildAttestation: {"subjectAttestationId": ...}` the journey used (read them from
   `<work>/journey.json` or the list routes). Then `POST /gate-runs/{id}/validate` and
   `POST /gate-runs/{id}/start`, each with `If-Match: "<revision>"`.
2. For each case from `GET /gate-runs/{id}/cases`: `POST /case-runs/{id}/contained-start` with
   the launcher `attesterPrincipalId` and the job, poll `GET /case-runs/{id}/containment` until
   the job is no longer `RUNNING`, then `POST /case-runs/{id}/finish-input`.
3. `POST /gates/{gateId}/evaluate` with `{"gateRunId": ...}`.

Check, and write down:

- every case: containment `PROCESS_TREE_ENFORCED`, build attestation `TRUSTED_LAUNCHER`,
  INV-04 PASS with the independent `effectiveReviewId` (`GET /run-operations/{id}`);
- the decision PASS for the corrected build (the baseline build stays REVIEW/FAIL, see
  `BUILD-STATUS.md`);
- for a new capture of the baseline failure, `GET /imports/{id}/release-evidence` shows release
  evidence with no refusal reasons;
- a release-evidence export (`POST /exports` with `gateEvaluationId` and
  `evidenceUse: RELEASE_EVIDENCE`, then `POST /exports/{exportId}/write` with `outPath` and
  `confirm` set to the plan's `planDigest`) verifies offline:
  `node --no-warnings packages/cli/src/main.ts export verify --bundle <bundle> --extract-to <empty dir>`
  with `profile-review-signatures` among the passing checks and your review in
  `evidence/release-evidence.json`.

## 9. Operator: close out

1. Rerun the suites on the same commit, engine configured:

   ```sh
   pnpm run check
   pnpm run test:containment
   pnpm run test:delivery
   ```

   `test:delivery` clones the committed HEAD and runs both journeys (they still use their own
   test reviewer; that is expected and is why step 8 exists).

2. Record in `docs/status/M16.md`, section "Independent profile review": the reviewer's role
   (not private details), `reviewerId`, `keyDigest`, `reviewId`, `reviewDigest`,
   `statementDigest`, the reviewed `interceptorArtifactDigest` and commit, the decision, the
   findings, and the step 8 gate run ids, decision, and bundle verification.
3. Update the RP-02 and RP-06 rows of `BUILD-STATUS.md`. Reconsider `WORKING_LOCAL` only when RP-05
   (a green clean-checkout run on a real CI service) is also met; this review alone does not
   reach it.

## 10. Findings template (reviewer)

```text
Interceptor profile review — RouteSpec
Reviewer role / organisation:        <role, not private details>
Independent of the operator:         <how: different person, own machine, own key>
Commit reviewed:                     <sha>
profileDigest:                       sha256:...
interceptorArtifactDigest (own run): sha256:...   matches statement: yes/no
Reviewer keyDigest:                  sha256:...
Decision:                            APPROVED | REJECTED
Checklist:
  ARTIFACT_DIGEST_VERIFIED              yes/no  notes:
  PROCESS_TREE_SCOPE_CONFINES_SUBJECT   yes/no  notes:
  SUPPORTED_SINKS_COMPLETE              yes/no  notes:
  DENIAL_MECHANISM_HAS_NO_EFFECT        yes/no  notes:
  PRIVATE_CHANNEL_ISOLATED_FROM_SUBJECT yes/no  notes:
Findings (id, severity, file:line, description, suggested fix):
Out of scope / not checked:
statementDigest signed:              sha256:...
Date:
```
