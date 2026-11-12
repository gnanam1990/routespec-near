/**
 * T-037 — Host, Origin, CORS, and token checks block browser attacks.
 *
 * A real ControlServer on a loopback socket. Every attack is a raw HTTP request carrying exactly
 * the headers a hostile page, a DNS-rebinding page, or another local origin could make a browser
 * send. After the whole attack battery the journal's row count in every table is unchanged.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RouteSpecStore } from '@routespec/store';
import { ControlServer, ControlToken } from '../src/index.ts';
import {
  PREFIX,
  errorCode,
  expectOk,
  raw,
  startHarness,
  tempDir,
  type Harness,
  type Reply,
} from './support/fixture.ts';

let h: Harness;
let consoleDir: string;
let cleanupConsole: () => void = () => undefined;

const CORS_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
];

function noCors(r: Reply): void {
  for (const name of CORS_HEADERS) expect(r.headers[name], name).toBeUndefined();
}

beforeAll(async () => {
  const t = tempDir('routespec-m08-console-');
  consoleDir = join(t.dir, 'dist');
  cleanupConsole = t.cleanup;
  mkdirSync(join(consoleDir, 'assets'), { recursive: true });
  writeFileSync(
    join(consoleDir, 'index.html'),
    '<!doctype html><title>RouteSpec</title><script type="module" src="/assets/app.js"></script>',
  );
  writeFileSync(join(consoleDir, 'assets', 'app.js'), 'export {};');
  h = await startHarness({ consoleDir, rateLimits: { authFailures: 1000 } });
});

afterAll(async () => {
  await h?.close();
  cleanupConsole();
});

describe('T-037 — Host, Origin, CORS, and token checks block browser attacks', () => {
  it('binds only literal loopback addresses and is not reachable on other interfaces', async () => {
    const t = tempDir();
    const store = RouteSpecStore.open({ path: join(t.dir, 'j.db') });
    try {
      for (const host of ['0.0.0.0', '::', 'localhost', '192.168.1.10', '']) {
        await expect(ControlServer.start({ store, host })).rejects.toMatchObject({
          code: 'RS_MODE_POLICY_DENIED',
        });
      }
    } finally {
      store.close();
      t.cleanup();
    }
    const settings = expectOk(await h.api('GET', '/settings'), 200);
    expect(settings['bindAddress']).toBe('127.0.0.1');
    const external = Object.values(networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i?.address as string);
    for (const address of external.slice(0, 2)) {
      const refused = await new Promise<string>((resolve) => {
        const req = httpRequest(
          { host: address, port: h.port, path: `${PREFIX}/settings`, timeout: 2000 },
          () => resolve('CONNECTED'),
        );
        req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'ERROR'));
        req.on('timeout', () => {
          req.destroy();
          resolve('TIMEOUT');
        });
        req.end();
      });
      expect(refused, address).not.toBe('CONNECTED');
    }
  });

  it('refuses every attack and leaves every journal table unchanged', async () => {
    const before = h.tableCounts();
    const auth = { authorization: `Bearer ${h.token}` };
    const json = { 'content-type': 'application/json', 'idempotency-key': 'attack-key-0001' };
    const body = JSON.stringify({ name: 'attacker project' });
    const attempts: Array<{ label: string; reply: Promise<Reply>; status: number; code: string }> = [];
    const attack = (label: string, status: number, code: string, r: Parameters<typeof raw>[1]) =>
      attempts.push({ label, status, code, reply: raw(h.port, r) });

    // DNS rebinding: the attacker's own name resolves to 127.0.0.1, so Host carries that name.
    for (const host of [
      `evil.example:${h.port}`,
      `127.0.0.1.nip.io:${h.port}`,
      'evil.example',
      `127.0.0.1:${h.port + 1}`,
      `localhost.evil.example:${h.port}`,
    ]) {
      attack(`rebinding host ${host} (API)`, 403, 'RS_HOST_REJECTED', {
        method: 'POST',
        path: `${PREFIX}/projects`,
        host,
        headers: { ...auth, ...json },
        body,
      });
      attack(`rebinding host ${host} (console)`, 403, 'RS_HOST_REJECTED', { method: 'GET', path: '/', host });
    }
    // HTTP/1.1 without Host is refused by the HTTP parser itself (400) before any handler runs.
    attack('missing Host', 400, '', { method: 'GET', path: `${PREFIX}/settings`, host: null, headers: auth });

    // Malicious and lookalike origins, even with a valid token.
    for (const origin of [
      'http://evil.example',
      'null',
      `http://127.0.0.1:${h.port + 1}`,
      `https://127.0.0.1:${h.port}`,
      `http://localhost.evil.example:${h.port}`,
    ]) {
      attack(`origin ${origin}`, 403, 'RS_ORIGIN_REJECTED', {
        method: 'POST',
        path: `${PREFIX}/projects`,
        headers: { ...auth, ...json, origin },
        body,
      });
      attack(`origin ${origin} read`, 403, 'RS_ORIGIN_REJECTED', {
        method: 'GET',
        path: `${PREFIX}/projects`,
        headers: { ...auth, origin },
      });
    }
    // Fetch Metadata from a cross-site or same-site (other port/subdomain) context.
    for (const site of ['cross-site', 'same-site']) {
      attack(`sec-fetch-site ${site}`, 403, 'RS_ORIGIN_REJECTED', {
        method: 'POST',
        path: `${PREFIX}/projects`,
        headers: { ...auth, ...json, 'sec-fetch-site': site },
        body,
      });
    }

    // CORS preflight: foreign origins are refused; same-origin pages never need one.
    attack('preflight foreign', 403, 'RS_ORIGIN_REJECTED', {
      method: 'OPTIONS',
      path: `${PREFIX}/projects`,
      headers: {
        origin: 'http://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    attack('preflight same origin', 405, 'RS_METHOD_NOT_ALLOWED', {
      method: 'OPTIONS',
      path: `${PREFIX}/projects`,
      headers: { origin: `http://127.0.0.1:${h.port}`, 'access-control-request-method': 'POST' },
    });

    // Missing, wrong, misplaced, and wrong-kind credentials.
    attack('no token', 401, 'RS_CONTROL_AUTH_REQUIRED', {
      method: 'POST',
      path: `${PREFIX}/projects`,
      headers: json,
      body,
    });
    attack('wrong token', 401, 'RS_CONTROL_AUTH_INVALID', {
      method: 'POST',
      path: `${PREFIX}/projects`,
      headers: { ...json, authorization: `Bearer ${new ControlToken().reveal()}` },
      body,
    });
    attack('basic auth', 401, 'RS_CONTROL_AUTH_INVALID', {
      method: 'GET',
      path: `${PREFIX}/projects`,
      headers: { authorization: `Basic ${Buffer.from(`a:${h.token}`).toString('base64')}` },
    });
    attack('token in query string', 401, 'RS_CONTROL_AUTH_INVALID', {
      method: 'GET',
      path: `${PREFIX}/projects?token=${encodeURIComponent(h.token)}`,
      headers: auth,
    });
    attack('token as cookie only', 401, 'RS_CONTROL_AUTH_REQUIRED', {
      method: 'GET',
      path: `${PREFIX}/projects`,
      headers: { cookie: `token=${h.token}` },
    });
    attack('case token header', 401, 'RS_CONTROL_AUTH_INVALID', {
      method: 'GET',
      path: `${PREFIX}/projects`,
      headers: { ...auth, 'x-routespec-case-token': 'rsct_' + 'a'.repeat(43) },
    });
    attack('case token as bearer', 401, 'RS_CONTROL_AUTH_INVALID', {
      method: 'GET',
      path: `${PREFIX}/projects`,
      headers: { authorization: `Bearer rsct_${'b'.repeat(43)}` },
    });
    attack('route enumeration without token', 401, 'RS_CONTROL_AUTH_REQUIRED', {
      method: 'GET',
      path: `${PREFIX}/does-not-exist`,
    });

    // CSRF: what an HTML form or a no-preflight fetch can send.
    for (const type of [
      'application/x-www-form-urlencoded',
      'text/plain',
      'multipart/form-data; boundary=x',
    ]) {
      attack(`csrf form ${type} without token`, 401, 'RS_CONTROL_AUTH_REQUIRED', {
        method: 'POST',
        path: `${PREFIX}/projects`,
        headers: { 'content-type': type, origin: `http://127.0.0.1:${h.port}` },
        body: 'name=attacker',
      });
      attack(`csrf form ${type} even with token`, 415, 'RS_CONTENT_TYPE_UNSUPPORTED', {
        method: 'POST',
        path: `${PREFIX}/projects`,
        headers: { ...auth, 'content-type': type, 'idempotency-key': 'attack-key-0002' },
        body: 'name=attacker',
      });
    }
    attack('csrf form from foreign page', 403, 'RS_ORIGIN_REJECTED', {
      method: 'POST',
      path: `${PREFIX}/projects`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://evil.example',
        'sec-fetch-site': 'cross-site',
      },
      body: 'name=attacker',
    });
    attack('static mutation', 405, 'RS_METHOD_NOT_ALLOWED', {
      method: 'POST',
      path: '/index.html',
      headers: { 'content-type': 'text/plain' },
      body: 'x',
    });
    attack('path traversal', 200, '', { method: 'GET', path: '/..%2f..%2fjournal.db' });
    attack('encoded traversal', 200, '', { method: 'GET', path: '/assets/..%5c..%5c..%5cjournal.db' });

    const results = await Promise.all(attempts.map(async (a) => ({ ...a, r: await a.reply })));
    for (const a of results) {
      expect(a.r.status, a.label).toBe(a.status);
      if (a.code !== '') expect(errorCode(a.r), a.label).toBe(a.code);
      noCors(a.r);
      expect(a.r.text, a.label).not.toContain(h.token);
    }
    // Traversal attempts stay inside the console directory: the shell, never the journal file.
    for (const label of ['path traversal', 'encoded traversal']) {
      const t = results.find((a) => a.label === label);
      expect(t?.r.text, label).toContain('<title>RouteSpec</title>');
      expect(t?.r.text, label).not.toContain('SQLite format');
    }
    expect(h.tableCounts()).toEqual(before);
    expect(h.store.countRows('projects')).toBe(before['projects']);
  });

  it('a genuine same-origin request with the bearer token works; responses never carry permissive CORS', async () => {
    const r = await raw(h.port, {
      method: 'POST',
      path: `${PREFIX}/projects`,
      headers: {
        authorization: `Bearer ${h.token}`,
        'content-type': 'application/json',
        'idempotency-key': 'genuine-key-0001',
        origin: `http://127.0.0.1:${h.port}`,
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({ name: 'genuine' }),
    });
    expect(r.status).toBe(201);
    noCors(r);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    const localhost = await raw(h.port, {
      method: 'GET',
      path: `${PREFIX}/projects`,
      host: `localhost:${h.port}`,
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(localhost.status).toBe(200);
  });

  it('serves the console with a strict CSP and hands the token over only in the URL fragment', async () => {
    const page = await raw(h.port, { method: 'GET', path: '/' });
    expect(page.status).toBe(200);
    const csp = String(page.headers['content-security-policy']);
    for (const directive of [
      "default-src 'none'",
      "script-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.text).not.toContain(h.token);
    const asset = await raw(h.port, { method: 'GET', path: '/assets/app.js' });
    expect(asset.headers['content-type']).toContain('text/javascript');
    const url = new URL(h.server.consoleUrl());
    expect(url.search).toBe('');
    expect(url.hash.startsWith('#token=')).toBe(true);
    expect(decodeURIComponent(url.hash.slice('#token='.length))).toBe(h.token);
    expect(url.origin).toBe(`http://127.0.0.1:${h.port}`);
  });

  it('repeated authentication failures are rate limited without touching the journal', async () => {
    const limited = await startHarness({ rateLimits: { authFailures: 5, windowMs: 60_000 } });
    try {
      const before = limited.tableCounts();
      const replies: Reply[] = [];
      for (let i = 0; i < 8; i++) {
        replies.push(
          await raw(limited.port, {
            method: 'GET',
            path: `${PREFIX}/projects`,
            headers: { authorization: `Bearer ${new ControlToken().reveal()}` },
          }),
        );
      }
      expect(replies.slice(0, 5).every((r) => r.status === 401)).toBe(true);
      expect(replies.slice(5).every((r) => r.status === 429 && errorCode(r) === 'RS_RATE_LIMITED')).toBe(
        true,
      );
      // The failure budget throttles failing credentials only; the genuine token keeps working
      // (a global lockout would let any local process deny the operator; SEC vuln-0003).
      const genuine = await limited.api('GET', '/projects');
      expect(genuine.status).toBe(200);
      expect(limited.tableCounts()).toEqual(before);
    } finally {
      await limited.close();
    }
  });
});
