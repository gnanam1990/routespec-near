/**
 * M13 (dependency upgrades): CI configuration defaults and error details are unchanged by the
 * validation-library major upgrade. Omitted `uploads` and `liveDry` blocks still receive their
 * nested defaults, and a schema failure still reports the same issue code.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isRouteSpecError } from '@routespec/contracts';
import { loadCiConfig } from '../src/index.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function workspaceWith(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'rs-m13-ci-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'routespec.ci.json'), JSON.stringify(config));
  return dir;
}

const BASE = {
  schema: 'routespec.ci-config/1',
  project: 'm13 sample',
  revisionLabel: 'm13',
  subject: {
    artifactFiles: ['client.ts'],
    lockFile: 'pnpm-lock.yaml',
    manifestFile: 'hooks.json',
    clientModule: 'client.ts',
  },
  scenarios: [{ file: 'happy-path.yaml' }],
  requiredInvariants: ['INV-01'],
  effect: { sinks: ['fulfilment-webhook'] },
  gate: { name: 'm13 gate' },
};

function issueOf(config: Record<string, unknown>): unknown {
  try {
    loadCiConfig('routespec.ci.json', workspaceWith(config));
  } catch (error) {
    if (isRouteSpecError(error)) return error.details;
    throw error;
  }
  throw new Error('expected the configuration to be rejected');
}

describe('M13 CI configuration defaults survive the validation upgrade', () => {
  it('omitted blocks receive their nested defaults', () => {
    const config = loadCiConfig('routespec.ci.json', workspaceWith(BASE));
    expect(config.uploads).toEqual({
      include: ['gate-report-json', 'junit', 'sarif'],
      extraPaths: [],
      retentionDays: 7,
    });
    expect(config.liveDry).toEqual({ requested: false });
    expect(config.scenarios).toEqual([{ file: 'happy-path.yaml', policy: 'REQUIRED' }]);
    expect(config.effect.basis).toBe('DECLARED_HOOKS_ONLY');
    expect(config.gate).toMatchObject({ requireAttestedBuild: false, parallelism: 1, mode: 'SIMULATE' });
  });

  it('a partial block keeps its other nested defaults', () => {
    const config = loadCiConfig(
      'routespec.ci.json',
      workspaceWith({ ...BASE, uploads: { retentionDays: 30 } }),
    );
    expect(config.uploads).toEqual({
      include: ['gate-report-json', 'junit', 'sarif'],
      extraPaths: [],
      retentionDays: 30,
    });
  });

  it('schema failures report the same issue codes as before', () => {
    expect(issueOf({ ...BASE, trustedRefs: ['main'] })).toEqual({
      path: 'trustedRefs.0',
      issue: 'invalid_string',
    });
    expect(issueOf({ ...BASE, gate: { name: 'g', mode: 'LIVE' } })).toEqual({
      path: 'gate.mode',
      issue: 'invalid_enum_value',
    });
    expect(issueOf({ ...BASE, schema: 'routespec.ci-config/2' })).toEqual({
      path: 'schema',
      issue: 'invalid_literal',
    });
    expect(issueOf({ ...BASE, gate: { name: 'g', extra: 1 } })).toEqual({
      path: 'gate',
      issue: 'unrecognized_keys',
    });
  });
});
