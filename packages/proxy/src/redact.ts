/**
 * Redaction before serialization (FR-17, NFR-03, INV-11, DATA-MODEL.md section 7).
 *
 * The proxy runs every inbound header set, body, and error through this module before anything
 * reaches the journal, a log line, or a response. Configured secret values (for example test
 * canaries or a provider credential the user mistakenly placed in client config) live only in
 * this object's memory; findings record category and path, never the value.
 */
import { isRouteSpecLocalHeader } from '@routespec/contracts';

export type RedactionCategory =
  | 'configured-secret'
  | 'provider-authorization'
  | 'cookie'
  | 'routespec-local-header'
  | 'jwt'
  | 'bearer'
  | 'private-key'
  | 'case-token'
  | 'control-token'
  | 'forbidden-field';

export interface RedactionFinding {
  readonly category: RedactionCategory;
  readonly path: string;
}

const PATTERNS: ReadonlyArray<readonly [RedactionCategory, RegExp]> = [
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['case-token', /\brsct_[A-Za-z0-9_-]{20,}/g],
  ['control-token', /\brsctl_[A-Za-z0-9_-]{20,}/g],
];

const FORBIDDEN_FIELD =
  /^(authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|jwt|bearer|token|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|apikey|secret|client[-_]?secret|password|passphrase|private[-_]?key|mnemonic|seed[-_]?phrase|signing[-_]?key)$/i;

const CREDENTIAL_HEADERS = new Map<string, RedactionCategory>([
  ['authorization', 'provider-authorization'],
  ['proxy-authorization', 'provider-authorization'],
  ['cookie', 'cookie'],
]);

export class Redactor {
  readonly #secrets = new Set<string>();
  #hits = 0;

  constructor(configuredSecrets: readonly string[] = []) {
    for (const s of configuredSecrets) this.addSecret(s);
  }

  /** Register a configured secret value (kept only in this process's memory). */
  addSecret(value: string): void {
    if (typeof value === 'string' && value.length >= 6) this.#secrets.add(value);
  }

  get redactionHits(): number {
    return this.#hits;
  }

  /** Findings in an arbitrary JSON-like value: configured values, patterns, secret-named fields. */
  findIn(value: unknown, path = '$', depth = 0, out: RedactionFinding[] = []): RedactionFinding[] {
    if (depth > 64 || out.length >= 32) return out;
    if (typeof value === 'string') {
      for (const secret of this.#secrets) {
        if (value.includes(secret)) out.push({ category: 'configured-secret', path });
      }
      for (const [category, pattern] of PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(value)) out.push({ category, path });
      }
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => this.findIn(v, `${path}[${i}]`, depth + 1, out));
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (FORBIDDEN_FIELD.test(k)) out.push({ category: 'forbidden-field', path: `${path}.${k}` });
        this.findIn(v, `${path}.${k}`, depth + 1, out);
      }
    }
    return out;
  }

  /** Replace every configured value and pattern occurrence in text with a category marker. */
  redactText(text: string): string {
    let out = text;
    for (const secret of this.#secrets) {
      if (out.includes(secret)) {
        out = out.split(secret).join('[REDACTED:configured-secret]');
        this.#hits++;
      }
    }
    for (const [category, pattern] of PATTERNS) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, () => {
        this.#hits++;
        return `[REDACTED:${category}]`;
      });
    }
    return out;
  }

  /**
   * Split inbound headers: credential headers and every RouteSpec-local header are removed from
   * the set that could ever be recorded or forwarded. RouteSpec-local values are returned
   * separately for authentication and never persisted.
   */
  partitionHeaders(headers: Readonly<Record<string, string | string[] | undefined>>): {
    readonly forwardable: Record<string, string>;
    readonly local: Record<string, string>;
    readonly stripped: readonly RedactionFinding[];
  } {
    const forwardable: Record<string, string> = {};
    const local: Record<string, string> = {};
    const stripped: RedactionFinding[] = [];
    for (const [rawName, rawValue] of Object.entries(headers)) {
      if (rawValue === undefined) continue;
      const name = rawName.toLowerCase();
      const value = Array.isArray(rawValue) ? rawValue.join(', ') : rawValue;
      const credential = CREDENTIAL_HEADERS.get(name);
      if (credential) {
        stripped.push({ category: credential, path: `header.${name}` });
        this.#hits++;
        continue;
      }
      if (isRouteSpecLocalHeader(name)) {
        local[name] = value;
        stripped.push({ category: 'routespec-local-header', path: `header.${name}` });
        continue;
      }
      forwardable[name] = this.redactText(value);
    }
    return { forwardable, local, stripped };
  }
}
