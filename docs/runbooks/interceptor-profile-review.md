# Runbook — reviewing an interceptor profile (M16)

An interceptor profile becomes `REVIEWED` only through a signed review by an enrolled reviewer
whose key is not a launcher key. Without an effective review, complete-effect coverage (INV-04)
stays REVIEW and captures are refused as release evidence. The steps below are for a real,
independent reviewer; RouteSpec's own tests use a locally generated test key and do not count as
an independent review.

## Roles

- **Operator:** holds the control token and the launcher key; runs the service; submits the
  reviewer's signature. Cannot create a review without the reviewer's private key.
- **Reviewer:** someone other than the operator. Holds an Ed25519 private key that never enters
  RouteSpec. Reads the profile and the interceptor artifact, then signs or declines.

## 1. The reviewer creates a key (on their own machine)

```sh
openssl genpkey -algorithm ed25519 -out reviewer.pem
openssl pkey -in reviewer.pem -pubout -outform DER | tail -c 32 | basenc --base64url | tr -d '='
```

The second command prints the 43-character public key `x`. Send only that value to the operator.

## 2. The operator enrolls the reviewer (local confirmation)

`POST /__routespec/v1/profile-reviewers` with
`{"projectId": "...", "label": "...", "publicKeyJwk": {"kty": "OKP", "crv": "Ed25519", "x": "..."}, "validFromMs": ..., "validUntilMs": ...}`.
The first call returns `202 LOCAL_CONFIRMATION_REQUIRED`; repeat it with the `confirmation`
code delivered on the local operator channel. A launcher key is refused with
`RS_REVIEWER_NOT_INDEPENDENT`.

## 3. The operator requests a challenge

`GET /__routespec/v1/projects/{projectId}/interceptor-profiles` lists profiles with their
`reviewState`. Then `POST /__routespec/v1/interceptor-profiles/{profileId}/review-challenges`
with `{"reviewerId": "...", "decision": "APPROVED", "checklist": {...}}`. The checklist must
answer exactly `ARTIFACT_DIGEST_VERIFIED`, `PROCESS_TREE_SCOPE_CONFINES_SUBJECT`,
`SUPPORTED_SINKS_COMPLETE`, `DENIAL_MECHANISM_HAS_NO_EFFECT`, and
`PRIVATE_CHANNEL_ISOLATED_FROM_SUBJECT`; an approval needs every item `true`. Save the response
as `challenge.json` and give it to the reviewer. It expires after the challenge TTL.

## 4. The reviewer checks and signs

The statement in `challenge.json` names the exact profile fields and the interceptor artifact
digest. Compare them with the reviewed artifact (`packages/proxy/src/interceptor/` and
`packages/containment/`), then sign:

```sh
node packages/cli/src/main.ts profile review-sign --challenge challenge.json --key reviewer.pem
```

The command refuses a key that is not the one the statement names and prints only the
signature. A reviewer who does not approve requests a `REJECTED` challenge instead; an effective
rejection keeps the profile out of `REVIEWED`.

## 5. The operator records the review

`POST /__routespec/v1/profile-review-challenges/{challengeId}/complete` with
`{"signature": "..."}`. The service verifies the signature and records one immutable review.
`node packages/cli/src/main.ts profile review-status --data <dir> --project ... --profile ...`
then reports `REVIEWED`. Run gate cases only after this: a review recorded after a case's input
closed does not change that case.

## 6. Revoking

`POST /__routespec/v1/interceptor-profile-reviews/{reviewId}/revoke` or
`POST /__routespec/v1/profile-reviewers/{reviewerId}/revoke`, each with a reason code and a local
confirmation. The records stay; new evaluations and promotions treat the profile as not
reviewed.

## 7. Record the result

Write down who reviewed, the review id and digest, the artifact digest reviewed, and any
findings in `docs/status/M16.md` (section "Independent profile review"). Until that happens the
independent review is `NOT_RUN`.
