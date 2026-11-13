/**
 * M52 — verify_certificate input handling. The tool runs `routespec certificate verify`
 * (read-only RPC views). Here only local refusals and an unreachable local endpoint are
 * exercised; the chain path runs against a real local NEAR node in
 * `sandbox-test/m52-verify-certificate.sandbox.test.ts`. Nothing here contacts testnet or
 * mainnet.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RouteSpecTools } from '../src/tools.ts';

const DIGEST = `sha256:${'ab'.repeat(32)}`;
let root: string;
let outside: string;
let tools: RouteSpecTools;
const logged: string[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'routespec-m52-cert-'));
  outside = mkdtempSync(join(tmpdir(), 'routespec-m52-cert-out-'));
  writeFileSync(join(outside, 'bundle.tar'), 'x');
  writeFileSync(join(root, 'not-a-bundle.tar'), 'not a tar archive');
  tools = new RouteSpecTools({
    root,
    env: { ...process.env, ROUTESPEC_ATTESTER_KEY: 'must-not-be-used' },
    log: (l) => logged.push(l),
  });
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('verify_certificate', () => {
  it('refuses incomplete or conflicting chain and subject arguments before any request', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ digest: DIGEST, network: 'testnet' }, 'INPUT_MISSING'],
      [{ registry: 'reg.test.near', digest: DIGEST }, 'INPUT_INVALID'],
      [
        { registry: 'reg.test.near', digest: DIGEST, network: 'testnet', rpc: 'http://127.0.0.1:9561' },
        'INPUT_INVALID',
      ],
      [{ registry: 'reg.test.near', network: 'testnet' }, 'INPUT_INVALID'],
      [{ registry: 'reg.test.near', network: 'testnet', digest: DIGEST, bundle: 'x.tar' }, 'INPUT_INVALID'],
      [{ registry: 'reg.test.near', rpc: 'file:///etc/passwd', digest: DIGEST }, 'INPUT_INVALID'],
      [
        { registry: 'reg.test.near', network: 'testnet', bundle: join(outside, 'bundle.tar') },
        'PATH_OUTSIDE_ROOT',
      ],
      [{ registry: 'reg.test.near', network: 'testnet', attesters: 'ed25519:x' }, 'INPUT_INVALID'],
    ];
    for (const [args, code] of cases) {
      const r = await tools.call('verify_certificate', args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.structuredContent, JSON.stringify(args)).toMatchObject({ error: { code } });
    }
  });

  it('passes the CLI refusal through for a bad network name or digest', async () => {
    const net = await tools.call('verify_certificate', {
      registry: 'reg.test.near',
      network: 'devnet',
      digest: DIGEST,
    });
    expect(net.isError).toBe(true);
    expect(net.structuredContent).toMatchObject({ exitCode: 4, error: { code: 'RS_CLI_USAGE' } });
    const dig = await tools.call('verify_certificate', {
      registry: 'reg.test.near',
      rpc: 'http://127.0.0.1:9561',
      digest: 'sha256:short',
    });
    expect(dig.structuredContent).toMatchObject({ exitCode: 4 });
  });

  it('reports an unreachable endpoint as a failed check, never as a release decision', async () => {
    // Port 9561 is reserved for this suite and nothing listens on it here.
    const r = await tools.call('verify_certificate', {
      registry: 'reg.test.near',
      rpc: 'http://127.0.0.1:9561',
      digest: DIGEST,
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent['release']).toBeUndefined();
    expect(r.structuredContent['exitCode']).not.toBe(0);
    expect(r.content[0]?.text).toMatch(/did not complete/);
  });

  it('refuses a bundle that does not verify', async () => {
    const r = await tools.call('verify_certificate', {
      registry: 'reg.test.near',
      rpc: 'http://127.0.0.1:9561',
      bundle: 'not-a-bundle.tar',
    });
    expect(r.structuredContent['release']).toBeUndefined();
    expect(r.structuredContent['exitCode']).not.toBe(0);
    expect(JSON.stringify(r.structuredContent)).not.toContain('must-not-be-used');
    expect(logged.join('\n')).not.toContain('must-not-be-used');
  });
});
