/**
 * M51 — the fidelity matrix's token-list read and the hard request cap (ADR-0027).
 *
 * The default adapter is unchanged: `GET /v0/tokens` stays denied (T-021). Only an adapter started
 * with an explicit token-list budget forwards that one read, with no body, no query and no
 * provider credential, over the same pinned egress. A session can never be started with a combined
 * budget above the hard cap of 40 upstream requests.
 *
 * The upstream here is the loopback emulator (SIMULATED); nothing leaves the machine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AdapterRefused,
  LIVE_DRY_HARD_REQUEST_CAP,
  classifyTokenListRequest,
  isIssuedTokenListAllowance,
  type LaunchedAdapter,
} from '../src/index.ts';
import { createTestPki, type TestPki } from './support/certs.ts';
import {
  PINNED_HOST,
  canaryJwt,
  launchTestAdapter,
  quoteRequest,
  raw,
  type ChildReport,
} from './support/harness.ts';
import { startUpstream, type Upstream } from './support/upstream.ts';

const req = (method: string, target: string, body = '', headers: Record<string, string> = {}) => ({
  method,
  target,
  headers,
  body: Buffer.from(body, 'utf8'),
});

describe('M51 token-list classifier (pure)', () => {
  it('allows only a bare GET /v0/tokens', () => {
    const ok = classifyTokenListRequest(req('GET', '/v0/tokens'));
    expect(ok.allowed).toBe(true);
    expect(isIssuedTokenListAllowance(ok)).toBe(true);
    expect(isIssuedTokenListAllowance({ ...ok })).toBe(false);
  });

  it.each([
    ['query', req('GET', '/v0/tokens?ondoTokens=true'), 'QUERY_NOT_ALLOWED'],
    ['body', req('GET', '/v0/tokens', '{"dry":false}'), 'BODY_NOT_ALLOWED'],
    ['method', req('POST', '/v0/tokens'), 'METHOD_NOT_ALLOWLISTED'],
    ['other path', req('GET', '/v0/status'), 'NOT_TOKEN_LIST_ROUTE'],
    ['trailing slash', req('GET', '/v0/tokens/'), 'NOT_TOKEN_LIST_ROUTE'],
    ['encoded', req('GET', '/v0/%74okens'), 'NOT_TOKEN_LIST_ROUTE'],
    ['encoding', req('GET', '/v0/tokens', '', { 'content-encoding': 'gzip' }), 'BODY_ENCODED'],
  ])('denies %s', (_name, request, reason) => {
    const out = classifyTokenListRequest(request);
    expect(out.allowed).toBe(false);
    if (!out.allowed) {
      expect(out.reason).toBe(reason);
      expect(out.boundary).toEqual({
        credentialAttached: false,
        dnsAttempted: false,
        socketAttempted: false,
        upstreamAttempted: false,
        upstreamClientInvoked: false,
      });
    }
  });
});

describe('M51 token-list read through the adapter (loopback upstream)', () => {
  const jwt = canaryJwt(3600, 'm51canary');
  let pki: TestPki;
  let upstream: Upstream;
  let adapter: LaunchedAdapter;
  const tokens = [{ assetId: 'nep141:a.test', decimals: 6, blockchain: 'near', symbol: 'AAA', price: 1 }];

  beforeAll(async () => {
    pki = createTestPki(PINNED_HOST);
    upstream = await startUpstream(pki.pinned, 'quote');
    upstream.tokens = tokens;
    adapter = await launchTestAdapter({
      test: { kind: 'loopback-tls', port: upstream.port, ca: pki.caCert },
      jwt,
      maxProbes: 1,
      maxTokenListFetches: 1,
    });
  }, 60_000);
  afterAll(async () => {
    await adapter.close().catch(() => undefined);
    await upstream.close();
  });

  it('a query string is denied before any egress', async () => {
    const res = await raw(adapter, { method: 'GET', path: '/v0/tokens?ondoTokens=true' });
    expect(res.status).toBe(403);
    expect(upstream.received).toHaveLength(0);
  });

  it('forwards one bare GET without the provider credential and returns the list', async () => {
    const res = await raw(adapter, {
      method: 'GET',
      path: '/v0/tokens',
      headers: { authorization: 'Bearer client-side-m51-canary' },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(tokens);
    expect(upstream.received).toHaveLength(1);
    const hit = upstream.received[0]!;
    expect(hit.method).toBe('GET');
    expect(hit.url).toBe('/v0/tokens');
    expect(hit.body).toBe('');
    expect([...hit.rawHeaderNames].sort()).toEqual(
      ['accept', 'accept-encoding', 'connection', 'host', 'user-agent'].sort(),
    );
    expect(JSON.stringify(hit.headers)).not.toContain('canary');
    const report = await adapter.report<ChildReport>();
    expect(report.credentialAttachments).toBe(0);
    expect(report.counters.tokenListForwarded).toBe(1);
    expect(report.counters.forwarded).toBe(0);
  });

  it('the token-list budget is one read per session', async () => {
    const res = await raw(adapter, { method: 'GET', path: '/v0/tokens' });
    expect(res.status).toBe(403);
    expect((res.json?.['error'] as { details: { reason: string } }).details.reason).toBe(
      'TOKEN_LIST_BUDGET_EXHAUSTED',
    );
    expect(upstream.received).toHaveLength(1);
  });

  it('the dry-quote path still works beside it and still attaches the credential', async () => {
    const res = await raw(adapter, {
      method: 'POST',
      path: '/v0/quote',
      body: JSON.stringify(quoteRequest()),
    });
    expect(res.status).toBe(200);
    expect(upstream.received).toHaveLength(2);
    expect(upstream.received[1]!.headers['authorization']).toBe(`Bearer ${jwt}`);
  });
});

describe('M51 hard request cap', () => {
  it('is 40', () => {
    expect(LIVE_DRY_HARD_REQUEST_CAP).toBe(40);
  });

  it('an adapter whose combined budget exceeds the cap refuses to start', async () => {
    await expect(
      launchTestAdapter({ test: { kind: 'deny-all' }, maxProbes: 40, maxTokenListFetches: 1 }),
    ).rejects.toMatchObject({ reason: 'REQUEST_CAP_EXCEEDED' });
    await expect(launchTestAdapter({ test: { kind: 'deny-all' }, maxProbes: 41 })).rejects.toBeInstanceOf(
      AdapterRefused,
    );
  });

  it('a budget exactly at the cap starts', async () => {
    const adapter = await launchTestAdapter({
      test: { kind: 'deny-all' },
      maxProbes: 39,
      maxTokenListFetches: 1,
    });
    await adapter.close();
  });
});
