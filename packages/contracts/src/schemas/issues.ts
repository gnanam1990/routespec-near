/**
 * Stable validation issue codes (M13, ADR-0018).
 *
 * RouteSpec surfaces schema issue codes in error details (control API `fields[].code`, CI config
 * `issue`, scenario compile issues). Those codes are part of what callers see, so they stay the
 * same across validation-library majors: the newer library folds several codes into
 * `invalid_format` / `invalid_value` / `invalid_key`, and this module maps them back to the codes
 * RouteSpec has always reported.
 */
import type { z } from 'zod';

type Issue = z.core.$ZodIssue;

/** The issue code RouteSpec reports for one validation issue. */
export function stableIssueCode(issue: Issue): string {
  switch (issue.code) {
    case 'invalid_format':
      return 'invalid_string';
    case 'invalid_value':
      return issue.values.length === 1 ? 'invalid_literal' : 'invalid_enum_value';
    case 'invalid_union':
      return 'discriminator' in issue && typeof issue.discriminator === 'string'
        ? 'invalid_union_discriminator'
        : 'invalid_union';
    case 'invalid_key':
    case 'invalid_element': {
      const inner = issue.issues[0];
      return inner === undefined ? issue.code : stableIssueCode(inner);
    }
    default:
      return issue.code;
  }
}

/**
 * True when the issue is a type mismatch on a value that is absent from `input` (the field, or
 * one of its parents, is missing). Present values of the wrong type, including `null`, are not
 * missing.
 */
export function isMissingValueIssue(issue: Issue, input: unknown): boolean {
  if (issue.code !== 'invalid_type') return false;
  let cursor: unknown = input;
  for (const key of issue.path) {
    if (typeof cursor !== 'object' || cursor === null) return true;
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) return true;
    cursor = (cursor as Record<PropertyKey, unknown>)[key];
  }
  return cursor === undefined;
}
