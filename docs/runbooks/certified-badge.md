# Runbook: "RouteSpec Certified" badge and verify page (M49)

The verify page is a static page that checks a release certificate in the visitor's browser: it
computes the bundle digest locally and reads the `routespec-registry` contract on NEAR directly.
The badge is a small JSON file for shields.io that the `routespec-pages` workflow regenerates from
the registry. Both need the M47 registry to be deployed and a certificate to be published first
(`docs/runbooks/release-certificates.md`); until then they honestly show "unverified".

Decisions and limits: `docs/adr/0031-certified-badge-and-verify-page.md`. Evidence:
`docs/status/M49.md`.

## 1. Look at it locally (nothing is published)

```powershell
pnpm --filter @routespec/verify-page build; node --no-warnings apps/verify/scripts/site.ts --dist apps/verify/dist; pnpm --filter @routespec/verify-page exec vite preview --port 9555 --strictPort
```

Open `http://127.0.0.1:9555/`. `site.ts` writes `config.json` and `badge/testnet.json` into the
build; with no registry deployed the badge is `unverified` and the page says the registry account
does not exist.

Write one badge by hand (read-only RPC call):

```powershell
node --no-warnings packages/cli/bin/routespec.mjs certificate badge --project-key gnanam1990/routespec-near --registry gnanam1990-routespec.testnet --network testnet --known-code-hash CbPrvc6jbuVNNg2qVmUDSiPhCGNBZetQAmptQZWyCfxr --write-on-error --out .data\badge-testnet.json
```

| Option                     | Effect                                                                     |
| -------------------------- | -------------------------------------------------------------------------- |
| `--digest sha256:<hex>`    | badge for one bundle digest                                                |
| `--bundle <file>`          | badge for the digest of that file (contents are not verified)              |
| `--project-key <key>`      | badge for the project's newest certificate                                 |
| `--attester <key>`         | count only this attester (repeat for several)                              |
| `--known-code-hash <hash>` | not certified unless the registry runs one of these code hashes            |
| `--label <text>`           | left side of the badge (default `RouteSpec`)                               |
| `--write-on-error`         | an unreadable registry writes an `unverified` badge instead of exiting 5/6 |

## 2. Publish on GitHub Pages (owner)

Pages must use GitHub Actions as its source. On a private repository this needs a plan that
allows Pages for private repositories.

```powershell
gh api -X POST repos/gnanam1990/routespec-near/pages -f build_type=workflow
```

Optional repository variables (none is a secret):

```powershell
gh variable set ROUTESPEC_BADGE_ATTESTERS --body "<ATTESTER PUBLIC KEY>" -R gnanam1990/routespec-near
gh variable set ROUTESPEC_MAINNET_REGISTRY_ACCOUNT --body "<MAINNET REGISTRY ACCOUNT>" -R gnanam1990/routespec-near
```

Without `ROUTESPEC_BADGE_ATTESTERS` any attester the registry reports enrolled and not revoked
counts. With it, only that key counts on the page and the badge. `ROUTESPEC_REGISTRY_ACCOUNT`
(testnet, shared with the certificate workflow), `ROUTESPEC_BADGE_PROJECT` and
`ROUTESPEC_REGISTRY_CODE_HASHES` are also read.

Then push `main` (the workflow runs on push) or start it by hand:

```powershell
gh workflow run routespec-pages.yml -R gnanam1990/routespec-near
```

The page is at `https://gnanam1990.github.io/routespec-near/` and the badge JSON at
`https://gnanam1990.github.io/routespec-near/badge/testnet.json`. The workflow runs again after
every `routespec-certificate` run on `main` and once a day, so a new certificate or a revocation
reaches the badge without a commit.

## 3. Check it

1. Open `https://gnanam1990.github.io/routespec-near/?project=gnanam1990%2Froutespec-near&network=testnet`.
   After the first PASS certificate it shows "Certified: PASS", the registry account, the code
   hash marked as a known reproducible build, and certificate `#0`.
2. Choose the bundle file of that release (for the contained journey:
   `.data\demo-contained\out\routespec-corrected-release.tar`). The page shows the digest it
   computed; it must equal the `bundle_digest` of the certificate.
3. Compare with the CLI:
   `node --no-warnings packages/cli/bin/routespec.mjs certificate verify --digest <digest> --registry gnanam1990-routespec.testnet --network testnet`.
   Its `release.decision` and `release.findings` are what the page shows.

## README snippet for integrators

Replace `<owner>/<repo>` and the project key with yours, and the registry with the one your
certificates are published to:

```markdown
[![RouteSpec Certified](https://img.shields.io/endpoint?url=https%3A%2F%2F<owner>.github.io%2F<repo>%2Fbadge%2Ftestnet.json)](https://<owner>.github.io/<repo>/?project=<url-encoded project key>&network=testnet)
```
