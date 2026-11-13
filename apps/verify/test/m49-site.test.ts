/**
 * M49 — publishing the verify page: the configuration written from repository variables, the
 * `certificate badge` arguments per network, and the Pages workflow policy (no secret, no pull
 * request trigger, pinned actions, write permission only in the deploy job).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateSigner, publicKeyText } from '@routespec/registry';
import { parseConfig } from '../src/config.ts';
import { badgeArgs, configFromEnv } from '../scripts/site.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const shipped = parseConfig(JSON.parse(readFileSync(resolve(here, '../public/config.json'), 'utf8')));

describe('configuration from repository variables', () => {
  it('keeps the shipped values when nothing is set', () => {
    expect(configFromEnv(shipped, {})).toEqual(shipped);
    expect(
      configFromEnv(shipped, { ROUTESPEC_REGISTRY_ACCOUNT: '  ', ROUTESPEC_BADGE_ATTESTERS: '' }),
    ).toEqual(shipped);
  });

  it('applies registries, project, pinned keys and extra code hashes', () => {
    const k = publicKeyText(generateSigner().publicKey);
    const c = configFromEnv(shipped, {
      ROUTESPEC_REGISTRY_ACCOUNT: 'other-registry.testnet',
      ROUTESPEC_MAINNET_REGISTRY_ACCOUNT: 'registry.routespec.near',
      ROUTESPEC_BADGE_PROJECT: 'org/repo',
      ROUTESPEC_BADGE_ATTESTERS: `${k}, ${k}`,
      ROUTESPEC_REGISTRY_CODE_HASHES: '11111111111111111111111111111111',
    });
    expect(c.networks['testnet']?.registry).toBe('other-registry.testnet');
    expect(c.networks['mainnet']?.registry).toBe('registry.routespec.near');
    expect(c.project).toBe('org/repo');
    expect(c.trustedAttesters).toEqual([k]);
    expect(c.knownCodeHashes).toEqual([...shipped.knownCodeHashes, '11111111111111111111111111111111']);
  });

  it('refuses a malformed variable instead of publishing it', () => {
    expect(() => configFromEnv(shipped, { ROUTESPEC_REGISTRY_ACCOUNT: 'Bad Account' })).toThrow(
      /config.json/,
    );
    expect(() => configFromEnv(shipped, { ROUTESPEC_BADGE_ATTESTERS: 'ed25519:nope' })).toThrow(
      /config.json/,
    );
  });
});

describe('badge arguments', () => {
  it('reads the project newest certificate with the chain id checked and errors marked', () => {
    const args = badgeArgs(shipped, 'testnet', 'out.json');
    expect(args).toEqual([
      'certificate',
      'badge',
      '--project-key',
      'gnanam1990/routespec-near',
      '--registry',
      'gnanam1990-routespec.testnet',
      '--network',
      'testnet',
      '--rpc',
      'https://test.rpc.fastnear.com',
      '--known-code-hash',
      shipped.knownCodeHashes[0],
      '--label',
      'RouteSpec testnet',
      '--write-on-error',
      '--out',
      'out.json',
    ]);
    expect(badgeArgs(shipped, 'mainnet', 'out.json')).toBeNull();
  });
});

describe('Pages workflow policy', () => {
  const text = readFileSync(resolve(repo, '.github/workflows/routespec-pages.yml'), 'utf8');

  it('never runs on a pull request and reads no secret', () => {
    expect(text).not.toMatch(/pull_request/);
    expect(text).not.toMatch(/secrets\./);
    expect(text).toMatch(/^permissions:\n {2}contents: read$/m);
  });

  it('pins every action to a full commit', () => {
    const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1] as string);
    expect(uses.length).toBe(4);
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it('grants Pages write only to the deploy job', () => {
    const [build, deploy] = text.split(/^ {2}deploy:$/m);
    expect(build).not.toMatch(/pages: write|id-token: write/);
    expect(deploy).toMatch(/pages: write/);
    expect(deploy).toMatch(/id-token: write/);
    expect(deploy).not.toMatch(/checkout/);
  });
});
