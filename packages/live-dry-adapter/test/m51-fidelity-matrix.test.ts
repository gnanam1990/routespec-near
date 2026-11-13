/**
 * M51 — fidelity matrix: token-list sanitizing, deterministic route selection, dry request
 * building, verdict rules and renderings (pure), then one whole run through the separately
 * launched adapter against the loopback upstream emulator.
 *
 * The emulator is SIMULATED and its token list is synthetic (`*.test` asset ids). Because the
 * transport is injected, the adapter labels every row UNKNOWN / INJECTED_TRANSPORT_NOT_OFFICIAL_
 * ENDPOINT and the matrix verdict is INCONCLUSIVE: a test run can never produce a compatible row.
 * The real run against the official endpoint is recorded in docs/status/M51.md.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LIVE_DRY_HARD_REQUEST_CAP,
  MATRIX_INTENTS_ACCOUNT,
  MATRIX_MAX_ROUTES,
  PINNED_PROFILE_INTEGRITY_DIGEST,
  RequestBudget,
  adapterMatrixClient,
  baselineStatus,
  buildDryQuoteRequest,
  clampRouteCount,
  classifyLiveDryRequest,
  evaluateMatrix,
  exitCodeFor,
  parseBaseline,
  parseTokenList,
  probeAmount,
  renderBadge,
  renderMatrixMarkdown,
  runFidelityMatrix,
  selectRoutes,
  type FidelityMatrix,
  type LaunchedAdapter,
  type MatrixRow,
  type MatrixToken,
} from '../src/index.ts';
import { createTestPki, type TestPki } from './support/certs.ts';
import { PINNED_HOST, canaryJwt, launchTestAdapter, type ChildReport } from './support/harness.ts';
import { startUpstream, type Upstream } from './support/upstream.ts';

const BASELINE_FILE = fileURLToPath(new URL('../fidelity-baseline.json', import.meta.url));
const KNOWN = `sha256:${'a'.repeat(64)}` as const;
const OTHER = `sha256:${'b'.repeat(64)}` as const;
const baseline = parseBaseline({
  schema: 'routespec.fidelity-baseline/1',
  profileIntegrityDigest: PINNED_PROFILE_INTEGRITY_DIGEST,
  knownResponseShapeDigests: [KNOWN],
});
const HUB = 'nep141:usdc-hub.test';

/** Synthetic list: NEAR hub pair plus `chains` other chains with a USDC and a native token each. */
function syntheticTokenList(chains: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [
    { assetId: HUB, decimals: 6, blockchain: 'near', symbol: 'USDC', price: 1 },
    { assetId: 'nep141:wrap.test', decimals: 24, blockchain: 'near', symbol: 'wNEAR', price: 2.5 },
  ];
  for (let i = 0; i < chains; i++) {
    const chain = `chain${String(i).padStart(2, '0')}`;
    out.push(
      { assetId: `nep141:native-${chain}.test`, decimals: 18, blockchain: chain, symbol: 'NAT', price: 100 },
      { assetId: `nep141:usdc-${chain}.test`, decimals: 6, blockchain: chain, symbol: 'USDC', price: 1 },
    );
  }
  return out;
}

const token = (over: Partial<MatrixToken> = {}): MatrixToken => ({
  assetId: 'nep141:a.test',
  blockchain: 'near',
  symbol: 'AAA',
  decimals: 6,
  priceUsd: 1,
  ...over,
});

describe('M51 token list (untrusted provider data)', () => {
  it('keeps five checked fields, skips and counts what does not fit', () => {
    const parsed = parseTokenList([
      { assetId: 'nep141:b.test', decimals: 6, blockchain: 'near', symbol: 'BBB', price: 2, extra: 'x' },
      { assetId: 'nep141:a.test', decimals: 18, blockchain: 'eth', symbol: 'AAA', price: 0.5 },
      { assetId: 'nep141:a.test', decimals: 18, blockchain: 'eth', symbol: 'DUP', price: 0.5 },
      { assetId: 'nep141:pipe.test', decimals: 6, blockchain: 'near', symbol: 'A|B', price: 1 },
      { assetId: 'nep141:md.test', decimals: 6, blockchain: 'near', symbol: '[x](http://e)', price: 1 },
      { assetId: 'nep141:zero.test', decimals: 6, blockchain: 'near', symbol: 'ZERO', price: 0 },
      { assetId: 'nep141:dec.test', decimals: 6.5, blockchain: 'near', symbol: 'DEC', price: 1 },
      { assetId: 'has space', decimals: 6, blockchain: 'near', symbol: 'SP', price: 1 },
      { assetId: 'nep141:chain.test', decimals: 6, blockchain: 'Near Chain', symbol: 'CH', price: 1 },
      null,
      'text',
    ]);
    expect(parsed.listed).toBe(11);
    expect(parsed.usable).toBe(2);
    expect(parsed.tokens).toEqual([
      { assetId: 'nep141:a.test', blockchain: 'eth', symbol: 'AAA', decimals: 18, priceUsd: 0.5 },
      { assetId: 'nep141:b.test', blockchain: 'near', symbol: 'BBB', decimals: 6, priceUsd: 2 },
    ]);
    expect(parsed.shapeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rejects a body that is not a bounded array', () => {
    expect(() => parseTokenList({ tokens: [] })).toThrow();
    expect(() => parseTokenList(new Array(5001).fill(null))).toThrow();
  });
});

describe('M51 route selection and dry requests', () => {
  it('sizes about 20 USD in base units with integer arithmetic', () => {
    expect(probeAmount(token({ decimals: 6, priceUsd: 1 }))).toBe('20000000');
    expect(probeAmount(token({ decimals: 24, priceUsd: 2.5 }))).toBe('8000000000000000000000000');
    expect(probeAmount(token({ decimals: 8, priceUsd: 100000 }))).toBe('20000');
    expect(probeAmount(token({ decimals: 0, priceUsd: 100 }))).toBeNull();
    expect(probeAmount(token({ priceUsd: 1e-12 }))).toBeNull();
  });

  it('is deterministic, hub-and-spoke, alternating direction, one chain per route first', () => {
    const { tokens } = parseTokenList(syntheticTokenList(30));
    const routes = selectRoutes(tokens, 24);
    expect(selectRoutes([...tokens].reverse(), 24)).toEqual(routes);
    expect(routes).toHaveLength(24);
    expect(routes.map((r) => r.index)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect([routes[0]!.origin.symbol, routes[0]!.destination.symbol]).toEqual(['wNEAR', 'USDC']);
    expect([routes[1]!.origin.symbol, routes[1]!.destination.symbol]).toEqual(['USDC', 'wNEAR']);
    const spokes = routes.slice(2);
    const far = spokes.map((r) => (r.origin.blockchain === 'near' ? r.destination : r.origin));
    expect(spokes.every((r) => r.origin.assetId === HUB || r.destination.assetId === HUB)).toBe(true);
    expect(new Set(far.map((t) => t.blockchain)).size).toBe(22);
    expect(far.every((t) => t.symbol === 'USDC')).toBe(true);
    expect(spokes.slice(0, 4).map((r) => (r.origin.blockchain === 'near' ? 'out' : 'in'))).toEqual([
      'in',
      'out',
      'in',
      'out',
    ]);
  });

  it('takes further rounds when there are fewer chains than routes, and returns [] without a hub', () => {
    const { tokens } = parseTokenList(syntheticTokenList(12));
    const routes = selectRoutes(tokens, 24);
    expect(routes).toHaveLength(24);
    expect(routes.slice(14).every((r) => [r.origin.symbol, r.destination.symbol].includes('NAT'))).toBe(true);
    expect(selectRoutes(tokens, 500)).toHaveLength(26);
    expect(
      selectRoutes(
        tokens.filter((t) => t.assetId !== HUB),
        24,
      ),
    ).toEqual([]);
  });

  it('every built request is dry and passes the unchanged live-dry policy', () => {
    const { tokens } = parseTokenList(syntheticTokenList(30));
    const now = new Date('2026-11-13T10:00:00.123Z');
    for (const route of selectRoutes(tokens, 39)) {
      const request = buildDryQuoteRequest(route, now);
      expect(request).toMatchObject({
        dry: true,
        deadline: '2026-11-13T11:00:00Z',
        recipient: MATRIX_INTENTS_ACCOUNT,
        refundType: 'INTENTS',
        recipientType: 'INTENTS',
      });
      const decision = classifyLiveDryRequest({
        method: 'POST',
        target: '/v0/quote',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify(request)),
      });
      expect(decision.allowed).toBe(true);
    }
  });

  it('clamps the route count so a run never needs more than 40 requests', () => {
    expect(MATRIX_MAX_ROUTES).toBe(39);
    expect(clampRouteCount(undefined)).toBe(24);
    expect(clampRouteCount(1000)).toBe(39);
    expect(clampRouteCount(0)).toBe(1);
    const budget = new RequestBudget();
    for (let i = 0; i < LIVE_DRY_HARD_REQUEST_CAP; i++) budget.take();
    expect(() => budget.take()).toThrow();
    expect(budget.used).toBe(40);
    expect(new RequestBudget(1000).cap).toBe(40);
  });
});

function row(index: number, over: Partial<MatrixRow> = {}): MatrixRow {
  return {
    index,
    origin: { symbol: 'USDC', blockchain: 'chain01', assetId: 'nep141:usdc-chain01.test' },
    destination: { symbol: 'USDC', blockchain: 'near', assetId: HUB },
    forwarded: true,
    httpStatus: 201,
    compatibility: 'OFFICIAL_ENDPOINT_COMPATIBLE',
    shapeResult: 'SHAPE_COMPATIBLE',
    reasonCode: 'PROFILE_SHAPE_MATCHED',
    responseShapeDigest: KNOWN,
    baseline: 'KNOWN_SHAPE',
    latencyMs: 700,
    ...over,
  };
}
const rows = (n: number, over: Partial<MatrixRow> = {}) =>
  Array.from({ length: n }, (_, i) => row(i + 1, over));
const evaluate = (r: MatrixRow[], transportKind: 'SYSTEM' | 'INJECTED' = 'SYSTEM', tokenListRead = true) =>
  evaluateMatrix({ rows: r, transportKind, tokenListRead });

describe('M51 verdict and baseline', () => {
  it('classifies a shape digest against the baseline only for a compatible row', () => {
    expect(baselineStatus(row(1), baseline)).toBe('KNOWN_SHAPE');
    expect(baselineStatus(row(1, { responseShapeDigest: OTHER }), baseline)).toBe('NEW_SHAPE');
    expect(baselineStatus(row(1, { compatibility: 'INCOMPATIBLE' }), baseline)).toBe('NOT_JUDGED');
    expect(baselineStatus(row(1, { compatibility: 'UNKNOWN' }), baseline)).toBe('NOT_JUDGED');
  });

  it('applies the verdict rules in order', () => {
    const unknown = {
      compatibility: 'UNKNOWN',
      reasonCode: 'PROVIDER_HTTP_400',
      baseline: 'NOT_JUDGED',
    } as const;
    const incompatible = {
      compatibility: 'INCOMPATIBLE',
      reasonCode: 'RS_UNKNOWN_MATERIAL_FIELD',
      baseline: 'NOT_JUDGED',
    } as const;
    expect(evaluate(rows(24))).toMatchObject({ verdict: 'NO_DRIFT' });
    expect(evaluate([...rows(23), row(24, { baseline: 'NEW_SHAPE' })])).toMatchObject({
      verdict: 'NEW_SHAPE',
    });
    expect(evaluate([...rows(23), row(24, incompatible)])).toMatchObject({
      verdict: 'DRIFT',
      counts: { compatible: 23, incompatible: 1, unknown: 0 },
    });
    expect(evaluate([...rows(3), row(4, incompatible)])).toMatchObject({ verdict: 'DRIFT' });
    expect(evaluate([...rows(19), ...rows(5, unknown)])).toMatchObject({
      verdict: 'INCONCLUSIVE',
      verdictReason: 'FEWER_THAN_MIN_ROUTES_COMPATIBLE',
    });
    expect(evaluate([...rows(20), ...rows(4, unknown)])).toMatchObject({ verdict: 'NO_DRIFT' });
    expect(evaluate(rows(24), 'INJECTED')).toMatchObject({
      verdict: 'INCONCLUSIVE',
      verdictReason: 'NOT_OFFICIAL_ENDPOINT',
    });
    expect(evaluate([], 'SYSTEM', false)).toMatchObject({
      verdict: 'INCONCLUSIVE',
      verdictReason: 'TOKEN_LIST_UNAVAILABLE',
    });
    expect((['NO_DRIFT', 'NEW_SHAPE', 'DRIFT', 'INCONCLUSIVE'] as const).map(exitCodeFor)).toEqual([
      0, 0, 1, 3,
    ]);
  });

  it('the committed baseline is well formed and bound to the pinned profile', () => {
    const committed = parseBaseline(JSON.parse(readFileSync(BASELINE_FILE, 'utf8')));
    expect(committed.profileIntegrityDigest).toBe(PINNED_PROFILE_INTEGRITY_DIGEST);
    expect(committed.knownResponseShapeDigests.length).toBeGreaterThan(0);
    expect(() => parseBaseline({ schema: 'routespec.fidelity-baseline/1' })).toThrow();
    expect(() => parseBaseline({ ...committed, knownResponseShapeDigests: ['not-a-digest'] })).toThrow();
  });
});

describe('M51 one matrix run through the adapter (loopback upstream, injected transport)', () => {
  const jwt = canaryJwt(3600, 'm51matrix');
  let pki: TestPki;
  let upstream: Upstream;
  let adapter: LaunchedAdapter;
  let matrix: FidelityMatrix;

  beforeAll(async () => {
    pki = createTestPki(PINNED_HOST);
    upstream = await startUpstream(pki.pinned, 'quote');
    upstream.tokens = syntheticTokenList(30);
    adapter = await launchTestAdapter({
      test: { kind: 'loopback-tls', port: upstream.port, ca: pki.caCert },
      jwt,
      maxProbes: 24,
      maxTokenListFetches: 1,
    });
    const sdk = await import('@defuse-protocol/one-click-sdk-typescript');
    matrix = await runFidelityMatrix({
      client: adapterMatrixClient(adapter, sdk as never),
      baseline,
      routes: 24,
      now: () => new Date('2026-11-13T10:00:00Z'),
    });
    sdk.OpenAPI.HEADERS = undefined;
  }, 120_000);
  afterAll(async () => {
    await adapter.close().catch(() => undefined);
    await upstream.close();
  });

  it('made one token-list read and one dry quote per route, 25 requests in all', () => {
    expect(upstream.received).toHaveLength(25);
    expect(upstream.received[0]).toMatchObject({ method: 'GET', url: '/v0/tokens' });
    expect(upstream.received[0]!.headers['authorization']).toBeUndefined();
    const quotes = upstream.received.slice(1);
    expect(quotes.every((r) => r.method === 'POST' && r.url === '/v0/quote')).toBe(true);
    expect(quotes.every((r) => (JSON.parse(r.body) as { dry: unknown }).dry === true)).toBe(true);
    expect(new Set(quotes.map((r) => r.body)).size).toBe(24);
    expect(matrix.requests).toEqual({ hardCap: 40, tokenListReads: 1, dryQuotes: 24, total: 25 });
  });

  it('a 25th quote in the same session is refused by the adapter and reported as not forwarded', async () => {
    const sdk = await import('@defuse-protocol/one-click-sdk-typescript');
    const client = adapterMatrixClient(adapter, sdk as never);
    const { tokens } = parseTokenList(syntheticTokenList(30));
    const extra = await client.quote(buildDryQuoteRequest(selectRoutes(tokens, 25)[24]!, new Date()));
    sdk.OpenAPI.HEADERS = undefined;
    expect(extra).toMatchObject({
      forwarded: false,
      compatibility: 'UNKNOWN',
      reasonCode: 'NOT_FORWARDED_PROBE_BUDGET_EXHAUSTED',
      responseShapeDigest: null,
    });
    expect(upstream.received).toHaveLength(25);
    const report = await adapter.report<ChildReport>();
    expect(report.counters).toMatchObject({ forwarded: 24, tokenListForwarded: 1, upstreamRequests: 25 });
  });

  it('an injected transport can never yield a compatible row or a passing verdict', () => {
    expect(matrix.transportKind).toBe('INJECTED');
    expect(matrix.rows).toHaveLength(24);
    for (const r of matrix.rows) {
      expect(r).toMatchObject({
        forwarded: true,
        httpStatus: 200,
        compatibility: 'UNKNOWN',
        shapeResult: 'SHAPE_COMPATIBLE',
        reasonCode: 'INJECTED_TRANSPORT_NOT_OFFICIAL_ENDPOINT',
        baseline: 'NOT_JUDGED',
      });
      expect(r.responseShapeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(matrix).toMatchObject({ verdict: 'INCONCLUSIVE', verdictReason: 'NOT_OFFICIAL_ENDPOINT' });
    expect(matrix.counts).toEqual({ routes: 24, compatible: 0, incompatible: 0, unknown: 24, newShapes: 0 });
    expect(renderBadge(matrix)).toEqual({
      schemaVersion: 1,
      label: '1Click fidelity',
      message: 'inconclusive, 0/24 routes',
      color: 'lightgrey',
    });
    expect(exitCodeFor(matrix.verdict)).toBe(3);
  });

  it('the matrix and its renderings carry no quote value, address or credential', () => {
    const sent = upstream.received.slice(1).map((r) => JSON.parse(r.body) as Record<string, string>);
    const markdown = renderMatrixMarkdown(matrix);
    const all = `${JSON.stringify(matrix)}\n${markdown}\n${JSON.stringify(renderBadge(matrix))}`;
    for (const request of sent) expect(all).not.toContain(request['amount']!);
    for (const value of [
      MATRIX_INTENTS_ACCOUNT,
      jwt,
      'm51matrix',
      '987654',
      'corr-sim',
      'SIMULATEDSIGNATURE',
    ]) {
      expect(all).not.toContain(value);
    }
    expect(all).not.toMatch(/amountOut|depositAddress|correlationId|priceUsd|"price"/);
    expect(markdown).toContain('| 1 | wNEAR (near) | USDC (near) | 200 | UNKNOWN |');
    expect(markdown).toContain('Verdict: **INCONCLUSIVE** (NOT_OFFICIAL_ENDPOINT)');
    expect(markdown).toContain('Requests: 25 of at most 40');
    expect(markdown.split('\n').filter((l) => /^\| \d+ \|/.test(l))).toHaveLength(24);
  });
});

describe('M51 token list unavailable', () => {
  it('yields an inconclusive matrix with no quote sent', async () => {
    const calls: string[] = [];
    const matrix = await runFidelityMatrix({
      baseline,
      client: {
        transportKind: () => Promise.resolve('SYSTEM' as const),
        tokenState: () => Promise.resolve('OPTIONAL_ABSENT' as const),
        tokens: () => {
          calls.push('tokens');
          return Promise.resolve({ ok: false as const, reasonCode: 'CLIENT_HTTP_502' });
        },
        quote: () => {
          calls.push('quote');
          return Promise.reject(new Error('must not be called'));
        },
      },
    });
    expect(calls).toEqual(['tokens']);
    expect(matrix).toMatchObject({
      verdict: 'INCONCLUSIVE',
      verdictReason: 'TOKEN_LIST_UNAVAILABLE',
      tokenList: { status: 'UNAVAILABLE', reasonCode: 'CLIENT_HTTP_502' },
      requests: { total: 1, dryQuotes: 0 },
    });
  });
});
