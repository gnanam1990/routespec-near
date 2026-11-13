# @routespec/registry

Owner module: M47. Status: **VERIFIED_BOUNDED** on win32/x64 with a local near-sandbox node in a
Linux container (see `docs/status/M47.md`). Nothing here has been run against NEAR testnet or
mainnet by the build; deployment and publication are owner actions
(`docs/runbooks/release-certificates.md`). Decisions: `docs/adr/0028-onchain-release-certificates.md`.

What it holds:

- `certificate.ts`: the certificate fields, the exact signing payload (`routespec.certificate/1`),
  the signed envelope, and offline verification. The TypeScript twin of the Rust crate the
  contract uses; both are checked against `contracts/routespec-registry/vectors/certificate-v1.json`.
- `keys.ts`: Ed25519 with `node:crypto`, base58, the `ed25519:` text form, and the accepted
  secret formats (PKCS#8 PEM, NEAR `ed25519:<base58>`, NEAR credentials JSON).
- `near.ts`: a minimal NEAR JSON-RPC client (views, access keys, Borsh transactions). `https`
  only, or `http` for a loopback sandbox.
- `registry-client.ts`: typed calls and views of the `routespec-registry` contract; every view
  result is validated against a closed shape.
- `release.ts`: `aggregateRelease`, the pure release aggregation over a local gate decision and
  the certificates and attester states read from the registry.
- `sandbox.ts` (entry `@routespec/registry/sandbox`): the near-sandbox harness for the suites.
  Test support only.

Tests: `pnpm exec vitest run packages/registry` (unit, no chain) and `pnpm run test:registry`
(the contract on a real local node; needs `ROUTESPEC_CONTAINER_CLI`).
