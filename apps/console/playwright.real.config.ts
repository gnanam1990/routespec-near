import { defineConfig, devices } from '@playwright/test';

/**
 * Console acceptance suite (M09: T-047..T-051) against the real control service. The global
 * setup starts `e2e-real/support/service.ts` in its own process: the real ControlServer, the
 * SQLite journal, and records produced by the real runner, kernel, and regression pipeline,
 * with the built console served same-origin under the production CSP.
 */
export default defineConfig({
  testDir: './e2e-real',
  testMatch: /.*\.spec\.ts$/,
  globalSetup: './e2e-real/global-setup.ts',
  fullyParallel: false,
  // One worker: journeys drive one shared service and its journal clock.
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  timeout: 180_000,
  expect: { timeout: 15_000 },
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
});
