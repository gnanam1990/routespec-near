/**
 * Quarantine finding vocabulary (FR-11, FR-17, SECURITY.md section 8).
 *
 * A finding is metadata only: a closed category, a sanitized JSON path, and a count. It never
 * carries the matched value. Categories fall into three dispositions:
 * - REJECTING: the source cannot be safely persisted even in sanitized form (secret-bearing,
 *   resource-exceeded, malformed). Only the raw digest and findings persist.
 * - BLOCKING: the sanitized source persists for review, but it can never be mapped or promoted
 *   (unresolved material, nondeterminism, identity mismatch).
 * - ADVISORY: content was neutralized or is noteworthy for the reviewer (active content,
 *   instruction text, digested signed material, ignored origin claims, unfetched URLs).
 */
export const SCANNER_REVISION = 'routespec-trace-scanner@1.0.0' as const;

export const REJECTING_CATEGORIES = Object.freeze([
  'SECRET_CONFIGURED_VALUE',
  'SECRET_JWT',
  'SECRET_BEARER',
  'SECRET_PRIVATE_KEY',
  'SECRET_CASE_TOKEN',
  'SECRET_PROVIDER_KEY',
  'SECRET_AUTHORIZATION_HEADER',
  'SECRET_COOKIE',
  'SECRET_FIELD',
  'RESOURCE_BYTES',
  'RESOURCE_DEPTH',
  'RESOURCE_STRING',
  'RESOURCE_EVENTS',
  'RESOURCE_KEYS',
  'RESOURCE_NODES',
  'SCHEMA_INVALID',
  'SCHEMA_ENCODING',
  'SCHEMA_DUPLICATE_KEY',
  'SCHEMA_FORBIDDEN_KEY',
] as const);

export const BLOCKING_CATEGORIES = Object.freeze([
  'UNRESOLVED_MATERIAL',
  'UNRESOLVED_REFERENCE',
  'NONDETERMINISTIC_ORDER',
  'NONDETERMINISTIC_TIME',
  'DUPLICATE_SEQUENCE',
  'IDENTITY_MALFORMED',
  'IDENTITY_MISMATCH',
] as const);

export const ADVISORY_CATEGORIES = Object.freeze([
  'ACTIVE_HTML',
  'ACTIVE_SCRIPT',
  'ACTIVE_SVG_HANDLER',
  'ACTIVE_URL_SCHEME',
  'ACTIVE_TERMINAL_ESCAPE',
  'ACTIVE_CONTROL_CHARACTER',
  'ACTIVE_BIDI_CONTROL',
  'ACTIVE_MARKDOWN_LINK',
  'INSTRUCTION_TEXT',
  'URL_NOT_FETCHED',
  'SIGNED_MATERIAL_DIGESTED',
  'ORIGIN_CLAIM_IGNORED',
  'PATH_UNSAFE',
] as const);

export type RejectingCategory = (typeof REJECTING_CATEGORIES)[number];
export type BlockingCategory = (typeof BLOCKING_CATEGORIES)[number];
export type AdvisoryCategory = (typeof ADVISORY_CATEGORIES)[number];
export type FindingCategory = RejectingCategory | BlockingCategory | AdvisoryCategory;

export interface Finding {
  readonly category: FindingCategory;
  readonly path: string;
  readonly count: number;
  readonly blocking: boolean;
}

const REJECTING = new Set<string>(REJECTING_CATEGORIES);
const BLOCKING = new Set<string>(BLOCKING_CATEGORIES);

export function isRejecting(category: string): boolean {
  return REJECTING.has(category);
}

export function isBlocking(category: string): boolean {
  return REJECTING.has(category) || BLOCKING.has(category);
}

/** A JSON path safe to persist and display: no value text, bounded, restricted alphabet. */
export function safePath(parts: readonly (string | number)[]): string {
  let out = '$';
  for (const p of parts) {
    if (typeof p === 'number') out += `[${p}]`;
    else {
      const key = p.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48);
      out += `.${key.length > 0 ? key : '_'}`;
    }
    if (out.length > 240) return `${out.slice(0, 240)}_`;
  }
  return out;
}

/** Collects findings, merging repeated (category, path) pairs into a count. */
export class FindingSet {
  private readonly map = new Map<string, Finding>();

  add(category: FindingCategory, path: string): void {
    const key = `${category}\u0000${path}`;
    const prior = this.map.get(key);
    if (prior) this.map.set(key, { ...prior, count: prior.count + 1 });
    else if (this.map.size < 512)
      this.map.set(key, { category, path, count: 1, blocking: isBlocking(category) });
  }

  has(predicate: (f: Finding) => boolean): boolean {
    return [...this.map.values()].some(predicate);
  }

  get rejecting(): boolean {
    return this.has((f) => isRejecting(f.category));
  }

  list(): Finding[] {
    return [...this.map.values()].sort((a, b) =>
      a.category < b.category
        ? -1
        : a.category > b.category
          ? 1
          : a.path < b.path
            ? -1
            : a.path > b.path
              ? 1
              : 0,
    );
  }
}
