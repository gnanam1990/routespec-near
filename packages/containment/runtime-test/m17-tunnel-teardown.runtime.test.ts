/**
 * M17 — no host-side tunnel connection outlives the subject's side of it (T-036 container-host
 * run, RP-06). Needs a real engine; skipped as `NOT_RUN: <reason>` without one.
 *
 * Found while running T-036 against Docker Engine in WSL 2: a subject that closes a tunnel
 * connection at once can end it before the launcher's own connection to the host target is
 * established. That host-side connection then stayed open to the target (the effect sink) after
 * the subject had gone, and kept the interceptor's orderly teardown waiting. Every host-side
 * connection must end when the subject ends its side, and none may survive the container.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { ContainedSubject, detectContainerRuntime, type RuntimeStatus } from '../src/index.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PROBE = fileURLToPath(new URL('../test/support/escape-probe.mjs', import.meta.url));
const CONTAINER_PORT = 9351;

let runtime: RuntimeStatus;
let server: Server;
let port = 0;
const open = new Set<Socket>();
let accepted = 0;

beforeAll(async () => {
  runtime = await detectContainerRuntime();
  server = createServer((s) => {
    accepted++;
    open.add(s);
    s.on('error', () => s.destroy());
    s.on('close', () => open.delete(s));
    // A target that waits for request bytes and closes only when the client ends its side
    // (default half-open handling, like the interceptor's HTTP listener).
  });
  await new Promise<void>((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve));
  port = (server.address() as { port: number }).port;
}, 120_000);

afterAll(async () => {
  for (const s of open) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function needRuntime(ctx: TestContext): Extract<RuntimeStatus, { status: 'AVAILABLE' }> {
  if (runtime.status !== 'AVAILABLE') {
    ctx.skip(`NOT_RUN: ${runtime.reason}${runtime.detail ? ` (${runtime.detail})` : ''}`);
    throw new Error('unreachable');
  }
  return runtime;
}

const settle = async (predicate: () => boolean, ms = 5000) => {
  for (let waited = 0; waited < ms && !predicate(); waited += 50) await new Promise((r) => setTimeout(r, 50));
};

describe('M17 — tunnel connections end with the subject side', () => {
  it('connections the subject closes at once leave no host-side connection open', async (ctx) => {
    const rt = needRuntime(ctx);
    const s = await ContainedSubject.launch({
      cli: rt.cli,
      imageId: rt.imageId,
      root: ROOT,
      entry: PROBE,
      tunnels: [{ containerPort: CONTAINER_PORT, hostPort: port, purpose: 'effect-sink' }],
    });
    let teardown;
    try {
      await s.waitFor('loaded', 60_000);
      const r = await s.request({ type: 'connect-close', port: CONTAINER_PORT, count: 20 });
      expect(r['results']).toEqual(Array.from({ length: 20 }, () => 'CLOSED'));
      await settle(() => accepted >= 20 && open.size === 0);
      // While the container still runs: every host-side connection has ended.
      expect(open.size).toBe(0);
    } finally {
      teardown = await s.stop();
    }
    expect(teardown.removed).toBe(true);
    await settle(() => open.size === 0);
    expect(open.size).toBe(0);
    expect(teardown.tunnels['effect-sink']?.connections).toBe(accepted);
  });
});
