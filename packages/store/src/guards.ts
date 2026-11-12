/**
 * Repository-boundary secret guards (SECURITY.md, DATA-MODEL.md section 7, INV-11).
 *
 * Defense in depth: every JSON value written by a repository method passes through
 * `assertNoSecrets`. Known secret-bearing field names and high-confidence secret value
 * patterns are rejected before any persistence. Errors name only the path and rule, never
 * the value.
 */
import { RouteSpecError } from '@routespec/contracts';

const FORBIDDEN_KEY =
  /^(authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|jwt|bearer|token|access[-_]?token|refresh[-_]?token|id[-_]?token|provider[-_]?(jwt|token|credential)s?|api[-_]?key|apikey|secret|client[-_]?secret|password|passphrase|private[-_]?key|mnemonic|seed[-_]?phrase|signing[-_]?key|x-routespec-case-token)$/i;

// Credential shapes carry no leading word boundary: a letter, digit or underscore placed
// directly before a JWT or an rsct_/rsctl_ token must not hide it (security fix vuln-0002).
const SECRET_VALUE_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['jwt', /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['bearer', /^\s*Bearer\s+\S{8,}/i],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['case-token', /rsct_[A-Za-z0-9_-]{20,}/],
  ['control-token', /rsctl_[A-Za-z0-9_-]{20,}/],
];

export function assertNoSecrets(value: unknown, path = '$', depth = 0): void {
  if (depth > 64)
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'Value nesting exceeds the limit.', { details: { path } });
  if (typeof value === 'string') {
    for (const [rule, pattern] of SECRET_VALUE_RULES) {
      if (pattern.test(value)) {
        throw new RouteSpecError(
          'RS_SECRET_FIELD_REJECTED',
          'A secret-shaped value was rejected before persistence.',
          {
            details: { path, rule },
          },
        );
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSecrets(item, `${path}[${i}]`, depth + 1));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(key)) {
        throw new RouteSpecError(
          'RS_SECRET_FIELD_REJECTED',
          'A secret-bearing field was rejected before persistence.',
          {
            details: { path: `${path}.${key}`, rule: 'forbidden-field' },
          },
        );
      }
      assertNoSecrets(child, `${path}.${key}`, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Persistence-boundary guard on every journal write (M11, T-011, INV-11).
//
// Repository methods write many plain text columns (names, labels, keys, filenames) that never
// pass through `assertNoSecrets`. As a last line of defence every string parameter bound to a
// write statement inside a journal transaction is checked for configured secret values (held
// only in this process's memory) and for the exact shapes of RouteSpec's own one-time
// credentials (control token `rsctl_`, case token `rsct_`). A hit aborts the transaction.

const CREDENTIAL_SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  ['control-token', /rsctl_[A-Za-z0-9_-]{20,}/],
  ['case-token', /rsct_[A-Za-z0-9_-]{20,}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

const configuredSecretValues = new Map<string, number>();

/** Minimum length of a configured secret value (shorter values would match ordinary text). */
export const MIN_CONFIGURED_SECRET_LENGTH = 8;

/**
 * Register configured secret values for this process (memory only). Values shorter than
 * `MIN_CONFIGURED_SECRET_LENGTH` are refused: they cannot be told apart from ordinary text.
 * Returns a function that unregisters exactly these values.
 */
export function registerConfiguredSecrets(values: readonly string[]): () => void {
  const accepted: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string' || v.length < MIN_CONFIGURED_SECRET_LENGTH) {
      throw new RouteSpecError(
        'RS_SCHEMA_INVALID',
        `A configured secret value must have at least ${MIN_CONFIGURED_SECRET_LENGTH} characters.`,
      );
    }
    configuredSecretValues.set(v, (configuredSecretValues.get(v) ?? 0) + 1);
    accepted.push(v);
  }
  return () => {
    for (const v of accepted) {
      const n = (configuredSecretValues.get(v) ?? 1) - 1;
      if (n <= 0) configuredSecretValues.delete(v);
      else configuredSecretValues.set(v, n);
    }
  };
}

/** The rule a string breaks at the persistence boundary, or null (never returns the value). */
export function persistedSecretRule(value: string): string | null {
  for (const secret of configuredSecretValues.keys()) if (value.includes(secret)) return 'configured-secret';
  for (const [rule, pattern] of CREDENTIAL_SHAPES) if (pattern.test(value)) return rule;
  return null;
}

function checkParam(value: unknown): void {
  if (typeof value === 'string') {
    const rule = persistedSecretRule(value);
    if (rule !== null) {
      throw new RouteSpecError(
        'RS_SECRET_FIELD_REJECTED',
        'A secret value was refused at the journal boundary.',
        {
          details: { rule },
        },
      );
    }
  } else if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    for (const v of Object.values(value as Record<string, unknown>)) checkParam(v);
  }
}

/** Check every bound parameter of one write statement. */
export function assertWriteParams(params: readonly unknown[]): void {
  for (const p of params) checkParam(p);
}
