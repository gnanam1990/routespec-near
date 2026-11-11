/**
 * Compatibility classification and redacted shape evidence (FR-16, NFR-12, INV-08).
 *
 * Only the response *shape* is kept: a sorted list of JSON paths with their JSON types, bounded in
 * depth and count. No value is retained (no amounts, addresses, signatures, correlation IDs or
 * provider error text). The result lives on its own compatibility axis: it has no gate-run,
 * case-run or verdict field and nothing here can read or write a local GateRun.
 *
 * Label rules:
 * - DOCUMENTED_ONLY: no probe ran; the label comes from the pinned profile source read only.
 * - OFFICIAL_ENDPOINT_COMPATIBLE: a 200 JSON response that passes the pinned profile's quote
 *   finalization schema for the exact request sent, received over the built-in system transport
 *   (system DNS + system CA store) from the pinned origin. An injected transport can never earn it.
 * - INCOMPATIBLE: the endpoint answered 2xx but the body is not the profile shape (non-JSON,
 *   unknown field, missing field, request echo mismatch, invalid value).
 * - UNKNOWN: anything that does not let the shape be judged (transport failure, timeout,
 *   redirect, refused encoding, oversize, provider 4xx/5xx) and every compatible shape seen
 *   through a non-system transport.
 */
import {
  ONECLICK_PROFILE,
  digestValue,
  isRouteSpecError,
  validateQuoteFinalization,
  validateQuoteRequest,
  type Digest,
  type OfficialCompatibility,
} from '@routespec/contracts';
import type { EgressOutcome } from './egress.ts';
import type { AllowedDryQuote } from './policy.ts';

export type ShapeResult = 'SHAPE_COMPATIBLE' | 'SHAPE_INCOMPATIBLE' | 'NOT_JUDGED';

export interface ResponseShape {
  /** `path: type` entries, sorted. Types only; never values. */
  readonly fields: readonly string[];
  readonly truncated: boolean;
}

export interface CompatibilityResult {
  readonly compatibility: OfficialCompatibility;
  readonly shapeResult: ShapeResult;
  readonly reasonCode: string;
  readonly httpStatus: number | null;
  readonly responseShape: ResponseShape | null;
  readonly responseShapeDigest: Digest | null;
  readonly responseBytes: number;
  /** Whether the dry response carried a response-assigned deposit address (shape only). */
  readonly responseAssignedAddress: 'PRESENT' | 'ABSENT' | 'NOT_OBSERVED';
  readonly settlementExercised: false;
}

const MAX_SHAPE_FIELDS = 256;
const MAX_SHAPE_DEPTH = 8;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Extract a redacted, bounded type-only shape. Array elements collapse to `[]`. */
export function extractShape(value: unknown): ResponseShape {
  const out = new Set<string>();
  let truncated = false;
  const walk = (v: unknown, path: string, depth: number) => {
    if (out.size >= MAX_SHAPE_FIELDS) {
      truncated = true;
      return;
    }
    out.add(`${path}: ${typeOf(v)}`);
    if (depth >= MAX_SHAPE_DEPTH) {
      if (v !== null && typeof v === 'object') truncated = true;
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v.slice(0, 16)) walk(item, `${path}[]`, depth + 1);
    } else if (v !== null && typeof v === 'object') {
      for (const key of Object.keys(v).sort()) {
        const safeKey = /^[A-Za-z0-9_]{1,64}$/.test(key) ? key : '<non-identifier-key>';
        walk((v as Record<string, unknown>)[key], `${path}.${safeKey}`, depth + 1);
      }
    }
  };
  walk(value, '$', 0);
  return Object.freeze({ fields: Object.freeze([...out].sort()), truncated });
}

function shapeDigest(shape: ResponseShape): Digest {
  return digestValue('routespec.live-dry.response-shape/1', {
    fields: [...shape.fields],
    truncated: shape.truncated,
  });
}

/** The baseline record before any probe: a label from the pinned profile only. */
export function documentedOnly(): CompatibilityResult {
  return Object.freeze({
    compatibility: 'DOCUMENTED_ONLY',
    shapeResult: 'NOT_JUDGED',
    reasonCode: 'NO_PROBE_RUN_PROFILE_SOURCE_READ_ONLY',
    httpStatus: null,
    responseShape: null,
    responseShapeDigest: null,
    responseBytes: 0,
    responseAssignedAddress: 'NOT_OBSERVED',
    settlementExercised: false,
  });
}

export function classifyOutcome(input: {
  readonly allowance: AllowedDryQuote;
  readonly outcome: EgressOutcome;
  readonly officialTransport: boolean;
}): CompatibilityResult {
  const { allowance, outcome, officialTransport } = input;
  const base = { settlementExercised: false as const };
  if (outcome.kind === 'FAILED') {
    return Object.freeze({
      ...base,
      compatibility: 'UNKNOWN',
      shapeResult: 'NOT_JUDGED',
      reasonCode: outcome.reason,
      httpStatus: outcome.status,
      responseShape: null,
      responseShapeDigest: null,
      responseBytes: 0,
      responseAssignedAddress: 'NOT_OBSERVED',
    });
  }
  const bytes = outcome.body.length;
  if (outcome.status < 200 || outcome.status >= 300) {
    return Object.freeze({
      ...base,
      compatibility: 'UNKNOWN',
      shapeResult: 'NOT_JUDGED',
      reasonCode: `PROVIDER_HTTP_${outcome.status}`,
      httpStatus: outcome.status,
      responseShape: null,
      responseShapeDigest: null,
      responseBytes: bytes,
      responseAssignedAddress: 'NOT_OBSERVED',
    });
  }
  const incompatible = (reasonCode: string, shape: ResponseShape | null): CompatibilityResult =>
    Object.freeze({
      ...base,
      compatibility: 'INCOMPATIBLE',
      shapeResult: 'SHAPE_INCOMPATIBLE',
      reasonCode,
      httpStatus: outcome.status,
      responseShape: shape,
      responseShapeDigest: shape ? shapeDigest(shape) : null,
      responseBytes: bytes,
      responseAssignedAddress: 'NOT_OBSERVED',
    });
  const ct = (outcome.contentType ?? '').toLowerCase();
  if (!ct.startsWith('application/json')) return incompatible('RESPONSE_NOT_JSON', null);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(outcome.body));
  } catch {
    return incompatible('RESPONSE_NOT_JSON', null);
  }
  const shape = extractShape(json);
  try {
    const bound = validateQuoteRequest(allowance.material);
    validateQuoteFinalization(bound, json);
  } catch (error) {
    return incompatible(isRouteSpecError(error) ? error.code : 'RS_MATERIAL_INVALID', shape);
  }
  const quote = (json as { quote?: Record<string, unknown> }).quote ?? {};
  const assigned = 'depositAddress' in quote ? 'PRESENT' : 'ABSENT';
  return Object.freeze({
    ...base,
    compatibility: officialTransport ? 'OFFICIAL_ENDPOINT_COMPATIBLE' : 'UNKNOWN',
    shapeResult: 'SHAPE_COMPATIBLE',
    reasonCode: officialTransport ? 'PROFILE_SHAPE_MATCHED' : 'INJECTED_TRANSPORT_NOT_OFFICIAL_ENDPOINT',
    httpStatus: outcome.status,
    responseShape: shape,
    responseShapeDigest: shapeDigest(shape),
    responseBytes: bytes,
    responseAssignedAddress: assigned,
  });
}

/** Identity of what a probe was judged against. */
export function profileIdentity() {
  return Object.freeze({
    protocolProfileId: ONECLICK_PROFILE.profileId,
    profileIntegrityDigest: ONECLICK_PROFILE.integrityDigest,
    routeSchemaDigest: ONECLICK_PROFILE.routeSchemaDigest,
    statusSchemaDigest: ONECLICK_PROFILE.statusSchemaDigest,
    sdkPackage: ONECLICK_PROFILE.sdk.packageName,
    sdkVersion: ONECLICK_PROFILE.sdk.version,
    sdkGitHead: ONECLICK_PROFILE.sdk.gitHead,
    origin: ONECLICK_PROFILE.sdk.defaultBaseUrl,
  });
}
