/**
 * Strict JSON parsing for live-dry request bodies.
 *
 * `JSON.parse` silently keeps the last of two duplicate keys, so `{"dry":true,"dry":false}` would
 * read as dry to this process while an upstream parser could read it as committed. The adapter
 * refuses any body that is ambiguous in that way: duplicate keys at any depth, a byte-order mark,
 * non-UTF-8 bytes, nesting beyond a fixed depth, or a top-level value that is not an object.
 */

export type StrictJsonResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

const MAX_DEPTH = 16;

/** Scan for duplicate object keys without evaluating anything. Assumes `text` is valid JSON. */
function findDuplicateKey(text: string): boolean {
  const stack: Array<Set<string> | null> = [];
  let i = 0;
  let expectKey = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      let raw = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          raw += text.slice(j, j + 2);
          j += 2;
        } else {
          raw += text[j];
          j += 1;
        }
      }
      const top = stack[stack.length - 1];
      if (expectKey && top) {
        const key = JSON.parse(`"${raw}"`) as string;
        if (top.has(key)) return true;
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
      expectKey = false;
    } else if (ch === ',') {
      expectKey = stack[stack.length - 1] !== null && stack.length > 0;
    }
    i += 1;
  }
  return false;
}

function depthOf(value: unknown, depth = 0): number {
  if (depth > MAX_DEPTH) return depth;
  if (Array.isArray(value)) return Math.max(depth, ...value.map((v) => depthOf(v, depth + 1)));
  if (value !== null && typeof value === 'object') {
    return Math.max(depth, ...Object.values(value).map((v) => depthOf(v, depth + 1)));
  }
  return depth;
}

export function parseStrictJsonObject(bytes: Buffer): StrictJsonResult {
  if (bytes.length === 0) return { ok: false, reason: 'BODY_EMPTY' };
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { ok: false, reason: 'BODY_BOM' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'BODY_NOT_UTF8' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'BODY_NOT_JSON' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'BODY_NOT_OBJECT' };
  }
  if (depthOf(value) > MAX_DEPTH) return { ok: false, reason: 'BODY_TOO_DEEP' };
  if (findDuplicateKey(text)) return { ok: false, reason: 'DUPLICATE_KEY' };
  return { ok: true, value: value as Record<string, unknown> };
}
