# RouteSpec demo video script (2-3 minutes)

One complete moment, from a user action to a visible result: **a developer runs RouteSpec on two
builds of a NEAR Intents 1Click client; the naive build loses a commit response and is flagged,
the corrected build reconciles and passes.** Everything shown is the real product running
locally from a clean clone. Nothing is mocked on the critical path.

## Before recording (not filmed)

1. Fresh clone of the exact commit you will submit; note its short SHA.
2. Install and build (README "Try it in 10 minutes", step 1).
3. Docker Engine reachable and `node:22-bookworm-slim` pulled; set `ROUTESPEC_CONTAINER_CLI`
   (README step 4). Do one full rehearsal run, then delete `.data/` so the take starts clean.
4. Terminal font at least 16 pt, window about 120 columns wide. Close notifications, chat
   apps, password managers, and any window showing a home path, email, or account name. Use a
   neutral working directory name if the prompt shows the path.
5. Subtitles: write them from the "Say" lines below; audio is optional.

## Scene 1 — The problem (0:00-0:20)

Show: the README's "30-second summary" in the browser, or a title card with one sentence.

Say: "When a NEAR Intents 1Click deposit is accepted but the response is lost, a naive client
retries or gives up and never finds out what happened. Deposits are irreversible and there is no
Intents testnet, so this path is hard to test. RouteSpec tests it locally, with no funds."

## Scene 2 — The action: run both builds (0:20-1:30)

Show the terminal, in the repository root. Type and run, live, without cutting:

```sh
pnpm run delivery:journey -- --work .data/demo --out .data/journey.json --no-ui --contained
```

It takes about one minute. While it runs, say: "This starts the real RouteSpec service, registers
two builds of a client that uses the official 1Click TypeScript SDK, and runs each one in a
locked-down container against a local 1Click simulator. The scenario accepts the deposit commit
and then drops the response."

When it prints `{"ok":true,...}`, run:

```sh
node scripts/journey-summary.mjs .data/journey.json
```

Point at (highlight or zoom):

- `containment CONTAINED`
- baseline: `client GAVE_UP`, resubmissions answered `403 RS_TOKEN_PHASE_DENIED`,
  `INV-03 REVIEW`, gate decision `REVIEW`
- corrected: `client RECONCILED`, `INV-03 PASS`, `INV-04 PASS`, gate decision `PASS`
- `promoted as RELEASE_EVIDENCE`, `regression status CORRECTED_RUN_PASSED`

Say: "The naive build resubmitted, was refused, and gave up without reconciling, so RouteSpec
will not pass it. The failure was captured and promoted into a regression. The corrected build
reads the status route, reconciles to SUCCESS, and passes the original case and the new
regression."

## Scene 3 — The visible result in the console (1:30-2:30)

Not filmed: start the service and open the printed link while the terminal is off-screen, so
the `#token=` link is never recorded:

```sh
node packages/control-api/src/main.ts --data .data/demo/data --console apps/console/dist --handoff stderr
```

Film the browser only:

1. **Releases** page: four gate runs for `release-candidate-1`. Point at the last row: Verdict
   `PASS`, Subject identity "Trusted launcher attestation", Effect coverage "Independent
   boundary", Enforcement "Local advisory".
   Say: "Each row is one exact build, corpus, and gate run. Only the evaluator sets the verdict."
2. Click **Open gate run** on that row: two case runs, both `PASS`, required invariants
   INV-01 to INV-04, token "Revoked (RECONCILIATION_ONLY)", epoch 2.
3. Click **accepted-then-lost-response**: the live trace timeline shows `QUOTE_REQUEST_CREATED`,
   `QUOTE_FINALIZED`, `COMMIT_ACCEPTED`, then the provider status observations.
   Say: "Here is the commit that was accepted while the client never saw the answer, and the
   read-only reconciliation that resolved it."
4. Go back to **Releases**, open a baseline gate run (Verdict `REVIEW`) and show its case.
   Say: "The same scenario on the naive build stays REVIEW."

## Scene 4 — NEAR's role and next step (2:30-2:50)

Show the README "NEAR integration" table, or a closing card with the repository link.

Say: "RouteSpec targets the NEAR Intents 1Click flow: the official SDK, the quote, deposit
submit, and status routes, and their irreversible cross-chain settlement. It runs offline and
moves no funds. Built at NEAR HACKATHON. The repository has a ten-minute path to reproduce this."

## What must not be said or shown

- Do not say RouteSpec moved funds, swapped, settled, deposited, or touched mainnet or testnet.
  The only deposit addresses are simulated (`sim-deposit-...`).
- Do not say it was tested against the live 1Click API. The optional `dry: true` probe was not
  run.
- Do not claim `WORKING_LOCAL`, production readiness, or an independent review. The interceptor
  profile review in the journey uses a locally generated test key; there was no independent
  human security review.
- Do not say RouteSpec blocks merges or releases. Enforcement is advisory ("Local advisory",
  `CI_CHECK`).
- Do not say the GitHub Action ran on GitHub's hosted runners or that Linux or macOS were
  tested, unless that has happened and is recorded in `BUILD-STATUS.md` by then.
- Do not describe the uncontained run (no Docker) as a PASS for the corrected build: without
  containment it is REVIEW by design.
- Do not show the console `#token=` link, the control token, a provider JWT, a home path, or
  personal details. Do not speed up or cut around the journey run in scene 2.
- Do not present Dockside features as part of RouteSpec; they are separate projects.
