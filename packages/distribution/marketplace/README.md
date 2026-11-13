# RouteSpec 1Click release gate

A GitHub Action that runs the RouteSpec release gate for an application that uses NEAR Intents
1Click through the official TypeScript SDK. The gate starts a networkless, protocol-faithful
local 1Click service, plays exact fault schedules (for example "deposit submission accepted,
response lost") against your client, and returns PASS, FAIL, or REVIEW from a pure invariant
kernel. It stages redacted JSON, JUnit and SARIF reports for upload.

The step exits 0 only for a PASS decision. RouteSpec reports enforcement as `CI_CHECK` or
`REQUIRED_CHECK_UNVERIFIED` and never claims to block a merge: make the job a required check in
your branch protection if you want that.

## Usage

```yaml
permissions:
  contents: read
jobs:
  routespec:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          persist-credentials: false
      - id: gate
        uses: gnanam1990/routespec-gate-action@<release-commit-sha> # v0.1.0
        with:
          config: routespec.ci.json
      - if: ${{ always() && steps.gate.outputs.upload-directory != '' }}
        uses: actions/upload-artifact@b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882 # v4.4.3
        with:
          name: routespec-gate-${{ github.run_id }}
          path: ${{ steps.gate.outputs.upload-directory }}
          retention-days: ${{ steps.gate.outputs.retention-days }}
```

`routespec.ci.json` (schema `routespec.ci-config/1`) names your client launch module, its artifact
files, lockfile, declared effect manifest, scenarios and required invariants. Reference and a
working example: <https://github.com/gnanam1990/routespec-near/blob/main/packages/ci/README.md>.

## Inputs and outputs

| Input          | Required | Default   | Meaning                                                   |
| -------------- | -------- | --------- | --------------------------------------------------------- |
| `config`       | yes      |           | Path of the `routespec.ci-config/1` file in the workspace |
| `node-version` | no       | `22.23.1` | Exact Node.js version used to run RouteSpec               |

Outputs: `conclusion`, `decision`, `exit-code`, `trust`, `enforcement-mode`, `artifact-ready`,
`upload-directory`, `retention-days`, `certificate-bundle`, `certificate-journal`.

## What runs

1. `actions/setup-node`, pinned by commit.
2. `npm install routespec@<exact version>` into the runner's temporary directory with install
   scripts disabled, then `npm audit signatures`, which fails the step unless the registry
   signature and the npm provenance attestation of the installed package verify.
3. The RouteSpec CI entry point. Provider secrets and CI runtime tokens are removed from the
   step environment before it starts; the gate contacts no network.

Pull-request and fork jobs get no secrets and upload only redacted reports.

## Source

Built from <https://github.com/gnanam1990/routespec-near>. License: MIT.
