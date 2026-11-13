/**
 * Fidelity matrix (M51): the official token list as route-selection input.
 *
 * The list is provider data and is treated as untrusted: only five fields are read, each is
 * bounded and pattern-checked, and an entry that does not fit is skipped and counted. The symbol
 * later appears in a markdown table, so its alphabet is restricted here. Prices are used once, in
 * memory, to size a small dry amount; they are never written to a report.
 */
import { RouteSpecError, digestValue, type Digest } from '@routespec/contracts';
import { extractShape } from './compatibility.ts';

export const TOKEN_LIST_MAX_ENTRIES = 5_000;

export interface MatrixToken {
  readonly assetId: string;
  readonly blockchain: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly priceUsd: number;
}

export interface ParsedTokenList {
  readonly tokens: readonly MatrixToken[];
  /** Entries the endpoint listed. */
  readonly listed: number;
  /** Entries that passed the checks below. */
  readonly usable: number;
  /** Type-only shape digest of the list (no values). */
  readonly shapeDigest: Digest;
}

const ASSET_ID = /^[A-Za-z0-9:._-]{1,256}$/;
const BLOCKCHAIN = /^[a-z0-9]{1,32}$/;
const SYMBOL = /^[A-Za-z0-9.$+_-]{1,32}$/;

function toToken(entry: unknown): MatrixToken | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;
  const { assetId, blockchain, symbol, decimals, price } = e;
  if (typeof assetId !== 'string' || !ASSET_ID.test(assetId)) return null;
  if (typeof blockchain !== 'string' || !BLOCKCHAIN.test(blockchain)) return null;
  if (typeof symbol !== 'string' || !SYMBOL.test(symbol)) return null;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    return null;
  }
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || price > 1e9) return null;
  return Object.freeze({ assetId, blockchain, symbol, decimals, priceUsd: price });
}

/** Parse the token-list response. Throws only when the body is not a bounded array. */
export function parseTokenList(input: unknown): ParsedTokenList {
  if (!Array.isArray(input) || input.length > TOKEN_LIST_MAX_ENTRIES) {
    throw new RouteSpecError('RS_MATERIAL_INVALID', 'Token list is not a bounded array.', {
      details: { reason: 'TOKEN_LIST_SHAPE' },
    });
  }
  const seen = new Set<string>();
  const tokens: MatrixToken[] = [];
  for (const entry of input) {
    const token = toToken(entry);
    if (token === null || seen.has(token.assetId)) continue;
    seen.add(token.assetId);
    tokens.push(token);
  }
  tokens.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
  const shape = extractShape(input);
  return Object.freeze({
    tokens: Object.freeze(tokens),
    listed: input.length,
    usable: tokens.length,
    shapeDigest: digestValue('routespec.fidelity.token-list-shape/1', {
      fields: [...shape.fields],
      truncated: shape.truncated,
    }),
  });
}
