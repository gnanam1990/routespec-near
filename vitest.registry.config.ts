import { defineConfig } from 'vitest/config';

/**
 * M47 registry suite: tests against the routespec-registry contract deployed to a local NEAR
 * sandbox node, which runs in a Linux container (the engine command comes from
 * `ROUTESPEC_CONTAINER_CLI`). One node is started for the whole run; every test file deploys its
 * own registry account. Without a container engine each test skips itself as `NOT_RUN: <reason>`.
 * Nothing here contacts NEAR testnet or mainnet. Run with `pnpm run test:registry`.
 */
export default defineConfig({
  test: {
    include: ['packages/*/sandbox-test/**/*.sandbox.test.ts'],
    globalSetup: ['packages/registry/sandbox-test/global-setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 5 * 60_000,
    hookTimeout: 10 * 60_000,
    reporters: ['default'],
  },
});
