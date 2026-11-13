/**
 * M47 — `routespec certificate keygen|publish` without a chain, and the refusals of
 * `certificate verify|revoke-check` that need none.
 *
 * A real gate run is exported to a real bundle; `certificate publish` verifies it, reads the
 * corpus digest and the commit from the journal (or takes them as flags), signs, and writes the
 * envelope. The on-chain half runs in the near-sandbox suite (`pnpm run test:registry`).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  base58Encode,
  generateSigner,
  parseSignedCertificate,
  publicKeyText,
  signerFromSecret,
  signingPayload,
  verifySignedCertificate,
  type Ed25519Signer,
} from '@routespec/registry';
import { makeBundle, type CertifiableBundle } from './support/certificate-bundle.ts';
import { runCliProcess, tempDir } from './support/product.ts';

const REGISTRY = 'gnanam1990-routespec.testnet';
let tmp: ReturnType<typeof tempDir>;
let elsewhere: ReturnType<typeof tempDir>;
let bundle: CertifiableBundle;
let keyFile = '';
let signer: Ed25519Signer;

function cleanEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  for (const name of [
    'ROUTESPEC_DATA_DIR',
    'ROUTESPEC_ATTESTER_KEY',
    'ROUTESPEC_NEAR_SIGNER_KEY',
    'ROUTESPEC_NEAR_SIGNER_ACCOUNT',
  ]) {
    if (!(name in extra)) delete env[name];
  }
  return env;
}

function cli(args: string[], env: Record<string, string> = {}) {
  return runCliProcess(args, { cwd: elsewhere.dir, env: cleanEnv(env) });
}

function errorOf(json: Record<string, unknown> | null): { code: string; details: Record<string, unknown> } {
  return (json?.['error'] ?? { code: 'NONE', details: {} }) as {
    code: string;
    details: Record<string, unknown>;
  };
}

beforeAll(async () => {
  tmp = tempDir('routespec-m47-');
  elsewhere = tempDir('routespec-m47-else-');
  bundle = await makeBundle(tmp.dir, { scenarios: ['happy-path'], label: 'm47' });
  expect(bundle.gateExitCode).toBe(0);
  expect(bundle.decision).toBe('PASS');
  keyFile = join(elsewhere.dir, 'attester.pem');
  const made = await cli(['certificate', 'keygen', '--out', keyFile]);
  expect(made.exitCode, made.stderr).toBe(0);
  signer = signerFromSecret(readFileSync(keyFile, 'utf8'));
  expect(made.json?.['publicKey']).toBe(publicKeyText(signer.publicKey));
});

afterAll(() => {
  tmp?.cleanup();
  elsewhere?.cleanup();
});

describe('certificate keygen', () => {
  it('writes a private key file once and prints only the public key', async () => {
    const pem = readFileSync(keyFile, 'utf8');
    expect(pem.startsWith('-----BEGIN')).toBe(true);
    const again = await cli(['certificate', 'keygen', '--out', keyFile]);
    expect(again.exitCode).toBe(6);
    expect(errorOf(again.json).code).toBe('RS_EXPORT_OVERWRITE_DENIED');
    expect(readFileSync(keyFile, 'utf8')).toBe(pem);
    const other = join(elsewhere.dir, 'second.pem');
    const made = await cli(['certificate', 'keygen', '--out', other]);
    expect(made.exitCode).toBe(0);
    const body = readFileSync(other, 'utf8').split('\n').slice(1, -2).join('');
    expect(`${made.stdout}${made.stderr}`).not.toContain(body);
    expect(made.json?.['publicKey']).not.toBe(publicKeyText(signer.publicKey));
  });
});

describe('certificate publish (sign only)', () => {
  it('certifies the verified bundle with the values recorded in the journal', async () => {
    const out = join(elsewhere.dir, 'certificate.json');
    const before = Date.now();
    const r = await cli([
      'certificate',
      'publish',
      '--data',
      tmp.dir,
      '--bundle',
      bundle.bundlePath,
      '--project-key',
      'gnanam1990/routespec-near',
      '--registry',
      REGISTRY,
      '--attester-key',
      keyFile,
      '--out',
      out,
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.json).toMatchObject({
      ok: true,
      command: 'certificate publish',
      registry: REGISTRY,
      submitted: false,
      identitySource: 'JOURNAL',
      envelopeWritten: true,
      attester: publicKeyText(signer.publicKey),
    });
    const envelope = parseSignedCertificate(JSON.parse(readFileSync(out, 'utf8')));
    expect(envelope.certificate).toMatchObject({
      project: 'gnanam1990/routespec-near',
      bundle_digest: bundle.bundleDigest,
      verdict: 'PASS',
      corpus_digest: bundle.corpusDigest,
      artifact_digest: bundle.journal.artifactDigest,
      commit: bundle.commit,
    });
    expect(envelope.certificate.timestamp_ms).toBeGreaterThanOrEqual(before);
    expect(envelope.certificate.timestamp_ms).toBeLessThanOrEqual(Date.now());
    expect(r.json?.['certificate']).toEqual(envelope.certificate);
    expect(r.json?.['signature']).toBe(envelope.signature);
    expect(verifySignedCertificate(REGISTRY, envelope)).toEqual({ ok: true, reason: null });
    expect(verifySignedCertificate('gnanam1990-routespec.near', envelope).ok).toBe(false);
    const payload = signingPayload({
      registry: REGISTRY,
      project: envelope.certificate.project,
      bundleDigest: envelope.certificate.bundle_digest,
      verdict: envelope.certificate.verdict,
      corpusDigest: envelope.certificate.corpus_digest,
      artifactDigest: envelope.certificate.artifact_digest,
      commit: envelope.certificate.commit,
      timestampMs: envelope.certificate.timestamp_ms,
    });
    expect(r.json?.['payloadDigest']).toBe(`sha256:${createHash('sha256').update(payload).digest('hex')}`);

    const again = await cli([
      'certificate',
      'publish',
      '--data',
      tmp.dir,
      '--bundle',
      bundle.bundlePath,
      '--project-key',
      'gnanam1990/routespec-near',
      '--registry',
      REGISTRY,
      '--attester-key',
      keyFile,
      '--out',
      out,
    ]);
    expect(again.exitCode).toBe(6);
    expect(errorOf(again.json).code).toBe('RS_EXPORT_OVERWRITE_DENIED');
  });

  it('takes the corpus digest and commit as flags when no journal is given, and the key from the environment', async () => {
    const nearText = `ed25519:${base58Encode(Buffer.concat([signer.seed, signer.publicKey]))}`;
    const r = await cli(
      [
        'certificate',
        'publish',
        '--bundle',
        bundle.bundlePath,
        '--project-key',
        'org/repo',
        '--registry',
        REGISTRY,
        '--corpus-digest',
        bundle.corpusDigest,
        '--commit',
        bundle.commit,
      ],
      { ROUTESPEC_ATTESTER_KEY: nearText },
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.json).toMatchObject({ identitySource: 'FLAGS', submitted: false });
    const envelope = parseSignedCertificate({
      certificate: r.json?.['certificate'],
      attester: r.json?.['attester'],
      signature: r.json?.['signature'],
    });
    expect(verifySignedCertificate(REGISTRY, envelope).ok).toBe(true);
    expect(envelope.certificate.corpus_digest).toBe(bundle.corpusDigest);
    expect(`${r.stdout}${r.stderr}`).not.toContain(nearText.slice(8));
    expect(`${r.stdout}${r.stderr}`).not.toContain(base58Encode(signer.seed));
  });

  it('refuses flags that contradict the journal, and missing identity values', async () => {
    const base = [
      'certificate',
      'publish',
      '--bundle',
      bundle.bundlePath,
      '--project-key',
      'org/repo',
      '--registry',
      REGISTRY,
      '--attester-key',
      keyFile,
    ];
    const wrongCommit = await cli([...base, '--data', tmp.dir, '--commit', 'f'.repeat(40)]);
    expect(wrongCommit.exitCode).toBe(4);
    expect(errorOf(wrongCommit.json)).toMatchObject({
      code: 'RS_IDENTITY_MISMATCH',
      details: { flag: 'commit' },
    });
    const wrongCorpus = await cli([...base, '--data', tmp.dir, '--corpus-digest', `sha256:${'0'.repeat(64)}`]);
    expect(errorOf(wrongCorpus.json)).toMatchObject({
      code: 'RS_IDENTITY_MISMATCH',
      details: { flag: 'corpus-digest' },
    });
    const none = await cli(base);
    expect(none.exitCode).toBe(4);
    expect(errorOf(none.json).code).toBe('RS_CLI_USAGE');
    const shortCommit = await cli([...base, '--corpus-digest', bundle.corpusDigest, '--commit', 'abc1234']);
    expect(shortCommit.exitCode).toBe(4);
    const otherJournal = tempDir('routespec-m47-other-');
    try {
      const foreign = await cli([...base, '--data', otherJournal.dir]);
      expect(foreign.exitCode).toBe(4);
      expect(errorOf(foreign.json).code).toBe('RS_NOT_FOUND');
    } finally {
      otherJournal.cleanup();
    }
  });

  it('signs nothing for a bundle that does not verify', async () => {
    const bytes = readFileSync(bundle.bundlePath);
    const at = bytes.indexOf(Buffer.from('"decision"'));
    expect(at).toBeGreaterThan(0);
    bytes[at + 1] = 'D'.charCodeAt(0);
    const tampered = join(elsewhere.dir, 'tampered.tar');
    writeFileSync(tampered, bytes);
    const out = join(elsewhere.dir, 'tampered-certificate.json');
    const r = await cli([
      'certificate',
      'publish',
      '--data',
      tmp.dir,
      '--bundle',
      tampered,
      '--project-key',
      'org/repo',
      '--registry',
      REGISTRY,
      '--attester-key',
      keyFile,
      '--out',
      out,
    ]);
    expect(r.exitCode).toBe(5);
    expect(errorOf(r.json).code).toBe('RS_BUNDLE_VERIFY_FAILED');
    expect(r.json?.['signature']).toBeUndefined();
    expect(existsSync(out)).toBe(false);
  });

  it('refuses a missing or unusable attester key without echoing it', async () => {
    const base = [
      'certificate',
      'publish',
      '--data',
      tmp.dir,
      '--bundle',
      bundle.bundlePath,
      '--project-key',
      'org/repo',
      '--registry',
      REGISTRY,
    ];
    const missing = await cli(base);
    expect(missing.exitCode).toBe(4);
    expect(errorOf(missing.json).code).toBe('RS_CLI_USAGE');
    const other = generateSigner();
    const mismatched = base58Encode(Buffer.concat([signer.seed, other.publicKey]));
    const bad = await cli(base, { ROUTESPEC_ATTESTER_KEY: `ed25519:${mismatched}` });
    expect(bad.exitCode).toBe(4);
    expect(errorOf(bad.json).code).toBe('RS_CERTIFICATE_KEY_INVALID');
    expect(`${bad.stdout}${bad.stderr}`).not.toContain(mismatched.slice(0, 16));
    const badProject = await cli([...base, '--attester-key', keyFile, '--project-key', 'Org/Repo']);
    expect(badProject.exitCode).toBe(4);
    const badRegistry = await cli([...base.slice(0, -1), 'Not.An.Account', '--attester-key', keyFile]);
    expect(badRegistry.exitCode).toBe(4);
  });

  it('needs a chain and an account before it submits', async () => {
    const base = [
      'certificate',
      'publish',
      '--data',
      tmp.dir,
      '--bundle',
      bundle.bundlePath,
      '--project-key',
      'org/repo',
      '--registry',
      REGISTRY,
      '--attester-key',
      keyFile,
      '--submit',
    ];
    const noChain = await cli(base);
    expect(noChain.exitCode).toBe(4);
    expect(errorOf(noChain.json).code).toBe('RS_CLI_USAGE');
    const unreachable = await cli([...base, '--rpc', 'http://127.0.0.1:9509']);
    expect(unreachable.exitCode).toBe(5);
    expect(errorOf(unreachable.json).code).toBe('RS_REGISTRY_UNAVAILABLE');
  });
});

describe('certificate verify and revoke-check refusals that need no chain', () => {
  it('refuses unsafe or missing endpoints and malformed selectors', async () => {
    const digest = `sha256:${'ab'.repeat(32)}`;
    const cases: string[][] = [
      ['certificate', 'verify', '--digest', digest, '--registry', REGISTRY],
      ['certificate', 'verify', '--digest', digest, '--registry', REGISTRY, '--rpc', 'http://example.com'],
      ['certificate', 'verify', '--digest', digest, '--registry', REGISTRY, '--rpc', 'ftp://127.0.0.1'],
      ['certificate', 'verify', '--digest', digest, '--registry', REGISTRY, '--rpc', 'https://user:pw@example.com'],
      ['certificate', 'verify', '--digest', digest, '--registry', REGISTRY, '--network', 'devnet'],
      ['certificate', 'verify', '--digest', 'sha256:abc', '--registry', REGISTRY, '--network', 'testnet'],
      ['certificate', 'verify', '--registry', REGISTRY, '--network', 'testnet'],
      [
        'certificate',
        'verify',
        '--digest',
        digest,
        '--bundle',
        bundle.bundlePath,
        '--registry',
        REGISTRY,
        '--network',
        'testnet',
      ],
      [
        'certificate',
        'verify',
        '--digest',
        digest,
        '--registry',
        REGISTRY,
        '--rpc',
        'http://127.0.0.1:9509',
        '--attester',
        'ed25519:not-a-key',
      ],
      [
        'certificate',
        'verify',
        '--digest',
        digest,
        '--registry',
        REGISTRY,
        '--rpc',
        'http://127.0.0.1:9509',
        '--policy',
        'trust-me',
      ],
      ['certificate', 'revoke-check', '--registry', REGISTRY, '--rpc', 'http://127.0.0.1:9509'],
      ['certificate', 'revoke-check', '--digest', digest, '--registry', 'UPPER.near', '--network', 'testnet'],
    ];
    for (const args of cases) {
      const r = await cli(args);
      expect(r.exitCode, args.join(' ')).toBe(4);
      expect(errorOf(r.json).code, args.join(' ')).toBe('RS_CLI_USAGE');
    }
  });

  it('reports an unreachable endpoint as unavailable, never as a verdict', async () => {
    const digest = `sha256:${'ab'.repeat(32)}`;
    for (const command of ['verify', 'revoke-check']) {
      const r = await cli([
        'certificate',
        command,
        '--digest',
        digest,
        '--registry',
        REGISTRY,
        '--rpc',
        'http://127.0.0.1:9509',
      ]);
      expect(r.exitCode, command).toBe(5);
      expect(errorOf(r.json).code).toBe('RS_REGISTRY_UNAVAILABLE');
      expect(r.json?.['release']).toBeUndefined();
    }
  });

  it('does not ask the chain about a bundle that fails local verification', async () => {
    const copy = join(elsewhere.dir, 'copy.tar');
    copyFileSync(bundle.bundlePath, copy);
    const bytes = readFileSync(copy);
    bytes[bytes.length - 2000] = (bytes[bytes.length - 2000] as number) ^ 0xff;
    const at = bytes.indexOf(Buffer.from('"decision"'));
    bytes[at + 2] = 'E'.charCodeAt(0);
    writeFileSync(copy, bytes);
    const r = await cli([
      'certificate',
      'verify',
      '--bundle',
      copy,
      '--registry',
      REGISTRY,
      '--rpc',
      'http://127.0.0.1:9509',
    ]);
    expect(r.exitCode).toBe(5);
    expect(errorOf(r.json).code).toBe('RS_BUNDLE_VERIFY_FAILED');
  });
});
