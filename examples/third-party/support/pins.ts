/**
 * Pinned third-party example sources (M48).
 *
 * A pin names one public repository, one commit, its licence, and the exact files RouteSpec may
 * read from it, each with the SHA-256 of its git blob. Nothing from a pinned repository is
 * committed here: the files are fetched on request into the ignored `.data/third-party/`
 * directory (see `fetch.ts`) and are checked against these digests before every use.
 *
 * Node built-ins only: this module is also loaded inside the subject container.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Sha256 = `sha256:${string}`;

/** Licences accepted for a pinned source. Anything else, or no licence at all, is refused. */
export const PERMISSIVE_LICENCES: readonly string[] = Object.freeze([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
]);

export interface PinnedFile {
  readonly path: string;
  readonly sha256: Sha256;
}

export interface PinnedSource {
  readonly id: string;
  readonly repository: string;
  readonly standing: 'OFFICIAL' | 'WELL_KNOWN';
  readonly standingNote: string;
  readonly commit: string;
  readonly licence: { readonly spdx: string; readonly file: string; readonly holder: string };
  readonly entry: string;
  readonly files: readonly PinnedFile[];
  /** Bare module specifiers the pinned files may import. Everything else is refused. */
  readonly allowedImports: readonly string[];
}

export class PinError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PinError';
    this.code = code;
  }
}

export const PINS_SCHEMA = 'routespec.third-party-pins/1';
export const PINS_FILE = fileURLToPath(new URL('../pins.json', import.meta.url));
/** The RouteSpec checkout that holds this file (the subject root of a contained run). */
export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const REPOSITORY = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SEGMENT = /^[A-Za-z0-9_.@-]{1,128}$/;
const SPECIFIER = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PRINTABLE = /^[\x20-\x7e]{2,400}$/;

export function sha256(bytes: Buffer | string): Sha256 {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** A pinned path is a plain relative POSIX path: no `..`, no leading slash, no backslash. */
export function isSafeRelativePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512) return false;
  return path.split('/').every((s) => SEGMENT.test(s) && s !== '.' && s !== '..');
}

function fail(code: string, message: string): never {
  throw new PinError(code, message);
}

function text(value: unknown, pattern: RegExp, what: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail('PIN_INVALID', `${what} is malformed.`);
  return value;
}

function safePath(value: unknown, what: string): string {
  if (!isSafeRelativePath(value)) fail('PIN_PATH_UNSAFE', `${what} is not a safe relative path.`);
  return value;
}

function parseSource(raw: unknown): PinnedSource {
  if (raw === null || typeof raw !== 'object') fail('PIN_INVALID', 'A pinned source must be an object.');
  const r = raw as Record<string, unknown>;
  const id = text(r['id'], ID, 'id');
  const licence = (r['licence'] ?? {}) as Record<string, unknown>;
  const spdx = typeof licence['spdx'] === 'string' ? licence['spdx'] : '';
  if (!PERMISSIVE_LICENCES.includes(spdx)) {
    fail('PIN_LICENCE_NOT_PERMISSIVE', `${id}: licence "${spdx}" is not an accepted permissive licence.`);
  }
  const standing = r['standing'];
  if (standing !== 'OFFICIAL' && standing !== 'WELL_KNOWN') {
    fail('PIN_STANDING_INVALID', `${id}: standing must be OFFICIAL or WELL_KNOWN.`);
  }
  const listed = r['files'];
  if (!Array.isArray(listed) || listed.length === 0 || listed.length > 64) {
    fail('PIN_INVALID', `${id}: files must list 1 to 64 entries.`);
  }
  const files = (listed as unknown[]).map((f) => {
    const file = (f ?? {}) as Record<string, unknown>;
    const path = safePath(file['path'], `${id}: a file path`);
    return Object.freeze({
      path,
      sha256: text(file['sha256'], DIGEST, `${id}: digest of ${path}`) as Sha256,
    });
  });
  const paths = new Set(files.map((f) => f.path));
  if (paths.size !== files.length) fail('PIN_INVALID', `${id}: a file is listed twice.`);
  const entry = safePath(r['entry'], `${id}: entry`);
  const licenceFile = safePath(licence['file'], `${id}: licence file`);
  if (!paths.has(entry)) fail('PIN_INVALID', `${id}: the entry is not among the pinned files.`);
  if (!paths.has(licenceFile)) fail('PIN_INVALID', `${id}: the licence file is not among the pinned files.`);
  const allowed = Array.isArray(r['allowedImports']) ? (r['allowedImports'] as unknown[]) : [];
  return Object.freeze({
    id,
    repository: text(r['repository'], REPOSITORY, `${id}: repository`),
    standing,
    standingNote: text(r['standingNote'], PRINTABLE, `${id}: standingNote`),
    commit: text(r['commit'], COMMIT, `${id}: commit`),
    licence: Object.freeze({
      spdx,
      file: licenceFile,
      holder: text(licence['holder'], PRINTABLE, `${id}: licence holder`),
    }),
    entry,
    files: Object.freeze(files),
    allowedImports: Object.freeze(allowed.map((s) => text(s, SPECIFIER, `${id}: allowed import`))),
  });
}

/** Strict parse of a pins document. Throws `PinError` on anything unexpected. */
export function parsePins(value: unknown): readonly PinnedSource[] {
  if (value === null || typeof value !== 'object') fail('PIN_INVALID', 'Pins must be an object.');
  const doc = value as Record<string, unknown>;
  if (doc['schema'] !== PINS_SCHEMA) fail('PIN_INVALID', 'Unknown pins schema.');
  const listed = doc['sources'];
  if (!Array.isArray(listed)) fail('PIN_INVALID', 'Pins must list sources.');
  const sources = (listed as unknown[]).map(parseSource);
  if (new Set(sources.map((s) => s.id)).size !== sources.length) fail('PIN_INVALID', 'Duplicate pin id.');
  return Object.freeze(sources);
}

export function loadPins(file: string = PINS_FILE): readonly PinnedSource[] {
  return parsePins(JSON.parse(readFileSync(file, 'utf8')));
}

export function pinById(id: string, pins: readonly PinnedSource[] = loadPins()): PinnedSource {
  const pin = pins.find((p) => p.id === id);
  if (!pin) fail('PIN_UNKNOWN', `No pinned source "${id}".`);
  return pin;
}

/** Where the fetched files of a pin live inside a checkout (ignored by git). */
export function sourceDir(root: string, pin: PinnedSource): string {
  return join(root, '.data', 'third-party', pin.id, pin.commit);
}

export interface TreeCheck {
  readonly ok: boolean;
  readonly findings: readonly string[];
}

function listTree(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    const st = lstatSync(join(dir, name));
    if (st.isDirectory()) out.push(...listTree(join(dir, name), rel));
    else out.push(st.isFile() ? rel : `!${rel}`);
  }
  return out;
}

/**
 * Check a fetched tree against its pin: every pinned file present as a regular file with the
 * pinned digest, and nothing else in the tree. Reads bytes only; never executes anything.
 */
export function verifySourceTree(dir: string, pin: PinnedSource): TreeCheck {
  if (!existsSync(dir)) return { ok: false, findings: ['SOURCES_ABSENT'] };
  const findings: string[] = [];
  const present = listTree(dir);
  const pinned = new Map(pin.files.map((f) => [f.path, f.sha256]));
  for (const rel of present) {
    if (rel.startsWith('!')) findings.push(`NOT_A_REGULAR_FILE ${rel.slice(1)}`);
    else if (!pinned.has(rel)) findings.push(`UNPINNED_FILE ${rel}`);
  }
  for (const [path, digest] of pinned) {
    if (!present.includes(path)) findings.push(`MISSING_FILE ${path}`);
    else if (sha256(readFileSync(join(dir, ...path.split('/')))) !== digest) {
      findings.push(`DIGEST_MISMATCH ${path}`);
    }
  }
  return { ok: findings.length === 0, findings };
}
