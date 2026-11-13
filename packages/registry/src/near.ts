/**
 * A minimal NEAR JSON-RPC client (M47): contract views, access-key lookup, and signed
 * transactions. It implements only what the certificate commands need, with `node:crypto` and
 * the built-in `fetch`, so no NEAR SDK enters the dependency tree.
 *
 * Transaction encoding follows nearcore's Borsh layout for `Transaction` and
 * `SignedTransaction` (Ed25519 only). The near-sandbox suite sends these bytes to a real node.
 *
 * Endpoint rules: `https:` only, or `http:` for a loopback host (a local sandbox). No
 * credentials in the URL, no redirects, bounded response size and time. Errors carry the
 * contract's `RSREG_*` code when there is one and never contain key material.
 */
import { createHash } from 'node:crypto';
import { RouteSpecError } from '@routespec/contracts';
import { base58Decode, base58Encode, publicKeyText, type Ed25519Signer } from './keys.ts';

export const NEAR_NETWORKS = Object.freeze({
  testnet: { rpcUrl: 'https://test.rpc.fastnear.com', chainId: 'testnet' },
  mainnet: { rpcUrl: 'https://free.rpc.fastnear.com', chainId: 'mainnet' },
} as const);
export type NearNetwork = keyof typeof NEAR_NETWORKS;

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Validate an RPC endpoint (see the module comment). */
export function assertRpcUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new RouteSpecError('RS_CLI_USAGE', 'The RPC endpoint is not a URL.');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    throw new RouteSpecError(
      'RS_CLI_USAGE',
      'The RPC endpoint must use https (http is accepted for a loopback sandbox only).',
    );
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new RouteSpecError('RS_CLI_USAGE', 'The RPC endpoint must not carry credentials or a fragment.');
  }
  return url;
}

// ---------------------------------------------------------------------------------------------
// Borsh
// ---------------------------------------------------------------------------------------------

class BorshWriter {
  private readonly parts: Buffer[] = [];
  u8(v: number): this {
    this.parts.push(Buffer.from([v & 0xff]));
    return this;
  }
  u32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    this.parts.push(b);
    return this;
  }
  u64(v: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    this.parts.push(b);
    return this;
  }
  u128(v: bigint): this {
    const b = Buffer.alloc(16);
    b.writeBigUInt64LE(v & 0xffff_ffff_ffff_ffffn, 0);
    b.writeBigUInt64LE(v >> 64n, 8);
    this.parts.push(b);
    return this;
  }
  fixed(bytes: Uint8Array): this {
    this.parts.push(Buffer.from(bytes));
    return this;
  }
  bytes(bytes: Uint8Array): this {
    return this.u32(bytes.length).fixed(bytes);
  }
  string(text: string): this {
    return this.bytes(Buffer.from(text, 'utf8'));
  }
  end(): Buffer {
    return Buffer.concat(this.parts);
  }
}

export type NearAction =
  | { readonly type: 'CreateAccount' }
  | { readonly type: 'DeployContract'; readonly code: Uint8Array }
  | {
      readonly type: 'FunctionCall';
      readonly methodName: string;
      readonly args: Uint8Array;
      readonly gas: bigint;
      readonly deposit: bigint;
    }
  | { readonly type: 'Transfer'; readonly deposit: bigint }
  | { readonly type: 'AddFullAccessKey'; readonly publicKey: Uint8Array };

export interface NearTransaction {
  readonly signerId: string;
  /** 32-byte Ed25519 public key of the signer's access key. */
  readonly publicKey: Uint8Array;
  readonly nonce: bigint;
  readonly receiverId: string;
  /** 32 bytes. */
  readonly blockHash: Uint8Array;
  readonly actions: readonly NearAction[];
}

function writeAction(w: BorshWriter, action: NearAction): void {
  switch (action.type) {
    case 'CreateAccount':
      w.u8(0);
      return;
    case 'DeployContract':
      w.u8(1).bytes(action.code);
      return;
    case 'FunctionCall':
      w.u8(2).string(action.methodName).bytes(action.args).u64(action.gas).u128(action.deposit);
      return;
    case 'Transfer':
      w.u8(3).u128(action.deposit);
      return;
    case 'AddFullAccessKey':
      // AddKey { public_key, access_key { nonce: 0, permission: FullAccess } }
      w.u8(5).u8(0).fixed(action.publicKey).u64(0n).u8(1);
      return;
  }
}

/** Borsh bytes of an unsigned transaction. */
export function encodeTransaction(tx: NearTransaction): Buffer {
  if (tx.publicKey.length !== 32 || tx.blockHash.length !== 32) {
    throw new RouteSpecError('RS_INTERNAL', 'Transaction key and block hash must be 32 bytes.');
  }
  const w = new BorshWriter()
    .string(tx.signerId)
    .u8(0)
    .fixed(tx.publicKey)
    .u64(tx.nonce)
    .string(tx.receiverId)
    .fixed(tx.blockHash)
    .u32(tx.actions.length);
  for (const action of tx.actions) writeAction(w, action);
  return w.end();
}

export interface SignedNearTransaction {
  /** Base58 transaction hash. */
  readonly hash: string;
  /** Borsh bytes of the signed transaction. */
  readonly bytes: Buffer;
}

export function signTransaction(tx: NearTransaction, signer: Ed25519Signer): SignedNearTransaction {
  const encoded = encodeTransaction(tx);
  const hash = createHash('sha256').update(encoded).digest();
  const signature = signer.sign(hash);
  return {
    hash: base58Encode(hash),
    bytes: Buffer.concat([encoded, Buffer.from([0]), signature]),
  };
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------------------------

export type NearFinality = 'final' | 'optimistic';

export interface NearRpcOptions {
  readonly timeoutMs?: number;
  readonly finality?: NearFinality;
  /** How long `sendActions` waits: `FINAL` (default) or `EXECUTED_OPTIMISTIC`. */
  readonly waitUntil?: 'FINAL' | 'EXECUTED_OPTIMISTIC';
  readonly fetch?: typeof fetch;
}

export interface NearTransactionOutcome {
  readonly transactionHash: string;
  /** Decoded return value of the last action, when the transaction succeeded with one. */
  readonly returnValue: unknown;
  readonly logs: readonly string[];
  readonly finalExecutionStatus: string;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The registry's stable refusal code inside any error text, if there is one. */
export function contractRefusalCode(value: unknown): string | null {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return /RSREG_[A-Z0-9_]+(?::[a-z_]+)?/.exec(text)?.[0] ?? null;
}

function unavailable(message: string, details: Record<string, string> = {}): never {
  throw new RouteSpecError('RS_REGISTRY_UNAVAILABLE', message, { recoverable: true, details });
}

function rejected(source: unknown, fallback: string): never {
  const code = contractRefusalCode(source);
  const text = typeof source === 'string' ? source : JSON.stringify(source ?? '');
  const kind =
    code ??
    /"(MethodNotFound|CodeDoesNotExist|AccountDoesNotExist|InvalidNonce|InvalidAccessKeyError|NotEnoughBalance|InvalidSignature|Expired|CompilationError|LackBalanceForState)"/.exec(
      text,
    )?.[1] ??
    /\b(UNKNOWN_ACCOUNT|NO_CONTRACT_CODE|UNKNOWN_ACCESS_KEY|INVALID_TRANSACTION|CONTRACT_EXECUTION_ERROR)\b/.exec(
      text,
    )?.[1] ??
    fallback;
  throw new RouteSpecError('RS_REGISTRY_REJECTED', 'The registry refused the request.', {
    details: { reason: kind.slice(0, 80) },
  });
}

export class NearRpc {
  readonly url: URL;
  readonly finality: NearFinality;
  private readonly waitUntil: 'FINAL' | 'EXECUTED_OPTIMISTIC';
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;

  constructor(url: string, options: NearRpcOptions = {}) {
    this.url = assertRpcUrl(url);
    this.finality = options.finality ?? 'final';
    this.waitUntil = options.waitUntil ?? 'FINAL';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** One JSON-RPC call. Returns `{ result }` or `{ error }` exactly as the node answered. */
  async request(method: string, params: unknown): Promise<{ result?: unknown; error?: unknown }> {
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const length = Number(response.headers.get('content-length') ?? '0');
      if (length > MAX_RESPONSE_BYTES) unavailable('The RPC response exceeds the size limit.');
      text = await boundedText(response);
    } catch (error) {
      if (error instanceof RouteSpecError) throw error;
      unavailable('The NEAR RPC endpoint could not be reached.', {
        host: this.url.host,
        cause: error instanceof Error ? error.name.slice(0, 40) : 'unknown',
      });
    }
    if (text.length > MAX_RESPONSE_BYTES) unavailable('The RPC response exceeds the size limit.');
    let body: Record<string, unknown> | null;
    try {
      body = obj(JSON.parse(text));
    } catch {
      body = null;
    }
    if (body === null || (!('result' in body) && !('error' in body))) {
      unavailable('The NEAR RPC endpoint answered with something that is not JSON-RPC.', {
        host: this.url.host,
        status: String(response.status),
      });
    }
    return body;
  }

  async chainId(): Promise<string> {
    const { result, error } = await this.request('status', []);
    const id = obj(result)?.['chain_id'];
    if (error !== undefined || typeof id !== 'string') unavailable('The node did not report its chain id.');
    return id;
  }

  /** Call a view method and return its JSON result with the block it was read at. */
  async view(
    accountId: string,
    methodName: string,
    args: Record<string, unknown>,
  ): Promise<{ value: unknown; blockHeight: number; blockHash: string }> {
    const { result, error } = await this.request('query', {
      request_type: 'call_function',
      finality: this.finality,
      account_id: accountId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args), 'utf8').toString('base64'),
    });
    if (error !== undefined) rejected(error, 'VIEW_FAILED');
    const r = obj(result);
    if (r === null) unavailable('The view call returned no result.');
    if (typeof r['error'] === 'string') rejected(r['error'], 'VIEW_FAILED');
    const bytes = r['result'];
    if (!Array.isArray(bytes) || typeof r['block_height'] !== 'number') {
      unavailable('The view call returned an unexpected shape.');
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(bytes as number[]).toString('utf8'));
    } catch {
      unavailable('The view call did not return JSON.');
    }
    return { value, blockHeight: r['block_height'], blockHash: String(r['block_hash'] ?? '') };
  }

  /** The code hash (base58 of the SHA-256 of the deployed wasm) of an account. */
  async codeHash(accountId: string): Promise<string> {
    const { result, error } = await this.request('query', {
      request_type: 'view_account',
      finality: this.finality,
      account_id: accountId,
    });
    if (error !== undefined) rejected(error, 'UNKNOWN_ACCOUNT');
    const hash = obj(result)?.['code_hash'];
    if (typeof hash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash)) {
      unavailable('The account query returned an unexpected shape.');
    }
    return hash;
  }

  /** The current nonce of an access key and a recent block hash to anchor a transaction. */
  async accessKey(
    accountId: string,
    publicKey: Uint8Array,
  ): Promise<{ nonce: bigint; blockHash: Uint8Array }> {
    const { result, error } = await this.request('query', {
      request_type: 'view_access_key',
      finality: 'final',
      account_id: accountId,
      public_key: publicKeyText(publicKey),
    });
    if (error !== undefined) rejected(error, 'UNKNOWN_ACCESS_KEY');
    const r = obj(result);
    if (r === null) unavailable('The access-key query returned no result.');
    if (typeof r['error'] === 'string') rejected(r['error'], 'UNKNOWN_ACCESS_KEY');
    const nonce = r['nonce'];
    const hash = r['block_hash'];
    if ((typeof nonce !== 'number' && typeof nonce !== 'string') || typeof hash !== 'string') {
      unavailable('The access-key query returned an unexpected shape.');
    }
    return { nonce: BigInt(nonce), blockHash: base58Decode(hash) };
  }

  /** Sign and send one transaction and wait for its outcome (until final by default). */
  async sendActions(input: {
    readonly signerId: string;
    readonly signer: Ed25519Signer;
    readonly receiverId: string;
    readonly actions: readonly NearAction[];
  }): Promise<NearTransactionOutcome> {
    const key = await this.accessKey(input.signerId, input.signer.publicKey);
    const signed = signTransaction(
      {
        signerId: input.signerId,
        publicKey: input.signer.publicKey,
        nonce: key.nonce + 1n,
        receiverId: input.receiverId,
        blockHash: key.blockHash,
        actions: input.actions,
      },
      input.signer,
    );
    let answer = await this.request('send_tx', {
      signed_tx_base64: signed.bytes.toString('base64'),
      wait_until: this.waitUntil,
    });
    // The node gives up waiting after a few seconds; the transaction may still complete.
    for (let attempt = 0; attempt < 20 && isTimeout(answer.error); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      answer = await this.request('tx', {
        tx_hash: signed.hash,
        sender_account_id: input.signerId,
        wait_until: this.waitUntil,
      });
    }
    if (isTimeout(answer.error)) {
      unavailable('The transaction was sent but its outcome is not known yet.', {
        transactionHash: signed.hash,
      });
    }
    if (answer.error !== undefined) rejected(answer.error, 'INVALID_TRANSACTION');
    const r = obj(answer.result);
    const status = obj(r?.['status']);
    if (r === null || status === null) unavailable('The transaction outcome has an unexpected shape.');
    if ('Failure' in status) rejected(status['Failure'], 'TRANSACTION_FAILED');
    const logs: string[] = [];
    for (const receipt of Array.isArray(r['receipts_outcome']) ? r['receipts_outcome'] : []) {
      const outcome = obj(obj(receipt)?.['outcome']);
      const failure = obj(outcome?.['status'])?.['Failure'];
      if (failure !== undefined) rejected(failure, 'RECEIPT_FAILED');
      for (const line of Array.isArray(outcome?.['logs']) ? (outcome['logs'] as unknown[]) : []) {
        if (typeof line === 'string') logs.push(line);
      }
    }
    let returnValue: unknown = null;
    const success = status['SuccessValue'];
    if (typeof success === 'string' && success !== '') {
      try {
        returnValue = JSON.parse(Buffer.from(success, 'base64').toString('utf8'));
      } catch {
        returnValue = null;
      }
    }
    return {
      transactionHash: signed.hash,
      returnValue,
      logs,
      finalExecutionStatus: String(r['final_execution_status'] ?? ''),
    };
  }
}

/** Read a response body as text, giving up as soon as it exceeds the size limit. */
async function boundedText(response: Response): Promise<string> {
  if (response.body === null) return '';
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > MAX_RESPONSE_BYTES) unavailable('The RPC response exceeds the size limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isTimeout(error: unknown): boolean {
  if (error === undefined) return false;
  return /TIMEOUT_ERROR|"Timeout"|timed? ?out/i.test(JSON.stringify(error));
}

/** Arguments of a contract call as the UTF-8 JSON bytes NEAR expects. */
export function jsonArgs(args: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(args), 'utf8'));
}
