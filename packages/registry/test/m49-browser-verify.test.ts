/**
 * M49 — the browser verification core (`@routespec/registry/browser`) that the static verify page
 * runs. It must reach exactly the result `certificate verify --digest` reaches, using only what a
 * browser has (WebCrypto, `fetch`, `TextEncoder`), so:
 *
 * - its module graph imports no Node built-in and no Node-only workspace package;
 * - the signing payload and the WebCrypto Ed25519 check agree with the shared vectors that the
 *   Rust crate and the Node package are checked against;
 * - for the same registry answers, its decision, findings and accepted ids equal the Node
 *   `aggregateRelease` output (digest-only, REQUIRE_ONCHAIN_ATTESTER) in every case below.
 *
 * Reading a real registry from the page is exercised against a real node in the near-sandbox
 * suite (`apps/verify/sandbox-test`).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aggregateRelease,
  generateSigner,
  isPublicKeyText as nodeIsPublicKeyText,
  publicKeyText,
  signCertificate,
  signingPayload,
  type AttesterState,
  type CertificateFields,
  type Ed25519Signer,
  type OnchainCertificate,
} from '../src/index.ts';
import {
  assessDigest,
  BrowserVerifyError,
  isPublicKeyText,
  NearViewReader,
  payloadBytes,
  sha256Digest,
  verifyCertificateSignature,
} from '../src/browser.ts';

const here = dirname(fileURLToPath(import.meta.url));

interface Vectors {
  attesterPublicKeyHex: string;
  vectors: Array<{ name: string; fields: CertificateFields; payloadUtf8: string; signatureHex: string }>;
}
const vectors = JSON.parse(
  readFileSync(resolve(here, '../../../contracts/routespec-registry/vectors/certificate-v1.json'), 'utf8'),
) as Vectors;

/** Every module reachable from `browser.ts` through relative or workspace imports. */
function moduleGraph(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    const source = readFileSync(file, 'utf8');
    seen.set(file, source);
    for (const m of source.matchAll(/^\s*(?:import|export)[^'"]*from\s+'([^']+)'/gm)) {
      const spec = m[1] as string;
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec));
    }
  };
  visit(entry);
  return seen;
}

describe('browser module graph', () => {
  it('imports no Node built-in, no Node-only workspace package and uses no Buffer', () => {
    const graph = moduleGraph(resolve(here, '../src/browser.ts'));
    expect(graph.size).toBeGreaterThan(2);
    for (const [file, source] of graph) {
      const specs = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] as string);
      const bare = specs.filter((s) => !s.startsWith('.'));
      expect(bare, file).toEqual(bare.filter((s) => s === 'zod'));
      expect(source, file).not.toMatch(/\bBuffer\b|\brequire\(|process\./);
    }
  });
});

describe('payload and WebCrypto signatures against the shared vectors', () => {
  const attester = publicKeyText(Buffer.from(vectors.attesterPublicKeyHex, 'hex'));

  it('builds exactly the vector payload bytes', () => {
    for (const v of vectors.vectors) {
      expect(new TextDecoder().decode(payloadBytes(v.fields)), v.name).toBe(v.payloadUtf8);
      expect(Buffer.from(payloadBytes(v.fields)).equals(Buffer.from(signingPayload(v.fields)))).toBe(true);
    }
  });

  it('accepts every vector signature and refuses any change', async () => {
    for (const v of vectors.vectors) {
      const c = toOnchain(v.fields, attester, Buffer.from(v.signatureHex, 'hex').toString('base64'));
      expect(await verifyCertificateSignature(v.fields.registry, c), v.name).toBe(true);
      expect(await verifyCertificateSignature('other.testnet', c), v.name).toBe(false);
      expect(
        await verifyCertificateSignature(v.fields.registry, { ...c, timestampMs: c.timestampMs + 1 }),
      ).toBe(false);
      const flipped = Buffer.from(v.signatureHex, 'hex');
      flipped[10] = (flipped[10] as number) ^ 1;
      expect(
        await verifyCertificateSignature(v.fields.registry, { ...c, signature: flipped.toString('base64') }),
      ).toBe(false);
      expect(await verifyCertificateSignature(v.fields.registry, { ...c, signature: 'not base64' })).toBe(
        false,
      );
      expect(await verifyCertificateSignature(v.fields.registry, { ...c, attester: 'ed25519:1' })).toBe(
        false,
      );
    }
  });

  it('computes the same bundle digest as node:crypto', async () => {
    for (const size of [0, 1, 4096, 1_000_003]) {
      const bytes = new Uint8Array(size).map((_, i) => (i * 31) & 0xff);
      expect(await sha256Digest(bytes)).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    }
  });

  it('reads public key text exactly like the Node package', () => {
    const samples = [
      ...Array.from({ length: 20 }, () => publicKeyText(generateSigner().publicKey)),
      'ed25519:',
      'ed25519:1',
      'secp256k1:abc',
      `ed25519:${'1'.repeat(44)}`,
      `ed25519:0${publicKeyText(generateSigner().publicKey).slice(9)}`,
      `ed25519:${'z'.repeat(600)}`,
      `${publicKeyText(generateSigner().publicKey)} `,
    ];
    for (const s of samples) expect(isPublicKeyText(s), s).toBe(nodeIsPublicKeyText(s));
  });
});

const REGISTRY = 'registry.testnet';
const BUNDLE = `sha256:${'ab'.repeat(32)}`;
const fields: CertificateFields = {
  registry: REGISTRY,
  project: 'org/repo',
  bundleDigest: BUNDLE,
  verdict: 'PASS',
  corpusDigest: `sha256:${'cd'.repeat(32)}`,
  artifactDigest: `sha256:${'ef'.repeat(32)}`,
  commit: '0123456789abcdef0123456789abcdef01234567',
  timestampMs: 1_794_528_000_000,
};

function toOnchain(f: CertificateFields, attester: string, signature: string, id = 0): OnchainCertificate {
  return {
    id,
    registry: f.registry,
    project: f.project,
    bundleDigest: f.bundleDigest,
    verdict: f.verdict,
    corpusDigest: f.corpusDigest,
    artifactDigest: f.artifactDigest,
    commit: f.commit,
    timestampMs: f.timestampMs,
    attester,
    signature,
    publishedAtMs: f.timestampMs + 1000,
    publishedBlockHeight: 100 + id,
    attesterRevoked: false,
    attesterRevokedAtMs: null,
  };
}

function cert(signer: Ed25519Signer, id: number, patch: Partial<CertificateFields> = {}): OnchainCertificate {
  const f = { ...fields, ...patch };
  const s = signCertificate(f, signer);
  return toOnchain(f, s.attester, s.signature, id);
}

function state(signer: Ed25519Signer, revoked = false): AttesterState {
  return {
    publicKey: publicKeyText(signer.publicKey),
    label: 'ci',
    enrolledAtMs: 1,
    enrolledBlockHeight: 1,
    revoked,
    revokedAtMs: revoked ? 2 : null,
    revokedBlockHeight: revoked ? 2 : null,
    revocationReason: revoked ? 'key rotated' : null,
    certificates: 1,
  };
}

describe('digest-only assessment equals the Node aggregation', () => {
  const a = generateSigner();
  const b = generateSigner();
  const ka = publicKeyText(a.publicKey);
  const kb = publicKeyText(b.publicKey);
  const forged = { ...cert(a, 3), verdict: 'FAIL' };
  const cases: Array<{
    name: string;
    certificates: OnchainCertificate[];
    attesters: Record<string, AttesterState | null>;
    trusted?: string[];
    expect: string;
  }> = [
    { name: 'no certificate', certificates: [], attesters: {}, expect: 'REVIEW' },
    { name: 'one good PASS', certificates: [cert(a, 0)], attesters: { [ka]: state(a) }, expect: 'PASS' },
    {
      name: 'certified FAIL',
      certificates: [cert(a, 0, { verdict: 'FAIL' })],
      attesters: { [ka]: state(a) },
      expect: 'FAIL',
    },
    { name: 'revoked', certificates: [cert(a, 0)], attesters: { [ka]: state(a, true) }, expect: 'REVIEW' },
    { name: 'not enrolled', certificates: [cert(a, 0)], attesters: { [ka]: null }, expect: 'REVIEW' },
    { name: 'tampered verdict', certificates: [forged], attesters: { [ka]: state(a) }, expect: 'REVIEW' },
    {
      name: 'other registry',
      certificates: [{ ...cert(a, 0), registry: 'other.testnet' }],
      attesters: { [ka]: state(a) },
      expect: 'REVIEW',
    },
    {
      name: 'other bundle',
      certificates: [cert(a, 0, { bundleDigest: `sha256:${'11'.repeat(32)}` })],
      attesters: { [ka]: state(a) },
      expect: 'REVIEW',
    },
    {
      name: 'pinned other key',
      certificates: [cert(a, 0)],
      attesters: { [ka]: state(a), [kb]: state(b) },
      trusted: [kb],
      expect: 'REVIEW',
    },
    {
      name: 'pinned key',
      certificates: [cert(a, 0), cert(b, 1, { verdict: 'FAIL' })],
      attesters: { [ka]: state(a), [kb]: state(b) },
      trusted: [ka],
      expect: 'PASS',
    },
    {
      name: 'attesters disagree',
      certificates: [cert(a, 0), cert(b, 1, { verdict: 'FAIL' })],
      attesters: { [ka]: state(a), [kb]: state(b) },
      expect: 'REVIEW',
    },
    {
      name: 'disagreeing revoked attester ignored',
      certificates: [cert(a, 0), cert(b, 1, { verdict: 'FAIL' })],
      attesters: { [ka]: state(a), [kb]: state(b, true) },
      expect: 'PASS',
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const input = {
        registry: REGISTRY,
        bundleDigest: BUNDLE,
        certificates: c.certificates,
        attesters: c.attesters,
        trustedAttesters: c.trusted ?? [],
      };
      const browser = await assessDigest(input);
      const node = aggregateRelease({ ...input, local: null, policy: 'REQUIRE_ONCHAIN_ATTESTER' });
      expect(browser).toEqual(node);
      expect(browser.decision).toBe(c.expect);
    });
  }
});

describe('NearViewReader endpoint rules', () => {
  const PORT = 9552;
  let server: Server;
  let mode = 'not-json';

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (mode === 'not-json') res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
        else if (mode === 'redirect') res.writeHead(307, { location: 'http://127.0.0.1:1/' }).end();
        else if (mode === 'huge') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(5 * 1024 * 1024) }));
        } else if (mode === 'view-error') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' }, message: 'no account' },
            }),
          );
        }
      });
    });
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('accepts https anywhere and http only on loopback', () => {
    expect(() => new NearViewReader('https://test.rpc.fastnear.com')).not.toThrow();
    expect(() => new NearViewReader('http://127.0.0.1:9551')).not.toThrow();
    expect(() => new NearViewReader('http://localhost:9551')).not.toThrow();
    for (const bad of [
      'http://rpc.example.com',
      'ftp://127.0.0.1',
      'not a url',
      'https://u:p@rpc.example.com',
    ]) {
      expect(() => new NearViewReader(bad), bad).toThrow(BrowserVerifyError);
    }
  });

  it('reports a misbehaving endpoint as unavailable, never as an answer', async () => {
    const reader = new NearViewReader(`http://127.0.0.1:${String(PORT)}`);
    for (const m of ['not-json', 'redirect', 'huge']) {
      mode = m;
      const err = await reader.chainId().catch((e: unknown) => e);
      expect(err, m).toBeInstanceOf(BrowserVerifyError);
      expect((err as BrowserVerifyError).code, m).toBe('RPC_UNAVAILABLE');
    }
  });

  it('reports an unknown account as a registry refusal with the node reason', async () => {
    mode = 'view-error';
    const reader = new NearViewReader(`http://127.0.0.1:${String(PORT)}`);
    const err = (await reader.codeHash('nobody.testnet').catch((e: unknown) => e)) as BrowserVerifyError;
    expect(err).toBeInstanceOf(BrowserVerifyError);
    expect(err.code).toBe('REGISTRY_REJECTED');
    expect(err.reason).toBe('UNKNOWN_ACCOUNT');
  });
});
