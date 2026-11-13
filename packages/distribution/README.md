# @routespec/distribution

Owner module: M54. Decisions: `docs/adr/0032-distribution-npm-marketplace-console-demo.md`.
Status and evidence: `docs/status/M54.md`. Nothing in this package publishes anything; the
publish steps are the repository owner's.

| Part                    | Where                                          | Command                                                                   |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| npm package `routespec` | `src/npm-package.ts`, `npm/`                   | `pnpm run package:npm` (tarball in `.data/npm`)                           |
| Marketplace action      | `marketplace/` (root of a separate repository) | —                                                                         |
| Console demo recording  | `src/console-demo/record.ts`, `console-demo/`  | `pnpm run demo:record -- --data ... --journey ... --bundle ...`           |
| Console demo site       | `src/console-demo/build.ts`                    | `pnpm run demo:console` (deployed by `routespec-pages` under `/console/`) |
| Judge command           | `src/judge.ts`                                 | `pnpm judge [--contained] [--skip-package]`                               |

Tests: `test/` runs in `pnpm test` (closure and audit of the package build, Marketplace metadata,
release workflow policy, the committed recording). `dist-test/` is `pnpm run test:distribution`:
it packs the package, installs the tarball offline outside the repository and runs its commands,
and builds the demo site and drives it in Chromium.

## Recording the console demo again

```sh
export ROUTESPEC_CONTAINER_CLI='["docker"]'   # or the WSL form from the main README
pnpm run delivery:journey -- --work .data/demo-contained --out .data/journey-contained.json --no-ui --contained
pnpm run demo:record -- --data .data/demo-contained/data --journey .data/journey-contained.json \
  --bundle .data/demo-contained/out/routespec-corrected-release.tar
```

The recorder refuses an uncontained journey, a bundle that is not that journey's export, any
non-GET request from the console, and any response that contains the control token or a path of
the recording machine.
