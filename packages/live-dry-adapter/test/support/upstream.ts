/**
 * SIMULATED upstream: a loopback HTTPS server presenting a certificate for the pinned host name
 * (signed by the run-time test CA). It stands in for the official endpoint so the adapter's real
 * TLS, header, body, redirect and bound handling can be exercised without leaving the machine.
 * It is not the provider and its answers are not provider evidence.
 */
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import type { TestCert } from './certs.ts';

export type UpstreamMode =
  | 'quote'
  | 'quote-with-unknown-field'
  | 'redirect'
  | 'oversize'
  | 'slow'
  | 'gzip'
  | 'http401'
  | 'text';

export interface ReceivedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawHeaderNames: readonly string[];
  readonly body: string;
}

export interface Upstream {
  readonly port: number;
  readonly received: ReceivedRequest[];
  tlsConnections: number;
  mode: UpstreamMode;
  /** When set, `GET /v0/tokens` answers with this value (SIMULATED token list). */
  tokens: unknown;
  /** Quotes whose origin or destination asset is listed here get a 400 (SIMULATED refusal). */
  refuseAssets: readonly string[];
  close(): Promise<void>;
}

export function dryQuoteResponse(request: Record<string, unknown>) {
  return {
    correlationId: 'corr-sim-0001',
    timestamp: '2026-11-11T12:00:00.000Z',
    signature: 'ed25519:SIMULATEDSIGNATURE',
    quoteRequest: request,
    quote: {
      amountIn: String(request['amount']),
      amountInFormatted: '1.0',
      amountInUsd: '1.00',
      minAmountIn: String(request['amount']),
      amountOut: '987654',
      amountOutFormatted: '0.987654',
      amountOutUsd: '0.98',
      minAmountOut: '980000',
      timeEstimate: 30,
    },
  };
}

export async function startUpstream(cert: TestCert, mode: UpstreamMode = 'quote'): Promise<Upstream> {
  const received: ReceivedRequest[] = [];
  const state: {
    mode: UpstreamMode;
    tlsConnections: number;
    tokens: unknown;
    refuseAssets: readonly string[];
  } = { mode, tlsConnections: 0, tokens: undefined, refuseAssets: [] };
  const server: Server = createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const names: string[] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) names.push(req.rawHeaders[i]!.toLowerCase());
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        rawHeaderNames: names,
        body,
      });
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      if (req.method === 'GET' && req.url === '/v0/tokens' && state.tokens !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(state.tokens));
        return;
      }
      if (
        state.refuseAssets.includes(String(parsed['originAsset'])) ||
        state.refuseAssets.includes(String(parsed['destinationAsset']))
      ) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'No liquidity available', path: '/v0/quote' }));
        return;
      }
      switch (state.mode) {
        case 'quote': {
          const text = JSON.stringify(dryQuoteResponse(parsed));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(text);
          return;
        }
        case 'quote-with-unknown-field': {
          const r = dryQuoteResponse(parsed) as Record<string, unknown>;
          r['settlementInstructions'] = { route: 'sim' };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r));
          return;
        }
        case 'redirect':
          res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
          res.end();
          return;
        case 'oversize': {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ pad: 'x'.repeat(300 * 1024) }));
          return;
        }
        case 'slow':
          setTimeout(() => {
            if (!res.destroyed) {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end('{}');
            }
          }, 2_000);
          return;
        case 'gzip': {
          res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
          res.end(gzipSync(Buffer.from(JSON.stringify(dryQuoteResponse(parsed)))));
          return;
        }
        case 'http401':
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'simulated unauthorized' }));
          return;
        case 'text':
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html>simulated</html>');
          return;
      }
    });
  });
  server.on('secureConnection', () => state.tlsConnections++);
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    received,
    get tlsConnections() {
      return state.tlsConnections;
    },
    set tlsConnections(v: number) {
      state.tlsConnections = v;
    },
    get mode() {
      return state.mode;
    },
    set mode(m: UpstreamMode) {
      state.mode = m;
    },
    get tokens() {
      return state.tokens;
    },
    set tokens(t: unknown) {
      state.tokens = t;
    },
    get refuseAssets() {
      return state.refuseAssets;
    },
    set refuseAssets(a: readonly string[]) {
      state.refuseAssets = a;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
