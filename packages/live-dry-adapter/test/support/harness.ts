/** Shared helpers for the M07 tests. */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchLiveDryAdapter, sanitizedAdapterEnv, type LaunchedAdapter } from '../../src/index.ts';
import type { AdapterReport } from '../../src/server.ts';

export const TEST_ENTRY = fileURLToPath(new URL('./adapter-child.ts', import.meta.url));
export const PINNED_HOST = '1click.chaindefuser.com';

export interface ChildReport extends AdapterReport {
  readonly tripwire: { total: number; dnsLookups: number; socketConnects: number; clientSockets: number };
  readonly transportSeen: {
    resolveCalls: number;
    connectCalls: number;
    connectTargets: string[];
    resolvedHosts: string[];
  };
}

/** A JWT-shaped canary built at run time (no token literal lives in the repository). */
export function canaryJwt(expSecondsFromNow: number | null, marker = 'm07canary'): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const payload: Record<string, unknown> = { sub: marker, nonce: `${marker}-${process.pid}-${Date.now()}` };
  if (expSecondsFromNow !== null) payload['exp'] = Math.floor(Date.now() / 1000) + expSecondsFromNow;
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.${Buffer.from(`sig-${marker}-${Date.now()}`).toString('base64url')}`;
}

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'routespec-m07-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function launchTestAdapter(input: {
  test: unknown;
  jwt?: string;
  credentialPolicy?: 'NONE' | 'OPTIONAL';
  maxProbes?: number;
  ledgerPath?: string | null;
  extraEnv?: Record<string, string>;
  limits?: Record<string, number>;
}): Promise<LaunchedAdapter> {
  const env = sanitizedAdapterEnv(process.env, { passProviderJwt: false });
  if (input.jwt !== undefined) env['ROUTESPEC_PROVIDER_JWT'] = input.jwt;
  Object.assign(env, input.extraEnv ?? {});
  return launchLiveDryAdapter({
    entry: TEST_ENTRY,
    env,
    credentialPolicy: input.credentialPolicy ?? 'OPTIONAL',
    maxProbes: input.maxProbes ?? 1,
    ledgerPath: input.ledgerPath ?? null,
    limits: input.limits ?? {},
    test: input.test,
  });
}

export interface RawResponse {
  readonly status: number;
  readonly body: string;
  readonly json: Record<string, unknown> | null;
}

/** Raw HTTP to the adapter (for requests the SDK cannot express). */
export function raw(
  adapter: LaunchedAdapter,
  input: {
    method: string;
    path: string;
    body?: string | Buffer;
    headers?: Record<string, string>;
    token?: string | null;
  },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(input.token === null ? {} : { 'x-routespec-probe-token': input.token ?? adapter.probeToken }),
      ...(input.headers ?? {}),
    };
    const req = request(
      { host: '127.0.0.1', port: adapter.port, method: input.method, path: input.path, headers },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString('utf8')));
        res.on('end', () => {
          let json: Record<string, unknown> | null = null;
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, body: text, json });
        });
      },
    );
    req.on('error', reject);
    req.end(input.body);
  });
}

export function quoteRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: 'nep141:origin-m07.test',
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: 'nep141:destination-m07.test',
    amount: '1000000',
    refundTo: 'refund-m07-canary.test',
    refundType: 'ORIGIN_CHAIN',
    recipient: 'recipient-m07-canary.test',
    recipientType: 'DESTINATION_CHAIN',
    deadline: '2026-11-11T12:00:00Z',
    ...overrides,
  };
}

/** Every file in `dir` (database, WAL, SHM) as one string, for canary scans. */
export function readAllBytes(dir: string): string {
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f)).toString('latin1'))
    .join('\n');
}
