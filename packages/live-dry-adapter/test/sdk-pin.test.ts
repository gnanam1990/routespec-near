/**
 * M00 supplementary test: the installed official 1Click SDK matches the recorded pin and its
 * base URL is configurable to a local endpoint.
 *
 * No real 1Click API is contacted: the SDK is pointed at an in-test HTTP server bound to
 * 127.0.0.1 and proxy environment variables are removed before the SDK loads. No credential is
 * configured (OpenAPI.TOKEN stays undefined) and the test asserts no Authorization header is sent.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ONECLICK_SDK_PIN, ROUTESPEC_HEADERS, validateQuoteRequest } from '@routespec/contracts';

for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[key];
}

const require = createRequire(import.meta.url);

interface Received {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}

const received: Received[] = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'local loopback stub: not a provider' }));
  });
});

let base = '';
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('official 1Click SDK pin', () => {
  it('installed package version and license equal the recorded pin', () => {
    // The package `exports` map hides package.json; resolve the CJS entry and walk up from dist/.
    const pkgPath = join(dirname(dirname(require.resolve(ONECLICK_SDK_PIN.packageName))), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      name: string;
      version: string;
      license: string;
    };
    expect(pkg.name).toBe(ONECLICK_SDK_PIN.packageName);
    expect(pkg.version).toBe(ONECLICK_SDK_PIN.version);
    expect(pkg.license).toBe(ONECLICK_SDK_PIN.license);
  });

  it('exports a mutable OpenAPI.BASE whose default is the recorded provider origin', async () => {
    const sdk = await import(ONECLICK_SDK_PIN.packageName);
    expect(sdk.OpenAPI.BASE).toBe(ONECLICK_SDK_PIN.defaultBaseUrl);
    expect(sdk.OpenAPI.VERSION).toBe(ONECLICK_SDK_PIN.embeddedApiVersion);
    expect(sdk.OpenAPI.TOKEN).toBeUndefined();
  });

  it('routes getQuote to a configured local base URL with injected correlation headers', async () => {
    const sdk = await import(ONECLICK_SDK_PIN.packageName);
    sdk.OpenAPI.BASE = base;
    sdk.OpenAPI.HEADERS = async () => ({
      [ROUTESPEC_HEADERS.session]: 'session-test',
      [ROUTESPEC_HEADERS.requestId]: 'request-1',
    });
    const request = {
      dry: true,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: 'nep141:origin.test',
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: 'nep141:destination.test',
      amount: '1000000',
      refundTo: 'refund.test',
      refundType: 'ORIGIN_CHAIN',
      recipient: 'recipient.test',
      recipientType: 'DESTINATION_CHAIN',
      deadline: '2026-11-11T12:00:00Z',
    };
    // The request body is valid profile material for QUOTE_REQUEST.
    expect(validateQuoteRequest(request).material.dry).toBe(true);
    await expect(sdk.OneClickService.getQuote(request)).rejects.toThrow();
    expect(received).toHaveLength(1);
    const hit = received[0]!;
    expect(hit.method).toBe('POST');
    expect(hit.url).toBe('/v0/quote');
    expect(JSON.parse(hit.body)).toEqual(request);
    expect(hit.headers[ROUTESPEC_HEADERS.session]).toBe('session-test');
    expect(hit.headers[ROUTESPEC_HEADERS.requestId]).toBe('request-1');
    expect(hit.headers['authorization']).toBeUndefined();
  });

  it('routes getExecutionStatus to GET /v0/status with the deposit address query', async () => {
    const sdk = await import(ONECLICK_SDK_PIN.packageName);
    sdk.OpenAPI.BASE = base;
    sdk.OpenAPI.HEADERS = undefined;
    await expect(sdk.OneClickService.getExecutionStatus('deposit.sim')).rejects.toThrow();
    const hit = received.at(-1)!;
    expect(hit.method).toBe('GET');
    expect(hit.url).toBe('/v0/status?depositAddress=deposit.sim');
  });
});
