# ADR-0033 — MCP server and coding agent skill (M52)

- Status: accepted
- Date: 2026-11-13
- Module: M52 (agent skill and MCP server). Builds on ADR-0012 (runner, CLI, release gates),
  ADR-0009 (invariant kernel), ADR-0029 (release certificates). Changes none of them.
- Numbering: 0031 and 0032 were taken by M49 (badge) and M53 (fix patterns), merged in parallel.

## Context

Coding agents write a growing share of 1Click integration code. The failure RouteSpec exists to
catch, a second order while the first one's outcome is unknown, is exactly what a code generator
writes when it treats a slow deposit submission like a slow read. M52 gives agents the gate as
tools and a skill that says when to use them. The specification pack does not describe an agent
interface, so the decisions below go beyond it. None of them changes the protocol profile, the
kernel, the proxy, the adapter, the store, or the CLI's existing commands.

## Decisions

1. **A hand-written MCP stdio server, no SDK dependency.** `packages/mcp` implements the MCP
   stdio transport directly: newline-delimited JSON-RPC 2.0, `initialize` (protocol versions
   `2025-06-18`, `2025-03-26`, `2024-11-05`; an unknown version is answered with the newest),
   `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Everything else is
   `-32601`. This keeps the frozen lockfile unchanged (no new third-party package, no cool-down
   question) and the surface small enough to test fully. stdout carries protocol lines only.
   There is no network listener.
2. **`routespec mcp` without a build-time cycle.** `@routespec/mcp` depends on `@routespec/cli`
   (launcher, certificate verify). The CLI loads the MCP entry only for `routespec mcp`, by a
   runtime URL to the sibling workspace package, so there is no package or project-reference
   cycle. It is the one CLI command that does not print a single JSON document.
3. **Five tools.** `run_gate`, `list_findings`, `explain_invariant`, `show_fix_pattern`,
   `verify_certificate`. Input errors are tool results with `isError: true`; unknown tools and
   malformed calls are JSON-RPC errors.
4. **`run_gate` is the real gate, uncontained.** It registers the build and a reviewed corpus
   through the journal repositories, starts `routespec gate run` through the reviewed launcher,
   and for every case starts a fresh subject process that loads the caller's client module
   (default export `async (ctx, request) => result`) with the pinned official SDK and the
   RouteSpec adapter. Verdicts come only from the kernel. The client runs as a local Node
   process, the trust of running its own tests; the run is `DECLARED_HOOKS_ONLY`, diagnostic,
   and never release evidence. INV-04 (needs an independent interceptor) and INV-09 (replay
   identity) are therefore not required; the required set is INV-01, 02, 03, 05, 06, 07, 08.
5. **A reviewed synthetic scenario `slow-deposit-answer`.** The delivery journey's
   `slow-commit-answer` (M41) scripts the second quote and second submission before the
   provider statuses, so with steps consumed strictly in order a client that never sends them can never reach
   a terminal status there. `slow-deposit-answer` is the same fault with the provider statuses
   and ground truth first: a reconciling client reaches SUCCESS, a hedging client still gets its
   second order answered and is judged INV-03 FAIL. It states no expected verdict. The default
   corpus is `happy-path`, `accepted-then-lost-response`, `slow-deposit-answer`.
6. **Findings in the kernel's words.** The journal stores invariant verdicts but not the closed
   explanation and remediation codes. `list_findings` re-evaluates each case read-only from its
   journal snapshot with the same kernel and uses the codes only when the re-evaluated verdicts
   equal the stored ones. Fix patterns are mapped from remediation codes, never from free text.
7. **Path confinement.** Client modules and bundles must resolve (symbolic links followed)
   inside `--root`; anything else is refused before a process starts.
8. **`verify_certificate` is read-only.** It runs `routespec certificate verify` in process,
   with the signer environment variables removed. It never signs or sends a transaction.
9. **The skill is plain Markdown.** `examples/agent-skill/SKILL.md` with `name` and
   `description` front matter, vendor-neutral, so any coding agent that reads skills or project
   instructions can use it. A shell fallback (`gate.ts`) covers agents without MCP.
10. **The demo is scripted, the gate is real.** `demo/agent-session.ts` plays the agent's
    choices against the real server; `demo/TRANSCRIPT.md` is a recording of one such session.

## Consequences

- A client must be expressible as a module with a default job; integrations wrap their swap
  flow, they do not copy it.
- A contained MCP gate run (release evidence from an agent session) is not built; it would use
  the M14 `contained-start` path of the control API.
- The scenario list a tool accepts is closed (the core scenarios and `slow-deposit-answer`);
  agents cannot add scenarios through MCP.
