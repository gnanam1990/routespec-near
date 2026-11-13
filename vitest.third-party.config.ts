import { defineConfig } from 'vitest/config';

/**
 * M48 third-party example suite: runs the pinned public example clients for real inside the
 * subject container. It needs a Linux container engine and the pinned files fetched once with
 * `pnpm run examples:fetch` (network). Each test skips itself as `NOT_RUN: <reason>` when either
 * is missing. It is separate from `test:containment` because that suite must run in full from an
 * offline clean clone, where fetched files cannot exist. Run with `pnpm run test:third-party`.
 */
export default defineConfig({
  test: {
    include: ['packages/delivery/third-party-test/**/*.runtime.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 10 * 60_000,
    hookTimeout: 10 * 60_000,
    reporters: ['default'],
  },
});
