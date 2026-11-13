import { defineConfig } from 'vitest/config';

/**
 * M54 distribution suite: builds the npm package from the compiled workspace, installs the tarball
 * offline into an empty consumer directory outside the repository, and runs the installed
 * commands for real (the self-gate configuration through the installed CI entry point, and the
 * offline verification of the committed contained-run bundle). It also builds the static console
 * demo and drives it in Chromium. Run with `pnpm run test:distribution`.
 */
export default defineConfig({
  test: {
    include: ['packages/distribution/dist-test/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 10 * 60_000,
    hookTimeout: 10 * 60_000,
    reporters: ['default'],
  },
});
