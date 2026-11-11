/**
 * Bounded request parsing, typed error envelopes, and response writing for the control API
 * (API-SPEC sections 1 and 3).
 *
 * Bodies are read under a hard byte cap with no decompression; JSON is parsed with a duplicate
 * key check and a nesting limit before any schema validation. Error envelopes carry only safe
 * codes, human-safe messages, and scalar details (never request values).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RouteSpecError, type ErrorCode } from '@routespec/contracts';
import { STATUS_BY_CODE } from '@routespec/proxy';

const CONTROL_STATUS: Partial<Record<ErrorCode, number>> = {
  ...STATUS_BY_CODE,
  RS_CONTROL_AUTH_REQUIRED: 401,
  RS_CONTROL_AUTH_INVALID: 401,
  RS_METHOD_NOT_ALLOWED: 405,
  RS_IDEMPOTENCY_KEY_REQUIRED: 428,
  RS_PRECONDITION_REQUIRED: 428,
  RS_IDEMPOTENCY_KEY_REUSED: 409,
  RS_IDEMPOTENCY_IN_PROGRESS: 409,
  RS_REVISION_CONFLICT: 412,
  RS_CURSOR_INVALID: 400,
  RS_RATE_LIMITED: 429,
  RS_LOCAL_CONFIRMATION_REQUIRED: 403,
  RS_LOCAL_CONFIRMATION_INVALID: 403,
  RS_ATTESTER_UNAVAILABLE: 409,
  RS_CHALLENGE_UNAVAILABLE: 409,
  RS_ATTESTATION_REJECTED: 403,
  RS_PEER_BINDING_UNAVAILABLE: 403,
  RS_PROBE_NOT_AUTHORIZED: 403,
  RS_DELETION_PLAN_MISMATCH: 409,
  RS_IMMUTABLE_RECORD: 409,
  RS_LIFECYCLE_TRANSITION_INVALID: 409,
  RS_TERMINAL_IMMUTABLE: 409,
  RS_RECOVERY_NOT_REQUIRED: 409,
  RS_LEASE_HELD: 409,
  RS_PARALLELISM_EXCEEDED: 409,
  RS_GATE_VALIDATION_FAILED: 409,
  RS_SCENARIO_INVALID: 400,
  RS_SCENARIO_UNSAFE_CONSTRUCT: 400,
  RS_IMPORT_STATE_INVALID: 409,
  RS_IMPORT_BLOCKED: 422,
  RS_IMPORT_MAPPING_INVALID: 422,
  RS_IMPORT_REVIEW_INVALID: 422,
  RS_IMPORT_CAPTURE_MISMATCH: 409,
  RS_IMPORT_LIMIT_EXCEEDED: 413,
  RS_EXPORT_BLOCKED: 422,
  RS_EXPORT_CONFIRMATION_REQUIRED: 403,
  RS_EXPORT_OVERWRITE_DENIED: 409,
  RS_EXPORT_PATH_INVALID: 400,
  RS_ENFORCEMENT_CLAIM_REJECTED: 422,
  RS_EFFECT_HOOK_UNDECLARED: 422,
  RS_UNKNOWN_CONTRACT_KIND: 400,
  RS_SCHEMA_VERSION_UNSUPPORTED: 400,
};

export function controlStatusFor(code: ErrorCode): number {
  return CONTROL_STATUS[code] ?? 500;
}

export function safeError(error: unknown): RouteSpecError {
  if (error instanceof RouteSpecError) return error;
  const message = error instanceof Error ? error.message : '';
  // SQLite trigger aborts carry the RouteSpec code as their message.
  const match = /\b(RS_[A-Z0-9_]+)\b/.exec(message);
  if (match) {
    const code = match[1] as ErrorCode;
    if (CONTROL_STATUS[code] !== undefined)
      return new RouteSpecError(code, 'The journal refused this change.');
  }
  return new RouteSpecError('RS_INTERNAL', 'Internal control API error.');
}

export const BASE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'x-frame-options': 'DENY',
});

export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    ...extra,
  });
  res.end(text);
}

export function writeError(res: ServerResponse, error: RouteSpecError, requestId: string): void {
  const status = controlStatusFor(error.code);
  const extra: Record<string, string> = {};
  if (error.code === 'RS_RATE_LIMITED') extra['retry-after'] = '1';
  writeJson(res, status, error.toEnvelope(requestId), extra);
}

/** JSON.parse reviver-free duplicate-key detection with a nesting limit. */
function scanJson(text: string, maxDepth: number): void {
  const stack: Array<Set<string> | null> = [];
  let i = 0;
  let expectKey = false;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') {
      let j = i + 1;
      let raw = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          raw += text.slice(j, j + 2);
          j += 2;
        } else {
          raw += text[j];
          j++;
        }
      }
      const top = stack[stack.length - 1];
      if (expectKey && top) {
        let key: string;
        try {
          key = JSON.parse(`"${raw}"`) as string;
        } catch {
          throw new RouteSpecError('RS_SCHEMA_INVALID', 'Request body is not valid JSON.');
        }
        if (top.has(key)) throw new RouteSpecError('RS_SCHEMA_INVALID', 'Request body has a duplicate key.');
        top.add(key);
        expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (ch === '{') {
      stack.push(new Set());
      expectKey = true;
    } else if (ch === '[') {
      stack.push(null);
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    } else if (ch === ',') {
      expectKey = stack[stack.length - 1] instanceof Set;
    }
    if (stack.length > maxDepth)
      throw new RouteSpecError('RS_SCHEMA_INVALID', 'Request body nesting exceeds the limit.');
    i++;
  }
}

/**
 * Read at most `maxBytes` of the body. Past the cap the request is paused, not destroyed, so
 * the caller can still answer 413 before the connection is closed (M11, T-042).
 */
function readCapped(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        cleanup();
        req.pause();
        reject(
          new RouteSpecError('RS_BODY_TOO_LARGE', 'Request body exceeds the limit.', {
            details: { maxBytes },
          }),
        );
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = () => {
      cleanup();
      reject(new RouteSpecError('RS_SCHEMA_INVALID', 'The request body could not be read.'));
    };
    const onAborted = onError;
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
}

export async function readJsonBody(req: IncomingMessage, maxBytes: number, maxDepth = 24): Promise<unknown> {
  const type = String(req.headers['content-type'] ?? '')
    .toLowerCase()
    .trim();
  if (!/^application\/json(\s*;\s*charset=utf-8)?$/.test(type)) {
    throw new RouteSpecError(
      'RS_CONTENT_TYPE_UNSUPPORTED',
      'Control mutations accept only application/json bodies.',
    );
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
  const buf = await readCapped(req, maxBytes);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'Request body must not start with a byte-order mark.');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'Request body is not valid UTF-8.');
  }
  scanJson(text, maxDepth);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'Request body is not valid JSON.');
  }
}

/** Drain and refuse a body on a route that defines none. */
export function assertNoBody(req: IncomingMessage): void {
  const length = req.headers['content-length'];
  if ((length !== undefined && length !== '0') || req.headers['transfer-encoding'] !== undefined) {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'This route does not accept a request body.');
  }
}
