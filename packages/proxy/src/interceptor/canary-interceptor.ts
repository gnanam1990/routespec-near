/**
 * Reviewed canary effect interceptor artifact (M02 deliverable 9; profile in ../interceptor-channel.ts).
 *
 * Launched by `InterceptorHost` as a separate process with an inherited IPC pipe. It is
 * deliberately self-contained (Node built-ins only, no workspace imports) so its file digest is
 * the whole reviewed artifact. It has no outbound client: it only listens on 127.0.0.1 and
 * talks to its parent over the inherited pipe.
 *
 * Behavior:
 * 1. On `bind` (private channel key + exact build/gate/case/session/epoch/policy/manifest
 *    binding + supported sinks) it opens a loopback sink listener and reports its port.
 * 2. A subject effect attempt `POST /sink/<sinkClass>` with `{effectId, runOperationId?}` is
 *    framed as ATTEMPTED and handed to the parent for journaling; the subject receives no
 *    answer until the parent acknowledges the frame (journal handoff before any response).
 * 3. Before `release` the attempt is denied (BLOCKED, 409). After `release` (declared
 *    completion accepted upstream of this process) it is RELEASED to a no-effect canary (202):
 *    no real target is ever invoked. Any unacknowledged frame fails closed (503).
 * 4. On `teardown` it closes the listener, says `bye`, and exits.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

interface Binding {
  readonly interceptorInstanceId: string;
  readonly buildRevisionId: string;
  readonly gateRunId: string;
  readonly caseRunId: string;
  readonly sessionId: string;
  readonly fencingEpoch: number;
  readonly policyDigest: string;
  readonly manifestDigest: string;
  readonly interceptorProfileDigest: string;
  readonly sinkEffects: Readonly<Record<string, string>>;
}

type ParentMsg =
  | { type: 'bind'; channelKey: string; binding: Binding }
  | { type: 'ack'; sequence: number; ok: boolean; code: string | null }
  | { type: 'release' }
  | { type: 'teardown' };

const MAX_BODY = 4096;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
let channelKey: string | null = null;
let binding: Binding | null = null;
let released = false;
let sequence = 0;
const pending = new Map<number, (ok: boolean, code: string | null) => void>();

function send(message: Record<string, unknown>): void {
  if (process.connected) process.send?.(message);
}

function reply(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function frame(
  action: 'ATTEMPTED' | 'BLOCKED' | 'RELEASED',
  sinkClass: string,
  effectId: string,
  runOperationId: string | null,
) {
  const b = binding as Binding;
  sequence += 1;
  return {
    sequence,
    buildRevisionId: b.buildRevisionId,
    gateRunId: b.gateRunId,
    caseRunId: b.caseRunId,
    sessionId: b.sessionId,
    fencingEpoch: b.fencingEpoch,
    policyDigest: b.policyDigest,
    manifestDigest: b.manifestDigest,
    interceptorProfileDigest: b.interceptorProfileDigest,
    runOperationId,
    sinkClass,
    effectId,
    effectType: b.sinkEffects[sinkClass] ?? 'UNDECLARED',
    action,
    virtualMs: null,
  };
}

function handOff(f: ReturnType<typeof frame>): Promise<{ ok: boolean; code: string | null }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(f.sequence);
      resolve({ ok: false, code: 'RS_CHANNEL_TIMEOUT' });
    }, 5000);
    pending.set(f.sequence, (ok, code) => {
      clearTimeout(timer);
      resolve({ ok, code });
    });
    send({ type: 'frame', channelKey, frame: f });
  });
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function onSink(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const match = /^\/sink\/([A-Za-z0-9._-]{1,64})$/.exec(req.url ?? '');
  if (req.method !== 'POST' || !match || binding === null) {
    reply(res, 404, { denied: true, reason: 'UNKNOWN_SINK_ROUTE' });
    return;
  }
  const sinkClass = match[1] as string;
  const body = await readBody(req);
  const effectId = body?.['effectId'];
  const runOperationId = body?.['runOperationId'] ?? null;
  if (
    typeof effectId !== 'string' ||
    !ID.test(effectId) ||
    (runOperationId !== null && typeof runOperationId !== 'string')
  ) {
    reply(res, 400, { denied: true, reason: 'MALFORMED_EFFECT' });
    return;
  }
  const attempted = await handOff(frame('ATTEMPTED', sinkClass, effectId, runOperationId as string | null));
  if (!attempted.ok) {
    reply(res, attempted.code === 'RS_SINK_UNSUPPORTED' ? 403 : 503, {
      denied: true,
      reason: attempted.code,
    });
    return;
  }
  const action = released ? 'RELEASED' : 'BLOCKED';
  const decided = await handOff(frame(action, sinkClass, effectId, runOperationId as string | null));
  if (!decided.ok || action === 'BLOCKED') {
    reply(res, decided.ok ? 409 : 503, {
      denied: true,
      reason: decided.ok ? 'EFFECT_NOT_RELEASED' : decided.code,
    });
    return;
  }
  // Released to the no-effect canary: acknowledged, nothing is forwarded anywhere.
  reply(res, 202, { denied: false, canary: true });
}

const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, (req, res) => {
  void onSink(req, res).catch(() => {
    if (!res.headersSent) reply(res, 503, { denied: true, reason: 'INTERCEPTOR_ERROR' });
  });
});

process.on('message', (raw: unknown) => {
  const msg = raw as ParentMsg;
  if (msg.type === 'bind' && channelKey === null) {
    channelKey = msg.channelKey;
    binding = msg.binding;
    server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
      const address = server.address();
      send({ type: 'ready', sinkPort: typeof address === 'object' && address !== null ? address.port : 0 });
    });
  } else if (msg.type === 'ack') {
    const resolve = pending.get(msg.sequence);
    pending.delete(msg.sequence);
    resolve?.(msg.ok, msg.code);
  } else if (msg.type === 'release') {
    released = true;
    send({ type: 'released' });
  } else if (msg.type === 'teardown') {
    server.close(() => {
      send({ type: 'bye' });
      process.disconnect?.();
      setImmediate(() => process.exit(0));
    });
  }
});
process.on('disconnect', () => process.exit(0));
send({ type: 'hello', pid: process.pid });
