# @routespec/verify-page

The static "RouteSpec Certified" verify page (M49). It computes the SHA-256 of an evidence bundle
in the browser, reads the `routespec-registry` contract on NEAR with view calls, checks every
certificate signature with WebCrypto, and shows the same decision as
`routespec certificate verify --digest`. The decision logic is `@routespec/registry/browser`.

- `pnpm --filter @routespec/verify-page build` builds `dist/`.
- `node --no-warnings apps/verify/scripts/site.ts --dist apps/verify/dist` writes `config.json`
  from the environment and `badge/<network>.json` with `routespec certificate badge`.
- Links: `?digest=sha256:<hex>`, `?project=<key>`, `&network=`, `&attester=` (narrows only),
  `&registry=` (labelled), `&rpc=` (loopback only).

Runbook: `docs/runbooks/certified-badge.md`. Decisions: `docs/adr/0031-certified-badge-and-verify-page.md`.
