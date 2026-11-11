/**
 * Minimal deterministic POSIX ustar archive writer/reader for evidence bundles.
 *
 * Writer: regular files only, sorted entry order, mode 0644, uid/gid 0, mtime 0, empty
 * user/group names, so identical content yields identical bytes. Reader: fails closed on any
 * entry that is not a regular file (links, directories, devices, PAX/GNU extensions), on an
 * unsafe name (absolute, drive letter, backslash, `..`, empty segment, non-portable
 * characters), duplicate names, bad checksums, truncation, or trailing garbage.
 */
import { RouteSpecError } from '@routespec/contracts';

const BLOCK = 512;
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
export const MAX_ENTRIES = 4096;
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63}){0,7}$/;

export interface TarEntry {
  readonly path: string;
  readonly content: Buffer;
}

export function isSafeEntryName(name: string): boolean {
  return name.length <= 100 && SAFE_NAME.test(name) && !name.split('/').some((p) => p === '..' || p === '.');
}

function bad(reason: string): never {
  throw new RouteSpecError('RS_BUNDLE_VERIFY_FAILED', 'Bundle archive is malformed or unsafe.', {
    details: { reason },
  });
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function header(path: string, size: number): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(path, 0, 100, 'ascii');
  h.write(octal(0o644, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(0, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write('0', 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

export function writeTar(entries: readonly TarEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set<string>();
  const parts: Buffer[] = [];
  for (const e of sorted) {
    if (!isSafeEntryName(e.path)) bad('unsafe-name');
    if (seen.has(e.path)) bad('duplicate-name');
    seen.add(e.path);
    if (e.content.length > MAX_ENTRY_BYTES) bad('entry-too-large');
    parts.push(header(e.path, e.content.length), e.content);
    const pad = (BLOCK - (e.content.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

function field(h: Buffer, start: number, len: number): string {
  const raw = h.subarray(start, start + len);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? len : end).toString('ascii');
}

export function readTar(bytes: Buffer): TarEntry[] {
  if (bytes.length > MAX_BUNDLE_BYTES) bad('bundle-too-large');
  if (bytes.length % BLOCK !== 0) bad('not-block-aligned');
  const out: TarEntry[] = [];
  const seen = new Set<string>();
  let off = 0;
  for (;;) {
    if (off + BLOCK > bytes.length) bad('truncated');
    const h = bytes.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) {
      if (off + BLOCK * 2 > bytes.length) bad('missing-end-marker');
      if (!bytes.subarray(off, off + BLOCK * 2).every((b) => b === 0)) bad('bad-end-marker');
      if (!bytes.subarray(off + BLOCK * 2).every((b) => b === 0)) bad('trailing-data');
      return out;
    }
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] as number);
    const recorded = parseInt(field(h, 148, 8).trim(), 8);
    if (!Number.isInteger(recorded) || recorded !== sum) bad('checksum');
    if (field(h, 257, 6) !== 'ustar') bad('not-ustar');
    const type = String.fromCharCode(h[156] as number);
    if (type !== '0' && type !== '\0') bad('not-regular-file');
    if (field(h, 345, 155) !== '') bad('prefix-not-supported');
    const name = field(h, 0, 100);
    if (!isSafeEntryName(name)) bad('unsafe-name');
    if (seen.has(name)) bad('duplicate-name');
    seen.add(name);
    const size = parseInt(field(h, 124, 12).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES) bad('bad-size');
    off += BLOCK;
    if (off + size > bytes.length) bad('truncated');
    out.push({ path: name, content: Buffer.from(bytes.subarray(off, off + size)) });
    off += size + ((BLOCK - (size % BLOCK)) % BLOCK);
    if (out.length > MAX_ENTRIES) bad('too-many-entries');
  }
}
