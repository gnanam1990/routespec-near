# @routespec/mcp

Owner module: M52. RouteSpec MCP server for coding agents (stdio, no network listener).

Start it with `routespec mcp [--root <dir>] [--work <dir>]` (or `pnpm run mcp`, or the
`routespec-mcp` bin). Tools:

- `run_gate` — run the gate on a client module (default export `async (ctx, request) => result`
  using `ctx.sdk.OneClickService`); real launcher, real subject processes with the pinned
  official SDK, kernel verdicts. Default scenarios: `happy-path`, `accepted-then-lost-response`,
  `slow-deposit-answer`. Uncontained and diagnostic (`DECLARED_HOOKS_ONLY`), never release
  evidence. Required invariants: INV-01, 02, 03, 05, 06, 07, 08.
- `list_findings` — per failing case: invariant, kernel explanation and remediation codes and
  texts, fix patterns, most severe first.
- `explain_invariant` — rule and every kernel explanation code of an invariant.
- `show_fix_pattern` — `reconcile-through-status`, `no-second-order-while-unanswered`,
  `exact-retry-same-order`, `release-effects-after-success`, with before and after code.
- `verify_certificate` — `routespec certificate verify` against the NEAR registry (read-only).

Files read by the tools must be inside `--root`. Decisions: `docs/adr/0032-mcp-server-and-agent-skill.md`.
The skill and the demo: `examples/agent-skill/`. Status: `docs/status/M52.md`.

Tests: `packages/mcp/test` (in `pnpm test`), `packages/mcp/sandbox-test` (in
`pnpm run test:registry`, local NEAR sandbox node).
