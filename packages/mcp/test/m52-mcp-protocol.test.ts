/**
 * M52 — the MCP stdio transport of `routespec mcp`, exercised as a separate process through the
 * real CLI entry: lifecycle, tool listing, JSON-RPC error handling, and stdout discipline.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { McpTestClient } from './support/mcp-client.ts';

const TOOLS = ['run_gate', 'list_findings', 'explain_invariant', 'show_fix_pattern', 'verify_certificate'];

let client: McpTestClient | null = null;
afterEach(async () => {
  await client?.close();
  client = null;
});

describe('routespec mcp: protocol', () => {
  it('initializes with the requested protocol version and lists exactly the five tools', async () => {
    client = McpTestClient.start();
    const init = await client.initialize('2025-06-18');
    expect(init['result']).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'routespec' },
    });
    expect(String((init['result'] as Record<string, unknown>)['instructions'])).toMatch(/run_gate/);
    const list = await client.request('tools/list');
    const tools = (list['result'] as { tools: Array<{ name: string; inputSchema: { type: string } }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(TOOLS);
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
    expect((await client.request('ping'))['result']).toEqual({});
  });

  it('answers an unsupported protocol version with its newest supported one', async () => {
    client = McpTestClient.start();
    const init = await client.initialize('1999-01-01');
    expect((init['result'] as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');
    const old = McpTestClient.start();
    try {
      const r = await old.initialize('2024-11-05');
      expect((r['result'] as { protocolVersion: string }).protocolVersion).toBe('2024-11-05');
    } finally {
      await old.close();
    }
  });

  it('returns JSON-RPC errors for bad input and never answers a notification', async () => {
    client = McpTestClient.start();
    await client.initialize();
    const parse = client.response(null);
    client.raw('{not json\n');
    expect(((await parse)['error'] as { code: number }).code).toBe(-32700);
    expect(((await client.request('resources/list'))['error'] as { code: number }).code).toBe(-32601);
    const unknownTool = await client.request('tools/call', { name: 'rm_rf', arguments: {} });
    expect((unknownTool['error'] as { code: number }).code).toBe(-32602);
    const badArgs = await client.request('tools/call', { name: 'explain_invariant', arguments: [1] });
    expect((badArgs['error'] as { code: number }).code).toBe(-32602);
    const invalid = client.response(7);
    client.raw(`${JSON.stringify({ jsonrpc: '1.0', id: 7, method: 'ping' })}\n`);
    expect(((await invalid)['error'] as { code: number }).code).toBe(-32600);

    const before = client.lines.length;
    client.notify('notifications/cancelled', { requestId: 99 });
    await client.request('ping');
    // Only the ping answer was written: the notification got no reply.
    expect(client.lines.length).toBe(before + 1);
  });

  it('reports tool input errors as tool results, not protocol errors', async () => {
    client = McpTestClient.start();
    await client.initialize();
    const unknownInvariant = await client.call('explain_invariant', { invariant: 'INV-42' });
    expect(unknownInvariant.isError).toBe(true);
    expect(unknownInvariant.structuredContent).toMatchObject({ error: { code: 'UNKNOWN_INVARIANT' } });
    const extra = await client.call('show_fix_pattern', { pattern: 'reconcile-through-status', shell: 'x' });
    expect(extra.structuredContent).toMatchObject({ error: { code: 'INPUT_INVALID' } });
    const noRun = await client.call('list_findings');
    expect(noRun.structuredContent).toMatchObject({ error: { code: 'NO_RUN' } });
  });

  it('writes only JSON-RPC lines on stdout and exits when stdin closes', async () => {
    client = McpTestClient.start();
    await client.initialize();
    await client.call('show_fix_pattern');
    await client.call('explain_invariant', { invariant: 'INV-03' });
    const c = client;
    client = null;
    expect(await c.close()).toBe(0);
    expect(c.lines.length).toBeGreaterThanOrEqual(3);
    for (const line of c.lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
  });

  it('refuses an unknown option', async () => {
    const c = McpTestClient.start(['--listen', '0.0.0.0']);
    expect(await c.close()).toBe(4);
    expect(c.lines).toEqual([]);
    expect(c.stderr).toMatch(/unknown or incomplete option/);
  });
});
