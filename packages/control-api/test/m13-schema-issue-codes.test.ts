/**
 * M13 (dependency upgrades): `RS_SCHEMA_INVALID` details from the control API carry the same
 * field paths and issue codes after the validation-library major upgrade.
 */
import { describe, expect, it } from 'vitest';
import { isRouteSpecError } from '@routespec/contracts';
import {
  attesterRevoke,
  challengeCreate,
  oidcPolicy,
  parseBody,
  projectCreate,
  scenarioCreate,
} from '../src/schemas.ts';

type Field = { field: string; code: string; message: string };

function fieldsOf(
  schema: Parameters<typeof parseBody>[0],
  body: unknown,
): { fields: Field[]; unknownFields: string[] } {
  try {
    parseBody(schema, body);
  } catch (error) {
    if (isRouteSpecError(error) && error.code === 'RS_SCHEMA_INVALID') {
      return error.details as unknown as { fields: Field[]; unknownFields: string[] };
    }
    throw error;
  }
  throw new Error('expected RS_SCHEMA_INVALID');
}

const UUID = '01234567-89ab-cdef-0123-456789abcdef';

describe('M13 control API schema issue codes', () => {
  it('format, type, size, and unknown-field failures keep their codes', () => {
    const r = fieldsOf(scenarioCreate, { projectId: 'nope', source: '', extra: true });
    expect(r.fields).toEqual([
      { field: 'projectId', code: 'INVALID_STRING', message: 'Invalid value.' },
      { field: 'source', code: 'TOO_SMALL', message: 'Invalid value.' },
      { field: '$', code: 'UNKNOWN_FIELD', message: 'Unknown field.' },
    ]);
    expect(r.unknownFields).toEqual(['extra']);
    expect(fieldsOf(projectCreate, { name: 7 }).fields).toEqual([
      { field: 'name', code: 'INVALID_TYPE', message: 'Invalid value.' },
    ]);
    expect(fieldsOf(projectCreate, {}).fields).toEqual([
      { field: 'name', code: 'INVALID_TYPE', message: 'Invalid value.' },
    ]);
  });

  it('enum and discriminator failures keep their codes', () => {
    expect(fieldsOf(attesterRevoke, { reasonCode: 'BORED' }).fields).toEqual([
      { field: 'reasonCode', code: 'INVALID_ENUM_VALUE', message: 'Invalid value.' },
    ]);
    expect(fieldsOf(challengeCreate, { scope: 'ELSEWHERE', projectId: UUID }).fields).toEqual([
      { field: 'scope', code: 'INVALID_UNION_DISCRIMINATOR', message: 'Invalid value.' },
    ]);
  });

  it('the issuer URL check still rejects non-URLs and non-https issuers', () => {
    const base = {
      kind: 'CI_OIDC',
      signingKeys: [],
      audience: 'a',
      repositoryId: '1',
      workflowRef: 'w',
      allowedRefs: ['refs/heads/main'],
      subject: 's',
      maxTokenAgeMs: 1000,
      maxKeyAgeMs: 60_000,
    };
    const codes = (issuer: string) =>
      fieldsOf(oidcPolicy, { ...base, issuer })
        .fields.filter((f) => f.field === 'issuer')
        .map((f) => f.code);
    expect(codes('not a url')).toContain('INVALID_STRING');
    expect(codes('http://issuer.example')).toEqual(['INVALID_STRING']);
    expect(codes('https://issuer.example')).toEqual([]);
  });
});
