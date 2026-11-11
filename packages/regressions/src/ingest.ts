/**
 * Bounded streaming ingest and a bounded, strict JSON reader (FR-11, NFR-06, SECURITY.md 8).
 *
 * `ingestStream` hashes every byte as it streams and keeps at most `maxBytes` in process memory
 * (never on disk, never in the journal). Past the limit it stops reading, cancels the source,
 * and reports a resource finding; the digest then covers only the bytes read and is labelled so.
 *
 * `parseBoundedJson` is a recursive-descent reader that enforces depth, string length, keys per
 * object, total node count, rejects duplicate keys (a smuggling vector JSON.parse silently
 * resolves) and prototype-polluting keys, and decodes strings with the standard JSON grammar.
 * It never evaluates anything; it builds plain data only.
 */
import { createHash } from 'node:crypto';
import type { ImportLimits } from './limits.ts';
import { safePath, type FindingCategory } from './findings.ts';

export interface IngestResult {
  readonly bytes: Buffer | null;
  readonly byteCount: number;
  readonly digest: `sha256:${string}`;
  readonly complete: boolean;
}

export type ByteSource = AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>;

export async function ingestStream(source: ByteSource, maxBytes: number): Promise<IngestResult> {
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  let byteCount = 0;
  let complete = true;
  const iterator =
    Symbol.asyncIterator in source
      ? (source as AsyncIterable<Uint8Array | string>)[Symbol.asyncIterator]()
      : null;
  const syncIterator =
    iterator === null ? (source as Iterable<Uint8Array | string>)[Symbol.iterator]() : null;
  try {
    for (;;) {
      const step = iterator ? await iterator.next() : (syncIterator as Iterator<Uint8Array | string>).next();
      if (step.done) break;
      const chunk =
        typeof step.value === 'string' ? Buffer.from(step.value, 'utf8') : Buffer.from(step.value);
      const room = maxBytes - byteCount;
      if (chunk.length > room) {
        // Hash the bytes that fit plus one more so a truncated digest never equals a complete one.
        const kept = chunk.subarray(0, Math.max(room, 0) + 1);
        hash.update(kept);
        byteCount += kept.length;
        complete = false;
        break;
      }
      hash.update(chunk);
      chunks.push(chunk);
      byteCount += chunk.length;
    }
  } finally {
    if (!complete) {
      await iterator?.return?.();
      syncIterator?.return?.();
    }
  }
  return {
    bytes: complete ? Buffer.concat(chunks) : null,
    byteCount,
    digest: `sha256:${hash.digest('hex')}`,
    complete,
  };
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface JsonParseFailure {
  readonly ok: false;
  readonly category: FindingCategory;
  readonly path: string;
}

export type JsonParseResult = { readonly ok: true; readonly value: JsonValue } | JsonParseFailure;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class Stop extends Error {
  readonly category: FindingCategory;
  readonly where: string;
  constructor(category: FindingCategory, where: string) {
    super(category);
    this.category = category;
    this.where = where;
  }
}

export function parseBoundedJson(text: string, limits: ImportLimits): JsonParseResult {
  let i = 0;
  let nodes = 0;
  const path: Array<string | number> = [];
  const stop = (category: FindingCategory): never => {
    throw new Stop(category, safePath(path));
  };
  const ws = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  const readString = (): string => {
    const start = i;
    i++; // opening quote
    for (;;) {
      if (i >= text.length) stop('SCHEMA_INVALID');
      const c = text.charCodeAt(i);
      if (c === 0x22) break;
      if (c === 0x5c) i += 2;
      else {
        if (c < 0x20) stop('SCHEMA_INVALID');
        i++;
      }
      if (i - start > limits.maxStringLength * 6 + 2) stop('RESOURCE_STRING');
    }
    i++; // closing quote
    let decoded: string;
    try {
      decoded = JSON.parse(text.slice(start, i)) as string;
    } catch {
      return stop('SCHEMA_INVALID');
    }
    if (decoded.length > limits.maxStringLength) stop('RESOURCE_STRING');
    return decoded;
  };
  const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const value = (depth: number): JsonValue => {
    if (depth > limits.maxDepth) stop('RESOURCE_DEPTH');
    if (++nodes > limits.maxNodes) stop('RESOURCE_NODES');
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const out: Record<string, JsonValue> = {};
      const seen = new Set<string>();
      ws();
      if (text[i] === '}') {
        i++;
        return out;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') stop('SCHEMA_INVALID');
        const key = readString();
        if (FORBIDDEN_KEYS.has(key)) stop('SCHEMA_FORBIDDEN_KEY');
        if (seen.has(key)) {
          path.push(key);
          stop('SCHEMA_DUPLICATE_KEY');
        }
        seen.add(key);
        if (seen.size > limits.maxKeysPerObject) stop('RESOURCE_KEYS');
        ws();
        if (text[i] !== ':') stop('SCHEMA_INVALID');
        i++;
        path.push(key);
        out[key] = value(depth + 1);
        path.pop();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return out;
        }
        return stop('SCHEMA_INVALID');
      }
    }
    if (c === '[') {
      i++;
      const out: JsonValue[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return out;
      }
      for (;;) {
        path.push(out.length);
        out.push(value(depth + 1));
        path.pop();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return out;
        }
        return stop('SCHEMA_INVALID');
      }
    }
    if (c === '"') return readString();
    if (text.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return false;
    }
    if (text.startsWith('null', i)) {
      i += 4;
      return null;
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (m === null) return stop('SCHEMA_INVALID');
    i += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) stop('SCHEMA_INVALID');
    return n;
  };
  try {
    const v = value(0);
    ws();
    if (i !== text.length) stop('SCHEMA_INVALID');
    return { ok: true, value: v };
  } catch (error) {
    if (error instanceof Stop) return { ok: false, category: error.category, path: error.where };
    if (error instanceof RangeError) return { ok: false, category: 'RESOURCE_DEPTH', path: safePath(path) };
    throw error;
  }
}

/** Strict UTF-8 decode; invalid sequences or a byte-order-mark smuggle are refused. */
export function decodeUtf8(bytes: Buffer): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? null : text;
  } catch {
    return null;
  }
}
