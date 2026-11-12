/**
 * Stable validation issue codes (M13, ADR-0018).
 *
 * RouteSpec surfaces schema issue codes in error details (control API `fields[].code`, CI config
 * `issue`, scenario compile issues). Those codes are part of what callers see, so they stay the
 * same across validation-library majors: the newer library folds several codes into
 * `invalid_format` / `invalid_value` / `invalid_key`, and this module maps them back to the codes
 * RouteSpec has always reported.
 */
import { z } from 'zod';

type Issue = z.core.$ZodIssue;

/**
 * Message prefix the library uses for a multi-value enum mismatch. A single-value enum and a
 * literal produce identical issues in the newer library; `singleValueEnum()` gives its mismatch
 * this enum message so the reported code stays `invalid_enum_value`.
 */
const ENUM_MISMATCH_PREFIX = 'Invalid option: expected one of ';

/** A closed enum with exactly one value that still reports enum (not literal) mismatches. */
export function singleValueEnum<const V extends string>(value: V): z.ZodEnum<{ [K in V]: K }> {
  return z.enum([value], {
    error: (issue) =>
      issue.code === 'invalid_value' ? `${ENUM_MISMATCH_PREFIX}${JSON.stringify(value)}` : undefined,
  }) as unknown as z.ZodEnum<{ [K in V]: K }>;
}

/** Marks a call that has no input to inspect (the key of a map, for example). */
const NO_INPUT: unique symbol = Symbol('no-input');

/** The value at `path` in `input`, or `absent` when it (or one of its parents) is missing. */
function valueAt(input: unknown, path: readonly PropertyKey[]): { absent: boolean; value: unknown } {
  let cursor: unknown = input;
  for (const key of path) {
    if (typeof cursor !== 'object' || cursor === null) return { absent: true, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) return { absent: true, value: undefined };
    cursor = (cursor as Record<PropertyKey, unknown>)[key];
  }
  return { absent: cursor === undefined, value: cursor };
}

/** True for a mismatch reported by an enum (not a literal). */
function isEnumMismatch(issue: Issue): boolean {
  return (
    issue.code === 'invalid_value' &&
    (issue.values.length > 1 || issue.message.startsWith(ENUM_MISMATCH_PREFIX))
  );
}

/**
 * The issue code RouteSpec reports for one validation issue. `input` is the value that was
 * validated: an enum given an absent or non-string value reports a type mismatch, as before.
 */
export function stableIssueCode(issue: Issue, input: unknown = NO_INPUT): string {
  switch (issue.code) {
    case 'invalid_format':
      return 'invalid_string';
    case 'invalid_value':
      if (!isEnumMismatch(issue)) return 'invalid_literal';
      if (input !== NO_INPUT && typeof valueAt(input, issue.path).value !== 'string') return 'invalid_type';
      return 'invalid_enum_value';
    case 'invalid_union':
      return 'discriminator' in issue && typeof issue.discriminator === 'string'
        ? 'invalid_union_discriminator'
        : 'invalid_union';
    case 'invalid_key': {
      // A record key is always a string; the key check sees the key itself.
      const inner = issue.issues[0];
      const key = issue.path[issue.path.length - 1];
      return inner === undefined
        ? issue.code
        : stableIssueCode(inner, typeof key === 'string' ? key : NO_INPUT);
    }
    case 'invalid_element': {
      const inner = issue.issues[0];
      return inner === undefined ? issue.code : stableIssueCode(inner);
    }
    default:
      return issue.code;
  }
}

/**
 * True when the issue is a type mismatch (including an enum given no value) on a value that is
 * absent from `input` (the field, or one of its parents, is missing). Present values of the
 * wrong type, including `null`, are not missing.
 */
export function isMissingValueIssue(issue: Issue, input: unknown): boolean {
  if (issue.code !== 'invalid_type' && !isEnumMismatch(issue)) return false;
  return valueAt(input, issue.path).absent;
}
