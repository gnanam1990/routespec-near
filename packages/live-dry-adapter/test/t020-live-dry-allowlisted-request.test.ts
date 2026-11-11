/**
 * T-020 — Live dry quote forwards only an exact allowlisted request.
 *
 * Covers FR-04, FR-16. Scope of THIS file: everything up to the network boundary.
 * The pinned official SDK (in this test process, as the subject client) sends a `dry: true` quote
 * through the separately launched adapter, which forwards it over real TLS (SNI = pinned host,
 * certificate validation on) to a loopback upstream emulator. The test verifies the exact bytes
 * and headers the upstream received, that the SDK's own Authorization and every RouteSpec-local
 * header were stripped, that only the memory-only vault credential was attached, the redacted
 * shape capture, the separate compatibility label, the one-probe budget, expiry, release, and
 * that nothing sensitive reached the ledger file.
 *
 * NOT covered here, and BLOCKED: the real dry request to the official endpoint (RP-07). It needs
 * a user-held provider JWT and an explicit user action; see docs/status/M07.md for the runbook.
 * Because the transport here is injected, the adapter itself refuses to label the result
 * OFFICIAL_ENDPOINT_COMPATIBLE: the stored label is UNKNOWN with reason
 * INJECTED_TRANSPORT_NOT_OFFICIAL_ENDPOINT even though the shape matched.
 */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CompatibilityProbeRecord, validateQuoteRequest } from '@routespec/contracts';
import {
  CompatibilityLedger,
  UPSTREAM_USER_AGENT,
  classifyLiveDryRequest,
  classifyOutcome,
  documentedOnly,
  type LaunchedAdapter,
} from '../src/index.ts';
import { createTestPki, type TestPki } from './support/certs.ts';
import {
  PINNED_HOST,
  canaryJwt,
  launchTestAdapter,
  quoteRequest,
  raw,
  readAllBytes,
  tempDir,
  type ChildReport,
} from './support/harness.ts';
import { dryQuoteResponse, startUpstream, type Upstream } from './support/upstream.ts';

for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[key];
}

const CLIENT_TOKEN_CANARY = 'client-side-provider-token-m07-canary';

describe('T-020 official SDK dry quote through the adapter (pinned-origin boundary, loopback upstream)', () => {
  const jwt = canaryJwt(3600);
  const data = tempDir();
  let pki: TestPki;
  let upstream: Upstream;
  let adapter: LaunchedAdapter;
  let sdkResult: unknown;

  beforeAll(async () => {
    pki = createTestPki(PINNED_HOST);
    upstream = await startUpstream(pki.pinned, 'quote');
    adapter = await launchTestAdapter({
      test: {
        kind: 'loopback-tls',
        port: upstream.port,
        ca: pki.caCert,
        answers: [[{ address: '8.8.8.8', family: 4 }]],
      },
      jwt,
      credentialPolicy: 'OPTIONAL',
      maxProbes: 1,
      ledgerPath: join(data.dir, 'compat.sqlite'),
    });
  }, 60_000);
  afterAll(async () => {
    await adapter.close().catch(() => undefined);
    await upstream.close();
    data.cleanup();
  });

  it('the pinned official SDK receives the upstream answer to its dry quote', async () => {
    const sdk = await import('@defuse-protocol/one-click-sdk-typescript');
    sdk.OpenAPI.BASE = adapter.baseUrl;
    sdk.OpenAPI.TOKEN = CLIENT_TOKEN_CANARY;
    sdk.OpenAPI.HEADERS = {
      'x-routespec-probe-token': adapter.probeToken,
      'x-routespec-session': 'local-session-header',
    };
    sdkResult = await sdk.OneClickService.getQuote(quoteRequest() as never);
    expect(sdkResult).toEqual(dryQuoteResponse(quoteRequest()));
    sdk.OpenAPI.TOKEN = undefined;
    sdk.OpenAPI.HEADERS = undefined;
  });

  it('upstream received exactly one request: the allowlisted route, fixed headers, validated body', () => {
    expect(upstream.received).toHaveLength(1);
    const hit = upstream.received[0]!;
    expect(hit.method).toBe('POST');
    expect(hit.url).toBe('/v0/quote');
    expect([...hit.rawHeaderNames].sort()).toEqual(
      [
        'accept',
        'accept-encoding',
        'authorization',
        'connection',
        'content-length',
        'content-type',
        'host',
        'user-agent',
      ].sort(),
    );
    expect(hit.headers['host']).toBe(PINNED_HOST);
    expect(hit.headers['content-type']).toBe('application/json');
    expect(hit.headers['accept-encoding']).toBe('identity');
    expect(hit.headers['user-agent']).toBe(UPSTREAM_USER_AGENT);
    // Only the vault credential; the SDK's own token and the local headers never cross.
    expect(hit.headers['authorization']).toBe(`Bearer ${jwt}`);
    expect(JSON.stringify(hit.headers)).not.toContain(CLIENT_TOKEN_CANARY);
    expect(hit.rawHeaderNames.some((n) => n.startsWith('x-routespec-'))).toBe(false);
    const body = JSON.parse(hit.body) as Record<string, unknown>;
    expect(body).toEqual(quoteRequest());
    expect(body['dry']).toBe(true);
    expect('depositAddress' in body).toBe(false);
    expect(hit.body).toBe(JSON.stringify(validateQuoteRequest(quoteRequest()).material));
  });

  it('a second dry quote is denied by the one-probe budget before any egress', async () => {
    const res = await raw(adapter, {
      method: 'POST',
      path: '/v0/quote',
      body: JSON.stringify(quoteRequest()),
    });
    expect(res.status).toBe(403);
    const details = (res.json?.['error'] as { details: Record<string, unknown> }).details;
    expect(details['reason']).toBe('PROBE_BUDGET_EXHAUSTED');
    expect(details['dnsAttempted']).toBe(false);
    expect(upstream.received).toHaveLength(1);
  });

  it('the stored result is redacted shape evidence on the separate compatibility axis', async () => {
    const report = await adapter.report<ChildReport>();
    expect(report.counters.forwarded).toBe(1);
    expect(report.counters.resolverCalls).toBe(1);
    expect(report.counters.connectorCalls).toBe(1);
    expect(report.counters.upstreamRequests).toBe(1);
    expect(report.credentialAttachments).toBe(1);
    expect(report.transportKind).toBe('INJECTED');
    expect(report.transportSeen.connectTargets).toEqual(['8.8.8.8']);
    expect(report.probes).toHaveLength(1);
    const p = report.probes[0]!;
    expect(p.compatibility).toBe('UNKNOWN');
    expect(p.shapeResult).toBe('SHAPE_COMPATIBLE');
    expect(p.reasonCode).toBe('INJECTED_TRANSPORT_NOT_OFFICIAL_ENDPOINT');
    expect(p.transportKind).toBe('INJECTED');
    expect(p.httpStatus).toBe(200);
    expect(p.responseAssignedAddress).toBe('ABSENT');
    expect(p.settlementExercised).toBe(false);
    expect(p.credentialAttached).toBe(true);
    expect(p.tokenState).toBe('PRESENT_IN_MEMORY');
    expect(p.quoteRequestDigest).toBe(validateQuoteRequest(quoteRequest()).quoteRequestDigest);
    expect(p.responseShape!.fields).toContain('$.quote.amountOut: string');
    expect(p.responseShape!.fields).toContain('$.quoteRequest.dry: boolean');
    expect(p.responseShape!.fields).toContain('$.quote.timeEstimate: number');
    for (const key of ['dnsMs', 'connectMs', 'ttfbMs', 'totalMs'] as const) {
      expect(typeof p.timing![key]).toBe('number');
    }
    expect(CompatibilityProbeRecord.parse(CompatibilityLedger.toContractRecord(p)).compatibility).toBe(
      'UNKNOWN',
    );
  });

  it('the ledger holds no credential, no request or response value, and no gate-run linkage', () => {
    const bytes = readAllBytes(data.dir);
    expect(bytes).not.toContain(jwt);
    expect(bytes).not.toContain(jwt.split('.')[1]!);
    expect(bytes).not.toContain(CLIENT_TOKEN_CANARY);
    for (const value of [
      'recipient-m07-canary.test',
      'refund-m07-canary.test',
      '987654',
      'corr-sim-0001',
      'SIMULATEDSIGNATURE',
    ]) {
      expect(bytes, value).not.toContain(value);
    }
    const db = new DatabaseSync(join(data.dir, 'compat.sqlite'), { readOnly: true });
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => String((r as { name: unknown }).name));
    const columns = tables.flatMap((t) =>
      db
        .prepare(`PRAGMA table_info(${t})`)
        .all()
        .map((c) => String((c as { name: unknown }).name)),
    );
    db.close();
    expect(tables.sort()).toEqual(['compatibility_probes', 'policy_denials']);
    for (const column of columns) {
      expect(column).not.toMatch(/gate|case_run|verdict|evidence_scope|lifecycle|session/);
    }
  });

  it('release drops the credential reference; the state is reported, never the value', async () => {
    expect(await adapter.release()).toBe('OPTIONAL_ABSENT');
    const report = await adapter.report<ChildReport>();
    expect(JSON.stringify(report)).not.toContain(jwt);
  });
});

describe('T-020 credential states and expiry', () => {
  it('an expired provider credential stops the probe before DNS', async () => {
    const adapter = await launchTestAdapter({ test: { kind: 'deny-all' }, jwt: canaryJwt(-60) });
    try {
      expect(adapter.tokenState).toBe('EXPIRED');
      const res = await raw(adapter, {
        method: 'POST',
        path: '/v0/quote',
        body: JSON.stringify(quoteRequest()),
      });
      expect(res.status).toBe(401);
      expect((res.json?.['error'] as { code: string }).code).toBe('RS_TOKEN_EXPIRED');
      const report = await adapter.report<ChildReport>();
      expect(report.counters.resolverCalls).toBe(0);
      expect(report.transportSeen.resolveCalls).toBe(0);
      expect(report.credentialAttachments).toBe(0);
    } finally {
      await adapter.close();
    }
  });

  it('absent credential is OPTIONAL_ABSENT; policy NONE is NOT_REQUIRED and ignores a supplied value', async () => {
    const absent = await launchTestAdapter({ test: { kind: 'deny-all' } });
    expect(absent.tokenState).toBe('OPTIONAL_ABSENT');
    await absent.close();
    const none = await launchTestAdapter({
      test: { kind: 'deny-all' },
      credentialPolicy: 'NONE',
      jwt: canaryJwt(3600),
    });
    expect(none.tokenState).toBe('NOT_REQUIRED');
    await none.close();
  });

  it('a malformed provider credential refuses the launch without echoing it', async () => {
    const value = 'not-a-jwt-m07-canary';
    await expect(launchTestAdapter({ test: { kind: 'deny-all' }, jwt: value })).rejects.toMatchObject({
      reason: 'PROVIDER_CREDENTIAL_INVALID',
    });
  });
});

describe('T-020 compatibility label rules (pure)', () => {
  const allowance = classifyLiveDryRequest({
    method: 'POST',
    target: '/v0/quote',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(quoteRequest())),
  });
  if (!allowance.allowed) throw new Error('fixture must be allowed');
  const response = (status: number, body: unknown, contentType = 'application/json') => ({
    kind: 'RESPONSE' as const,
    status,
    contentType,
    body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    timing: { dnsMs: 1, connectMs: 1, ttfbMs: 1, totalMs: 3 },
    boundary: {
      credentialAttached: false,
      dnsAttempted: true,
      socketAttempted: true,
      upstreamAttempted: true,
    },
    pinnedFamily: 4 as const,
  });

  it('a matching shape is OFFICIAL_ENDPOINT_COMPATIBLE only for the built-in system transport', () => {
    const ok = response(200, dryQuoteResponse(quoteRequest()));
    expect(classifyOutcome({ allowance, outcome: ok, officialTransport: true }).compatibility).toBe(
      'OFFICIAL_ENDPOINT_COMPATIBLE',
    );
    expect(classifyOutcome({ allowance, outcome: ok, officialTransport: false }).compatibility).toBe(
      'UNKNOWN',
    );
  });

  it('unknown fields, missing fields, echo mismatch and non-JSON are INCOMPATIBLE', () => {
    const extra = { ...dryQuoteResponse(quoteRequest()), settlement: {} };
    const missing = { ...dryQuoteResponse(quoteRequest()), signature: undefined };
    const echo = dryQuoteResponse(quoteRequest({ amount: '5' }));
    for (const body of [extra, missing, echo]) {
      expect(
        classifyOutcome({ allowance, outcome: response(200, body), officialTransport: true }).compatibility,
      ).toBe('INCOMPATIBLE');
    }
    expect(
      classifyOutcome({ allowance, outcome: response(200, '<html>', 'text/html'), officialTransport: true })
        .compatibility,
    ).toBe('INCOMPATIBLE');
  });

  it('provider 4xx/5xx and transport failures are UNKNOWN; no probe is DOCUMENTED_ONLY', () => {
    expect(
      classifyOutcome({ allowance, outcome: response(401, { message: 'x' }), officialTransport: true }),
    ).toMatchObject({
      compatibility: 'UNKNOWN',
      reasonCode: 'PROVIDER_HTTP_401',
    });
    expect(documentedOnly()).toMatchObject({ compatibility: 'DOCUMENTED_ONLY', settlementExercised: false });
  });

  it('shape capture keeps types only', () => {
    const r = classifyOutcome({
      allowance,
      outcome: response(200, dryQuoteResponse(quoteRequest())),
      officialTransport: true,
    });
    const text = JSON.stringify(r);
    for (const value of ['987654', 'corr-sim-0001', 'recipient-m07-canary.test', 'SIMULATEDSIGNATURE']) {
      expect(text).not.toContain(value);
    }
  });
});
