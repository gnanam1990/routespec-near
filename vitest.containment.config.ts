import { defineConfig } from 'vitest/config';

/**
 * M14 containment suite: tests that need a real Linux container engine (Docker Engine, for
 * example inside WSL 2). Each test skips itself as `NOT_RUN: <reason>` when detection finds no
 * usable engine or image, so this suite never passes or fails without a runtime. Run with
 * `pnpm run test:containment`; the engine command comes from `ROUTESPEC_CONTAINER_CLI`.
 */
export default defineConfig({
  test: {
    include: ['packages/*/runtime-test/**/*.runtime.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 5 * 60_000,
    hookTimeout: 5 * 60_000,
    reporters: ['default'],
  },
});
