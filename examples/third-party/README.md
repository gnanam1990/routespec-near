# Third-party example clients (M48)

RouteSpec's own demo clients were written for RouteSpec. This directory runs example code that
other people published, exactly as they published it, through the same release check.

Nothing from another repository is stored here. Each example is named by repository and commit in
[`pins.json`](pins.json), fetched on request, checked byte for byte, and run only inside the
RouteSpec subject container (no network, read-only filesystem, no capabilities, non-root). The
result is whatever the invariant kernel returns for what the example actually sent, including
"nothing could be evaluated".

## What is pinned

| Id                              | Repository and commit                                                                                                                                | Standing | Licence | File run                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | ----------------------------- |
| `one-click-sdk-basic-swap-flow` | [defuse-protocol/one-click-sdk-typescript](https://github.com/defuse-protocol/one-click-sdk-typescript) @ `ae8b24e064785c8cba8081263e03e52fed4de089` | Official | ISC     | `examples/basic-swap-flow.ts` |

One repository qualified. The search, every repository that was read, and the reason each other
one was left out are in [Candidates](#candidates-examined-on-2026-11-13) below.

## Run it

Needs the container setup from [`docs/runbooks/container-containment.md`](../../docs/runbooks/container-containment.md)
(a Linux container engine and the `node:22-bookworm-slim` image). There is no uncontained mode:
without an engine the command exits 2 with `NOT_RUN` and launches nothing.

```sh
pnpm install --frozen-lockfile
pnpm run examples:fetch          # network: fetches the pinned commit, verifies every file digest
pnpm run examples:third-party -- --work .data/third-party-run --out .data/third-party-run.json
```

On Windows with Docker Engine inside WSL 2, set the engine command first (PowerShell):

```powershell
$env:ROUTESPEC_CONTAINER_CLI = '["wsl.exe","-d","Ubuntu-24.04","-u","root","--exec","docker"]'
```

`pnpm run examples:fetch -- --check` verifies what is already on disk without using the network.
The same run is part of the containment suite: `pnpm run test:containment` (it reports
`NOT_RUN: THIRD_PARTY_SOURCES_ABSENT` until the fetch has been done once).

## Result recorded on 2026-11-13

Recorded from a real contained run on Windows 11 with Docker Engine 29.1.3 in WSL 2
(`docs/status/M48.md` has the commands and the full record):

```text
containment CONTAINED (node:22-bookworm-slim)
one-click-sdk-basic-swap-flow: https://github.com/defuse-protocol/one-click-sdk-typescript @ ae8b24e06478 (ISC) gate decision REVIEW
  case 0 happy-path: verdict REVIEW | subject DONE SETTLED | sdk calls: getTokens REJECTED 404 RS_UNSUPPORTED_ROUTE | run operations 0 | invariants: none evaluated
  case 1 accepted-then-lost-response: verdict REVIEW | subject DONE SETTLED | sdk calls: getTokens REJECTED 404 RS_UNSUPPORTED_ROUTE | run operations 0 | invariants: none evaluated
```

Read it as:

- **No invariant finding, because nothing could be evaluated.** The example's first call is the
  token list (`GET /v0/tokens`). RouteSpec's `oneclick-v0` profile serves the quote, deposit
  submission, and status routes only, so the local service answered `404 RS_UNSUPPORTED_ROUTE`.
  The example catches the error, prints it, and stops. It never requested a quote, so there is no
  run operation and the kernel evaluated no invariant. The case verdict is REVIEW, not PASS.
- **This is a limit of RouteSpec, not a defect in the example.** The example is a `dry: true`
  walkthrough of the SDK. It was not written to be a production client, and RouteSpec does not
  claim to have tested how it handles a lost answer.
- **Containment held.** Both cases ran with `PROCESS_TREE_ENFORCED` and no containment finding;
  the example's own `OpenAPI.BASE = "https://1click.chaindefuser.com"` had no effect; the only
  traffic was one request to the RouteSpec proxy; the container was removed with no survivor.
- **One version difference.** The example's own `package.json` asks for SDK `0.1.1`. RouteSpec
  ran it with SDK `0.1.26`, the only version its adapter attaches to.

## How an example is run

1. `support/fetch.ts` (host, read-only) fetches the pinned commit into a throw-away bare
   repository and reads the pinned files as git blobs. No checkout, install, build, or script of
   the fetched repository runs. A file whose SHA-256 differs from the pin is refused.
2. `packages/delivery/src/third-party.ts` verifies the files again, starts the control service
   with containment and the attesting launcher, registers `<id>/adapter.ts` as a build, and starts
   every case with `contained-start`.
3. Inside the container, `<id>/adapter.ts` refuses to continue if it is not in a container, keeps
   the official SDK on the RouteSpec proxy origin, and imports the pinned entry through
   `support/confined.ts`. That loader serves only the pinned files (checked against their digests
   again as they are read), lets them import only each other and the allow-listed packages, and
   translates TypeScript with the repository's pinned compiler. The source text is never edited.
4. The adapter reports which SDK methods the example called and what it printed. Verdicts come
   only from the kernel.

The module loader is not the security boundary. The container is. The loader makes sure that what
runs is the pinned bytes and nothing else.

## Add another example

1. Check the repository: public, official or well known, a permissive licence file at the commit
   (`MIT`, `ISC`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, or `0BSD`), and code that calls
   1Click through the official TypeScript SDK and imports nothing RouteSpec does not install.
2. Add a pin to `pins.json`: repository URL, the full 40-character commit, the licence, the entry
   file, and every file to read with the SHA-256 of its git blob
   (`git cat-file blob <commit>:<path> | sha256sum`). Always pin the licence file too.
3. Add `<id>/adapter.ts`, `<id>/adapter.effects.json`, and `<id>/NOTICE.md`.
4. Run the commands above and record the result plainly, whatever it is.

A pin without a permissive licence, with a short or symbolic commit, or with a path that leaves
its tree is refused by `support/pins.ts` (tests: `packages/delivery/test/m48-third-party-examples.test.ts`).

## Candidates examined on 2026-11-13

About one hour of search over the GitHub repository search API and the organisations
`defuse-protocol`, `near-examples`, `near`, and `aurora-is-near`. Each repository below was read
at the commit shown; nothing from any of them was executed on the host. Star counts are as
listed on that day.

| Repository                                 | Commit read    | Licence at that commit                                                                                                 | Uses the official TS SDK    | Decision                                                                                                                                                        |
| ------------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defuse-protocol/one-click-sdk-typescript` | `ae8b24e06478` | ISC                                                                                                                    | Yes (its own example)       | **Pinned.**                                                                                                                                                     |
| `near-examples/near-intents-examples`      | `32247f923f1b` | **None.** No licence file, no licence field; the README says only that the project is provided as educational examples | Yes, exactly `0.1.26`       | Left out: no licence grant. It is the closest match otherwise (`1click-example/` exports quote, deposit submission, and status polling functions).              |
| `defuse-protocol/nearintents-mpp-sdk`      | `72ae6a0cb937` | MIT                                                                                                                    | No (its own `fetch` client) | Left out: RouteSpec's adapter attaches only to the official SDK, and the module needs the `mppx` dependency tree, which RouteSpec does not install.             |
| `defuse-protocol/defuse-frontend`          | `594085d3c7e6` | MIT                                                                                                                    | A patched `0.1.16` tarball  | Left out: a Next.js application; its 1Click module depends on application internals and on a patched SDK that is not the pinned one.                            |
| `aurora-is-near/intents-swap-widget`       | `dc09370d7963` | MIT                                                                                                                    | Not for its calls           | Left out: a React widget that reaches 1Click through its own fee service; the one demo page that calls the SDK is a browser component with wallet dependencies. |
| `defuse-protocol/sdk-monorepo`             | `930d2816081f` | MIT                                                                                                                    | No                          | Left out: not a 1Click client.                                                                                                                                  |
| `nikshepsvn/near-hydra`                    | `53aee00b5121` | Apache-2.0                                                                                                             | Yes (`^0.1.17`)             | Left out: describes itself as unofficial and has 6 stars, so it is neither official nor well known. Otherwise compatible.                                       |
| `IkerAlus/x402_1CS_gateway`                | `44074be19b1a` | Apache-2.0                                                                                                             | Yes (`^0.1.17`)             | Left out: a personal repository with 1 star, and its settlement module imports `ethers` and `@x402/evm`, which RouteSpec does not install.                      |
| `nuanu-ai/agent-payment-node`              | `37b3aff9dc85` | MIT                                                                                                                    | No                          | Left out: does not use the official SDK.                                                                                                                        |
| `near/agent-skills`                        | `cb32b6af195e` | None                                                                                                                   | Documentation snippets only | Left out: no licence, and no runnable client.                                                                                                                   |

`defuse-protocol/one-click-sdk-go` (MIT) and `defuse-protocol/one-click-sdk-rs` (no licence) were
seen in the listing and not read: RouteSpec supports the TypeScript SDK only.

The target for this module was two to four repositories. One met every rule. Two more
(`near-examples/near-intents-examples` and `nikshepsvn/near-hydra`) would run with the same
machinery and were left out by rule, not for a technical reason.
