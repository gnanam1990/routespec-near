/**
 * M49 — the verify page's configuration and link rules. A link is untrusted input: it may name a
 * digest, a project, a configured network, pinned keys (narrowing only), another registry (shown
 * as such), and an RPC endpoint on this computer only.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateSigner, publicKeyText } from '@routespec/registry';
import { parseConfig, type VerifyPageConfig } from '../src/config.ts';
import { inputFromSearch, RequestError, resolveRequest, verifyLink } from '../src/request.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const shipped = parseConfig(JSON.parse(readFileSync(resolve(here, '../public/config.json'), 'utf8')));
const DIGEST = `sha256:${'ab'.repeat(32)}`;

function config(patch: Partial<VerifyPageConfig> = {}): VerifyPageConfig {
  return { ...shipped, ...patch };
}

describe('shipped configuration', () => {
  it('names the testnet registry the certificate workflow publishes to', () => {
    expect(shipped.defaultNetwork).toBe('testnet');
    expect(shipped.networks['testnet']).toEqual({
      chainId: 'testnet',
      rpcUrl: 'https://test.rpc.fastnear.com',
      registry: 'gnanam1990-routespec.testnet',
    });
    const workflow = readFileSync(resolve(repo, '.github/workflows/routespec-certificate.yml'), 'utf8');
    expect(workflow).toContain(
      `vars.ROUTESPEC_REGISTRY_ACCOUNT || '${String(shipped.networks['testnet']?.registry)}'`,
    );
    expect(workflow).toContain(`project-key: ${String(shipped.project)}`);
    expect(shipped.networks['mainnet']?.registry).toBeNull();
  });

  it('knows exactly the reproducible registry build recorded for the contract tree on this commit', () => {
    const status = readFileSync(resolve(repo, 'docs/status/M47.md'), 'utf8');
    const hash = /\| NEAR code hash \| `([1-9A-HJ-NP-Za-km-z]{32,44})`/.exec(status)?.[1];
    const tree = /\| Contract tree\s+\| `([0-9a-f]{40})`/.exec(status)?.[1];
    expect(shipped.knownCodeHashes).toEqual([hash]);
    let current: string | null = null;
    try {
      current = execFileSync('git', ['rev-parse', 'HEAD:contracts/routespec-registry'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim();
    } catch {
      current = null; // not a git checkout: nothing to compare
    }
    if (current !== null) {
      expect(
        current,
        'The registry contract changed: rebuild it reproducibly, record the new code hash in docs/status/M47.md and add it to apps/verify/public/config.json knownCodeHashes.',
      ).toBe(tree);
    }
  });

  it('refuses a malformed configuration', () => {
    const bad: unknown[] = [
      {},
      { ...shipped, schema: 'other' },
      { ...shipped, defaultNetwork: 'nowhere' },
      {
        ...shipped,
        networks: { testnet: { ...shipped.networks['testnet'], rpcUrl: 'http://rpc.example.com' } },
      },
      { ...shipped, trustedAttesters: ['ed25519:nope'] },
      { ...shipped, extra: true },
    ];
    for (const b of bad) expect(() => parseConfig(b), JSON.stringify(b).slice(0, 80)).toThrow(/config.json/);
  });
});

describe('link rules', () => {
  const q = (s: string) => inputFromSearch(new URLSearchParams(s));

  it('uses the configured network, endpoint and registry by default', () => {
    expect(resolveRequest(config(), q(`digest=${DIGEST}`))).toEqual({
      network: 'testnet',
      chainId: 'testnet',
      rpcUrl: 'https://test.rpc.fastnear.com',
      registry: 'gnanam1990-routespec.testnet',
      trustedAttesters: [],
      digest: DIGEST,
      project: null,
      notices: [],
    });
    expect(resolveRequest(config(), q('project=org/repo')).project).toBe('org/repo');
    expect(
      resolveRequest(config(), q(`digest=${DIGEST.toUpperCase().replace('SHA256', 'sha256')}`)).digest,
    ).toBe(DIGEST);
  });

  it('refuses a public RPC endpoint from a link, accepts one on this computer with a notice', () => {
    for (const rpc of ['https://rpc.example.com', 'http://10.0.0.1:3030', 'https://u:p@localhost/']) {
      expect(
        () => resolveRequest(config(), q(`digest=${DIGEST}&rpc=${encodeURIComponent(rpc)}`)),
        rpc,
      ).toThrow(RequestError);
    }
    const local = resolveRequest(
      config(),
      q(`digest=${DIGEST}&rpc=${encodeURIComponent('http://127.0.0.1:3030')}`),
    );
    expect(local).toMatchObject({ rpcUrl: 'http://127.0.0.1:3030/', notices: ['RPC_FROM_LINK'] });
  });

  it('says so when a link names another registry, and needs one when none is configured', () => {
    expect(resolveRequest(config(), q(`digest=${DIGEST}&registry=someone.testnet`))).toMatchObject({
      registry: 'someone.testnet',
      notices: ['REGISTRY_NOT_DEFAULT'],
    });
    expect(() => resolveRequest(config(), q(`digest=${DIGEST}&network=mainnet`))).toThrow(/No registry/);
    expect(resolveRequest(config(), q(`digest=${DIGEST}&network=mainnet&registry=rs.near`)).registry).toBe(
      'rs.near',
    );
    expect(() => resolveRequest(config(), q(`digest=${DIGEST}&network=devnet`))).toThrow(/does not know/);
    expect(() => resolveRequest(config(), q(`digest=${DIGEST}&registry=Not_An_Account`))).toThrow(
      RequestError,
    );
  });

  it('lets a link narrow pinned attester keys but never add one', () => {
    const a = publicKeyText(generateSigner().publicKey);
    const b = publicKeyText(generateSigner().publicKey);
    expect(resolveRequest(config(), q(`digest=${DIGEST}&attester=${a}`))).toMatchObject({
      trustedAttesters: [a],
      notices: ['ATTESTERS_FROM_LINK'],
    });
    const pinned = config({ trustedAttesters: [a, b] });
    expect(resolveRequest(pinned, q(`digest=${DIGEST}`)).trustedAttesters).toEqual([a, b]);
    expect(resolveRequest(pinned, q(`digest=${DIGEST}&attester=${b}`)).trustedAttesters).toEqual([b]);
    const c = publicKeyText(generateSigner().publicKey);
    expect(() => resolveRequest(pinned, q(`digest=${DIGEST}&attester=${c}`))).toThrow(/only narrow/);
    expect(() => resolveRequest(config(), q(`digest=${DIGEST}&attester=ed25519:x`))).toThrow(RequestError);
  });

  it('refuses malformed digests and projects, and both at once', () => {
    for (const s of ['digest=sha256:12', 'digest=abc', 'project=-bad', `digest=${DIGEST}&project=org/repo`]) {
      expect(() => resolveRequest(config(), q(s)), s).toThrow(RequestError);
    }
  });

  it('builds a link to a check without carrying other parameters', () => {
    expect(verifyLink('https://example.github.io/routespec/?rpc=x#y', 'testnet', { digest: DIGEST })).toBe(
      `https://example.github.io/routespec/?digest=${encodeURIComponent(DIGEST)}&network=testnet`,
    );
    expect(verifyLink('https://example.github.io/routespec/', 'testnet', { project: 'org/repo' })).toBe(
      'https://example.github.io/routespec/?project=org%2Frepo&network=testnet',
    );
  });
});
