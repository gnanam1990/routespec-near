import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

/**
 * Most test files start real child processes (the CLI, subject clients, control servers) and
 * some hold real-time leases. One worker per core oversubscribes the CPU several times over on a
 * many-core host, which turned into lease expiries and 60 s timeouts. Half the cores, at most 8,
 * keeps every file's own processes responsive; `ROUTESPEC_TEST_WORKERS` overrides it.
 */
const fromEnv = Number(process.env['ROUTESPEC_TEST_WORKERS']);
const maxWorkers =
  Number.isInteger(fromEnv) && fromEnv > 0
    ? fromEnv
    : Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    pool: 'forks',
    maxWorkers,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
});
