# RouteSpec skill and MCP server for coding agents (M52)

This directory holds a plain Markdown skill for coding agents (`SKILL.md`), an MCP server
configuration example (`mcp.json`), a shell fallback (`gate.ts`), and a demo: a naive 1Click
client, the same client after the reconcile pattern, a scripted agent session, and a recorded
transcript of it.

The rule the skill teaches: **before shipping 1Click code, run the gate; on FAIL apply the
reconcile pattern.**

## Install the skill

Copy `SKILL.md` into wherever your coding agent reads skills or project instructions (many read
a `skills/<name>/SKILL.md` folder; others take the body as a project instruction file). The
front matter (`name`, `description`) says when to use it.

## Register the MCP server

The server is the `routespec mcp` command (package `packages/mcp`). It speaks MCP over stdio and
opens no network listener. Register it in your coding agent's MCP configuration; `mcp.json` is
the common shape:

```json
{
  "mcpServers": {
    "routespec": {
      "command": "node",
      "args": ["--no-warnings", "packages/cli/bin/routespec.mjs", "mcp", "--root", "."]
    }
  }
}
```

Run it from the repository root (Node 22.18 or newer, after `pnpm install`). `--root` is the
only directory the tools read client modules and bundles from; `--work <dir>` keeps the gate
journals (default: a fresh temporary directory).

| Tool                 | Input                                                     | Output                                                                |
| -------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| `run_gate`           | `client` (module path), optional `scenarios`              | decision, per-case contribution and failing invariants, `runId`       |
| `list_findings`      | optional `runId`, `includePassing`                        | per case: invariant, kernel explanation and remediation, fix patterns |
| `explain_invariant`  | `invariant` (for example `INV-03`)                        | rule, every kernel explanation code with its verdict, remediations    |
| `show_fix_pattern`   | `pattern` or `invariant`, or nothing for the list         | problem, rule, before and after code                                  |
| `verify_certificate` | `registry`, `network` or `rpc`, `bundle` or `digest`, ... | release decision from the NEAR registry (read-only views)             |

## Shell fallback

Without MCP support, the same gate runs from a shell:

```sh
node --no-warnings examples/agent-skill/gate.ts path/to/client.ts
```

It prints one JSON document (`run` and `findings`) and exits 0 PASS, 2 FAIL, 3 REVIEW or
NOT_RUN, 4 input error.

## The client module

The gate runs a client module whose default export is `async (ctx, request) => result`, using
the official SDK through `ctx.sdk.OneClickService` (already pointed at the RouteSpec proxy).
After a deposit submission that failed without a usable answer, `ctx.reconciliationAuthority()`
resolves once RouteSpec has issued reconciliation-only authority. See
`demo/swap-client.fixed.ts`.

## Demo

```sh
pnpm run demo:agent-session
```

A scripted agent connects to the real MCP server, runs the gate on `swap-client.naive.ts`
(FAIL: INV-03, a second order while the first is unanswered), lists the findings, reads the fix
pattern, applies the reconcile pattern (the working copy becomes `swap-client.fixed.ts`), and
runs the gate again (PASS). The agent's choices are scripted; the gate runs are real.
`demo/TRANSCRIPT.md` is the recording.

## What these runs are

MCP gate runs are uncontained (`DECLARED_HOOKS_ONLY`): the client runs as a local Node process,
the same trust as running its tests. They are diagnostic, not release evidence. INV-04
(protected effects) is judged only in a contained run and is not required here. See
`docs/adr/0033-mcp-server-and-agent-skill.md`.
