/**
 * RouteSpec canonical encoding, version 1 (`rs-canon/1`). See docs/adr/0003-canonical-encoding.md.
 *
 * A typed, length-prefixed, deterministic binary encoding. It depends on no wall clock, host
 * path, locale, platform byte order, or object insertion order:
 *
 *   null          0x00
 *   false / true  0x01 / 0x02
 *   integer       0x03 u32(len) ASCII-decimal  (safe integer `number` or `bigint`; canonical form)
 *   string        0x04 u32(len) UTF-8 bytes    (must be well-formed Unicode)
 *   bytes         0x05 u32(len) raw bytes      (Uint8Array)
 *   array         0x06 u32(count) item*
 *   object        0x07 u32(count) (string-key value)* with keys sorted by UTF-8 byte order
 *   decimal       0x08 u32(len) ASCII           (finite non-integer `number`, ECMAScript
 *                                                Number::toString; only when explicitly allowed
 *                                                for raw provider payload digests, never economics)
 *
 * `undefined`, functions, symbols, non-plain objects (Date, Map, Set, class instances),
 * non-finite numbers, and lone surrogates are rejected rather than silently normalized.
 */
import { RouteSpecError } from '../errors.ts';

export const CANONICAL_ENCODING_VERSION = 'rs-canon/1' as const;

export interface CanonicalEncodeOptions {
  /** Permit finite non-integer numbers (tag 0x08). Default false. */
  readonly allowNonIntegerNumbers?: boolean;
  /** Maximum nesting depth. Default 64. */
  readonly maxDepth?: number;
  /** Maximum encoded size in bytes. Default 16 MiB. */
  readonly maxBytes?: number;
}

const TAG_NULL = 0x00;
const TAG_FALSE = 0x01;
const TAG_TRUE = 0x02;
const TAG_INTEGER = 0x03;
const TAG_STRING = 0x04;
const TAG_BYTES = 0x05;
const TAG_ARRAY = 0x06;
const TAG_OBJECT = 0x07;
const TAG_DECIMAL = 0x08;

const UTF8 = new TextEncoder();

class ByteSink {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  push(bytes: Uint8Array): void {
    this.size += bytes.length;
    if (this.size > this.maxBytes) {
      throw new RouteSpecError('RS_CANONICAL_LIMIT_EXCEEDED', 'Canonical encoding exceeds the byte limit.', {
        details: { maxBytes: this.maxBytes },
      });
    }
    this.chunks.push(bytes);
  }

  tag(tag: number): void {
    this.push(Uint8Array.of(tag));
  }

  u32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RouteSpecError('RS_CANONICAL_LIMIT_EXCEEDED', 'Length prefix out of range.');
    }
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, false);
    this.push(out);
  }

  lengthPrefixed(tag: number, bytes: Uint8Array): void {
    this.tag(tag);
    this.u32(bytes.length);
    this.push(bytes);
  }

  result(): Uint8Array {
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const diff = (a[i] as number) - (b[i] as number);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

function encodeUtf8Checked(value: string, path: string): Uint8Array {
  if (!value.isWellFormed()) {
    throw new RouteSpecError('RS_CANONICAL_MALFORMED_STRING', 'String contains a lone surrogate.', {
      details: { path },
    });
  }
  return UTF8.encode(value);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function unsupported(path: string, kind: string): never {
  throw new RouteSpecError('RS_CANONICAL_UNSUPPORTED_TYPE', 'Value type is not canonically encodable.', {
    details: { path, kind },
  });
}

function encodeInto(
  sink: ByteSink,
  value: unknown,
  path: string,
  depth: number,
  options: Required<CanonicalEncodeOptions>,
): void {
  if (depth > options.maxDepth) {
    throw new RouteSpecError('RS_CANONICAL_LIMIT_EXCEEDED', 'Canonical encoding exceeds the depth limit.', {
      details: { path, maxDepth: options.maxDepth },
    });
  }
  if (value === null) {
    sink.tag(TAG_NULL);
    return;
  }
  switch (typeof value) {
    case 'boolean':
      sink.tag(value ? TAG_TRUE : TAG_FALSE);
      return;
    case 'bigint':
      sink.lengthPrefixed(TAG_INTEGER, UTF8.encode(value.toString(10)));
      return;
    case 'number': {
      if (!Number.isFinite(value)) unsupported(path, 'non-finite-number');
      if (Number.isInteger(value)) {
        if (!Number.isSafeInteger(value)) {
          throw new RouteSpecError(
            'RS_CANONICAL_NON_INTEGER',
            'Integer exceeds the safe range; use bigint.',
            {
              details: { path },
            },
          );
        }
        // Object.is(-0) normalizes to "0" via String(); -0 and 0 are the same integer.
        sink.lengthPrefixed(TAG_INTEGER, UTF8.encode(String(value === 0 ? 0 : value)));
        return;
      }
      if (!options.allowNonIntegerNumbers) {
        throw new RouteSpecError('RS_CANONICAL_NON_INTEGER', 'Non-integer number is not canonical here.', {
          details: { path },
        });
      }
      sink.lengthPrefixed(TAG_DECIMAL, UTF8.encode(String(value)));
      return;
    }
    case 'string':
      sink.lengthPrefixed(TAG_STRING, encodeUtf8Checked(value, path));
      return;
    case 'object':
      break;
    default:
      unsupported(path, typeof value);
  }
  const obj = value as object;
  if (obj instanceof Uint8Array) {
    sink.lengthPrefixed(TAG_BYTES, obj);
    return;
  }
  if (Array.isArray(obj)) {
    sink.tag(TAG_ARRAY);
    sink.u32(obj.length);
    for (let i = 0; i < obj.length; i++) {
      if (!(i in obj)) unsupported(`${path}[${i}]`, 'array-hole');
      encodeInto(sink, obj[i], `${path}[${i}]`, depth + 1, options);
    }
    return;
  }
  if (!isPlainObject(obj)) unsupported(path, 'non-plain-object');
  if (Object.getOwnPropertySymbols(obj).length > 0) unsupported(path, 'symbol-key');
  const entries = Object.keys(obj).map((key) => ({ key, bytes: encodeUtf8Checked(key, path) }));
  entries.sort((a, b) => compareBytes(a.bytes, b.bytes));
  sink.tag(TAG_OBJECT);
  sink.u32(entries.length);
  for (const { key, bytes } of entries) {
    const child = (obj as Record<string, unknown>)[key];
    if (child === undefined) unsupported(`${path}.${key}`, 'undefined');
    sink.lengthPrefixed(TAG_STRING, bytes);
    encodeInto(sink, child, `${path}.${key}`, depth + 1, options);
  }
}

export function canonicalEncode(value: unknown, options: CanonicalEncodeOptions = {}): Uint8Array {
  const resolved: Required<CanonicalEncodeOptions> = {
    allowNonIntegerNumbers: options.allowNonIntegerNumbers ?? false,
    maxDepth: options.maxDepth ?? 64,
    maxBytes: options.maxBytes ?? 16 * 1024 * 1024,
  };
  const sink = new ByteSink(resolved.maxBytes);
  encodeInto(sink, value, '$', 0, resolved);
  return sink.result();
}

/**
 * Canonical JSON text: keys sorted by UTF-8 byte order, no insignificant whitespace,
 * integers only (bigint rendered as a JSON string is NOT done implicitly — callers must
 * represent base-unit amounts as decimal strings). Used for human-inspectable storage
 * columns; digests always use `canonicalEncode`.
 */
export function canonicalJson(value: unknown, options: CanonicalEncodeOptions = {}): string {
  // Validate with the binary encoder first so both representations accept the same domain.
  canonicalEncode(value, options);
  return stringifySorted(value);
}

function stringifySorted(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') {
    // JSON has no exact bigint; base-unit amounts must be decimal strings in stored JSON.
    unsupported('$', 'bigint-in-json');
  }
  if (value instanceof Uint8Array) {
    return JSON.stringify({ $bytes: Buffer.from(value).toString('base64') });
  }
  if (Array.isArray(value)) return `[${value.map(stringifySorted).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .map((key) => ({ key, bytes: UTF8.encode(key) }))
    .sort((a, b) => compareBytes(a.bytes, b.bytes));
  return `{${keys.map(({ key }) => `${JSON.stringify(key)}:${stringifySorted(obj[key])}`).join(',')}}`;
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
