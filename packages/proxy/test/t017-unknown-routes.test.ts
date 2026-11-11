/**
 * T-017 — Unknown proxy routes never pass through.
 *
 * Covers FR-03, FR-04. Against a separately launched networkless proxy process (network
 * tripwire installed before anything else), unknown paths, unsupported/prohibited SDK routes,
 * wrong methods, non-normal request targets, the control prefix, absolute-form proxy requests,
 * foreign hosts, browser origins, and unsupported content types/encodings each receive a typed
 * local denial with `upstreamAttempted: false`, even when valid case credentials are attached.
 * Nothing is journaled as an exchange and the proxy process records zero DNS/socket attempts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ONECLICK_SDK_ROUTES } from '@routespec/contracts';
import { adapterHeaders, quoteBody, send } from './support/gate.ts';
import { launchProxyChild, type ProxyChild } from './support/launch.ts';

let proxy: ProxyChild;

beforeAll(async () => {
  proxy = await launchProxyChild({ scenario: 'happy-path', mode: 'SIMULATE' });
});
afterAll(async () => {
  await proxy?.close();
});

describe('T-017 — Unknown proxy routes never pass through', () => {
  it('binds the IPv4 loopback address only', () => {
    expect(proxy.address.address).toBe('127.0.0.1');
    expect(proxy.address.family).toBe('IPv4');
  });

  it('denies every non-profile SDK route and unknown path with a typed local error', async () => {
    const creds = adapterHeaders(proxy.credentials, { requestId: 'unknown-1', logicalJob: 'job-1' });
    const sdkUnsupported = ONECLICK_SDK_ROUTES.filter((r) => r.profile !== 'SUPPORTED').map((r) => ({
      method: r.method,
      path: r.path.replace('{orderId}', 'order-1'),
    }));
    const others = [
      { method: 'GET', path: '/v1/quote' },
      { method: 'POST', path: '/v0/quote/' },
      { method: 'POST', path: '/v0/QUOTE' },
      { method: 'PUT', path: '/v0/quote' },
      { method: 'DELETE', path: '/v0/status' },
      { method: 'GET', path: '/v0/deposit/submit' },
      { method: 'PATCH', path: '/v0/deposit/submit' },
      { method: 'POST', path: '/v0/../v0/quote' },
      { method: 'POST', path: '/v0/%71uote' },
      { method: 'GET', path: '/__routespec/v1/projects' },
      { method: 'POST', path: '/__routespec/v1/effects/observe' },
      { method: 'GET', path: '/' },
      { method: 'OPTIONS', path: '/v0/quote' },
    ];
    for (const target of [...sdkUnsupported, ...others]) {
      for (const headers of [{}, creds]) {
        const r = await send(proxy.port, { ...target, headers, body: target.method === 'GET' ? undefined : { dry: true } });
        expect(r.status, `${target.method} ${target.path}`).toBe(404);
        expect(r.code).toBe('RS_UNSUPPORTED_ROUTE');
        const details = (r.body as { error: { details: Record<string, unknown> } }).error.details;
        expect(details['upstreamAttempted']).toBe(false);
      }
    }
  });

  it('denies absolute-form proxy targets, foreign hosts, and browser origins', async () => {
    const absolute = await send(proxy.port, {
      method: 'POST',
      path: 'http://1click.chaindefuser.com/v0/quote',
      host: '1click.chaindefuser.com',
      body: quoteBody(),
    });
    expect(absolute.code).toBe('RS_HOST_REJECTED');
    const sameHostAbsolute = await send(proxy.port, {
      method: 'POST',
      path: `http://127.0.0.1:${proxy.port}/v0/quote`,
      body: quoteBody(),
    });
    expect(sameHostAbsolute.code).toBe('RS_UNSUPPORTED_ROUTE');
    const rebinding = await send(proxy.port, { method: 'POST', path: '/v0/quote', host: 'attacker.example:80', body: quoteBody() });
    expect(rebinding.code).toBe('RS_HOST_REJECTED');
    const browser = await send(proxy.port, {
      method: 'POST',
      path: '/v0/quote',
      headers: { origin: 'http://localhost:5173' },
      body: quoteBody(),
    });
    expect(browser.code).toBe('RS_ORIGIN_REJECTED');
  });

  it('denies unsupported content types and compressed bodies before parsing', async () => {
    const creds = adapterHeaders(proxy.credentials, { requestId: 'ct-1', logicalJob: 'job-1' });
    const text = await send(proxy.port, {
      method: 'POST',
      path: '/v0/quote',
      headers: { ...creds, 'content-type': 'text/plain' },
      rawBody: JSON.stringify(quoteBody()),
    });
    expect(text.status).toBe(415);
    expect(text.code).toBe('RS_CONTENT_TYPE_UNSUPPORTED');
    const gzip = await send(proxy.port, {
      method: 'POST',
      path: '/v0/quote',
      headers: { ...creds, 'content-encoding': 'gzip' },
      rawBody: JSON.stringify(quoteBody()),
    });
    expect(gzip.code).toBe('RS_CONTENT_TYPE_UNSUPPORTED');
  });

  it('journaled no exchange, recorded every denial with no upstream facts, and made zero network attempts', async () => {
    const report = await proxy.report();
    expect(report.exchanges).toEqual([]);
    expect(report.runOperations).toEqual([]);
    expect(report.denials.length).toBeGreaterThanOrEqual(30);
    for (const d of report.denials) {
      expect(d).toMatchObject({ upstreamAttempted: false, credentialAttached: false, dnsAttempted: false });
    }
    expect(report.stats.upstreamAttempts).toBe(0);
    expect(report.tripwire.total, report.tripwire.detail.join(',')).toBe(0);
    // Exactly one IP-literal lookup: Node's server.listen({ host: '127.0.0.1' }) (no resolver call).
    expect(report.tripwire.literalLookups).toBe(1);
  });
});
