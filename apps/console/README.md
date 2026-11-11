# @routespec/console

Owner module: M09. Status: **IN_PROGRESS** — console shell over a typed control-API client. Not wired to the
real control API yet (M08); see `docs/status/M09.md`.

Local React + Vite console that renders persisted control-API records and never computes a verdict in the
browser.

## Layout

- `src/api/` — typed control client (`client.ts`), closed response schemas (`schemas.ts`), error classes.
- `src/content/` — the single status content map (labels, icons, tones) for every axis value.
- `src/components/` — status axis group, badges, digest reveal/copy, timeline, dialogs, forms, states.
- `src/pages/` — Releases, Gate runs (create/detail/case), Operations, Regressions (queue/review), Settings.
- `src/styles/` — design tokens (light/dark), base, components. Components use tokens only.
- `test/` — unit tests (run by the root `pnpm test`).
- `e2e/` — Playwright + axe tests against `e2e/fixture/server.ts`, a loopback **contract fixture** with
  simulated records. It is not the control API and is not acceptance evidence for a product gate.

## Commands

```text
pnpm --filter @routespec/console build       # production bundle in apps/console/dist
pnpm --filter @routespec/console typecheck
pnpm --filter @routespec/console e2e         # builds, starts the contract fixture, runs Playwright
```

The console expects to be served by the loopback control API from the same origin as `/__routespec/v1`, opened
with `#token=<control token>`; the token is moved into memory and removed from the address bar.
