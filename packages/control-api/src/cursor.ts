/**
 * Opaque, tamper-evident pagination cursors (API-SPEC section 1, T-045).
 *
 * A cursor names the exclusive position after the last returned row, the list it belongs to,
 * and a digest of the filters it was issued under. It is authenticated with a per-process HMAC
 * key, so a forged, edited, truncated, cross-list, or cross-filter cursor fails with
 * `RS_CURSOR_INVALID` instead of silently returning a different page. Cursors issued before a
 * service restart are invalid (the key is ephemeral) and fail the same clear way.
 *
 * Positions are journal sort keys (sequence numbers or `(created_at_ms, id)` pairs). Rows are
 * appended by a single serialized writer, so a row committed after a page was read always sorts
 * after that page's last position: concurrent appends can neither duplicate nor skip rows.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { RouteSpecError, digestValue } from '@routespec/contracts';

export type CursorPosition =
  | { readonly kind: 'seq'; readonly seq: number }
  | { readonly kind: 'key'; readonly t: number; readonly id: string };

interface CursorBody {
  readonly v: 1;
  readonly list: string;
  readonly f: string;
  readonly p: CursorPosition;
}

export class CursorCodec {
  readonly #key: Buffer;

  constructor(key: Buffer = randomBytes(32)) {
    this.#key = key;
  }

  #mac(payload: string): Buffer {
    return createHmac('sha256', this.#key).update(payload).digest();
  }

  encode(list: string, filters: unknown, position: CursorPosition): string {
    const body: CursorBody = {
      v: 1,
      list,
      f: digestValue('routespec.cursor-filters/1', filters),
      p: position,
    };
    const payload = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    return `${payload}.${this.#mac(payload).toString('base64url')}`;
  }

  decode(cursor: string, list: string, filters: unknown): CursorPosition {
    const invalid = () =>
      new RouteSpecError(
        'RS_CURSOR_INVALID',
        'The pagination cursor is invalid, expired, or belongs to another query.',
      );
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
    const [payload, mac] = cursor.split('.') as [string, string];
    const expected = this.#mac(payload);
    const presented = Buffer.from(mac, 'base64url');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) throw invalid();
    let body: CursorBody;
    try {
      body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as CursorBody;
    } catch {
      throw invalid();
    }
    if (body.v !== 1 || body.list !== list || body.f !== digestValue('routespec.cursor-filters/1', filters)) {
      throw invalid();
    }
    const p = body.p;
    if (p.kind === 'seq' && Number.isSafeInteger(p.seq) && p.seq >= 0) return { kind: 'seq', seq: p.seq };
    if (p.kind === 'key' && Number.isSafeInteger(p.t) && typeof p.id === 'string' && p.id.length <= 64) {
      return { kind: 'key', t: p.t, id: p.id };
    }
    throw invalid();
  }
}

export function parseLimit(raw: string | null, fallback = 50): number {
  if (raw === null) return fallback;
  if (!/^\d{1,3}$/.test(raw)) {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'limit must be an integer from 1 to 200.', {
      details: { field: 'limit' },
    });
  }
  const n = Number(raw);
  if (n < 1 || n > 200) {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'limit must be an integer from 1 to 200.', {
      details: { field: 'limit' },
    });
  }
  return n;
}
