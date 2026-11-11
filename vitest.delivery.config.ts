import { defineConfig } from 'vitest/config';

/**
 * M12 delivery suite (T-054, T-055): clones the exact commit into an empty directory, installs
 * offline, builds, and runs the full local product journey from that install. Slow by nature
 * (several minutes), so it is a separate command: `pnpm run test:delivery`.
 */
export default defineConfig({
  test: {
    include: ['packages/delivery/e2e/**/*.e2e.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 20 * 60_000,
    hookTimeout: 30 * 60_000,
    reporters: ['default'],
  },
});
