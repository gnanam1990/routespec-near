/**
 * M47 — the certificate signing payload. The shared vectors in
 * `contracts/routespec-registry/vectors/certificate-v1.json` are checked by the Rust crate the
 * contract uses and by this package, so the CLI signs exactly the bytes the contract verifies.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RouteSpecError } from '@routespec/contracts';
import {
  CERTIFICATE_PAYLOAD_DOMAIN,
  certificateFieldError,
  checkTimestampWindow,
  generateSigner,
  MAX_AGE_MS,
  MAX_FUTURE_SKEW_MS,
  parseSignedCertificate,
  publicKeyText,
  signCertificate,
  signingPayload,
  verifyEd25519,
  verifySignedCertificate,
  type CertificateFields,
} from '../src/index.ts';

interface Vectors {
  schema: string;
  attesterPublicKeyHex: string;
  vectors: Array<{
    name: string;
    fields: CertificateFields;
    payloadUtf8: string;
    payloadSha256: string;
    signatureHex: string;
  }>;
  invalid: Array<{ name: string; fields: CertificateFields; error: string }>;
}

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../contracts/routespec-registry/vectors/certificate-v1.json', import.meta.url),
    ),
    'utf8',
  ),
) as Vectors;

const base: CertificateFields = {
  registry: 'registry.testnet',
  project: 'org/repo',
  bundleDigest: `sha256:${'ab'.repeat(32)}`,
  verdict: 'PASS',
  corpusDigest: `sha256:${'cd'.repeat(32)}`,
  artifactDigest: `sha256:${'ef'.repeat(32)}`,
  commit: '0123456789abcdef0123456789abcdef01234567',
  timestampMs: 1_794_528_000_000,
};

describe('certificate signing payload', () => {
  it('reproduces the shared vectors byte for byte', () => {
    expect(vectors.schema).toBe('routespec.certificate-vectors/1');
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(6);
    for (const v of vectors.vectors) {
      const payload = signingPayload(v.fields);
      expect(Buffer.from(payload).toString('utf8'), v.name).toBe(v.payloadUtf8);
      expect(createHash('sha256').update(payload).digest('hex'), v.name).toBe(v.payloadSha256);
    }
  });

  it('verifies the recorded signatures and rejects them for any changed field', () => {
    const key = Buffer.from(vectors.attesterPublicKeyHex, 'hex');
    for (const v of vectors.vectors) {
      const signature = Buffer.from(v.signatureHex, 'hex');
      expect(verifyEd25519(key, signingPayload(v.fields), signature), v.name).toBe(true);
      const changes: Array<Partial<CertificateFields>> = [
        { registry: 'other-registry.testnet' },
        { project: 'someone/else' },
        { bundleDigest: `sha256:${'0'.repeat(63)}1` },
        { verdict: v.fields.verdict === 'PASS' ? 'FAIL' : 'PASS' },
        { corpusDigest: `sha256:${'0'.repeat(63)}1` },
        { artifactDigest: `sha256:${'0'.repeat(63)}1` },
        { commit: `${'0'.repeat(39)}1` },
        { timestampMs: v.fields.timestampMs === 1 ? 2 : v.fields.timestampMs - 1 },
      ];
      for (const change of changes) {
        const tampered = signingPayload({ ...v.fields, ...change });
        expect(verifyEd25519(key, tampered, signature), `${v.name} ${Object.keys(change)[0]}`).toBe(false);
      }
    }
  });

  it('refuses invalid fields with the same code as the contract', () => {
    expect(vectors.invalid.length).toBeGreaterThanOrEqual(20);
    for (const v of vectors.invalid) {
      expect(certificateFieldError(v.fields), v.name).toBe(v.error);
      let thrown: unknown = null;
      try {
        signingPayload(v.fields);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, v.name).toBeInstanceOf(RouteSpecError);
      expect((thrown as RouteSpecError).code).toBe('RS_CERTIFICATE_INVALID');
      expect((thrown as RouteSpecError).details['reason']).toBe(v.error);
    }
  });

  it('refuses a fractional, negative or non-numeric timestamp', () => {
    for (const timestampMs of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, '1' as unknown as number]) {
      expect(certificateFieldError({ ...base, timestampMs })).toBe('RSREG_FIELD_INVALID:timestamp_ms');
    }
  });

  it('starts with the domain line and ends with a line break', () => {
    const text = Buffer.from(signingPayload(base)).toString('utf8');
    expect(text.startsWith(`${CERTIFICATE_PAYLOAD_DOMAIN}\n`)).toBe(true);
    expect(text.endsWith('\ntimestamp:1794528000000\n')).toBe(true);
    expect(text.split('\n')).toHaveLength(10);
  });
});

describe('signed certificates', () => {
  it('signs to the publish arguments and verifies offline', () => {
    const signer = generateSigner();
    const signed = signCertificate(base, signer);
    expect(Object.keys(signed).sort()).toEqual(['attester', 'certificate', 'signature']);
    expect(signed.attester).toBe(publicKeyText(signer.publicKey));
    expect(signed.certificate).toEqual({
      project: base.project,
      bundle_digest: base.bundleDigest,
      verdict: 'PASS',
      corpus_digest: base.corpusDigest,
      artifact_digest: base.artifactDigest,
      commit: base.commit,
      timestamp_ms: base.timestampMs,
    });
    expect(Buffer.from(signed.signature, 'base64')).toHaveLength(64);
    expect(verifySignedCertificate(base.registry, signed)).toEqual({ ok: true, reason: null });
  });

  it('does not verify for another registry, another attester, or a changed field', () => {
    const signer = generateSigner();
    const signed = signCertificate(base, signer);
    expect(verifySignedCertificate('other.testnet', signed)).toEqual({
      ok: false,
      reason: 'CERTIFICATE_SIGNATURE_INVALID',
    });
    expect(
      verifySignedCertificate(base.registry, {
        ...signed,
        attester: publicKeyText(generateSigner().publicKey),
      }),
    ).toEqual({ ok: false, reason: 'CERTIFICATE_SIGNATURE_INVALID' });
    expect(
      verifySignedCertificate(base.registry, {
        ...signed,
        certificate: { ...signed.certificate, verdict: 'FAIL' },
      }),
    ).toEqual({ ok: false, reason: 'CERTIFICATE_SIGNATURE_INVALID' });
    const flipped = Buffer.from(signed.signature, 'base64');
    flipped[10] = (flipped[10] as number) ^ 1;
    expect(
      verifySignedCertificate(base.registry, { ...signed, signature: flipped.toString('base64') }),
    ).toEqual({ ok: false, reason: 'CERTIFICATE_SIGNATURE_INVALID' });
    expect(
      verifySignedCertificate(base.registry, {
        ...signed,
        certificate: { ...signed.certificate, project: 'Not Valid' },
      }),
    ).toEqual({ ok: false, reason: 'RSREG_FIELD_INVALID:project' });
  });

  it('parses an envelope strictly', () => {
    const signed = signCertificate(base, generateSigner());
    expect(parseSignedCertificate(JSON.parse(JSON.stringify(signed)))).toEqual(signed);
    for (const bad of [
      null,
      [],
      { ...signed, extra: 1 },
      { ...signed, certificate: { ...signed.certificate, note: 'x' } },
      { ...signed, signature: 'not base64 !' },
      { ...signed, signature: Buffer.alloc(63).toString('base64') },
      { ...signed, attester: 'secp256k1:abc' },
      { ...signed, certificate: { ...signed.certificate, timestamp_ms: '1' } },
    ]) {
      expect(() => parseSignedCertificate(bad)).toThrowError(RouteSpecError);
    }
  });

  it('applies the same timestamp window as the contract', () => {
    const now = 1_794_528_000_000;
    expect(checkTimestampWindow(now, now)).toBeNull();
    expect(checkTimestampWindow(now + MAX_FUTURE_SKEW_MS, now)).toBeNull();
    expect(checkTimestampWindow(now + MAX_FUTURE_SKEW_MS + 1, now)).toBe('RSREG_TIMESTAMP_FUTURE');
    expect(checkTimestampWindow(now - MAX_AGE_MS, now)).toBeNull();
    expect(checkTimestampWindow(now - MAX_AGE_MS - 1, now)).toBe('RSREG_TIMESTAMP_STALE');
  });
});
