import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVICE = fileURLToPath(new URL('./support/service.ts', import.meta.url));

/**
 * Starts the real control service and waits for its seeding to finish. The origin, the ephemeral
 * control token, and the seeded record ids reach the test workers through the environment only.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const child = fork(SERVICE, [], {
    execArgv: ['--no-warnings'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env },
  });
  const ready = await new Promise<{ origin: string; token: string; seed: unknown }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('control service did not finish seeding in 5 minutes')),
      300_000,
    );
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`control service exited during seeding (${String(code)})`));
    });
    child.on('message', (m) => {
      const msg = m as { type?: string; origin: string; token: string; seed: unknown };
      if (msg.type === 'ready') {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
  process.env['ROUTESPEC_REAL_ORIGIN'] = ready.origin;
  process.env['ROUTESPEC_REAL_TOKEN'] = ready.token;
  process.env['ROUTESPEC_REAL_SEED'] = JSON.stringify(ready.seed);
  return async () => {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.send({ type: 'stop' });
      setTimeout(() => {
        child.kill();
        resolve();
      }, 10_000);
    });
  };
}
