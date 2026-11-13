# Runbook: on-chain release certificates (M47)

A release certificate is a signed, public record that an attester you enrolled looked at one
evidence bundle and recorded its gate verdict. It lives in the `routespec-registry` contract on
NEAR. This runbook covers building the contract, deploying it, enrolling an attester, publishing
a certificate, verifying one, and revoking a key.

Decisions and limits: `docs/adr/0029-onchain-release-certificates.md`. Evidence:
`docs/status/M47.md`.

Words used here:

- **Registry**: the NEAR account that runs the contract, for example
  `gnanam1990-routespec.testnet`.
- **Owner**: the NEAR account that may enrol and revoke attester keys. In the commands below it
  is the registry account itself.
- **Attester key**: an Ed25519 key pair that signs certificates. It is not a NEAR account key
  and never needs NEAR tokens.
- **Bundle digest**: the SHA-256 of the evidence bundle file. It is how a certificate names a
  bundle.

The contract holds no funds and has no payable method. The registry account only needs a
balance that covers its own storage: about 2.4 NEAR for the contract code (236 KB at 1 NEAR per
100 KB) plus well under 0.01 NEAR per certificate. A testnet account created through the faucet
starts with enough. On mainnet fund it with about 4 NEAR.

Every on-chain step below is yours: RouteSpec's build and tests only ever used a local sandbox
node. Commands are for PowerShell with NEAR CLI (`near.cmd`, near-cli-rs) and are written for
testnet. For mainnet replace `testnet` with `mainnet` and the account names with yours.

## 1. Build the deployable wasm

The deployable artifact is the container build, because its digest does not depend on your
machine. It needs a container engine (see `docs/runbooks/container-containment.md`).

```powershell
$env:ROUTESPEC_CONTAINER_CLI = '["wsl.exe","-d","Ubuntu-24.04","-u","root","--exec","docker"]'
pnpm run registry:reproduce
```

It writes `.data/registry/repro/routespec_registry.wasm` and `build-manifest.json` and prints the
SHA-256 and the NEAR code hash. Compare both with `docs/status/M47.md`. To check a digest you
were given, add `-- --expect <sha256>`.

## 2. Create the registry account and deploy

```powershell
near.cmd account create-account sponsor-by-faucet-service gnanam1990-routespec.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
```

```powershell
Set-Content -Encoding ascii .data\registry\init.json '{"owner_id":"gnanam1990-routespec.testnet"}'; near.cmd contract deploy gnanam1990-routespec.testnet use-file .data\registry\repro\routespec_registry.wasm with-init-call new file-args .data\registry\init.json prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
```

Deploying and initialising in one transaction matters: `new` can only be called by the contract
account itself and only once.

Check what is deployed:

```powershell
near.cmd contract call-function as-read-only gnanam1990-routespec.testnet get_info json-args '{}' network-config testnet now
```

It must report `contract: routespec-registry`, your owner account, zero attesters, and zero
certificates.

## 3. Create an attester key and enrol it

```powershell
node --no-warnings packages/cli/bin/routespec.mjs certificate keygen --out .data\registry\attester-key.pem
```

This prints the public key (`ed25519:...`) and nothing else. Keep the file private; it is in
`.data/`, which git ignores. Enrol the public key (replace `<PUBLIC KEY>`):

```powershell
Set-Content -Encoding ascii .data\registry\enrol.json '{"public_key":"<PUBLIC KEY>","label":"release attester"}'; near.cmd contract call-function as-transaction gnanam1990-routespec.testnet enrol_attester file-args .data\registry\enrol.json prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as gnanam1990-routespec.testnet network-config testnet sign-with-keychain send
```

## 4. Publish the certificate of a bundle

Only a bundle that verifies and is release evidence can be certified. The contained journey
produces one (`docs/runbooks/container-containment.md`):

```powershell
pnpm run delivery:journey -- --work .data/demo-contained --out .data/journey-contained.json --no-ui --contained
```

Sign its certificate. This contacts nothing and writes the signed envelope:

```powershell
node --no-warnings packages/cli/bin/routespec.mjs certificate publish --data .data\demo-contained\data --bundle .data\demo-contained\out\routespec-corrected-release.tar --project-key gnanam1990/routespec-near --registry gnanam1990-routespec.testnet --attester-key .data\registry\attester-key.pem --expect-verdict PASS --out .data\registry\certificate.json
```

Submit the envelope yourself. Any account may submit it; the signature is what the contract
checks:

```powershell
near.cmd contract call-function as-transaction gnanam1990-routespec.testnet publish file-args .data\registry\certificate.json prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as gnanam1990-routespec.testnet network-config testnet sign-with-keychain send
```

The transaction returns the certificate id (0 for the first one). A signed envelope must be
submitted within thirty days of signing.

Alternative: let the CLI submit. Add `--submit --network testnet --near-account <account>
--near-key <NEAR credentials file>` to the `certificate publish` command instead of `--out`. The
CLI then needs a key of that NEAR account, which is why the two-step form above is the default
in this runbook.

## 5. Verify

Anyone with the bundle file, on any machine, with no journal:

```powershell
node --no-warnings packages/cli/bin/routespec.mjs certificate verify --bundle .data\demo-contained\out\routespec-corrected-release.tar --registry gnanam1990-routespec.testnet --network testnet --attester <PUBLIC KEY>
```

Exit code 0 and `release.decision: PASS` mean: the bundle verifies locally, its decision is
PASS, and the registry holds a certificate for exactly this bundle, signed by that key, which is
enrolled and not revoked. Exit 2 is a FAIL decision. Exit 3 is anything else (no certificate,
revoked or unknown attester, a mismatch); `release.findings` says which.

Useful options:

| Option                  | Effect                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `--digest sha256:<hex>` | check by digest alone, without the bundle (the result says so)                         |
| `--attester <key>`      | accept only this attester key (repeat for several); without it any enrolled key counts |
| `--project-key <key>`   | the certificate must name this project                                                 |
| `--code-hash <base58>`  | refuse a registry account that runs different code                                     |
| `--policy advisory`     | keep the local decision and only report what the registry holds                        |
| `--rpc <https url>`     | use your own RPC endpoint instead of the default for the network                       |

## 6. Revoke a key

Revocation is permanent. A revoked key can publish nothing and cannot be enrolled again; what it
published stays in the log and is no longer accepted by `certificate verify`.

```powershell
Set-Content -Encoding ascii .data\registry\revoke.json '{"public_key":"<PUBLIC KEY>","reason":"key rotated"}'; near.cmd contract call-function as-transaction gnanam1990-routespec.testnet revoke_attester file-args .data\registry\revoke.json prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as gnanam1990-routespec.testnet network-config testnet sign-with-keychain send
```

Check the state of a bundle's attesters, or of a key:

```powershell
node --no-warnings packages/cli/bin/routespec.mjs certificate revoke-check --digest sha256:<hex> --registry gnanam1990-routespec.testnet --network testnet
node --no-warnings packages/cli/bin/routespec.mjs certificate revoke-check --attester <PUBLIC KEY> --registry gnanam1990-routespec.testnet --network testnet
```

Exit 0 and `status: CLEAR` mean every attester involved is enrolled. Exit 3 means `REVOKED` or
`NO_CERTIFICATE`; each certificate row says whether it was published before the revocation.

## 7. Publish from CI

`.github/workflows/routespec-certificate.yml` runs the gate on every push to `main` and then, in
a separate step, publishes the certificate when the decision is PASS. Configure the repository:

| Kind     | Name                            | Value                                               |
| -------- | ------------------------------- | --------------------------------------------------- |
| secret   | `ROUTESPEC_ATTESTER_KEY`        | the contents of the attester key file               |
| secret   | `ROUTESPEC_NEAR_SIGNER_KEY`     | key of a NEAR account that pays gas (`ed25519:...`) |
| variable | `ROUTESPEC_NEAR_SIGNER_ACCOUNT` | that NEAR account                                   |
| variable | `ROUTESPEC_REGISTRY_ACCOUNT`    | the registry account                                |
| variable | `ROUTESPEC_REGISTRY_NETWORK`    | `testnet` or `mainnet`                              |

Use a dedicated NEAR account with a small balance for gas, and a dedicated attester key for CI
(enrol it as in step 3) so that it can be revoked without touching your own. Without the secrets
the step reports `SKIPPED_NO_SIGNER` and the job stays green. Pull requests never reach this
workflow.

## Troubleshooting

| Message                               | Meaning                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `RSREG_ATTESTER_UNKNOWN`              | the key that signed is not enrolled in this registry                                        |
| `RSREG_ATTESTER_REVOKED`              | the key was revoked                                                                         |
| `RSREG_SIGNATURE_INVALID`             | the envelope was changed after signing, or it was signed for another registry account       |
| `RSREG_ALREADY_PUBLISHED`             | this attester already has a certificate for this bundle                                     |
| `RSREG_TIMESTAMP_STALE` / `_FUTURE`   | the envelope is older than thirty days, or the signing clock is more than ten minutes ahead |
| `RSREG_NOT_OWNER`                     | enrol and revoke must be signed by the owner account                                        |
| `RS_CAPTURE_NOT_RELEASE_EVIDENCE`     | the bundle is diagnostic only (for example from an uncontained journey)                     |
| `RS_BUNDLE_VERIFY_FAILED`             | the bundle file does not verify; nothing was signed or looked up                            |
| `RS_REGISTRY_UNAVAILABLE`             | the RPC endpoint did not answer usably; this is never reported as a verdict                 |
| `RS_IDENTITY_MISMATCH` (expected/got) | `--network` names one chain and the endpoint serves another                                 |
| `REGISTRY_CODE_HASH_MISMATCH`         | the registry account runs different code than `--code-hash`                                 |
