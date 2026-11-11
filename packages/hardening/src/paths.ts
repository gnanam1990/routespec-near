/**
 * Local path policy shared by every file-system boundary (FR-17, FR-18, SECURITY.md sections 8-9).
 *
 * RouteSpec reads and writes only plain local paths that the operator named explicitly. This
 * module rejects, before any file-system call:
 *
 * - network and device namespaces: UNC (`\\host\share`, `//host/share`), Win32 device and
 *   extended-length prefixes (`\\.\`, `\\?\`, `\??\`). Opening a UNC path on Windows can send
 *   the user's NTLM credentials to a remote host, so this applies to reads as well as writes;
 * - drive-relative paths (`C:file`), which resolve against a hidden per-drive working directory;
 * - NUL and other control characters, and bidirectional override characters;
 * - NTFS alternate data streams (`file:stream`) and any other colon after the drive letter;
 * - reserved Windows device names in any component (`CON`, `NUL`, `COM1`, `LPT1`, `CONIN$`, with
 *   or without an extension), and components ending in a dot or a space, which Windows silently
 *   strips (an alias of another name);
 * - over-long paths.
 *
 * The rules are platform independent on purpose: an evidence bundle or path written on one
 * platform must stay safe on every other one.
 */
import { lstatSync, realpathSync, statSync, type Stats } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { RouteSpecError, type ErrorCode } from '@routespec/contracts';

export const MAX_LOCAL_PATH_LENGTH = 1024;

/** A reserved Windows device name, with or without an extension (`nul`, `con.json`, `COM1.txt`). */
export const WINDOWS_RESERVED_NAME =
  /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)(\..*)?$/i;

export type PathRule =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'CONTROL_CHARACTER'
  | 'BIDI_CHARACTER'
  | 'NETWORK_PATH'
  | 'DEVICE_NAMESPACE'
  | 'DRIVE_RELATIVE'
  | 'ALTERNATE_DATA_STREAM'
  | 'RESERVED_DEVICE_NAME'
  | 'TRAILING_DOT_OR_SPACE'
  | 'TRAVERSAL';

export interface PathCheck {
  readonly ok: boolean;
  readonly rule: PathRule | null;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const BIDI = /[‪-‮⁦-⁩‎‏]/;

function components(path: string): string[] {
  return path.split(/[\\/]+/).filter((p) => p.length > 0);
}

/** Pure syntactic check of an operator-supplied local path (no file-system access). */
export function checkLocalPathSyntax(path: unknown): PathCheck {
  const fail = (rule: PathRule): PathCheck => ({ ok: false, rule });
  if (typeof path !== 'string' || path.length === 0) return fail('EMPTY');
  if (path.length > MAX_LOCAL_PATH_LENGTH) return fail('TOO_LONG');
  if (CONTROL.test(path)) return fail('CONTROL_CHARACTER');
  if (BIDI.test(path)) return fail('BIDI_CHARACTER');
  if (/^[\\/]{2}[?.][\\/]/.test(path) || /^[\\/]\?\?[\\/]/.test(path)) return fail('DEVICE_NAMESPACE');
  if (/^[\\/]{2}/.test(path)) return fail('NETWORK_PATH');
  if (/^[A-Za-z]:(?![\\/])/.test(path)) return fail('DRIVE_RELATIVE');
  const body = /^[A-Za-z]:[\\/]/.test(path) ? path.slice(2) : path;
  if (body.includes(':')) return fail('ALTERNATE_DATA_STREAM');
  for (const part of components(body)) {
    if (part === '.' || part === '..') continue;
    if (WINDOWS_RESERVED_NAME.test(part)) return fail('RESERVED_DEVICE_NAME');
    if (/[. ]$/.test(part)) return fail('TRAILING_DOT_OR_SPACE');
  }
  return { ok: true, rule: null };
}

function refuse(code: ErrorCode, message: string, rule: PathRule | string): never {
  throw new RouteSpecError(code, message, { details: { rule } });
}

/** Throw a typed error unless `path` passes `checkLocalPathSyntax`. */
export function assertLocalPathSyntax(path: unknown, code: ErrorCode, what = 'path'): asserts path is string {
  const c = checkLocalPathSyntax(path);
  if (!c.ok) refuse(code, `The ${what} is not an accepted local path.`, c.rule as PathRule);
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export interface ResolvedOutput {
  /** Absolute target path (as the operator named it, resolved against the working directory). */
  readonly path: string;
  /** Canonical real path of the existing parent directory the file is written into. */
  readonly realParent: string;
  /** Whether a regular file already exists at the target (overwrite needs confirmation). */
  readonly exists: boolean;
}

/**
 * Resolve an explicit output file path. The parent directory must already exist and be a
 * directory; the final component must not exist or must be a regular file (never a symbolic
 * link, junction, directory, or device, dangling links included: `lstat`, not `stat`).
 */
export function resolveOutputFile(outPath: unknown, code: ErrorCode): ResolvedOutput {
  assertLocalPathSyntax(outPath, code, 'output path');
  const full = resolve(outPath);
  if (full.endsWith(sep)) refuse(code, 'The output path names a directory.', 'NOT_A_FILE');
  const parent = dirname(full);
  let parentStat: Stats;
  try {
    parentStat = statSync(parent);
  } catch {
    refuse(code, 'The output directory does not exist.', 'PARENT_MISSING');
  }
  if (!parentStat.isDirectory()) refuse(code, 'The output directory does not exist.', 'PARENT_MISSING');
  const st = lstatOrNull(full);
  if (st !== null && (st.isSymbolicLink() || !st.isFile())) {
    refuse(code, 'The output path is not a regular file.', st.isSymbolicLink() ? 'LINK' : 'NOT_A_FILE');
  }
  return { path: full, realParent: realpathSync.native(parent), exists: st !== null };
}

/**
 * Resolve an explicit input file. It must be a plain local path to an existing regular file;
 * a link is followed only when `followLinks` is set (reading through a link never writes).
 */
export function resolveInputFile(
  inPath: unknown,
  code: ErrorCode,
  options: { followLinks?: boolean } = {},
): string {
  assertLocalPathSyntax(inPath, code, 'input path');
  const full = resolve(inPath);
  const st = lstatOrNull(full);
  if (st === null) refuse(code, 'The input file does not exist.', 'MISSING');
  if (st.isSymbolicLink() && options.followLinks !== true) refuse(code, 'The input path is a link.', 'LINK');
  const target = statSync(full);
  if (!target.isFile()) refuse(code, 'The input path is not a regular file.', 'NOT_A_FILE');
  return full;
}

/**
 * Prepare a new or empty extraction directory that is a real directory (not a link or
 * junction to somewhere else). Returns its canonical real path; every extracted entry must
 * then stay under that path (`isWithin`).
 */
export function resolveExtractionDir(dir: unknown, code: ErrorCode): { path: string; exists: boolean } {
  assertLocalPathSyntax(dir, code, 'extraction directory');
  const full = resolve(dir);
  const st = lstatOrNull(full);
  if (st !== null && st.isSymbolicLink())
    refuse(code, 'The extraction directory must not be a link.', 'LINK');
  if (st !== null && !st.isDirectory())
    refuse(code, 'The extraction directory is not a directory.', 'NOT_A_DIRECTORY');
  return { path: full, exists: st !== null };
}

/** Whether `child` is `root` itself or strictly inside it (case-insensitive on Windows). */
export function isWithin(root: string, child: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const r = norm(resolve(root));
  const c = norm(resolve(child));
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** Whether a relative name is portable and safe as a single archive or file name component. */
export function isPortableComponent(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !CONTROL.test(name) &&
    !BIDI.test(name) &&
    !/[<>:"|?*\\/]/.test(name) &&
    !WINDOWS_RESERVED_NAME.test(name) &&
    !/[. ]$/.test(name)
  );
}
