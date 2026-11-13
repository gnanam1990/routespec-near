/**
 * Fidelity matrix (M51): the redacted matrix record, its verdict, and its renderings.
 *
 * A row keeps the route (public asset ids and symbols from the token list), the HTTP status, the
 * compatibility label and reason the adapter assigned, the type-only response shape digest and the
 * round-trip time. It keeps no amount, price, address, signature, correlation id or response
 * value: a quote is never written anywhere.
 *
 * Verdict, in this order:
 * - INCONCLUSIVE / NOT_OFFICIAL_ENDPOINT: the transport was injected (tests); nothing is claimed.
 * - INCONCLUSIVE / TOKEN_LIST_UNAVAILABLE: no usable token list, so no route was probed.
 * - DRIFT: at least one route answered 2xx with a body that is not the pinned profile shape.
 * - INCONCLUSIVE / FEWER_THAN_MIN_ROUTES_COMPATIBLE: fewer than 20 routes were judged compatible
 *   (provider 4xx/5xx, such as a route without liquidity, and transport failures are UNKNOWN,
 *   not drift).
 * - NEW_SHAPE: every judged route fits the profile, but a shape digest is not in the reviewed
 *   baseline (for example an optional field appeared). Review and extend the baseline.
 * - NO_DRIFT: at least 20 routes compatible, every shape digest in the baseline.
 */
import type { Digest, OfficialCompatibility, ProviderTokenState } from '@routespec/contracts';
import type { ShapeResult } from './compatibility.ts';
import { MATRIX_MIN_ROUTES } from './matrix-routes.ts';

export interface MatrixAsset {
  readonly symbol: string;
  readonly blockchain: string;
  readonly assetId: string;
}

export interface MatrixRow {
  readonly index: number;
  readonly origin: MatrixAsset;
  readonly destination: MatrixAsset;
  /** False when the adapter denied the request locally (policy or budget): nothing was sent. */
  readonly forwarded: boolean;
  readonly httpStatus: number | null;
  readonly compatibility: OfficialCompatibility;
  readonly shapeResult: ShapeResult;
  readonly reasonCode: string;
  readonly responseShapeDigest: Digest | null;
  readonly baseline: 'KNOWN_SHAPE' | 'NEW_SHAPE' | 'NOT_JUDGED';
  readonly latencyMs: number | null;
}

export type MatrixVerdict = 'NO_DRIFT' | 'NEW_SHAPE' | 'DRIFT' | 'INCONCLUSIVE';

export interface FidelityBaseline {
  readonly schema: 'routespec.fidelity-baseline/1';
  readonly profileIntegrityDigest: string;
  readonly knownResponseShapeDigests: readonly string[];
}

export interface FidelityMatrix {
  readonly schema: 'routespec.fidelity-matrix/1';
  readonly generatedAt: string;
  readonly origin: string;
  readonly profile: {
    readonly protocolProfileId: string;
    readonly profileIntegrityDigest: string;
    readonly sdkPackage: string;
    readonly sdkVersion: string;
  };
  readonly transportKind: 'SYSTEM' | 'INJECTED';
  readonly tokenState: ProviderTokenState;
  readonly tokenList: {
    readonly status: 'READ' | 'UNAVAILABLE';
    readonly reasonCode: string;
    readonly listed: number;
    readonly usable: number;
    readonly shapeDigest: Digest | null;
  };
  readonly requests: {
    readonly hardCap: number;
    /** Routes with a judgeable (2xx) answer the run aimed for. */
    readonly targetRoutes: number;
    /** Most dry quotes the run was allowed to send while reaching the target. */
    readonly quoteCeiling: number;
    readonly tokenListReads: number;
    readonly dryQuotes: number;
    readonly total: number;
  };
  readonly rows: readonly MatrixRow[];
  readonly counts: {
    readonly routes: number;
    readonly compatible: number;
    readonly incompatible: number;
    readonly unknown: number;
    readonly newShapes: number;
  };
  readonly verdict: MatrixVerdict;
  readonly verdictReason: string;
  readonly settlementExercised: false;
}

export function parseBaseline(input: unknown): FidelityBaseline {
  const b = input as Record<string, unknown> | null;
  const digests = b?.['knownResponseShapeDigests'];
  if (
    b === null ||
    typeof b !== 'object' ||
    b['schema'] !== 'routespec.fidelity-baseline/1' ||
    typeof b['profileIntegrityDigest'] !== 'string' ||
    !Array.isArray(digests) ||
    !digests.every((d) => typeof d === 'string' && /^sha256:[0-9a-f]{64}$/.test(d))
  ) {
    throw new Error('fidelity baseline is malformed');
  }
  return Object.freeze({
    schema: 'routespec.fidelity-baseline/1',
    profileIntegrityDigest: b['profileIntegrityDigest'],
    knownResponseShapeDigests: Object.freeze([...(digests as string[])]),
  });
}

/** Classify one row's shape digest against the reviewed baseline. */
export function baselineStatus(
  row: Pick<MatrixRow, 'compatibility' | 'responseShapeDigest'>,
  baseline: FidelityBaseline,
): MatrixRow['baseline'] {
  if (row.compatibility !== 'OFFICIAL_ENDPOINT_COMPATIBLE' || row.responseShapeDigest === null) {
    return 'NOT_JUDGED';
  }
  return baseline.knownResponseShapeDigests.includes(row.responseShapeDigest) ? 'KNOWN_SHAPE' : 'NEW_SHAPE';
}

export function evaluateMatrix(input: {
  readonly rows: readonly MatrixRow[];
  readonly transportKind: 'SYSTEM' | 'INJECTED';
  readonly tokenListRead: boolean;
}): Pick<FidelityMatrix, 'counts' | 'verdict' | 'verdictReason'> {
  const { rows } = input;
  const compatible = rows.filter((r) => r.compatibility === 'OFFICIAL_ENDPOINT_COMPATIBLE').length;
  const incompatible = rows.filter((r) => r.compatibility === 'INCOMPATIBLE').length;
  const newShapes = rows.filter((r) => r.baseline === 'NEW_SHAPE').length;
  const counts = Object.freeze({
    routes: rows.length,
    compatible,
    incompatible,
    unknown: rows.length - compatible - incompatible,
    newShapes,
  });
  const out = (verdict: MatrixVerdict, verdictReason: string) => ({ counts, verdict, verdictReason });
  if (input.transportKind !== 'SYSTEM') return out('INCONCLUSIVE', 'NOT_OFFICIAL_ENDPOINT');
  if (!input.tokenListRead) return out('INCONCLUSIVE', 'TOKEN_LIST_UNAVAILABLE');
  if (incompatible > 0) return out('DRIFT', 'PROFILE_SHAPE_MISMATCH');
  if (compatible < MATRIX_MIN_ROUTES) return out('INCONCLUSIVE', 'FEWER_THAN_MIN_ROUTES_COMPATIBLE');
  if (newShapes > 0) return out('NEW_SHAPE', 'SHAPE_DIGEST_OUTSIDE_BASELINE');
  return out('NO_DRIFT', 'ALL_SHAPES_IN_BASELINE');
}

/** Exit code of the matrix command for a verdict. */
export function exitCodeFor(verdict: MatrixVerdict): 0 | 1 | 3 {
  return verdict === 'DRIFT' ? 1 : verdict === 'INCONCLUSIVE' ? 3 : 0;
}

/** shields.io endpoint badge (https://shields.io/badges/endpoint-badge). */
export function renderBadge(matrix: FidelityMatrix) {
  const ratio = `${matrix.counts.compatible}/${matrix.counts.routes} routes`;
  const by: Record<MatrixVerdict, readonly [string, string]> = {
    NO_DRIFT: [`no drift, ${ratio}`, 'brightgreen'],
    NEW_SHAPE: [`new shape, ${ratio}`, 'yellow'],
    DRIFT: [`drift, ${matrix.counts.incompatible} of ${matrix.counts.routes} routes`, 'red'],
    INCONCLUSIVE: [`inconclusive, ${ratio}`, 'lightgrey'],
  };
  const [message, color] = by[matrix.verdict];
  return { schemaVersion: 1, label: '1Click fidelity', message, color };
}

const asset = (a: MatrixAsset) => `${a.symbol} (${a.blockchain})`;
const short = (d: string | null) => (d === null ? 'none' : `\`${d.slice(0, 19)}\``);

export function renderMatrixMarkdown(matrix: FidelityMatrix): string {
  const c = matrix.counts;
  const lines: string[] = [
    '# 1Click fidelity matrix',
    '',
    `- Generated: ${matrix.generatedAt}`,
    `- Endpoint: \`${matrix.origin}\` (transport ${matrix.transportKind}, provider token ${matrix.tokenState})`,
    `- Profile: \`${matrix.profile.protocolProfileId}\` \`${matrix.profile.profileIntegrityDigest}\`, SDK \`${matrix.profile.sdkPackage}@${matrix.profile.sdkVersion}\``,
    `- Verdict: **${matrix.verdict}** (${matrix.verdictReason}): ${c.compatible} compatible, ${c.incompatible} incompatible, ${c.unknown} unknown, ${c.newShapes} with a shape outside the baseline, of ${c.routes} routes`,
    `- Requests: ${matrix.requests.total} of at most ${matrix.requests.hardCap} (${matrix.requests.tokenListReads} token-list read, ${matrix.requests.dryQuotes} dry quotes; target ${matrix.requests.targetRoutes} answered routes, ceiling ${matrix.requests.quoteCeiling} quotes)`,
    `- Token list: ${matrix.tokenList.status} (${matrix.tokenList.reasonCode}), ${matrix.tokenList.listed} listed, ${matrix.tokenList.usable} usable, shape ${short(matrix.tokenList.shapeDigest)}`,
    '- Every quote was `dry: true`. No deposit address was requested, nothing was signed, submitted or settled, and no quote value (amount, price, address, signature) is recorded here.',
    '',
    '| #   | Origin | Destination | HTTP | Compatibility | Reason | Shape digest | Baseline | ms  |',
    '| --- | ------ | ----------- | ---- | ------------- | ------ | ------------ | -------- | --- |',
  ];
  for (const r of matrix.rows) {
    lines.push(
      `| ${r.index} | ${asset(r.origin)} | ${asset(r.destination)} | ${r.httpStatus ?? 'none'} | ${r.compatibility} | ${r.reasonCode} | ${short(r.responseShapeDigest)} | ${r.baseline} | ${r.latencyMs ?? 'none'} |`,
    );
  }
  const byDigest = new Map<string, MatrixRow[]>();
  for (const r of matrix.rows) {
    if (r.responseShapeDigest === null) continue;
    byDigest.set(r.responseShapeDigest, [...(byDigest.get(r.responseShapeDigest) ?? []), r]);
  }
  lines.push('', '## Response shape digests', '');
  if (byDigest.size === 0) {
    lines.push('No response shape was captured.');
  } else {
    lines.push('| Shape digest | Routes | Baseline |', '| ------------ | ------ | -------- |');
    for (const digest of [...byDigest.keys()].sort()) {
      const rows = byDigest.get(digest)!;
      lines.push(`| \`${digest}\` | ${rows.map((r) => r.index).join(', ')} | ${rows[0]!.baseline} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}
