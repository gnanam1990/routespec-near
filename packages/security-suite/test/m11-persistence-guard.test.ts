/**
 * M11 journal persistence guard (INV-11, supports T-011). Supplementary module test; it claims
 * no canonical test ID. Repository methods are called directly, below every request-boundary
 * check, so this proves the last line of defence on its own: a configured secret value or a
 * RouteSpec credential shape bound to any write statement aborts the transaction and nothing is
 * written.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCanary, scanTree } from '@routespec/hardening';
import { RouteSpecStore, registerConfiguredSecrets } from '@routespec/store';
import { tempDir } from '../../proxy/test/support/gate.ts';

let tmp: ReturnType<typeof tempDir>;
let store: RouteSpecStore;
const secret = makeCanary('configured');
let unregister: () => void = () => undefined;

beforeAll(() => {
  tmp = tempDir('routespec-m11-guard-');
  store = RouteSpecStore.open({ path: join(tmp.dir, 'journal.db') });
  unregister = registerConfiguredSecrets([secret.value]);
});

afterAll(() => {
  unregister();
  store?.close();
  tmp?.cleanup();
});

describe('M11 — journal write guard', () => {
  it('refuses a configured secret or a credential shape in plain text columns', () => {
    const controlShape = `rsctl_${'A'.repeat(43)}`;
    const caseShape = `rsct_${'b'.repeat(43)}`;
    for (const [label, name, key] of [
      ['name with configured secret', `release ${secret.value}`, 'guard-key-0001'],
      ['idempotency key with configured secret', 'ok', secret.value],
      ['name with control-token shape', `pasted ${controlShape}`, 'guard-key-0002'],
      ['name with case-token shape', `pasted ${caseShape}`, 'guard-key-0003'],
    ] as const) {
      const before = store.countRows('projects');
      expect(() => store.createProject({ name, idempotencyKey: key }), label).toThrow(
        expect.objectContaining({ code: 'RS_SECRET_FIELD_REJECTED' }),
      );
      expect(store.countRows('projects')).toBe(before);
    }
    expect(scanTree(tmp.dir, [secret, { label: 'control', value: controlShape }]).findings).toEqual([]);
  });

  it('ordinary values still pass, and unregistering restores ordinary behaviour', () => {
    expect(store.createProject({ name: 'ordinary', idempotencyKey: 'guard-key-0004' }).projectId).toMatch(
      /-/,
    );
    unregister();
    unregister = () => undefined;
    expect(
      store.createProject({ name: `after ${secret.value}`, idempotencyKey: 'guard-key-0005' }).projectId,
    ).toMatch(/-/);
  });

  it('refuses configured values shorter than the minimum (they would match ordinary text)', () => {
    expect(() => registerConfiguredSecrets(['short'])).toThrow(
      expect.objectContaining({ code: 'RS_SCHEMA_INVALID' }),
    );
  });
});
