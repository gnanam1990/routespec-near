/**
 * M13 (dependency upgrades): the validation library moved to its next major version. Error
 * details that RouteSpec surfaces (control API `fields[].code`, CI config `issue`, scenario
 * compile issues) keep the issue codes they carried before the upgrade, and "missing value"
 * detection no longer depends on a removed issue property.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isMissingValueIssue, singleValueEnum, stableIssueCode } from '../src/index.ts';

function issuesOf(schema: z.ZodType, input: unknown): z.core.$ZodIssue[] {
  const r = schema.safeParse(input);
  if (r.success) throw new Error('expected a validation failure');
  return r.error.issues;
}

function codesOf(schema: z.ZodType, input: unknown): string[] {
  return issuesOf(schema, input).map((i) => stableIssueCode(i, input));
}

describe('M13 stable validation issue codes', () => {
  it('format checks keep the string-check code', () => {
    expect(codesOf(z.string().regex(/^a$/), 'b')).toEqual(['invalid_string']);
    expect(codesOf(z.string().startsWith('https://'), 'http://x')).toEqual(['invalid_string']);
    expect(codesOf(z.url(), 'not a url')).toEqual(['invalid_string']);
    expect(codesOf(z.iso.datetime({ offset: true }), 'yesterday')).toEqual(['invalid_string']);
  });

  it('enum and literal mismatches keep their distinct codes', () => {
    expect(codesOf(z.enum(['A', 'B']), 'C')).toEqual(['invalid_enum_value']);
    expect(codesOf(z.literal('routespec.ci-config/1'), 'other')).toEqual(['invalid_literal']);
  });

  it('an unknown discriminator keeps the discriminator code and path', () => {
    const u = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), a: z.string() }).strict(),
      z.object({ kind: z.literal('b'), b: z.number() }).strict(),
    ]);
    const issues = issuesOf(z.object({ step: u }).strict(), { step: { kind: 'c' } });
    expect(issues.map((i) => stableIssueCode(i, { step: { kind: 'c' } }))).toEqual([
      'invalid_union_discriminator',
    ]);
    expect(issues[0]?.path).toEqual(['step', 'kind']);
  });

  it('a record key failure reports the key check code at the key path', () => {
    const rec = z.record(z.string().max(3), z.string());
    const issues = issuesOf(rec, { abcdef: 'x' });
    expect(issues.map((i) => stableIssueCode(i, { abcdef: 'x' }))).toEqual(['too_big']);
    expect(issues[0]?.path).toEqual(['abcdef']);
  });

  it('unchanged codes pass through', () => {
    expect(codesOf(z.object({ a: z.string() }).strict(), { a: 'x', b: 1 })).toEqual(['unrecognized_keys']);
    expect(codesOf(z.string().max(2), 'abc')).toEqual(['too_big']);
    expect(codesOf(z.array(z.string()).min(1), [])).toEqual(['too_small']);
    expect(codesOf(z.number().int(), 1.5)).toEqual(['invalid_type']);
    expect(codesOf(z.union([z.string(), z.number()]), true)).toEqual(['invalid_union']);
    expect(
      codesOf(
        z.string().refine(() => false, 'nope'),
        'x',
      ),
    ).toEqual(['custom']);
  });
});

describe('M13 missing-value detection', () => {
  const schema = z.object({ a: z.string(), nested: z.object({ b: z.number() }).strict() }).strict();

  it('flags absent fields, including absent nested parents', () => {
    const input = { nested: {} };
    const missing = issuesOf(schema, input).filter((i) => isMissingValueIssue(i, input));
    expect(missing.map((i) => i.path.join('.')).sort()).toEqual(['a', 'nested.b']);
  });

  it('does not flag present fields of the wrong type or null', () => {
    const input = { a: 5, nested: { b: null } };
    expect(issuesOf(schema, input).some((i) => isMissingValueIssue(i, input))).toBe(false);
  });
});

describe('M13 single-value enums', () => {
  it('a single-value enum mismatch keeps the enum code, unlike a literal', () => {
    expect(codesOf(singleValueEnum('CONNECTION_RESET'), 'TIMEOUT')).toEqual(['invalid_enum_value']);
    expect(codesOf(z.literal('CONNECTION_RESET'), 'TIMEOUT')).toEqual(['invalid_literal']);
  });

  it('accepts only its value and reports other type errors unchanged', () => {
    const e = singleValueEnum('CONNECTION_RESET');
    expect(e.parse('CONNECTION_RESET')).toBe('CONNECTION_RESET');
    expect(codesOf(e, 5)).toEqual(['invalid_type']);
    expect(codesOf(z.object({ e }).strict(), {})).toEqual(['invalid_type']);
  });
});

describe('M13 enum type mismatches', () => {
  const schema = z
    .object({ e: z.enum(['A', 'B']), one: singleValueEnum('X').optional(), lit: z.literal('L').optional() })
    .strict();
  const codes = (input: unknown): string[] => issuesOf(schema, input).map((i) => stableIssueCode(i, input));

  it('an absent or non-string enum value is a type mismatch, as before', () => {
    expect(codes({})).toEqual(['invalid_type']);
    expect(codes({ e: 5 })).toEqual(['invalid_type']);
    expect(codes({ e: null })).toEqual(['invalid_type']);
    expect(codes({ e: 'A', one: 7 })).toEqual(['invalid_type']);
  });

  it('a string outside the enum is still an enum mismatch; literals keep the literal code', () => {
    expect(codes({ e: 'C' })).toEqual(['invalid_enum_value']);
    expect(codes({ e: 'A', one: 'Y' })).toEqual(['invalid_enum_value']);
    expect(codes({ e: 'A', lit: 5 })).toEqual(['invalid_literal']);
  });

  it('an absent enum value is a missing value; a present wrong one is not', () => {
    const missing = (input: unknown) => issuesOf(schema, input).some((i) => isMissingValueIssue(i, input));
    expect(missing({})).toBe(true);
    expect(missing({ e: 5 })).toBe(false);
    expect(missing({ e: 'C' })).toBe(false);
  });
});
