/**
 * M47 — attester and NEAR account keys: base58, the `ed25519:` text forms, the accepted secret
 * formats, and signatures that Node's own Ed25519 implementation verifies.
 */
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RouteSpecError } from '@routespec/contracts';
import {
  base58Decode,
  base58Encode,
  generateSigner,
  isSmallOrderPublicKey,
  parsePublicKey,
  publicKeyText,
  signerFromSecret,
  signerToPem,
  verifyEd25519,
} from '../src/index.ts';

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof RouteSpecError ? e.code : 'OTHER';
  }
}

describe('base58', () => {
  it('matches known encodings', () => {
    expect(base58Encode(new Uint8Array([]))).toBe('');
    expect(base58Encode(new Uint8Array([0]))).toBe('1');
    expect(base58Encode(new Uint8Array([0, 0, 1]))).toBe('112');
    expect(base58Encode(Buffer.from('hello world', 'utf8'))).toBe('StV1DL6CwTryKyV');
    expect(base58Encode(new Uint8Array(32))).toBe('1'.repeat(32));
    expect(Buffer.from(base58Decode('StV1DL6CwTryKyV')).toString('utf8')).toBe('hello world');
  });

  it('round-trips arbitrary bytes, including leading zeros', () => {
    for (let n = 0; n < 80; n++) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = (i * 73 + n * 31 + (i < n % 4 ? 0 : 7)) & 0xff;
      if (n > 2) bytes[0] = 0;
      expect(Buffer.from(base58Decode(base58Encode(bytes)))).toEqual(Buffer.from(bytes));
    }
  });

  it('refuses characters outside the alphabet', () => {
    for (const bad of ['0', 'O', 'I', 'l', 'abc def', 'abc+']) {
      expect(
        code(() => base58Decode(bad)),
        bad,
      ).toBe('RS_CERTIFICATE_KEY_INVALID');
    }
  });
});

describe('public keys', () => {
  it('round-trips the ed25519: text form', () => {
    const signer = generateSigner();
    const text = publicKeyText(signer.publicKey);
    expect(text).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(Buffer.from(parsePublicKey(text))).toEqual(Buffer.from(signer.publicKey));
  });

  it('refuses other curves, wrong lengths and malformed text', () => {
    for (const bad of [
      'secp256k1:abc',
      'ed25519:',
      `ed25519:${base58Encode(new Uint8Array(31))}`,
      `ed25519:${base58Encode(new Uint8Array(33))}`,
      base58Encode(new Uint8Array(32)),
      'ed25519:0OIl',
    ]) {
      expect(
        code(() => parsePublicKey(bad)),
        bad,
      ).toBe('RS_CERTIFICATE_KEY_INVALID');
    }
  });
});

describe('secret key formats', () => {
  it('accepts a PEM private key, the NEAR text form and a NEAR credentials file', () => {
    const signer = generateSigner();
    const pem = signerToPem(signer);
    const fromPem = signerFromSecret(pem);
    expect(Buffer.from(fromPem.publicKey)).toEqual(Buffer.from(signer.publicKey));

    const nearText = `ed25519:${base58Encode(Buffer.concat([signer.seed, signer.publicKey]))}`;
    const fromNear = signerFromSecret(`${nearText}\n`);
    expect(Buffer.from(fromNear.publicKey)).toEqual(Buffer.from(signer.publicKey));

    const seedOnly = signerFromSecret(`ed25519:${base58Encode(signer.seed)}`);
    expect(Buffer.from(seedOnly.publicKey)).toEqual(Buffer.from(signer.publicKey));

    const credentials = JSON.stringify({
      account_id: 'someone.testnet',
      public_key: publicKeyText(signer.publicKey),
      private_key: nearText,
    });
    const fromFile = signerFromSecret(credentials);
    expect(Buffer.from(fromFile.publicKey)).toEqual(Buffer.from(signer.publicKey));
  });

  it('signs so that an independent verifier accepts the signature', () => {
    const signer = generateSigner();
    const message = Buffer.from('routespec.certificate/1\n', 'utf8');
    const signature = signer.sign(message);
    expect(signature).toHaveLength(64);
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(signer.publicKey).toString('base64url') };
    expect(verify(null, message, createPublicKey({ key: jwk, format: 'jwk' }), signature)).toBe(true);
    expect(verifyEd25519(signer.publicKey, message, signature)).toBe(true);
    expect(verifyEd25519(signer.publicKey, Buffer.from('other'), signature)).toBe(false);
    expect(verifyEd25519(new Uint8Array(31), message, signature)).toBe(false);
    expect(verifyEd25519(signer.publicKey, message, signature.subarray(0, 63))).toBe(false);
  });

  it('refuses a key that is not Ed25519, a mismatched pair, and anything unreadable', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPem = rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const a = generateSigner();
    const b = generateSigner();
    const mismatched = `ed25519:${base58Encode(Buffer.concat([a.seed, b.publicKey]))}`;
    const wrongFilePair = JSON.stringify({
      public_key: publicKeyText(b.publicKey),
      private_key: `ed25519:${base58Encode(Buffer.concat([a.seed, a.publicKey]))}`,
    });
    for (const bad of [rsaPem, mismatched, wrongFilePair, '', 'hello', '{"private_key":5}', 'ed25519:abc']) {
      expect(code(() => signerFromSecret(bad))).toBe('RS_CERTIFICATE_KEY_INVALID');
    }
  });

  it('never puts key material in an error', () => {
    const a = generateSigner();
    const b = generateSigner();
    const secret = base58Encode(Buffer.concat([a.seed, b.publicKey]));
    try {
      signerFromSecret(`ed25519:${secret}`);
      expect.unreachable();
    } catch (e) {
      const text = JSON.stringify([(e as RouteSpecError).message, (e as RouteSpecError).details]);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(secret.slice(0, 12));
    }
  });
});

/**
 * The seven encodings (each with either sign bit) of the eight Ed25519 points of small order,
 * the same list libsodium blocks. With such a public key, R = that key and s = 0 verify for any
 * message under cofactorless verification, so anyone could sign for it.
 */
const SMALL_ORDER_KEYS: readonly Uint8Array[] = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
].flatMap((hex) => {
  const plain = new Uint8Array(Buffer.from(hex, 'hex'));
  const signed = new Uint8Array(plain);
  signed[31] = (signed[31] as number) ^ 0x80;
  return [plain, signed];
});

describe('small-order public keys', () => {
  it('are recognised in every encoding, and a real key is not', () => {
    for (const k of SMALL_ORDER_KEYS) expect(isSmallOrderPublicKey(k)).toBe(true);
    for (let i = 0; i < 50; i++) expect(isSmallOrderPublicKey(generateSigner().publicKey)).toBe(false);
    expect(isSmallOrderPublicKey(new Uint8Array(31))).toBe(false);
  });

  it('never verify, so a forged signature for the identity key is refused', () => {
    const identity = SMALL_ORDER_KEYS[2] as Uint8Array;
    // R = the identity point, s = 0: valid for every message under cofactorless verification.
    const forged = Buffer.concat([Buffer.from(identity), Buffer.alloc(32)]);
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), identity]);
    const nodeKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    // Node itself accepts the forgery, which is why the key has to be refused by RouteSpec.
    expect(verify(null, Buffer.from('any message'), nodeKey, forged)).toBe(true);
    for (const k of SMALL_ORDER_KEYS) {
      expect(
        verifyEd25519(k, Buffer.from('any message'), Buffer.concat([Buffer.from(k), Buffer.alloc(32)])),
      ).toBe(false);
    }
  });
});
