/**
 * T-021 — Dry-probe mutation denial precedes credential attachment.
 *
 * Covers FR-04, FR-16, INV-10. In the separately launched live-dry adapter, false/missing/string
 * `dry`, deposit submit, transfer/withdrawal, intent submission, order and auth routes, and every
 * profile-declared mutating/material extension are attempted, both through the pinned official
 * SDK and as raw HTTP. Each is denied by the policy before the provider credential is attached,
 * before DNS, before a socket and before the upstream client is invoked. Evidence: the adapter's
 * own counters, the injected transport's call log (resolve/connect throw if reached), the
 * process-wide network tripwire inside the adapter process, the vault attachment counter, and
 * the append-only denial ledger (whose CHECK constraints only admit all-false boundary flags).
 * No request leaves the machine; the transport used here cannot reach any network.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ONECLICK_SDK_ROUTES } from '@routespec/contracts';
import {
  DENIAL_BOUNDARY,
  ProviderCredentialVault,
  classifyLiveDryRequest,
  compileUpstreamOrigin,
  sendDryQuote,
  type EgressTransport,
  type InboundRequest,
  type LaunchedAdapter,
} from '../src/index.ts';
import {
  canaryJwt,
  launchTestAdapter,
  quoteRequest,
  raw,
  readAllBytes,
  tempDir,
  type ChildReport,
} from './support/harness.ts';

for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[key];
}

const require = createRequire(import.meta.url);
const JSON_HEADERS = { 'content-type': 'application/json' };

function req(method: string, target: string, body: unknown, headers: Record<string, string> = JSON_HEADERS) {
  const bytes = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return { method, target, headers, body: bytes } satisfies InboundRequest;
}

describe('T-021 policy classifier (pure, runs before every other step)', () => {
  const denied: Array<[string, InboundRequest, string]> = [
    [
      'dry false (committed quote)',
      req('POST', '/v0/quote', quoteRequest({ dry: false })),
      'DRY_FALSE_COMMITTED_QUOTE',
    ],
    [
      'dry missing',
      req(
        'POST',
        '/v0/quote',
        (() => {
          const q = quoteRequest();
          delete q['dry'];
          return q;
        })(),
      ),
      'DRY_MISSING',
    ],
    ['dry "true" string', req('POST', '/v0/quote', quoteRequest({ dry: 'true' })), 'DRY_NOT_BOOLEAN'],
    ['dry "false" string', req('POST', '/v0/quote', quoteRequest({ dry: 'false' })), 'DRY_NOT_BOOLEAN'],
    ['dry 1', req('POST', '/v0/quote', quoteRequest({ dry: 1 })), 'DRY_NOT_BOOLEAN'],
    ['dry null', req('POST', '/v0/quote', quoteRequest({ dry: null })), 'DRY_NOT_BOOLEAN'],
    ['dry [true]', req('POST', '/v0/quote', quoteRequest({ dry: [true] })), 'DRY_NOT_BOOLEAN'],
    [
      'ambiguous duplicate dry keys',
      req(
        'POST',
        '/v0/quote',
        JSON.stringify(quoteRequest()).replace('"dry":true', '"dry":true,"dry":false'),
      ),
      'DUPLICATE_KEY',
    ],
    [
      'ambiguous duplicate nested key',
      req(
        'POST',
        '/v0/quote',
        JSON.stringify(quoteRequest({ appFees: [{ recipient: 'a.test', fee: 1 }] })).replace(
          '"fee":1',
          '"fee":1,"fee":2',
        ),
      ),
      'DUPLICATE_KEY',
    ],
    [
      'request-side deposit address',
      req('POST', '/v0/quote', quoteRequest({ depositAddress: 'dep.test' })),
      'DEPOSIT_ADDRESS_IN_REQUEST',
    ],
    [
      'request-side deposit memo',
      req('POST', '/v0/quote', quoteRequest({ depositMemo: 'memo' })),
      'DEPOSIT_ADDRESS_IN_REQUEST',
    ],
    [
      'commit material txHash',
      req('POST', '/v0/quote', quoteRequest({ txHash: '0xabc' })),
      'MUTATION_MATERIAL_PRESENT',
    ],
    [
      'signed intent payload',
      req('POST', '/v0/quote', quoteRequest({ signedData: { standard: 'nep413' } })),
      'MUTATION_MATERIAL_PRESENT',
    ],
    [
      'withdrawal extension',
      req('POST', '/v0/quote', quoteRequest({ withdrawal: { to: 'x' } })),
      'MUTATION_MATERIAL_PRESENT',
    ],
    [
      'transfer extension',
      req('POST', '/v0/quote', quoteRequest({ transfer: true })),
      'MUTATION_MATERIAL_PRESENT',
    ],
    [
      'unknown extension field',
      req('POST', '/v0/quote', quoteRequest({ commitImmediately: true })),
      'FIELD_OUTSIDE_PROFILE',
    ],
    [
      '__proto__ key',
      req('POST', '/v0/quote', JSON.stringify(quoteRequest()).replace('{', '{"__proto__":{"dry":true},')),
      'FIELD_OUTSIDE_PROFILE',
    ],
    ['invalid material', req('POST', '/v0/quote', quoteRequest({ amount: '-5' })), 'MATERIAL_INVALID'],
    [
      'deposit submit',
      req('POST', '/v0/deposit/submit', { txHash: '0xabc', depositAddress: 'dep.test' }),
      'COMMITTED_MUTATION_ROUTE',
    ],
    [
      'deposit submit even with dry true',
      req('POST', '/v0/deposit/submit', { dry: true, txHash: '0xabc', depositAddress: 'd' }),
      'COMMITTED_MUTATION_ROUTE',
    ],
    [
      'status lookup (disabled by default)',
      req('GET', '/v0/status?depositAddress=dep.test', ''),
      'STATUS_LOOKUP_DISABLED_BY_DEFAULT',
    ],
    ['submit signed intent', req('POST', '/v0/submit-intent', { type: 'swap_transfer' }), 'PROHIBITED_ROUTE'],
    ['create order', req('POST', '/v0/orders', { dry: true }), 'PROHIBITED_ROUTE'],
    ['cancel order', req('POST', '/v0/orders/abc123/cancel', {}), 'PROHIBITED_ROUTE'],
    ['auth authenticate', req('POST', '/v0/auth/authenticate', {}), 'PROHIBITED_ROUTE'],
    [
      'withdrawal listing',
      req('GET', '/v0/any-input/withdrawals?depositAddress=x', ''),
      'ROUTE_NOT_ALLOWLISTED',
    ],
    ['generate intent', req('POST', '/v0/generate-intent', { dry: true }), 'ROUTE_NOT_ALLOWLISTED'],
    ['tokens', req('GET', '/v0/tokens', ''), 'ROUTE_NOT_ALLOWLISTED'],
    ['GET on the quote route', req('GET', '/v0/quote', ''), 'METHOD_NOT_ALLOWLISTED'],
    ['PUT on the quote route', req('PUT', '/v0/quote', quoteRequest()), 'METHOD_NOT_ALLOWLISTED'],
    ['query on the quote route', req('POST', '/v0/quote?dry=true', quoteRequest()), 'QUERY_NOT_ALLOWED'],
    ['encoded path', req('POST', '/v0/%71uote', quoteRequest()), 'PATH_NOT_CANONICAL'],
    ['dot segment path', req('POST', '/v0/quote/../deposit/submit', quoteRequest()), 'PATH_NOT_CANONICAL'],
    ['trailing slash', req('POST', '/v0/quote/', quoteRequest()), 'PATH_NOT_CANONICAL'],
    ['double slash', req('POST', '//v0/quote', quoteRequest()), 'TARGET_NOT_ORIGIN_FORM'],
    [
      'absolute-form target',
      req('POST', 'https://1click.chaindefuser.com/v0/quote', quoteRequest()),
      'TARGET_NOT_ORIGIN_FORM',
    ],
    ['unlisted route', req('POST', '/v1/quote', quoteRequest()), 'UNLISTED_ROUTE'],
    [
      'non-JSON content type',
      req('POST', '/v0/quote', quoteRequest(), { 'content-type': 'text/plain' }),
      'CONTENT_TYPE_NOT_JSON',
    ],
    [
      'encoded body',
      req('POST', '/v0/quote', quoteRequest(), {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      }),
      'BODY_ENCODED',
    ],
    [
      'byte-order mark',
      req(
        'POST',
        '/v0/quote',
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(quoteRequest()))]),
      ),
      'BODY_BOM',
    ],
    ['invalid UTF-8', req('POST', '/v0/quote', Buffer.from([0x7b, 0xff, 0x7d])), 'BODY_NOT_UTF8'],
    ['array body', req('POST', '/v0/quote', [quoteRequest()]), 'BODY_NOT_OBJECT'],
    ['empty body', req('POST', '/v0/quote', ''), 'BODY_EMPTY'],
    [
      'oversized body',
      req('POST', '/v0/quote', quoteRequest({ customRecipientMsg: 'x'.repeat(70 * 1024) })),
      'BODY_TOO_LARGE',
    ],
  ];

  it.each(denied)('%s is denied with all boundary flags false', (_label, input, reason) => {
    const decision = classifyLiveDryRequest(input);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe(reason);
    expect(decision.boundary).toEqual({
      credentialAttached: false,
      dnsAttempted: false,
      socketAttempted: false,
      upstreamAttempted: false,
      upstreamClientInvoked: false,
    });
  });

  it('every SDK route other than the dry quote is denied', () => {
    for (const route of ONECLICK_SDK_ROUTES) {
      if (route.method === 'POST' && route.path === '/v0/quote') continue;
      const path = route.path.replace('{orderId}', 'order1');
      const decision = classifyLiveDryRequest(
        req(route.method, path, route.method === 'GET' ? '' : { dry: true }),
      );
      expect(decision.allowed, `${route.method} ${route.path}`).toBe(false);
    }
  });

  it('only boolean true dry passes, for arbitrary dry values (property)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (dry) => {
        const decision = classifyLiveDryRequest(req('POST', '/v0/quote', quoteRequest({ dry })));
        return dry === true ? decision.allowed : !decision.allowed;
      }),
      { numRuns: 300 },
    );
  });

  it('any extra top-level field is denied (property)', () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 24 })
          .filter(
            (k) =>
              !(k in quoteRequest()) &&
              ![
                'connectedWallets',
                'sessionId',
                'virtualChainRecipient',
                'virtualChainRefundRecipient',
                'customRecipientMsg',
                'confidentiality',
                'referral',
                'rebates',
                'quoteWaitingTimeMs',
                'appFees',
                'insured',
                'depositMode',
              ].includes(k),
          ),
        fc.jsonValue(),
        (key, value) =>
          !classifyLiveDryRequest(req('POST', '/v0/quote', { ...quoteRequest(), [key]: value })).allowed,
      ),
      { numRuns: 300 },
    );
  });

  it('the allowed decision forwards only the validated material', () => {
    const decision = classifyLiveDryRequest(
      req('POST', '/v0/quote', quoteRequest(), {
        'content-type': 'application/json',
        authorization: 'Bearer client-supplied-value',
        'x-routespec-session': 'local',
      }),
    );
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(JSON.parse(decision.forwardBody.toString('utf8'))).toEqual(quoteRequest());
    expect(decision.strippedInboundHeaders).toEqual(['authorization', 'x-routespec-session']);
  });
});

describe('T-021 credential and egress refuse anything that is not a policy-issued allowance', () => {
  it('a copied allowance object gets no credential, no DNS and no socket', async () => {
    const allowed = classifyLiveDryRequest(req('POST', '/v0/quote', quoteRequest()));
    expect(allowed.allowed).toBe(true);
    const forged = { ...allowed } as typeof allowed;
    const env: NodeJS.ProcessEnv = { ROUTESPEC_PROVIDER_JWT: canaryJwt(3600) };
    const vault = new ProviderCredentialVault('OPTIONAL');
    vault.loadFromProtectedEnv(env);
    expect(env['ROUTESPEC_PROVIDER_JWT']).toBeUndefined();
    expect(vault.state()).toBe('PRESENT_IN_MEMORY');
    if (!forged.allowed) return;
    expect(() => vault.authorizationFor(forged)).toThrow(/without a policy allowance/);
    const calls = { resolve: 0, connect: 0 };
    const transport: EgressTransport = {
      label: 'TEST_COUNTING',
      async resolve() {
        calls.resolve++;
        return [];
      },
      connect() {
        calls.connect++;
        throw new Error('unreachable');
      },
    };
    const counters = { resolverCalls: 0, connectorCalls: 0, upstreamRequests: 0 };
    await expect(
      sendDryQuote({
        allowance: forged,
        vault,
        origin: compileUpstreamOrigin('https://1click.chaindefuser.com'),
        transport,
        counters,
      }),
    ).rejects.toThrow(/policy-issued allowance/);
    expect(calls).toEqual({ resolve: 0, connect: 0 });
    expect(counters).toEqual({ resolverCalls: 0, connectorCalls: 0, upstreamRequests: 0 });
    expect(vault.attachments).toBe(0);
    expect(JSON.stringify(vault)).toBe('{"tokenState":"PRESENT_IN_MEMORY"}');
    expect(String(vault)).not.toContain('.');
  });

  it('DENIAL_BOUNDARY is a frozen constant', () => {
    expect(Object.isFrozen(DENIAL_BOUNDARY)).toBe(true);
  });
});

describe('T-021 separately launched adapter denies every mutation before credential, DNS and socket', () => {
  const jwt = canaryJwt(3600);
  const data = tempDir();
  let adapter: LaunchedAdapter;
  const responses: string[] = [];

  beforeAll(async () => {
    adapter = await launchTestAdapter({
      test: { kind: 'deny-all' },
      jwt,
      credentialPolicy: 'OPTIONAL',
      maxProbes: 5,
      ledgerPath: join(data.dir, 'compat.sqlite'),
    });
  });
  afterAll(async () => {
    await adapter.close().catch(() => undefined);
    data.cleanup();
  });

  it('the adapter is a separate process holding the credential in memory only', () => {
    expect(adapter.child.pid).toBeGreaterThan(0);
    expect(adapter.child.pid).not.toBe(process.pid);
    expect(adapter.tokenState).toBe('PRESENT_IN_MEMORY');
    expect(adapter.preflight.origin).toBe('https://1click.chaindefuser.com');
    expect(adapter.child.spawnargs.join(' ')).not.toContain(jwt);
  });

  it('the pinned official SDK cannot commit, submit, withdraw or reconcile through it', async () => {
    const sdk = await import('@defuse-protocol/one-click-sdk-typescript');
    sdk.OpenAPI.BASE = adapter.baseUrl;
    sdk.OpenAPI.HEADERS = { 'x-routespec-probe-token': adapter.probeToken };
    sdk.OpenAPI.TOKEN = undefined;
    const attempts: Array<[string, () => Promise<unknown>, string]> = [
      [
        'getQuote dry:false',
        () => sdk.OneClickService.getQuote(quoteRequest({ dry: false }) as never),
        'DRY_FALSE_COMMITTED_QUOTE',
      ],
      [
        'getQuote dry missing',
        () => {
          const q = quoteRequest();
          delete q['dry'];
          return sdk.OneClickService.getQuote(q as never);
        },
        'DRY_MISSING',
      ],
      [
        'getQuote dry "true"',
        () => sdk.OneClickService.getQuote(quoteRequest({ dry: 'true' }) as never),
        'DRY_NOT_BOOLEAN',
      ],
      [
        'submitDepositTx',
        () => sdk.OneClickService.submitDepositTx({ txHash: '0xabc', depositAddress: 'dep.test' }),
        'COMMITTED_MUTATION_ROUTE',
      ],
      [
        'getExecutionStatus',
        () => sdk.OneClickService.getExecutionStatus('dep.test'),
        'STATUS_LOOKUP_DISABLED_BY_DEFAULT',
      ],
      [
        'submitIntent',
        () => sdk.OneClickService.submitIntent({ type: 'swap_transfer', signedData: {} } as never),
        'PROHIBITED_ROUTE',
      ],
      ['generateIntent', () => sdk.OneClickService.generateIntent({} as never), 'ROUTE_NOT_ALLOWLISTED'],
      [
        'getAnyInputQuoteWithdrawals',
        () => sdk.OneClickService.getAnyInputQuoteWithdrawals('dep.test'),
        'ROUTE_NOT_ALLOWLISTED',
      ],
      ['getTokens', () => sdk.OneClickService.getTokens(), 'ROUTE_NOT_ALLOWLISTED'],
    ];
    for (const [label, call, reason] of attempts) {
      const error = await call().then(
        () => null,
        (e: unknown) =>
          e as { status?: number; body?: { error?: { code: string; details: Record<string, unknown> } } },
      );
      expect(error, label).not.toBeNull();
      const details = error!.body?.error?.details ?? {};
      expect(details['reason'], label).toBe(reason);
      expect(details['credentialAttached'], label).toBe(false);
      expect(details['dnsAttempted'], label).toBe(false);
      expect(details['upstreamAttempted'], label).toBe(false);
      responses.push(JSON.stringify(error!.body));
    }
  });

  it('raw mutation-shaped and ambiguous requests are denied the same way', async () => {
    const cases: Array<[string, Parameters<typeof raw>[1], string]> = [
      [
        'dry false',
        { method: 'POST', path: '/v0/quote', body: JSON.stringify(quoteRequest({ dry: false })) },
        'DRY_FALSE_COMMITTED_QUOTE',
      ],
      [
        'duplicate dry',
        {
          method: 'POST',
          path: '/v0/quote',
          body: JSON.stringify(quoteRequest()).replace('"dry":true', '"dry":true,"dry":false'),
        },
        'DUPLICATE_KEY',
      ],
      [
        'committed extension',
        { method: 'POST', path: '/v0/quote', body: JSON.stringify(quoteRequest({ txHash: '0x1' })) },
        'MUTATION_MATERIAL_PRESENT',
      ],
      [
        'deposit submit',
        {
          method: 'POST',
          path: '/v0/deposit/submit',
          body: JSON.stringify({ txHash: '0x1', depositAddress: 'd' }),
        },
        'COMMITTED_MUTATION_ROUTE',
      ],
      ['create order', { method: 'POST', path: '/v0/orders', body: '{}' }, 'PROHIBITED_ROUTE'],
      ['cancel order', { method: 'POST', path: '/v0/orders/o1/cancel', body: '{}' }, 'PROHIBITED_ROUTE'],
      ['auth refresh', { method: 'POST', path: '/v0/auth/refresh', body: '{}' }, 'PROHIBITED_ROUTE'],
      ['unlisted', { method: 'POST', path: '/v0/withdraw', body: '{}' }, 'UNLISTED_ROUTE'],
    ];
    for (const [label, input, reason] of cases) {
      const res = await raw(adapter, input);
      expect(res.status, label).toBeGreaterThanOrEqual(400);
      const details = (res.json?.['error'] as { details: Record<string, unknown> }).details;
      expect(details['reason'], label).toBe(reason);
      expect(details['credentialAttached'], label).toBe(false);
      expect(details['dnsAttempted'], label).toBe(false);
      expect(details['upstreamAttempted'], label).toBe(false);
      responses.push(res.body);
    }
  });

  it('local checks (probe-session token, Host, browser Origin) also stop before the policy and egress', async () => {
    const noToken = await raw(adapter, {
      method: 'POST',
      path: '/v0/quote',
      body: JSON.stringify(quoteRequest()),
      token: null,
    });
    expect(noToken.status).toBe(401);
    const wrongToken = await raw(adapter, {
      method: 'POST',
      path: '/v0/quote',
      body: JSON.stringify(quoteRequest()),
      token: 'rslp_wrong_token_value_0000000000',
    });
    expect(wrongToken.status).toBe(401);
    // Provider Authorization is never accepted as the local credential.
    const authOnly = await raw(adapter, {
      method: 'POST',
      path: '/v0/quote',
      body: JSON.stringify(quoteRequest()),
      token: null,
      headers: { authorization: `Bearer ${adapter.probeToken}` },
    });
    expect(authOnly.status).toBe(401);
    const browser = await raw(adapter, {
      method: 'POST',
      path: '/v0/quote',
      body: JSON.stringify(quoteRequest()),
      headers: { origin: 'https://evil.example' },
    });
    expect(browser.status).toBe(403);
    const host = await raw(adapter, {
      method: 'POST',
      path: '/v0/quote',
      body: JSON.stringify(quoteRequest()),
      headers: { host: 'rebind.example:80' },
    });
    expect(host.status).toBe(403);
    for (const r of [noToken, wrongToken, authOnly, browser, host]) responses.push(r.body);
  });

  it('nothing reached the credential, the resolver, a socket or the upstream client', async () => {
    const report = await adapter.report<ChildReport>();
    expect(report.counters.policyDenials).toBe(17);
    expect(report.counters.localRejections).toBe(5);
    expect(report.counters.forwarded).toBe(0);
    expect(report.counters.resolverCalls).toBe(0);
    expect(report.counters.connectorCalls).toBe(0);
    expect(report.counters.upstreamRequests).toBe(0);
    expect(report.credentialAttachments).toBe(0);
    expect(report.transportSeen).toEqual({
      resolveCalls: 0,
      connectCalls: 0,
      connectTargets: [],
      resolvedHosts: [],
    });
    expect(report.tripwire.total).toBe(0);
    expect(report.tripwire.dnsLookups).toBe(0);
    expect(report.tokenState).toBe('PRESENT_IN_MEMORY');
    expect(report.probes).toHaveLength(0);
    expect(report.denials).toHaveLength(17);
    expect(new Set(report.denials.map((d) => d.code))).toEqual(
      new Set(['RS_MODE_POLICY_DENIED', 'RS_UNSUPPORTED_ROUTE']),
    );
  });

  it('the denial ledger holds only code/reason/route, all-false flags, and no credential or body', async () => {
    const db = new DatabaseSync(join(data.dir, 'compat.sqlite'), { readOnly: true });
    const rows = db.prepare('SELECT * FROM policy_denials').all() as Array<Record<string, unknown>>;
    db.close();
    expect(rows).toHaveLength(17);
    for (const row of rows) {
      expect(row['credential_attached']).toBe(0);
      expect(row['dns_attempted']).toBe(0);
      expect(row['socket_attempted']).toBe(0);
      expect(row['upstream_attempted']).toBe(0);
      expect(Object.keys(row).sort()).toEqual(
        [
          'code',
          'credential_attached',
          'denial_id',
          'dns_attempted',
          'method',
          'observed_at_ms',
          'reason',
          'route',
          'socket_attempted',
          'upstream_attempted',
        ].sort(),
      );
    }
    const bytes = readAllBytes(data.dir);
    expect(bytes).not.toContain(jwt);
    expect(bytes).not.toContain(jwt.split('.')[1]!);
    expect(bytes).not.toContain('recipient-m07-canary.test');
    expect(responses.join('\n')).not.toContain(jwt);
    // The ledger rejects a row that claims a credential was attached on a denial.
    const writable = new DatabaseSync(join(data.dir, 'compat.sqlite'));
    expect(() =>
      writable.prepare(`INSERT INTO policy_denials VALUES ('x','POST','r','c','r',1,0,0,0,0)`).run(),
    ).toThrow();
    expect(() => writable.prepare(`DELETE FROM policy_denials`).run()).toThrow(/RS_IMMUTABLE_RECORD/);
    writable.close();
  });

  it('the official SDK resolves from this package (it is the pinned client the subject uses)', () => {
    expect(require.resolve('@defuse-protocol/one-click-sdk-typescript')).toContain(
      'one-click-sdk-typescript',
    );
  });
});
