# ADR-0031 — "RouteSpec Certified" badge and the static verify page

- Status: accepted
- Date: 2026-11-13
- Module: M49 (certified badge and verify page; depends on M47, ADR-0029)
- Goes beyond the sealed specification: yes, as ADR-0029 does. `docs/spec/` has no on-chain
  component, no badge and no public page. This ADR adds a read-only view of the M47 registry.
  Nothing in `docs/spec/` is edited and no existing claim changes meaning.

## Context

M47 lets an enrolled attester publish a signed certificate for an evidence bundle, and
`routespec certificate verify` checks it from a terminal. A reader of a project README, or a judge,
does not have the CLI installed. They need two things: a badge that shows the current state at a
glance, and a page that checks a certificate in their own browser without trusting the project's
server.

## Decision

1. **One status, computed one way.** `badgeStatus` (`packages/registry/src/badge.ts`) maps the
   digest-only release decision (`aggregateRelease` with `local: null` and
   `REQUIRE_ONCHAIN_ATTESTER`, exactly `certificate verify --digest`) to one of ten statuses:
   `CERTIFIED_PASS|FAIL|REVIEW|NOT_RUN` (an accepted certificate, showing the verdict the
   attester signed), `ATTESTER_REVOKED`, `ATTESTERS_DISAGREE`, `NO_CERTIFICATE`, `NOT_CERTIFIED`,
   `REGISTRY_CODE_UNKNOWN`, `UNVERIFIED`. "Certified" therefore means: at least one certificate for
   exactly this bundle digest, its Ed25519 signature checked locally, from an attester the registry
   reports enrolled and not revoked (and pinned, when keys are pinned), and no such attester
   disagreeing. A certified FAIL is shown as such, in red; it is never hidden or turned into
   "not certified".

2. **The verify page runs the CLI's logic, not a copy of it.** The aggregation moved, unchanged,
   to `release-core.ts`, which takes the signature check as a function. The field rules and payload
   text moved to `payload.ts`, the base58 and key text rules to `key-text.ts`, the view shapes to
   `views.ts`. None of these imports Node. The Node package checks signatures with `node:crypto`;
   the browser entry `@routespec/registry/browser` checks them with WebCrypto Ed25519 first and then
   calls the same `aggregateReleaseWith`. Tests assert that the browser module graph imports no Node
   built-in, that it signs and verifies the shared M47 vectors, and that its decision equals the
   Node decision in every case, then the near-sandbox suite compares the page in Chromium with the
   CLI against a real node. A browser without WebCrypto Ed25519 gets an explicit "cannot check"
   error, never "signature invalid".

3. **Static page, no server.** `apps/verify` is a Vite build of plain TypeScript, published to
   GitHub Pages. It computes the SHA-256 of a chosen bundle file in the browser (the file is never
   sent anywhere), or takes `?digest=` or `?project=` (the project's newest certificate). It reads
   the registry with view calls only (`final` finality) and shows the registry account, the chain id
   the node reports, the code hash, the owner, the block height, every certificate with its
   attester state and findings, and what the result does and does not prove. Everything is written
   with `textContent`. A meta CSP allows scripts and styles from the page origin only and network
   connections to https and loopback.

4. **The configuration is the trust root, a link is not.** `config.json` next to the page names,
   per network, the RPC endpoint, the registry account, pinned attester keys, and known registry
   code hashes; the Pages workflow writes it from repository variables. Rules for a link:
   - an RPC endpoint from a link is accepted only on a loopback host, because the endpoint is
     trusted for enrolment and revocation state;
   - another registry account is accepted but labelled as not the configured one (its owner decides
     who may attest);
   - attester keys from a link can only narrow the pinned set.

5. **Known registry code.** With known code hashes configured, a registry whose code hash is not
   among them is `REGISTRY_CODE_UNKNOWN`, never certified. The shipped configuration holds the
   reproducible build recorded in `docs/status/M47.md`; a test fails when the contract tree changes
   without that record and this list being updated.

6. **Badge JSON is generated, not served.** `routespec certificate badge` writes the shields.io
   "endpoint" JSON (only the keys shields accepts) for `--digest`, `--bundle` (digest only), or
   `--project-key` (newest certificate, from a pinned attester when pinned; looks back 200). The
   workflow `routespec-pages` runs it for each configured network with `--write-on-error`: a
   registry that cannot be read, is not a registry, or serves another network gives an
   "unverified" badge (`isError`), never a stale or invented one. It runs on push to `main`, after
   the certificate workflow, daily (so a revocation reaches the badge), and by hand; never on a pull
   request; it reads no secret; only its deploy job can write to Pages.

## Consequences and limits (recorded)

- The badge is as fresh as the last workflow run (at most a day, plus the shields cache of one
  hour). The page is always live.
- Digest only: neither the badge nor the page verifies the bundle contents. The page says so and
  points to `certificate verify --bundle`, which does.
- The RPC endpoint can hide certificates or misreport enrolment and revocation (no light client),
  as in ADR-0029. The badge inherits the trust of the endpoint named in the configuration.
- A project badge follows the newest certificate of the project. If the newest one is a FAIL or
  comes from a revoked attester, the badge says so; pin the attester key in the configuration to
  follow one attester only.
- GitHub Pages must be enabled (source: GitHub Actions). On a private repository that needs a plan
  that allows Pages for private repositories; otherwise the built `apps/verify/dist` can be served
  from any static host.

## Alternatives considered

- **A badge service that reads the chain on each request.** Rejected: it needs a running server
  and puts a third party between the reader and the chain. The page already reads the chain live.
- **A second, browser-only aggregation.** Rejected: two decision functions can drift; one function
  with an injected signature check cannot.
- **Accepting any RPC endpoint from a link.** Rejected: a link could then show "certified" for a
  key that only a dishonest endpoint reports as enrolled.
