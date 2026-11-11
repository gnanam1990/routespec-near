/**
 * T-038 — SSRF and redirect targets are denied.
 *
 * Covers FR-16, NFR-02. Private, link-local, cloud-metadata, loopback, IP-literal, CGNAT,
 * documentation, transition and DNS-rebound targets, alternate schemes and ports, redirects,
 * untrusted or mismatched certificates, encoded/oversize/slow responses and proxy environment
 * variables are all exercised against the separately launched adapter. Evidence per case: the
 * injected transport's call log (which address the adapter pinned, how often it resolved), the
 * loopback upstream emulator's own TLS/request counters, a trap listener standing in for a proxy,
 * the adapter counters, and the adapter-process network tripwire.
 *
 * Networkless: the only sockets are loopback ones. Scripted resolver answers stand in for DNS;
 * the connection itself is real TLS (SNI = pinned host, certificate validation on) to a loopback
 * emulator presenting a run-time test-CA certificate for the pinned host.
 */
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyResolvedAddress,
  compileUpstreamOrigin,
  pinResolvedAddresses,
  sanitizedAdapterEnv,
  type LaunchedAdapter,
} from '../src/index.ts';
import { createTestPki, type TestPki } from './support/certs.ts';
import {
  PINNED_HOST,
  canaryJwt,
  launchTestAdapter,
  quoteRequest,
  raw,
  tempDir,
  type ChildReport,
} from './support/harness.ts';
import { startUpstream, type Upstream } from './support/upstream.ts';

describe('T-038 upstream origin compilation', () => {
  const rejected: Array<[string, string]> = [
    ['http://1click.chaindefuser.com', 'SCHEME_NOT_HTTPS'],
    ['ftp://1click.chaindefuser.com', 'SCHEME_NOT_HTTPS'],
    ['file:///etc/passwd', 'SCHEME_NOT_HTTPS'],
    ['ws://1click.chaindefuser.com', 'SCHEME_NOT_HTTPS'],
    ['https://user:pw@1click.chaindefuser.com', 'USERINFO_PRESENT'],
    ['https://1click.chaindefuser.com:8443', 'PORT_NOT_DEFAULT'],
    ['https://1click.chaindefuser.com/v0', 'PATH_OR_QUERY_PRESENT'],
    ['https://1click.chaindefuser.com/?x=1', 'PATH_OR_QUERY_PRESENT'],
    ['https://127.0.0.1', 'IP_LITERAL_HOST'],
    ['https://169.254.169.254', 'IP_LITERAL_HOST'],
    ['https://[::1]', 'IP_LITERAL_HOST'],
    ['https://[fd00:ec2::254]', 'IP_LITERAL_HOST'],
    ['https://2130706433', 'IP_LITERAL_HOST'],
    ['https://0x7f.0.0.1', 'IP_LITERAL_HOST'],
    ['https://localhost', 'SINGLE_LABEL_HOST'],
    ['https://api.localhost', 'LOCAL_ONLY_HOST'],
    ['https://metadata.google.internal', 'LOCAL_ONLY_HOST'],
    ['https://1click.chaindefuser.com.', 'TRAILING_DOT_HOST'],
    ['https://1click.chaindefuser.com.evil.example', 'ORIGIN_NOT_PINNED'],
    ['https://evil.example', 'ORIGIN_NOT_PINNED'],
    ['not a url', 'ORIGIN_MALFORMED'],
  ];
  it.each(rejected)('%s is refused (%s)', (url, reason) => {
    let caught: unknown;
    try {
      compileUpstreamOrigin(url);
    } catch (error) {
      caught = error;
    }
    expect((caught as { details?: Record<string, unknown> }).details?.['reason']).toBe(reason);
  });

  it('only the pinned profile origin compiles', () => {
    expect(compileUpstreamOrigin('https://1click.chaindefuser.com')).toEqual({
      origin: 'https://1click.chaindefuser.com',
      hostname: PINNED_HOST,
      port: 443,
    });
    expect(compileUpstreamOrigin('https://1CLICK.chaindefuser.com/').hostname).toBe(PINNED_HOST);
  });
});

describe('T-038 resolved-address classification', () => {
  const forbidden: Array<[string, string]> = [
    ['127.0.0.1', 'LOOPBACK'],
    ['127.255.0.9', 'LOOPBACK'],
    ['0.0.0.0', 'THIS_NETWORK'],
    ['10.1.2.3', 'PRIVATE'],
    ['172.16.0.1', 'PRIVATE'],
    ['172.31.255.255', 'PRIVATE'],
    ['192.168.1.1', 'PRIVATE'],
    ['169.254.169.254', 'LINK_LOCAL_OR_METADATA'],
    ['100.64.0.1', 'CGNAT'],
    ['100.100.100.200', 'CGNAT'],
    ['192.0.2.10', 'DOCUMENTATION'],
    ['198.51.100.7', 'DOCUMENTATION'],
    ['203.0.113.9', 'DOCUMENTATION'],
    ['198.18.0.1', 'BENCHMARKING'],
    ['224.0.0.1', 'MULTICAST'],
    ['240.0.0.1', 'RESERVED'],
    ['255.255.255.255', 'RESERVED'],
    ['::1', 'LOOPBACK'],
    ['::', 'UNSPECIFIED'],
    ['::ffff:127.0.0.1', 'IPV4_MAPPED'],
    ['::ffff:169.254.169.254', 'IPV4_MAPPED'],
    ['::ffff:8.8.8.8', 'IPV4_MAPPED'],
    ['64:ff9b::a9fe:a9fe', 'NAT64'],
    ['2002:a9fe:a9fe::1', 'TRANSITION_6TO4'],
    ['2001:0:4136:e378::1', 'IETF_PROTOCOL'],
    ['2001:db8::1', 'DOCUMENTATION'],
    ['fd00:ec2::254', 'UNIQUE_LOCAL_OR_METADATA'],
    ['fc00::1', 'UNIQUE_LOCAL_OR_METADATA'],
    ['fe80::1', 'LINK_LOCAL'],
    ['fe80::1%eth0', 'SCOPED_ADDRESS'],
    ['ff02::1', 'MULTICAST'],
    ['4000::1', 'NOT_GLOBAL_UNICAST'],
    ['1click.chaindefuser.com', 'NOT_AN_IP_ADDRESS'],
  ];
  it.each(forbidden)('%s is forbidden (%s)', (address, reason) => {
    const v = classifyResolvedAddress(address);
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe(reason);
  });

  it.each(['8.8.8.8', '1.1.1.1', '104.18.0.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e'])(
    '%s is global unicast and allowed',
    (address) => expect(classifyResolvedAddress(address).allowed).toBe(true),
  );

  it('one forbidden answer rejects the whole answer set', () => {
    expect(() =>
      pinResolvedAddresses([
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.7', family: 4 },
      ]),
    ).toThrow(/forbidden address/);
    expect(() => pinResolvedAddresses([])).toThrow(/no address/);
    expect(pinResolvedAddresses([{ address: '8.8.4.4', family: 4 }])).toEqual({
      address: '8.8.4.4',
      family: 4,
    });
  });
});

describe('T-038 launch environment', () => {
  it('the launcher passes no proxy, TLS-override, extra-CA or NODE_OPTIONS variables', () => {
    const env = sanitizedAdapterEnv(
      {
        PATH: '/bin',
        SystemRoot: 'C:\\Windows',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        HTTP_PROXY: 'http://127.0.0.1:9',
        NO_PROXY: '*',
        NODE_USE_ENV_PROXY: '1',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        NODE_EXTRA_CA_CERTS: '/tmp/ca.pem',
        NODE_OPTIONS: '--require ./inject.js',
        ROUTESPEC_PROVIDER_JWT: 'jwt-value',
      },
      { passProviderJwt: false },
    );
    expect(env).toEqual({ PATH: '/bin', SystemRoot: 'C:\\Windows' });
    expect(sanitizedAdapterEnv({ ROUTESPEC_PROVIDER_JWT: 'jwt-value' }, { passProviderJwt: true })).toEqual({
      ROUTESPEC_PROVIDER_JWT: 'jwt-value',
    });
  });

  it('the adapter refuses to start with TLS validation disabled or extra trust roots', async () => {
    await expect(
      launchTestAdapter({ test: { kind: 'deny-all' }, extraEnv: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } }),
    ).rejects.toMatchObject({ reason: 'TLS_VALIDATION_DISABLED' });
    await expect(
      launchTestAdapter({
        test: { kind: 'deny-all' },
        extraEnv: { NODE_EXTRA_CA_CERTS: 'C:\\nonexistent\\ca.pem' },
      }),
    ).rejects.toMatchObject({ reason: 'EXTRA_TRUST_ROOTS_CONFIGURED' });
  });
});

describe('T-038 separately launched adapter egress', () => {
  let pki: TestPki;
  let upstream: Upstream;
  let untrusted: Upstream;
  let wrongHost: Upstream;
  let trap: TcpServer;
  let trapConnections = 0;
  let trapPort = 0;
  const open: LaunchedAdapter[] = [];

  beforeAll(async () => {
    pki = createTestPki(PINNED_HOST);
    upstream = await startUpstream(pki.pinned);
    untrusted = await startUpstream(pki.untrusted);
    wrongHost = await startUpstream(pki.wrongHost);
    trap = createTcpServer((s) => {
      trapConnections++;
      s.destroy();
    });
    await new Promise<void>((resolve) => trap.listen(0, '127.0.0.1', resolve));
    trapPort = (trap.address() as AddressInfo).port;
  }, 60_000);
  afterAll(async () => {
    for (const a of open) await a.close().catch(() => undefined);
    await upstream.close();
    await untrusted.close();
    await wrongHost.close();
    await new Promise<void>((resolve) => trap.close(() => resolve()));
    data.cleanup();
  });

  const data = tempDir();
  let ledgers = 0;
  async function adapterFor(
    test: Record<string, unknown>,
    extra: Parameters<typeof launchTestAdapter>[0] | object = {},
  ) {
    const ledgerPath = join(data.dir, `compat-${ledgers++}.sqlite`);
    const a = await launchTestAdapter({ test, jwt: canaryJwt(3600), maxProbes: 20, ledgerPath, ...extra });
    open.push(a);
    return a;
  }

  const probe = (a: LaunchedAdapter) =>
    raw(a, { method: 'POST', path: '/v0/quote', body: JSON.stringify(quoteRequest()) });

  it('forbidden resolved addresses get no connection and no credential', async () => {
    const answers = [
      [{ address: '10.0.0.5', family: 4 }],
      [{ address: '169.254.169.254', family: 4 }],
      [{ address: '127.0.0.1', family: 4 }],
      [{ address: 'fd00:ec2::254', family: 6 }],
      [{ address: '::ffff:127.0.0.1', family: 6 }],
      [{ address: '100.100.100.200', family: 4 }],
      [
        { address: '8.8.8.8', family: 4 },
        { address: '192.168.0.10', family: 4 },
      ],
      [],
    ];
    const a = await adapterFor({ kind: 'loopback-tls', port: upstream.port, ca: pki.caCert, answers });
    const before = upstream.received.length;
    for (let i = 0; i < answers.length; i++) {
      const res = await probe(a);
      expect(res.status).toBe(502);
      const details = (res.json?.['error'] as { details: Record<string, unknown> }).details;
      expect(details['reason']).toBe('ADDRESS_DENIED');
      expect(details['compatibility']).toBe('UNKNOWN');
      expect(details['credentialAttached']).toBe(false);
      expect(details['upstreamAttempted']).toBe(false);
    }
    const report = await a.report<ChildReport>();
    expect(report.counters.resolverCalls).toBe(answers.length);
    expect(report.counters.connectorCalls).toBe(0);
    expect(report.counters.upstreamRequests).toBe(0);
    expect(report.credentialAttachments).toBe(0);
    expect(report.transportSeen.connectTargets).toEqual([]);
    expect(report.tripwire.total).toBe(0);
    expect(upstream.received.length).toBe(before);
    expect(report.probes.every((p) => p.reasonCode === 'ADDRESS_DENIED' && !p.credentialAttached)).toBe(true);
  });

  it('DNS rebinding: one validated answer is pinned to the connection; a rebound answer is never used', async () => {
    const a = await adapterFor(
      {
        kind: 'loopback-tls',
        port: upstream.port,
        ca: pki.caCert,
        answers: [[{ address: '8.8.8.8', family: 4 }], [{ address: '127.0.0.1', family: 4 }]],
      },
      { maxProbes: 1 },
    );
    upstream.mode = 'quote';
    const before = upstream.received.length;
    const res = await probe(a);
    expect(res.status).toBe(200);
    const report = await a.report<ChildReport>();
    expect(report.transportSeen.resolveCalls).toBe(1);
    expect(report.transportSeen.resolvedHosts).toEqual([PINNED_HOST]);
    expect(report.transportSeen.connectTargets).toEqual(['8.8.8.8']);
    // No system DNS happened inside the adapter process at connect time or anywhere else.
    expect(report.tripwire.dnsLookups).toBe(0);
    expect(upstream.received.length).toBe(before + 1);
  });

  it('a redirect is rejected and its Location is never resolved or connected', async () => {
    upstream.mode = 'redirect';
    const a = await adapterFor(
      { kind: 'loopback-tls', port: upstream.port, ca: pki.caCert },
      { maxProbes: 1 },
    );
    const before = upstream.received.length;
    const res = await probe(a);
    upstream.mode = 'quote';
    expect(res.status).toBe(502);
    expect((res.json?.['error'] as { details: Record<string, unknown> }).details['reason']).toBe(
      'REDIRECT_REJECTED',
    );
    const report = await a.report<ChildReport>();
    expect(report.counters.resolverCalls).toBe(1);
    expect(report.counters.connectorCalls).toBe(1);
    expect(report.counters.upstreamRequests).toBe(1);
    expect(report.transportSeen.resolvedHosts).toEqual([PINNED_HOST]);
    expect(upstream.received.length).toBe(before + 1);
    expect(report.probes[0]!.compatibility).toBe('UNKNOWN');
    expect(report.probes[0]!.httpStatus).toBe(302);
    expect(report.tripwire.dnsLookups).toBe(0);
  });

  it('an untrusted certificate fails the handshake before any request byte or credential is sent', async () => {
    const a = await adapterFor(
      { kind: 'loopback-tls', port: untrusted.port, ca: pki.caCert },
      { maxProbes: 1 },
    );
    const res = await probe(a);
    expect(res.status).toBe(502);
    const details = (res.json?.['error'] as { details: Record<string, unknown> }).details;
    expect(details['reason']).toBe('TLS_VERIFY_FAILED');
    expect(details['credentialAttached']).toBe(false);
    expect(details['upstreamAttempted']).toBe(false);
    expect(untrusted.received).toHaveLength(0);
    const report = await a.report<ChildReport>();
    expect(report.credentialAttachments).toBe(0);
    expect(report.counters.upstreamRequests).toBe(0);
  });

  it('the adapter checks the handshake itself even if a connector does not reject bad certificates', async () => {
    const a = await adapterFor(
      { kind: 'loopback-tls', port: untrusted.port, ca: pki.caCert, connectorRejectsUnauthorized: false },
      { maxProbes: 1 },
    );
    const res = await probe(a);
    const details = (res.json?.['error'] as { details: Record<string, unknown> }).details;
    expect(details['reason']).toBe('TLS_VERIFY_FAILED');
    expect(details['credentialAttached']).toBe(false);
    expect(untrusted.received).toHaveLength(0);
    expect((await a.report<ChildReport>()).credentialAttachments).toBe(0);
  });

  it('a CA-signed certificate for another host name is rejected the same way', async () => {
    const a = await adapterFor(
      { kind: 'loopback-tls', port: wrongHost.port, ca: pki.caCert },
      { maxProbes: 1 },
    );
    const res = await probe(a);
    expect((res.json?.['error'] as { details: Record<string, unknown> }).details['reason']).toBe(
      'TLS_VERIFY_FAILED',
    );
    expect(wrongHost.received).toHaveLength(0);
    expect((await a.report<ChildReport>()).credentialAttachments).toBe(0);
  });

  it('proxy environment variables present in the adapter process are removed and never used', async () => {
    const proxy = `http://127.0.0.1:${trapPort}`;
    const a = await adapterFor(
      { kind: 'loopback-tls', port: upstream.port, ca: pki.caCert },
      {
        maxProbes: 1,
        // Windows environment names are case-insensitive, so only one spelling of each is set.
        extraEnv: { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy, NODE_USE_ENV_PROXY: '1' },
      },
    );
    expect([...a.preflight.ignoredProxyEnv].sort()).toEqual(
      ['ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NODE_USE_ENV_PROXY'].sort(),
    );
    upstream.mode = 'quote';
    const before = upstream.received.length;
    const res = await probe(a);
    expect(res.status).toBe(200);
    expect(upstream.received.length).toBe(before + 1);
    expect(trapConnections).toBe(0);
  });

  it.each([
    ['gzip', 'ENCODING_REFUSED'],
    ['oversize', 'RESPONSE_TOO_LARGE'],
    ['slow', 'TIMEOUT'],
  ] as const)('a %s response is bounded and classified UNKNOWN (%s)', async (mode, reason) => {
    upstream.mode = mode;
    const a = await adapterFor(
      { kind: 'loopback-tls', port: upstream.port, ca: pki.caCert },
      { maxProbes: 1, limits: { totalTimeoutMs: 800 } },
    );
    const res = await probe(a);
    upstream.mode = 'quote';
    expect(res.status).toBe(502);
    expect((res.json?.['error'] as { details: Record<string, unknown> }).details['reason']).toBe(reason);
    const report = await a.report<ChildReport>();
    expect(report.probes[0]!.compatibility).toBe('UNKNOWN');
    expect(report.probes[0]!.reasonCode).toBe(reason);
    expect(report.counters.upstreamRequests).toBe(1);
  });
});
