# routespec-registry

The RouteSpec release-certificate registry for NEAR (M47). Decisions and limits:
`docs/adr/0029-onchain-release-certificates.md`. How to deploy and use it:
`docs/runbooks/release-certificates.md`.

- `crates/routespec-certificate`: field rules and the exact bytes an attester signs. No
  dependencies. Host tests run against `vectors/certificate-v1.json`, the same file the
  TypeScript package checks.
- `crates/routespec-registry`: the contract (near-sdk 5.30.1). Owner-managed attester keys, a
  signature-gated append-only certificate log, views by id, by bundle digest and by project. No
  payable method, no promise, no transfer.

| Method                                                    | Who          | What                                                       |
| --------------------------------------------------------- | ------------ | ---------------------------------------------------------- |
| `new(owner_id)`                                           | the contract | one-time initialisation, in the deploy transaction         |
| `enrol_attester(public_key, label)`                       | owner        | enrol an Ed25519 key (at most 64, never twice, never weak) |
| `revoke_attester(public_key, reason)`                     | owner        | revoke a key, permanently                                  |
| `publish(certificate, attester, signature)`               | anyone       | append a certificate signed by an enrolled attester        |
| `get_info()`                                              | view         | contract name, version, payload domain, owner, counts      |
| `get_attester(public_key)`, `list_attesters(from, limit)` | view         | attester state with enrolment and revocation blocks        |
| `get_certificate(id)`                                     | view         | one certificate by its position in the log                 |
| `get_certificates_by_bundle(bundle_digest)`               | view         | every certificate for a bundle (at most one per attester)  |
| `get_certificates_by_project(project, from, limit)`       | view         | a project's certificates in publication order              |
| `get_project_certificate_count(project)`                  | view         | how many certificates a project has                        |

Refusals are panics with a stable code: `RSREG_NOT_OWNER`, `RSREG_KEY_NOT_ED25519`, `RSREG_KEY_WEAK`,
`RSREG_ATTESTER_EXISTS`, `RSREG_ATTESTER_LIMIT`, `RSREG_ATTESTER_UNKNOWN`,
`RSREG_ATTESTER_REVOKED`, `RSREG_ALREADY_REVOKED`, `RSREG_SIGNATURE_INVALID`,
`RSREG_ALREADY_PUBLISHED`, `RSREG_BUNDLE_CERTIFICATE_LIMIT`, `RSREG_TIMESTAMP_FUTURE`,
`RSREG_TIMESTAMP_STALE`, and `RSREG_FIELD_INVALID:<field>`.

Commands, from the repository root:

```sh
pnpm run registry:test        # host tests of the certificate crate
pnpm run registry:build       # wasm for this host (digest depends on the host)
pnpm run registry:reproduce   # the deployable wasm, built in a pinned container
pnpm run test:registry        # the contract on a local near-sandbox node
```
