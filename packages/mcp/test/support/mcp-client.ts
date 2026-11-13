/**
 * Test support (M52): a minimal MCP stdio client. It starts `routespec mcp` as a separate
 * process through the real CLI entry and exchanges newline-delimited JSON-RPC messages with it,
 * the way a coding agent's MCP client does.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const CLI_BIN = fileURLToPath(new URL('../../../cli/bin/routespec.mjs', import.meta.url));

type J = Record<string, unknown>;

export class McpTestClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: string[] = [];
  stderr = '';
  private buffer = '';
  private nextId = 1;
  private readonly waiting = new Map<unknown, (msg: J) => void>();
  private readonly exited: Promise<number | null>;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.on('data', (c: Buffer) => {
      this.buffer += c.toString('utf8');
      let i: number;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        this.lines.push(line);
        const msg = JSON.parse(line) as J;
        const w = this.waiting.get(msg['id']);
        if (w !== undefined) {
          this.waiting.delete(msg['id']);
          w(msg);
        }
      }
    });
    child.stderr.on('data', (c: Buffer) => (this.stderr += c.toString('utf8')));
    this.exited = new Promise((r) => child.on('close', (code) => r(code)));
  }

  static start(
    args: readonly string[] = ['--root', REPO_ROOT],
    env: NodeJS.ProcessEnv = process.env,
  ): McpTestClient {
    const child = spawn(process.execPath, ['--no-warnings', CLI_BIN, 'mcp', ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new McpTestClient(child);
  }

  /** Send raw text (one or more lines). */
  raw(text: string): void {
    this.child.stdin.write(text);
  }

  /** Wait for the response with this id. */
  response(id: unknown): Promise<J> {
    return new Promise((resolve) => this.waiting.set(id, resolve));
  }

  async request(method: string, params?: unknown): Promise<J> {
    const id = this.nextId++;
    const p = this.response(id);
    this.raw(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`,
    );
    return p;
  }

  notify(method: string, params?: unknown): void {
    this.raw(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  async initialize(protocolVersion = '2025-06-18'): Promise<J> {
    const r = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'routespec-test-client', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return r;
  }

  /** tools/call; returns the tool result (content, structuredContent, isError). */
  async call(name: string, args: J = {}): Promise<{ structuredContent: J; isError: boolean; text: string }> {
    const r = await this.request('tools/call', { name, arguments: args });
    const result = r['result'] as {
      structuredContent: J;
      isError: boolean;
      content: Array<{ text: string }>;
    };
    if (result === undefined) throw new Error(`tools/call ${name} failed: ${JSON.stringify(r['error'])}`);
    return {
      structuredContent: result.structuredContent,
      isError: result.isError,
      text: result.content[0]?.text ?? '',
    };
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    return this.exited;
  }
}
