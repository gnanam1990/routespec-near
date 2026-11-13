/**
 * Model Context Protocol server over stdio (M52, ADR-0031).
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout, as the MCP stdio transport
 * defines it. stdout carries protocol messages only; diagnostics go to stderr. Implemented
 * methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
 * Anything else is `-32601`. There is no network listener.
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { RouteSpecTools, TOOL_DEFINITIONS, type ServerOptions } from './tools.ts';

export const SERVER_NAME = 'routespec';
export const SERVER_VERSION = '0.1.0';
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
const MAX_LINE_BYTES = 1_000_000;

export const SERVER_INSTRUCTIONS =
  'RouteSpec checks NEAR Intents 1Click client code before it ships. Call run_gate on the client module; on FAIL or REVIEW call list_findings, apply the fix patterns it names (show_fix_pattern has the code), and run the gate again until it is PASS. Gate runs are local and networkless.';

type Id = string | number | null;
type J = Record<string, unknown>;

export interface McpServerHandle {
  /** Resolves when the input ends and every in-flight call has answered. */
  readonly closed: Promise<void>;
}

function isId(v: unknown): v is Id {
  return v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

export function serveMcp(input: Readable, output: Writable, options: ServerOptions): McpServerHandle {
  const tools = new RouteSpecTools(options);
  const log = options.log ?? (() => undefined);
  let initialized = false;
  const inflight = new Set<Promise<void>>();

  const send = (msg: J) => {
    output.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  };
  const error = (id: Id, code: number, message: string) => send({ id, error: { code, message } });

  const handle = async (msg: J): Promise<void> => {
    const method = msg['method'];
    const hasId = 'id' in msg;
    const id = (msg['id'] ?? null) as Id;
    if (msg['jsonrpc'] !== '2.0' || typeof method !== 'string' || (hasId && !isId(msg['id']))) {
      if (hasId || method === undefined) error(isId(msg['id']) ? id : null, -32600, 'Invalid Request');
      return;
    }
    if (!hasId) {
      // Notifications get no answer.
      if (method === 'notifications/initialized') initialized = true;
      return;
    }
    const params = (msg['params'] ?? {}) as J;
    switch (method) {
      case 'initialize': {
        const asked =
          typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '';
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
          ? asked
          : (SUPPORTED_PROTOCOL_VERSIONS[0] as string);
        send({
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, title: 'RouteSpec', version: SERVER_VERSION },
            instructions: SERVER_INSTRUCTIONS,
          },
        });
        return;
      }
      case 'ping':
        send({ id, result: {} });
        return;
      case 'tools/list':
        send({ id, result: { tools: TOOL_DEFINITIONS } });
        return;
      case 'tools/call': {
        const name = params['name'];
        if (typeof name !== 'string' || !TOOL_DEFINITIONS.some((t) => t.name === name)) {
          error(id, -32602, `Unknown tool: ${String(name).slice(0, 64)}`);
          return;
        }
        const args = params['arguments'] ?? {};
        if (typeof args !== 'object' || args === null || Array.isArray(args)) {
          error(id, -32602, 'Tool arguments must be an object.');
          return;
        }
        if (!initialized) log('routespec-mcp: tools/call before notifications/initialized');
        send({ id, result: await tools.call(name, args) });
        return;
      }
      default:
        error(id, -32601, `Method not found: ${method.slice(0, 64)}`);
    }
  };

  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.trim() === '') return;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      error(null, -32600, 'Message too large');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      error(null, -32700, 'Parse error');
      return;
    }
    const batch = Array.isArray(parsed) ? parsed : [parsed];
    if (batch.length === 0) {
      error(null, -32600, 'Invalid Request');
      return;
    }
    for (const m of batch) {
      if (m === null || typeof m !== 'object' || Array.isArray(m)) {
        error(null, -32600, 'Invalid Request');
        continue;
      }
      const p = handle(m as J).catch((e: unknown) => {
        log(`routespec-mcp: internal error: ${(e as Error).name}`);
        const mid = (m as J)['id'];
        if (isId(mid) && mid !== null) error(mid, -32603, 'Internal error');
      });
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    }
  });
  const closed = new Promise<void>((resolve) => {
    rl.on('close', () => {
      void Promise.all([...inflight]).then(() => resolve());
    });
  });
  return { closed };
}
