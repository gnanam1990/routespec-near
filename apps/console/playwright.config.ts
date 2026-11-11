import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

// Ephemeral per-run control token for the loopback contract fixture. It is passed to the
// fixture server and test workers through the environment and never written to disk.
const port = Number(process.env['FIXTURE_PORT'] ?? 4319);
process.env['FIXTURE_PORT'] = String(port);
process.env['FIXTURE_CONTROL_TOKEN'] ??= randomBytes(24).toString('base64url');

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  // One worker: tests switch the fixture's offline/delay mode, which is server-wide state.
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: 'pnpm exec vite build && node e2e/fixture/server.ts',
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      FIXTURE_PORT: String(port),
      FIXTURE_CONTROL_TOKEN: process.env['FIXTURE_CONTROL_TOKEN'],
    },
  },
});
