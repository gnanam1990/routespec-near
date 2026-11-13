/**
 * M52 — the MCP `verify_certificate` tool against the routespec-registry contract on a real
 * local NEAR node (near-sandbox, started by the registry suite's global setup).
 *
 * A real gate run is exported to a real PASS bundle. Before any certificate exists the tool
 * reports REVIEW; after the attester is enrolled by the owner and the CLI submits the signed
 * certificate, the tool, through the MCP stdio server, reports PASS for exactly that bundle and
 * still REVIEW for any other digest. Without a container engine every test reports
 * `NOT_RUN: <reason>`. Nothing here contacts NEAR testnet or mainnet.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it, type TestContext } from 'vitest';
import {
  base58Encode,
  generateSigner,
  NearRpc,
  publicKeyText,
  RegistryClient,
  type Ed25519Signer,
} from '@routespec/registry';
import { createAccount, deployRegistry, sandboxRoot, type SandboxAccount } from '@routespec/registry/sandbox';
import { makeBundle, type CertifiableBundle } from '../../cli/test/support/certificate-bundle.ts';
import { runCliProcess, tempDir } from '../../cli/test/support/product.ts';
import { McpTestClient } from '../test/support/mcp-client.ts';

const sandbox = inject('registrySandbox');
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const PROJECT = 'gnanam1990/routespec-near';

let tmp: ReturnType<typeof tempDir>;
let root: string;
let pass: CertifiableBundle;
let registryAccount: SandboxAccount;
let owner: SandboxAccount;
let payer: SandboxAccount;
let registry: RegistryClient;
let attesterKey = '';
let client: McpTestClient;

function need(ctx: TestContext): void {
  if (!sandbox.available) ctx.skip(`NOT_RUN: ${sandbox.reason}`);
}

function nearSecret(signer: Ed25519Signer): string {
  return `ed25519:${base58Encode(Buffer.concat([signer.seed, signer.publicKey]))}`;
}

function verifyArgs(subject: Record<string, unknown>): Record<string, unknown> {
  return { registry: registryAccount.accountId, rpc: (sandbox as { rpcUrl: string }).rpcUrl, ...subject };
}

beforeAll(async () => {
  if (!sandbox.available) return;
  tmp = tempDir('routespec-m52-sandbox-');
  pass = await makeBundle(join(tmp.dir, 'data'), { scenarios: ['happy-path'], label: 'm52pass' });
  expect(pass.decision).toBe('PASS');
  // The MCP server only reads files inside its root: give it a copy of the bundle.
  root = join(tmp.dir, 'root');
  mkdirSync(root, { recursive: true });
  copyFileSync(pass.bundlePath, join(root, 'evidence.tar'));

  const rpc = new NearRpc(sandbox.rpcUrl);
  registryAccount = { accountId: `mcp-registry-${suffix}.test.near`, signer: generateSigner() };
  owner = { accountId: `mcp-owner-${suffix}.test.near`, signer: generateSigner() };
  payer = { accountId: `mcp-payer-${suffix}.test.near`, signer: generateSigner() };
  for (const a of [registryAccount, owner, payer]) await createAccount(rpc, sandboxRoot(sandbox), a);
  await deployRegistry(rpc, registryAccount, new Uint8Array(readFileSync(sandbox.wasmPath)), owner.accountId);
  registry = new RegistryClient(rpc, registryAccount.accountId);
  client = McpTestClient.start(['--root', root]);
  await client.initialize();
});

afterAll(async () => {
  await client?.close();
  tmp?.cleanup();
});

describe('verify_certificate on a local NEAR node', () => {
  it('reports REVIEW while no certificate exists, and PASS under the advisory policy', async (ctx) => {
    need(ctx);
    const r = await client.call('verify_certificate', verifyArgs({ bundle: 'evidence.tar' }));
    expect(r.isError, r.text).toBe(false);
    expect(r.structuredContent).toMatchObject({
      bundleDigest: pass.bundleDigest,
      exitCode: 3,
      release: {
        decision: 'REVIEW',
        localDecision: 'PASS',
        findings: ['CERTIFICATE_NOT_FOUND', 'ONCHAIN_ATTESTATION_REQUIRED'],
      },
    });
    const advisory = await client.call(
      'verify_certificate',
      verifyArgs({ bundle: 'evidence.tar', policy: 'advisory' }),
    );
    expect(advisory.structuredContent).toMatchObject({ exitCode: 0, release: { decision: 'PASS' } });
  });

  it('reports PASS for the bundle once an enrolled attester certified it, and REVIEW for another digest', async (ctx) => {
    need(ctx);
    const keyFile = join(tmp.dir, 'attester.pem');
    const made = await runCliProcess(['certificate', 'keygen', '--out', keyFile]);
    expect(made.exitCode, made.stderr).toBe(0);
    attesterKey = String(made.json?.['publicKey']);
    await registry.enrolAttester(attesterKey, 'release attester', owner);
    const payerKeyFile = join(tmp.dir, 'payer.json');
    writeFileSync(
      payerKeyFile,
      JSON.stringify({
        account_id: payer.accountId,
        public_key: publicKeyText(payer.signer.publicKey),
        private_key: nearSecret(payer.signer),
      }),
    );
    const published = await runCliProcess([
      'certificate',
      'publish',
      '--data',
      pass.dataDir,
      '--bundle',
      pass.bundlePath,
      '--project-key',
      PROJECT,
      '--registry',
      registryAccount.accountId,
      '--rpc',
      (sandbox as { rpcUrl: string }).rpcUrl,
      '--attester-key',
      keyFile,
      '--near-account',
      payer.accountId,
      '--near-key',
      payerKeyFile,
      '--submit',
    ]);
    expect(published.exitCode, published.stderr).toBe(0);

    const byBundle = await client.call('verify_certificate', verifyArgs({ bundle: 'evidence.tar' }));
    expect(byBundle.structuredContent).toMatchObject({
      exitCode: 0,
      release: { decision: 'PASS', localDecision: 'PASS', acceptedCertificateIds: [0] },
    });
    expect(byBundle.text).toMatch(/^Release PASS for sha256:/);
    const byDigest = await client.call('verify_certificate', verifyArgs({ digest: pass.bundleDigest }));
    expect(byDigest.structuredContent).toMatchObject({ exitCode: 0, release: { decision: 'PASS' } });
    const other = await client.call(
      'verify_certificate',
      verifyArgs({ digest: `sha256:${'cd'.repeat(32)}` }),
    );
    expect(other.structuredContent).toMatchObject({ release: { decision: 'REVIEW' } });
    // The tool never prints a key it was not given and never signs: no secret appears.
    expect(client.lines.join('\n')).not.toContain(nearSecret(payer.signer).slice(8));
  });
});
