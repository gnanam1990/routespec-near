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

const SECRET_VALUE_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['bearer', /^\s*Bearer\s+\S{8,}/i],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['case-token', /\brsct_[A-Za-z0-9_-]{20,}/],
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
