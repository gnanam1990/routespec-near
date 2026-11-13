# routespec

RouteSpec is a local release check for applications that use NEAR Intents 1Click through the
official TypeScript SDK. It runs your client against a networkless, protocol-faithful local 1Click
service, injects deterministic faults (for example "deposit submission accepted, response lost"),
records what the client did, and returns PASS, FAIL, or REVIEW from a pure invariant kernel, with
a checksummed evidence bundle and JSON, JUnit and SARIF reports.

Source, documentation and the full product journey: <https://github.com/gnanam1990/routespec-near>.

## Requirements

Node.js 22.18 or later. Nothing else: the package bundles its two third-party runtime
dependencies (`zod`, `yaml`) and fetches nothing at run time.

## Commands

```sh
npx routespec <command> ...                       # the RouteSpec CLI
npx -p routespec routespec-ci run --config routespec.ci.json --workspace . --work-dir <dir outside the workspace>
```

- `routespec` prints exactly one JSON document on stdout. Exit codes: 0 PASS, 2 FAIL, 3
  REVIEW/NOT_RUN, 4 usage or configuration error, 5 internal error, 6 safety policy denial.
  Commands include `gate create|run|evaluate|show`, `export plan|write|verify`, and
  `certificate keygen|publish|verify|revoke-check`.
- `routespec-ci run` is the entry point of the RouteSpec GitHub Action: it reads a
  `routespec.ci-config/1` file, runs the networkless gate (simulate and replay only) and stages
  redacted reports. Configuration reference:
  <https://github.com/gnanam1990/routespec-near/blob/main/packages/ci/README.md>.

`routespec export verify --bundle <file.tar> --extract-to <empty dir>` checks an evidence bundle
offline.

## What it does not do

Gate runs contact no network. Only the `certificate` commands contact a NEAR JSON-RPC endpoint,
and only the one you name. RouteSpec never signs or sends a NEAR transaction unless you run
`certificate publish --submit` with your own key. It never claims to block a merge.

## Provenance

Releases are built and published from the repository's `npm-publish` workflow with npm
provenance, so `npm audit signatures` can tie the tarball to the commit and workflow run that
built it.

License: MIT.
