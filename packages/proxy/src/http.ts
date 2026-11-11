/**
 * Bounded request parsing and typed error responses for the loopback proxy (NFR-06, API-SPEC
 * section 3). Bodies are read with a hard byte cap, compressed bodies are refused (no
 * decompression, so no decompression bomb), JSON depth is scanned before parsing, and error
 * envelopes carry only safe codes and scalar details.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RouteSpecError, type ErrorCode } from '@routespec/contracts';

export const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  RS_SCHEMA_INVALID: 400,
  RS_MATERIAL_INVALID: 400,
  RS_UNKNOWN_MATERIAL_FIELD: 400,
  RS_DEPOSIT_ADDRESS_NOT_REQUEST_KNOWN: 400,
  RS_HEADER_INVALID: 400,
  RS_PARTIAL_FINALIZATION: 400,
  RS_TOKEN_INVALID: 401,
  RS_TOKEN_REVOKED: 401,
  RS_TOKEN_EXPIRED: 401,
  RS_TOKEN_PHASE_DENIED: 403,
  RS_IDENTITY_MISMATCH: 403,
  RS_CLIENT_CONFLICT: 403,
  RS_ADAPTER_MISMATCH: 403,
  RS_STALE_FENCING_EPOCH: 403,
  RS_MODE_POLICY_DENIED: 403,
  RS_HOST_REJECTED: 403,
  RS_ORIGIN_REJECTED: 403,
  RS_UNSUPPORTED_ROUTE: 404,
  RS_NOT_FOUND: 404,
  RS_PHASE_INVALID: 409,
  RS_DUPLICATE: 409,
  RS_MATERIAL_CHANGED: 409,
  RS_SECOND_COMMIT_REJECTED: 409,
  RS_COMMIT_MATERIAL_MISMATCH: 409,
  RS_COMMIT_WITHOUT_FINALIZATION: 409,
  RS_FINALIZATION_CONFLICT: 409,
  RS_FINALIZATION_REQUEST_MISMATCH: 409,
  RS_SCENARIO_UNEXPECTED_REQUEST: 409,
  RS_SCENARIO_ENDED: 409,
  RS_LEASE_EXPIRED: 409,
  RS_BODY_TOO_LARGE: 413,
  RS_CONTENT_TYPE_UNSUPPORTED: 415,
  RS_SECRET_FIELD_REJECTED: 422,
  RS_SCENARIO_LIMIT_EXCEEDED: 429,
  RS_STORAGE_FULL: 503,
  RS_STORAGE_BUSY: 503,
  RS_STORAGE_UNAVAILABLE: 503,
};

export function httpStatusFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

/** Normalize anything thrown into a safe RouteSpecError (never serialize foreign errors wholesale). */
export function toSafeError(error: unknown): RouteSpecError {
  if (error instanceof RouteSpecError) return error;
  return new RouteSpecError('RS_INTERNAL', 'Internal proxy error.');
}

export function writeError(res: ServerResponse, error: RouteSpecError, requestId: string): void {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(error.toEnvelope(requestId));
  res.writeHead(httpStatusFor(error.code), {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function jsonDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (ch === 0x5c) i++;
      else if (ch === 0x22) inString = false;
      continue;
    }
    if (ch === 0x22) inString = true;
    else if (ch === 0x7b || ch === 0x5b) max = Math.max(max, ++depth);
    else if (ch === 0x7d || ch === 0x5d) depth--;
  }
  return max;
}

/** Read a JSON body under a hard byte cap. Compressed or non-JSON bodies are refused. */
export async function readJsonBody(req: IncomingMessage, maxBytes: number, maxDepth = 16): Promise<unknown> {
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!/^application\/json(\s*;\s*charset=utf-8)?$/.test(type.trim())) {
    throw new RouteSpecError('RS_CONTENT_TYPE_UNSUPPORTED', 'Only application/json bodies are accepted.');
  }
  const encoding = req.headers['content-encoding'];
  if (encoding !== undefined && encoding !== 'identity') {
    throw new RouteSpecError('RS_CONTENT_TYPE_UNSUPPORTED', 'Compressed request bodies are not accepted.');
  }
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RouteSpecError('RS_BODY_TOO_LARGE', 'Request body exceeds the limit.', {
      details: { maxBytes },
    });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      throw new RouteSpecError('RS_BODY_TOO_LARGE', 'Request body exceeds the limit.', {
        details: { maxBytes },
      });
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (jsonDepth(text) > maxDepth) {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'Request body nesting exceeds the limit.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'Request body is not valid JSON.');
  }
}

/** Reject any request that carries a body where the route defines none. */
export function assertNoBody(req: IncomingMessage): void {
  const length = req.headers['content-length'];
  if ((length !== undefined && length !== '0') || req.headers['transfer-encoding'] !== undefined) {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'This route does not accept a request body.');
  }
}
