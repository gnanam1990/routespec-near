/**
 * Ed25519 keys for attesters and NEAR accounts (M47).
 *
 * Uses only `node:crypto`. Public keys are written the NEAR way, `ed25519:<base58 of 32 bytes>`.
 * A secret can be given as a PKCS#8 PEM private key, as NEAR's `ed25519:<base58>` text (the
 * 32-byte seed followed by the 32-byte public key, or the seed alone), or as a NEAR credentials
 * JSON file with a `private_key` field. Errors never contain key material.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { RouteSpecError } from '@routespec/contracts';
import { base58DecodeChecked, base58Encode } from './key-text.ts';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_SECRET_TEXT = 16 * 1024;

function keyError(message: string): never {
  throw new RouteSpecError('RS_CERTIFICATE_KEY_INVALID', message);
}

export { base58Encode, isPublicKeyText } from './key-text.ts';

export function base58Decode(text: string): Uint8Array {
  const bytes = base58DecodeChecked(text);
  if (bytes === 'TOO_LONG') keyError('Base58 text is too long.');
  if (bytes === 'NOT_BASE58') keyError('Text is not base58.');
  return bytes;
}

/** `ed25519:<base58>` for a 32-byte public key. */
export function publicKeyText(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) keyError('An Ed25519 public key has 32 bytes.');
  return `ed25519:${base58Encode(publicKey)}`;
}

/** The 32 bytes of an `ed25519:<base58>` public key; any other curve or length is refused. */
export function parsePublicKey(text: string): Uint8Array {
  if (typeof text !== 'string' || !text.startsWith('ed25519:')) {
    keyError('A public key must be written as ed25519:<base58>.');
  }
  const bytes = base58Decode(text.slice(8));
  if (bytes.length !== 32) keyError('An Ed25519 public key has 32 bytes.');
  return bytes;
}

function publicKeyObject(publicKey: Uint8Array): KeyObject {
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * The seven encodings of the eight Ed25519 points of small order, compared without the sign bit
 * (the list libsodium blocks; the Rust twin is `is_small_order_key` in `routespec-certificate`).
 */
const SMALL_ORDER_ENCODINGS: readonly Buffer[] = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
].map((hex) => Buffer.from(hex, 'hex'));

/**
 * Whether 32 public-key bytes encode an Ed25519 point of small order. Such a key has no secret:
 * a signature made of a small-order R and s = 0 verifies for any message under cofactorless
 * verification (Node's and NEAR's), so anyone could sign for it.
 */
export function isSmallOrderPublicKey(publicKey: Uint8Array): boolean {
  if (publicKey.length !== 32) return false;
  const key = Buffer.from(publicKey);
  return SMALL_ORDER_ENCODINGS.some(
    (bad) => key.subarray(0, 31).equals(bad.subarray(0, 31)) && ((key[31] as number) & 0x7f) === bad[31],
  );
}

/**
 * Ed25519 verification that never throws: malformed keys or signatures are simply invalid, and
 * so is every signature for a small-order key.
 */
export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  if (isSmallOrderPublicKey(publicKey)) return false;
  try {
    return verify(null, message, publicKeyObject(publicKey), signature);
  } catch {
    return false;
  }
}

export interface Ed25519Signer {
  /** 32 bytes. */
  readonly publicKey: Uint8Array;
  /** The 32-byte seed. Kept in memory only; never logged or returned by any command. */
  readonly seed: Uint8Array;
  sign(message: Uint8Array): Buffer;
}

function signerFromKeyObject(privateKey: KeyObject): Ed25519Signer {
  if (privateKey.asymmetricKeyType !== 'ed25519') keyError('The key must be Ed25519.');
  const jwk = privateKey.export({ format: 'jwk' }) as { x?: string; d?: string };
  if (typeof jwk.x !== 'string' || typeof jwk.d !== 'string') keyError('The key must be Ed25519.');
  const publicKey = new Uint8Array(Buffer.from(jwk.x, 'base64url'));
  const seed = new Uint8Array(Buffer.from(jwk.d, 'base64url'));
  return { publicKey, seed, sign: (message) => sign(null, message, privateKey) };
}

function signerFromSeed(seed: Uint8Array): Ed25519Signer {
  return signerFromKeyObject(
    createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' }),
  );
}

export function generateSigner(): Ed25519Signer {
  return signerFromKeyObject(generateKeyPairSync('ed25519').privateKey);
}

/** PKCS#8 PEM for a signer (what `certificate keygen` writes). */
export function signerToPem(signer: Ed25519Signer): string {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, signer.seed]),
    format: 'der',
    type: 'pkcs8',
  })
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
}

function signerFromNearText(text: string): Ed25519Signer {
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(text.slice(8));
  } catch {
    keyError('The secret key is not valid ed25519:<base58> text.');
  }
  if (bytes.length !== 32 && bytes.length !== 64) keyError('The secret key has the wrong length.');
  const signer = signerFromSeed(bytes.subarray(0, 32));
  if (bytes.length === 64 && !Buffer.from(bytes.subarray(32)).equals(Buffer.from(signer.publicKey))) {
    keyError('The secret key does not match its public key.');
  }
  return signer;
}

/**
 * Read an Ed25519 secret from text in any accepted format (see the module comment). A NEAR
 * credentials file whose `public_key` does not belong to its `private_key` is refused.
 */
export function signerFromSecret(text: string): Ed25519Signer {
  if (typeof text !== 'string' || text.length > MAX_SECRET_TEXT) keyError('The key is not readable.');
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    let doc: unknown;
    try {
      doc = JSON.parse(trimmed);
    } catch {
      keyError('The key file is not valid JSON.');
    }
    const record = doc as Record<string, unknown> | null;
    const secret = record?.['private_key'] ?? record?.['secret_key'];
    if (typeof secret !== 'string' || !secret.startsWith('ed25519:')) {
      keyError('The key file has no ed25519 private_key.');
    }
    const signer = signerFromNearText(secret);
    const declared = record?.['public_key'];
    if (declared !== undefined && declared !== publicKeyText(signer.publicKey)) {
      keyError('The key file public_key does not belong to its private_key.');
    }
    return signer;
  }
  if (trimmed.startsWith('ed25519:')) return signerFromNearText(trimmed);
  if (trimmed.startsWith('-----BEGIN')) {
    let key: KeyObject;
    try {
      key = createPrivateKey(trimmed);
    } catch {
      keyError('The PEM is not a private key.');
    }
    return signerFromKeyObject(key);
  }
  keyError('The key is not in an accepted format (PEM, ed25519:<base58>, or NEAR credentials JSON).');
}
