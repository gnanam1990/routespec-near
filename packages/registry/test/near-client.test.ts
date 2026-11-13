/**
 * M47 — the minimal NEAR client: endpoint rules, the Borsh transaction layout, and behaviour
 * against an endpoint that misbehaves (a real local HTTP listener that answers badly on
 * purpose). Successful views and transactions are exercised against a real node in the
 * near-sandbox suite; nothing here stands in for a chain.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RouteSpecError } from '@routespec/contracts';
import {
  assertRpcUrl,
  base58Decode,
  contractRefusalCode,
  encodeTransaction,
  generateSigner,
  NearRpc,
  NEAR_NETWORKS,
  RegistryClient,
  signTransaction,
  verifyEd25519,
  type NearTransaction,
} from '../src/index.ts';

const PORT = 9507;
let server: Server;
let mode = 'not-json';

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (mode === 'not-json') {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html>gateway</html>');
      } else if (mode === 'redirect') {
        res.writeHead(307, { location: 'http://127.0.0.1:1/elsewhere' }).end();
      } else if (mode === 'server-error') {
        res.writeHead(502).end('bad gateway');
      } else if (mode === 'huge') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(5 * 1024 * 1024) }));
      } else if (mode === 'huge-chunked') {
        // No content-length: the client has to stop reading by itself.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"jsonrpc":"2.0","id":1,"result":"');
        const block = 'x'.repeat(256 * 1024);
        let sent = 0;
        const pump = (): void => {
          while (sent < 64 && !res.destroyed) {
            sent++;
            if (!res.write(block)) {
              res.once('drain', pump);
              return;
            }
          }
          if (!res.destroyed) res.end('"}');
        };
        pump();
      } else if (mode === 'wrong-shape') {
        res.writeHead(200, { 'content-type': 'application/json' });
        const value = Buffer.from(JSON.stringify({ contract: 'routespec-registry', surprise: true }));
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { result: [...value], block_height: 5, block_hash: 'x' },
          }),
        );
      } else {
        res.destroy();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function code(error: unknown): string {
  return error instanceof RouteSpecError ? error.code : `OTHER:${String(error)}`;
}

describe('RPC endpoint rules', () => {
  it('accepts https anywhere and http for loopback only', () => {
    expect(assertRpcUrl('https://test.rpc.fastnear.com').host).toBe('test.rpc.fastnear.com');
    expect(assertRpcUrl('http://127.0.0.1:9501').port).toBe('9501');
    expect(assertRpcUrl('http://localhost:9501').hostname).toBe('localhost');
    expect(assertRpcUrl('http://[::1]:9501').port).toBe('9501');
    for (const bad of [
      'http://example.com',
      'http://127.0.0.1.example.com',
      'http://10.0.0.5:3030',
      'ftp://127.0.0.1',
      'file:///etc/passwd',
      'https://user:secret@example.com',
      'https://example.com/#fragment',
      'not a url',
      '',
    ]) {
      expect(() => assertRpcUrl(bad), bad).toThrowError(RouteSpecError);
    }
    expect(NEAR_NETWORKS.testnet.rpcUrl).toBe('https://test.rpc.fastnear.com');
    for (const n of Object.values(NEAR_NETWORKS)) expect(assertRpcUrl(n.rpcUrl).protocol).toBe('https:');
  });
});

describe('transaction encoding', () => {
  const signer = generateSigner();
  const tx: NearTransaction = {
    signerId: 'alice.near',
    publicKey: signer.publicKey,
    nonce: 0x0102030405060708n,
    receiverId: 'registry.near',
    blockHash: new Uint8Array(32).fill(0xaa),
    actions: [
      {
        type: 'FunctionCall',
        methodName: 'publish',
        args: new Uint8Array([0x7b, 0x7d]),
        gas: 30_000_000_000_000n,
        deposit: 0n,
      },
    ],
  };

  it('follows the Borsh layout of a NEAR transaction', () => {
    const bytes = encodeTransaction(tx);
    let at = 0;
    const take = (n: number): Buffer => bytes.subarray(at, (at += n));
    expect(take(4).readUInt32LE()).toBe(10);
    expect(take(10).toString()).toBe('alice.near');
    expect(take(1)[0]).toBe(0); // ED25519
    expect(Buffer.from(take(32))).toEqual(Buffer.from(signer.publicKey));
    expect(take(8).toString('hex')).toBe('0807060504030201'); // little-endian nonce
    expect(take(4).readUInt32LE()).toBe(13);
    expect(take(13).toString()).toBe('registry.near');
    expect(take(32).every((b) => b === 0xaa)).toBe(true);
    expect(take(4).readUInt32LE()).toBe(1); // one action
    expect(take(1)[0]).toBe(2); // FunctionCall
    expect(take(4).readUInt32LE()).toBe(7);
    expect(take(7).toString()).toBe('publish');
    expect(take(4).readUInt32LE()).toBe(2);
    expect(take(2).toString()).toBe('{}');
    expect(take(8).readBigUInt64LE()).toBe(30_000_000_000_000n);
    expect(take(16).every((b) => b === 0)).toBe(true); // u128 deposit: zero
    expect(at).toBe(bytes.length);
  });

  it('encodes the other actions with their nearcore tags', () => {
    const tail = (action: NearTransaction['actions'][number]): Buffer => {
      const one = encodeTransaction({ ...tx, actions: [action] });
      const none = encodeTransaction({ ...tx, actions: [] });
      return one.subarray(none.length);
    };
    expect(tail({ type: 'CreateAccount' }).toString('hex')).toBe('00');
    expect(tail({ type: 'DeployContract', code: new Uint8Array([1, 2, 3]) }).toString('hex')).toBe(
      '0103000000010203',
    );
    expect(tail({ type: 'Transfer', deposit: 1n + (2n << 64n) }).toString('hex')).toBe(
      `03${'0100000000000000'}${'0200000000000000'}`,
    );
    const key = new Uint8Array(32).fill(9);
    expect(tail({ type: 'AddFullAccessKey', publicKey: key }).toString('hex')).toBe(
      `0500${'09'.repeat(32)}${'00'.repeat(8)}01`,
    );
  });

  it('signs the SHA-256 of the encoded transaction and appends an Ed25519 signature', () => {
    const encoded = encodeTransaction(tx);
    const signed = signTransaction(tx, signer);
    const hash = createHash('sha256').update(encoded).digest();
    expect(Buffer.from(base58Decode(signed.hash))).toEqual(hash);
    expect(signed.bytes.subarray(0, encoded.length)).toEqual(encoded);
    expect(signed.bytes[encoded.length]).toBe(0);
    const signature = signed.bytes.subarray(encoded.length + 1);
    expect(signature).toHaveLength(64);
    expect(verifyEd25519(signer.publicKey, hash, signature)).toBe(true);
  });

  it('refuses a key or block hash of the wrong size', () => {
    expect(() => encodeTransaction({ ...tx, blockHash: new Uint8Array(31) })).toThrowError(RouteSpecError);
    expect(() => encodeTransaction({ ...tx, publicKey: new Uint8Array(33) })).toThrowError(RouteSpecError);
  });
});

describe('contract refusal codes', () => {
  it('finds the registry code inside nested node errors', () => {
    const failure = {
      ActionError: {
        index: 0,
        kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: RSREG_ATTESTER_REVOKED' } },
      },
    };
    expect(contractRefusalCode(failure)).toBe('RSREG_ATTESTER_REVOKED');
    expect(contractRefusalCode('wasm execution failed: RSREG_FIELD_INVALID:bundle_digest at ...')).toBe(
      'RSREG_FIELD_INVALID:bundle_digest',
    );
    expect(contractRefusalCode({ ActionError: { kind: 'AccountDoesNotExist' } })).toBeNull();
    expect(contractRefusalCode(undefined)).toBeNull();
  });
});

describe('an endpoint that misbehaves', () => {
  const rpc = new NearRpc(`http://127.0.0.1:${String(PORT)}`, { timeoutMs: 5_000 });
  const registry = new RegistryClient(rpc, 'registry.testnet');

  it('is reported as unavailable, never as an answer', async () => {
    for (const m of ['not-json', 'redirect', 'server-error', 'huge', 'huge-chunked', 'drop']) {
      mode = m;
      const error = await registry.info().then(
        () => null,
        (e: unknown) => e,
      );
      expect(code(error), m).toBe('RS_REGISTRY_UNAVAILABLE');
      const chain = await rpc.chainId().then(
        () => null,
        (e: unknown) => e,
      );
      expect(code(chain), m).toBe('RS_REGISTRY_UNAVAILABLE');
    }
  });

  it('refuses a view result with an unexpected shape', async () => {
    mode = 'wrong-shape';
    const error = await registry.info().then(
      () => null,
      (e: unknown) => e,
    );
    expect(code(error)).toBe('RS_REGISTRY_UNAVAILABLE');
    expect((error as RouteSpecError).details).toMatchObject({ view: 'get_info' });
    const list = await registry.certificatesByBundle(`sha256:${'ab'.repeat(32)}`).then(
      () => null,
      (e: unknown) => e,
    );
    expect(code(list)).toBe('RS_REGISTRY_UNAVAILABLE');
  });

  it('refuses a registry name that is not an account id', () => {
    expect(() => new RegistryClient(rpc, 'Not An Account')).toThrowError(RouteSpecError);
  });
});
