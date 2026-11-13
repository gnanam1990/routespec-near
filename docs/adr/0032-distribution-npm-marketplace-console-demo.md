# ADR-0032 — Distribution: npm package, Marketplace action, static console demo, judge command (M54)

- Status: accepted
- Date: 2026-11-13
- Module: M54 (distribution). Builds on ADR-0012 (CLI), ADR-0015 (CI action trust and uploads),
  ADR-0025 (CI credentials removed before the entry point), ADR-0014 and ADR-0026 (console).
  Changes none of them.

## Context

RouteSpec ran only from a clone: the workspace executes its TypeScript sources with Node's type
stripping, and the GitHub Action builds the checked-out repository. M54 adds ways to use and see
RouteSpec without a clone. The specification pack does not describe distribution, so every
decision below goes beyond it. None changes the protocol profile, the kernel, the proxy, the
store, the gate, or any verdict.

## Decisions

1. **One npm package, `routespec`, compiled and self-contained.** Node refuses type stripping
   under `node_modules`, so the package ships the JavaScript that `tsc -b` already emits, never
   the sources. `packages/distribution/src/npm-package.ts` stages the runtime closure of
   `@routespec/cli` and `@routespec/ci` (thirteen workspace packages after M53) plus their only
   third-party runtime dependencies, `zod@4.6.7`, `yaml@2.8.4` and `typescript@5.9.3` (the M53
   fix-pattern finder uses the compiler API), all as `bundleDependencies`. Installing
   the tarball fetches nothing else, so the provenance attestation of the tarball covers every
   file that runs. Bins: `routespec` (the CLI) and `routespec-ci` (the action entry point). The
   workspace packages keep their own names inside the package and stay private on npm.
   `routespec mcp` (M52) is not packaged: the MCP server needs the official SDK and its dependency
   tree at run time. The npm bin answers `mcp` with `RS_MCP_NOT_PACKAGED` (exit 4), and the build
   audit lists that one missing file-URL target explicitly.
2. **Forked child entry points are rewritten at build time, and checked.** A few modules fork a
   sibling file by URL (`new URL('./main.ts', import.meta.url)`). The build rewrites exactly that
   form to the compiled `.js` sibling and fails if a target is missing, if any relative `.ts`
   literal is left, if a TypeScript source would ship, or if a bare import is not bundled. Source
   files are not changed, so the workspace keeps running from TypeScript.
3. **Provenance from one manual workflow.** `.github/workflows/npm-publish.yml` runs only on
   `workflow_dispatch`. It builds the package, runs the distribution suite against the packed
   tarball, and publishes that tarball with `--provenance`. Only that job gets `id-token: write`;
   the only secret is `NPM_TOKEN`, only in the publish step. Name and version live in
   `packages/distribution/npm/publish-manifest.json` (`routespec@0.1.0`).
4. **The Marketplace action is a separate single-action repository.** GitHub Marketplace lists a
   repository only when its root holds exactly one action and no workflow files; this repository
   has two actions and several workflows. `packages/distribution/marketplace/` is the complete
   root of that repository (`action.yml`, `README.md`, `LICENSE`). Its action installs
   `routespec@<exact version>` from npm with install scripts disabled, runs
   `npm audit signatures` (registry signature and provenance must verify), and then runs the
   same credential-withholding step as `.github/actions/routespec-gate`, pointed at the installed
   package. A test keeps its inputs, outputs and withholding script identical to the
   in-repository action.
5. **The console demo is a recording, not a mock.** `record.ts` copies the data directory of a
   real contained journey, starts the real control service on it, drives the built console in
   Chromium through every in-app link, and keeps each GET response exactly as the service sent
   it. A non-GET request, a non-contained journey, a bundle that is not the journey's export, or
   any response containing the control token or a path of the recording machine fails the
   recording. The demo build (`VITE_ROUTESPEC_DEMO=1`) answers the console from that snapshot:
   recorded GETs unchanged, unrecorded GETs 404 `RS_STATIC_DEMO_NOT_RECORDED`, every mutation 403
   `RS_STATIC_DEMO_READ_ONLY`. A banner and the connection badge say it is a read-only snapshot,
   with the run's commit and the evidence bundle for download. The committed recording
   (`packages/distribution/console-demo/`) carries `provenance.json` with the digests the build
   and the tests check. The console served by the local service is unchanged (base `/`, no
   demo code path taken).
6. **The demo shares the repository's one Pages site.** A repository has a single GitHub Pages
   site, and M49 (ADR-0031) already deploys the verify page to its root from
   `.github/workflows/routespec-pages.yml`. M54 adds one build step to that workflow: the demo is
   built from the committed recording into `console/` (`/routespec-near/console/`), and a root
   `404.html` (written only when the site has none) hands deep links below that path to the demo
   as `?route=`, which the demo restores before routing. The step records nothing and adds no
   permission, secret or action.
7. **`pnpm judge` runs real steps and reports their own results.** Build, the uncontained journey,
   the contained journey when an engine is configured, the demo recording check with the CLI's
   offline bundle verification, and the npm package installed offline gating the self-gate
   configuration. It prints each step's outcome and the product's decisions and exits non-zero on
   any failed step. It never computes a verdict.

## Consequences

- `npx routespec` and the Marketplace action work only after the owner publishes the package and
  creates the action repository; until then they are PENDING. Nothing was published by M54.
- The demo is deployed whenever M49's Pages workflow deploys (on push to `main` once Pages is
  enabled). Its action pins are M49's, which M49 resolved against the release tags.
- The demo is as old as its recording. Re-recording after a product change is one command
  (`pnpm run demo:record -- ...`); the snapshot digest changes and the tests follow the
  provenance file.
- The Marketplace step's file-descriptor handoff is tested on Linux only, as for the
  in-repository action (SEC vuln-0001): Git Bash on Windows cannot pass descriptor 3 to a native
  Node process.
