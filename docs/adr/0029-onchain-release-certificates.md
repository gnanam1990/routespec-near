# ADR-0029 — On-chain release certificates and the attester registry

- Status: accepted
- Date: 2026-11-13
- Module: M47 (release certificates and attester registry)
- Goes beyond the sealed specification: yes. `docs/spec/` describes a local-first product with no
  on-chain component and says (bundle manifest) that "no signature is claimed until a signing ADR
  is accepted". This ADR is that decision for one narrow thing: a signed, public statement about
  an evidence bundle. Nothing in `docs/spec/` is edited and no existing claim changes meaning.

## Context

A RouteSpec evidence bundle is identified by the SHA-256 of its archive bytes and verifies
offline (`export verify`). What it could not do is answer, for someone who was not there: "did a
party I trust look at exactly this bundle and record its gate verdict, and has that party since
been withdrawn?" That needs a signature, a public place to look it up, and a way to revoke the
signer.

## Decision

1. **A registry contract on NEAR, `routespec-registry`, that holds no funds.**
   `contracts/routespec-registry` (near-sdk 5.30.1). It keeps owner-managed attester keys and an
   append-only log of certificates. It has no payable method, creates no promise and never
   transfers: the build script and the sandbox suite check that the wasm imports no `promise_*`
   or balance host function. Storage is paid from the registry account's own balance.

2. **What a certificate says.** One attester statement over
   `(registry account, project key, bundle digest, gate verdict, corpus digest, client artifact
digest, commit, timestamp)`. The exact signed bytes are a line-based UTF-8 payload with the
   domain line `routespec.certificate/1` (`contracts/routespec-registry/crates/routespec-certificate`).
   Every field has a closed character set, so a field cannot smuggle a line break or a second
   field. The registry account id is inside the payload, so a signature for one registry, or for
   testnet, is not valid for another registry or for mainnet. The Rust crate the contract uses and
   the TypeScript package the CLI uses are both checked against the same vector file.

3. **Who may write.** `publish(certificate, attester, signature)` may be called by any account.
   The authority is the Ed25519 signature: the contract accepts the certificate only when the key
   is enrolled and not revoked and `env::ed25519_verify` accepts the signature over the payload
   for exactly these fields. The submitting account only pays gas. This lets the owner, a CI job,
   or a relayer submit an envelope signed elsewhere, and keeps the attester key away from any
   NEAR account key.

4. **Append-only, one statement per attester and bundle.** Certificates are never updated or
   deleted. An attester can publish at most one certificate for a bundle digest (a second one,
   with the same or a different verdict, is refused), and a bundle can hold at most eight
   certificates. The signed timestamp must be within ten minutes ahead of and thirty days behind
   the block time.

5. **Enrolment and revocation.** Only the owner account enrols (`enrol_attester`) and revokes
   (`revoke_attester`). At most 64 keys. Revocation is permanent: a revoked key cannot publish
   and cannot be enrolled again. Its earlier certificates stay in the log; views report the
   attester's current state next to each certificate, with the block height and time of both
   events, so a reader can see that a certificate predates the revocation and still decide not
   to trust it.

6. **Initialisation.** `new(owner_id)` is `#[init]` and `#[private]`: only the contract account
   can initialise, in the deploy transaction, and only once.

7. **Gate evaluation stays networkless; the on-chain requirement is a release-level step.** A
   certificate attests the bundle of a finished gate evaluation, so the evaluation cannot depend
   on its own certificate. `aggregateRelease` (`packages/registry/src/release.ts`) is the pure
   function after it: local decision from the verified bundle, certificates and attester states
   from the registry, and a policy.
   - `REQUIRE_ONCHAIN_ATTESTER`: a local PASS stays PASS only with at least one certificate for
     exactly this bundle from an attester that is enrolled, not revoked, and (when keys are
     pinned) trusted, and only if no such attester disagrees. Otherwise REVIEW.
   - `ADVISORY`: the local decision is kept and the findings say what the registry holds.
   - A local FAIL, REVIEW, or NOT_RUN is never upgraded by anything on chain.
     `routespec certificate verify` applies it (default policy `require-onchain-attester`) and
     exits 0 only for PASS. `gate run` and `gate evaluate` are unchanged and contact nothing.

8. **CLI.** `routespec certificate keygen|publish|verify|revoke-check`. `publish` verifies the
   bundle first, refuses a bundle that is not release evidence, reads the corpus digest and the
   commit from the journal the bundle came from (or takes them as flags that must not contradict
   it), signs, and either writes the envelope (`--out`, which is exactly the JSON argument of the
   contract's `publish`) or submits it (`--submit`). These are the only RouteSpec commands that
   contact a network, and only a NEAR JSON-RPC endpoint the operator names: `https`, or `http`
   for a loopback sandbox; no redirects; bounded response size and time. With `--network` the
   endpoint's chain id is checked. `--code-hash` refuses a registry account that runs other code.

9. **No NEAR SDK dependency.** The CLI needs four RPC calls and one transaction shape. A minimal
   client (`packages/registry/src/near.ts`: Borsh transaction encoding, Ed25519 from
   `node:crypto`, built-in `fetch`) adds no third-party package. The near-sandbox suite sends its
   bytes to a real node.

10. **CI: a separate step in a separate workflow.** ADR-0015 keeps every pull-request workflow
    free of secrets, and that stays true. `.github/workflows/routespec-certificate.yml` runs on
    push to `main` and by hand only; its gate step receives no secret, and only its last step
    (`.github/actions/routespec-certificate`) receives the attester key and the NEAR account key.
    The gate step additionally withholds `ROUTESPEC_ATTESTER_KEY` and `ROUTESPEC_NEAR_SIGNER_KEY`
    like any other credential (ADR-0025), so a workflow that exposes them to the whole job still
    cannot leak them to the client module's environment. The certificate step publishes only when
    the decision is PASS, the job is trusted (read from the runner environment, not from an
    input), and all three signer values are set; it reads the decision again from the verified
    bundle; it is idempotent on a rerun. With no signer configured it reports
    `SKIPPED_NO_SIGNER` and exits 0.

11. **Reproducible wasm.** `pnpm run registry:reproduce` builds the contract in
    `node:22-bookworm-slim` pinned by digest, with Rust 1.97.1 from a rustup-init binary pinned by
    SHA-256 and the locked dependencies, from a clean clone of a commit. The digest of that build
    is the deployable artifact; `docs/status/M47.md` records it.

## Consequences and limits (recorded)

- **Trust roots.** A certificate is as trustworthy as (a) the attester's key handling, (b) the
  owner account, which can enrol any key, and (c) whoever holds a full-access key of the registry
  account, who can replace the contract code. A verifier who wants less should pin attester keys
  (`--attester`) and the code hash (`--code-hash`). There is no owner transfer method and no
  upgrade method; both are redeployment decisions of the account holder.
- **What a certificate does not prove.** It proves that an enrolled key signed these values. It
  does not prove that the gate was run honestly, that the build is the one the commit produces,
  or that a repository blocks releases on it. Build identity stays `USER_ASSERTED_LOCAL` unless
  attested by the existing launcher mechanism, and enforcement stays unverified (ADR-0012,
  ADR-0015). The corpus digest and the commit are attested values: the bundle does not carry
  them, so `certificate verify` cannot recompute them from the bundle alone.
- **RPC trust.** Signatures are verified locally, so an endpoint cannot invent a certificate for
  a pinned key. It can hide certificates or misreport enrolment and revocation; there is no light
  client. Use an endpoint you trust and the default `final` finality.
- **Revocation is not retroactive on chain.** The log keeps what a later-revoked key published.
  `certificate verify` does not accept such a certificate; another verifier may choose
  otherwise from the recorded block heights.
- **Storage.** Each certificate costs the registry account storage (a few hundred bytes). Only
  enrolled attesters can cause writes; a misbehaving attester is revoked. The account needs a
  small NEAR balance for storage and holds nothing else. NEAR lets anyone send tokens to any
  account with a plain transfer; the contract cannot refuse that and has no method to spend it.
- **Public data.** A certificate publishes the project key, digests, verdict, and commit id.
  Choose a project key you are willing to publish.
- **Audits.** A lighter audit than for a contract with funds is planned as a later stage; see
  `docs/status/M47.md` for the self-review done here and what is NOT_RUN.

## Alternatives considered

- **Signing inside the bundle only.** Rejected: no public lookup and no revocation.
- **Only allow the attester's NEAR account to publish (account-based authority).** Rejected: it
  ties the attester to one account key that must be online in CI and cannot be relayed. A
  detached Ed25519 signature can be produced offline and submitted by anyone.
- **Make gate aggregation itself read the chain.** Rejected: the gate is networkless by design
  (the gate CLI runs only the networkless SIMULATE and REPLAY modes, ADR-0012) and a decision cannot depend on a certificate about itself.
- **`near-api-js`.** Rejected for the dependency weight against four RPC calls.
