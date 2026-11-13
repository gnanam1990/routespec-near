/**
 * Base58 and NEAR `ed25519:<base58>` public key text (M47), with no Node dependency so that the
 * static verify page (M49) reads keys exactly as the CLI does. `keys.ts` builds on these.
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

/** The longest base58 text that is decoded at all. */
export const MAX_BASE58_TEXT = 512;

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i] as number];
  return out;
}

/** The decoded bytes, or a reason when the text is too long or not base58. */
export function base58DecodeChecked(text: string): Uint8Array | 'TOO_LONG' | 'NOT_BASE58' {
  if (text.length > MAX_BASE58_TEXT) return 'TOO_LONG';
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i++) {
    const value = ALPHABET_INDEX.get(text[i] as string);
    if (value === undefined) return 'NOT_BASE58';
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] as number) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i] as number;
  return out;
}

/** The 32 key bytes of canonical `ed25519:<base58>` text, or null for anything else. */
export function publicKeyBytes(text: unknown): Uint8Array | null {
  if (typeof text !== 'string' || !text.startsWith('ed25519:')) return null;
  const bytes = base58DecodeChecked(text.slice(8));
  if (typeof bytes === 'string' || bytes.length !== 32) return null;
  return `ed25519:${base58Encode(bytes)}` === text ? bytes : null;
}

export function isPublicKeyText(text: unknown): text is string {
  return publicKeyBytes(text) !== null;
}
