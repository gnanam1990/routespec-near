/**
 * Fidelity matrix (M51): deterministic route selection and the dry quote request for one route.
 *
 * Selection is a pure function of the sanitized token list, so two runs over the same list probe
 * the same routes. The hub is USDC on NEAR. The first two routes are the NEAR pair
 * (wNEAR <-> USDC); then every other chain, in name order, contributes its preferred token
 * (USDC, then USDT, then the lowest asset id), alternating direction into and out of the hub;
 * further rounds take each chain's next token until the requested count is reached.
 *
 * Every request is `dry: true`, EXACT_INPUT, about 20 USD of the origin asset, with refund and
 * recipient on the intents side (`refundType`/`recipientType: INTENTS`) to the all-zero implicit
 * account, so no chain-specific address is needed and no real account is named.
 */
import type { MatrixToken } from './matrix-tokens.ts';

export const MATRIX_MIN_ROUTES = 20;
export const MATRIX_DEFAULT_ROUTES = 24;
export const MATRIX_PROBE_USD = 20;
export const MATRIX_HUB = Object.freeze({ blockchain: 'near', symbol: 'USDC' });
export const MATRIX_HUB_PAIR_SYMBOL = 'wNEAR';
export const MATRIX_INTENTS_ACCOUNT = '0'.repeat(64);
const PREFERRED_SYMBOLS = ['USDC', 'USDT'];

export interface MatrixRoute {
  readonly index: number;
  readonly origin: MatrixToken;
  readonly destination: MatrixToken;
}

/** Base-unit amount worth about `usd` US dollars of `token`, or null when it cannot be sized. */
export function probeAmount(token: MatrixToken, usd: number = MATRIX_PROBE_USD): string | null {
  const priceNano = BigInt(Math.round(token.priceUsd * 1e9));
  if (priceNano <= 0n || !Number.isInteger(usd) || usd <= 0) return null;
  const amount = (BigInt(usd) * 10n ** 9n * 10n ** BigInt(token.decimals)) / priceNano;
  if (amount <= 0n || amount.toString().length > 60) return null;
  return amount.toString();
}

function byAssetId(a: MatrixToken, b: MatrixToken): number {
  return a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0;
}

function rank(token: MatrixToken): number {
  const i = PREFERRED_SYMBOLS.indexOf(token.symbol);
  return i === -1 ? PREFERRED_SYMBOLS.length : i;
}

/** Up to `count` routes, in a fixed order. Returns fewer when the list cannot supply them. */
export function selectRoutes(tokens: readonly MatrixToken[], count: number): MatrixRoute[] {
  const sized = tokens.filter((t) => probeAmount(t) !== null);
  const hub = sized
    .filter((t) => t.blockchain === MATRIX_HUB.blockchain && t.symbol === MATRIX_HUB.symbol)
    .sort(byAssetId)[0];
  if (hub === undefined || count <= 0) return [];
  const pairs: Array<[MatrixToken, MatrixToken]> = [];
  const pair = sized
    .filter((t) => t.blockchain === MATRIX_HUB.blockchain && t.symbol === MATRIX_HUB_PAIR_SYMBOL)
    .sort(byAssetId)[0];
  if (pair !== undefined) pairs.push([pair, hub], [hub, pair]);

  const byChain = new Map<string, MatrixToken[]>();
  for (const t of sized) {
    if (t.blockchain === MATRIX_HUB.blockchain) continue;
    const list = byChain.get(t.blockchain) ?? [];
    list.push(t);
    byChain.set(t.blockchain, list);
  }
  const chains = [...byChain.keys()].sort();
  for (const chain of chains) {
    byChain.get(chain)!.sort((a, b) => rank(a) - rank(b) || byAssetId(a, b));
  }
  const deepest = Math.max(0, ...chains.map((c) => byChain.get(c)!.length));
  for (let round = 0; round < deepest && pairs.length < count; round++) {
    for (const chain of chains) {
      const token = byChain.get(chain)![round];
      if (token === undefined) continue;
      pairs.push(pairs.length % 2 === 0 ? [token, hub] : [hub, token]);
    }
  }
  return pairs
    .slice(0, count)
    .map(([origin, destination], i) => Object.freeze({ index: i + 1, origin, destination }));
}

/** The dry quote request for one route. `deadline` is one hour after `now`, second precision. */
export function buildDryQuoteRequest(route: MatrixRoute, now: Date): Record<string, unknown> {
  const amount = probeAmount(route.origin);
  if (amount === null) throw new Error('route origin cannot be sized');
  return {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: route.origin.assetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: route.destination.assetId,
    amount,
    refundTo: MATRIX_INTENTS_ACCOUNT,
    refundType: 'INTENTS',
    recipient: MATRIX_INTENTS_ACCOUNT,
    recipientType: 'INTENTS',
    deadline: new Date(now.getTime() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}
