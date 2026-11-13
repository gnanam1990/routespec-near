/**
 * M47 — the CI certificate step publishing to the registry contract on a real local NEAR node
 * (near-sandbox).
 *
 * The real `routespec-ci run` entry point evaluates the gate in a trusted push job (simulated
 * runner environment, real gate), then the real `routespec-ci certificate` entry point, as a
 * separate process holding the signer secrets, signs and submits the certificate of the staged
 * bundle. The chain is then read back directly and through `routespec certificate verify`.
 *
 * What is simulated: the GitHub runner (environment variables and event payload). The node, the
 * contract, the transactions, the gate run, and the bundle are real. A run on GitHub-hosted
 * runners against NEAR testnet is an owner action and is NOT_RUN here.
 *
 * Without a container engine every test reports `NOT_RUN: <reason>`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, inject, it, type TestContext } from 'vitest';
import { runCli } from '@routespec/cli';
import {
  base58Encode,
  generateSigner,
  NearRpc,
  publicKeyText,
  RegistryClient,
  type Ed25519Signer,
} from '@routespec/registry';
import { createAccount, deployRegistry, sandboxRoot, type SandboxAccount } from '@routespec/registry/sandbox';
import {
  baseConfig,
  fixture,
  githubEnv,
  headSha,
  outputs,
  runAction,
  runCi,
  writeConfig,
  type CiRun,
  type Fixture,
} from '../test/support/harness.ts';

const sandbox = inject('registrySandbox');
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const PROJECT = 'example/routespec-subject';

let f: Fixture;
let rpc: NearRpc;
let registry: RegistryClient;
let registryAccount: SandboxAccount;
let owner: SandboxAccount;
let payer: SandboxAccount;
let gateOutputs: Record<string, string>;
let bundleDigest = '';
const attester = generateSigner();
const attesterKey = publicKeyText(attester.publicKey);

function need(ctx: TestContext): void {
  if (!sandbox.available) ctx.skip(`NOT_RUN: ${sandbox.reason}`);
}

function secretText(signer: Ed25519Signer): string {
  return `ed25519:${base58Encode(Buffer.concat([signer.seed, signer.publicKey]))}`;
}

function signerEnv(): Record<string, string> {
  return {
    ROUTESPEC_ATTESTER_KEY: secretText(attester),
    ROUTESPEC_NEAR_SIGNER_ACCOUNT: payer.accountId,
    ROUTESPEC_NEAR_SIGNER_KEY: secretText(payer.signer),
  };
}

async function certificateStep(
  event: Parameters<typeof githubEnv>[1],
  extraEnv: Record<string, string>,
  decision = 'PASS',
): Promise<CiRun & { out: Record<string, string>; summary: string }> {
  const { env, files } = githubEnv(f, event, extraEnv);
  const r = await runCi(
    [
      'certificate',
      `--bundle=${gateOutputs['certificate-bundle'] as string}`,
      `--journal=${gateOutputs['certificate-journal'] as string}`,
      `--decision=${decision}`,
      `--project-key=${PROJECT}`,
      `--registry=${registryAccount.accountId}`,
      `--rpc=${(sandbox as { rpcUrl: string }).rpcUrl}`,
    ],
    env,
  );
  return { ...r, out: outputs(files.output), summary: readFileSync(files.summary, 'utf8') };
}

beforeAll(async () => {
  if (!sandbox.available) return;
  f = fixture('m47-sandbox');
  rpc = new NearRpc(sandbox.rpcUrl);
  registryAccount = { accountId: `ci-registry-${suffix}.test.near`, signer: generateSigner() };
  owner = { accountId: `ci-owner-${suffix}.test.near`, signer: generateSigner() };
  payer = { accountId: `ci-payer-${suffix}.test.near`, signer: generateSigner() };
  for (const a of [registryAccount, owner, payer]) await createAccount(rpc, sandboxRoot(sandbox), a);
  await deployRegistry(rpc, registryAccount, new Uint8Array(readFileSync(sandbox.wasmPath)), owner.accountId);
  registry = new RegistryClient(rpc, registryAccount.accountId);
  await registry.enrolAttester(attesterKey, 'ci attester', owner);

  // The gate step of a trusted push job. The signer secrets are in the job environment on
  // purpose: the gate step must withhold them.
  const config = writeConfig(
    f,
    baseConfig(f, { uploads: { include: ['gate-report-json', 'evidence-bundle'], retentionDays: 3 } }),
  );
  const { env, files } = githubEnv(f, { kind: 'push', ref: 'refs/heads/main' }, signerEnv());
  const gate = await runAction(f, config, env);
  expect(gate.exitCode, gate.stderr).toBe(0);
  expect(gate.json).toMatchObject({ decision: 'PASS', context: { trust: 'TRUSTED' } });
  gateOutputs = outputs(files.output);
  bundleDigest = `sha256:${createHash('sha256')
    .update(readFileSync(gateOutputs['certificate-bundle'] as string))
    .digest('hex')}`;
});

afterAll(() => f?.cleanup());

describe('certificate step against the registry', () => {
  it('publishes nothing from a pull-request job or for a decision that is not PASS', async (ctx) => {
    need(ctx);
    const pr = await certificateStep({ kind: 'pull_request', fork: false }, signerEnv());
    expect(pr.exitCode).toBe(0);
    expect(pr.json).toMatchObject({ status: 'SKIPPED_UNTRUSTED_CONTEXT' });
    const notPass = await certificateStep({ kind: 'push', ref: 'refs/heads/main' }, signerEnv(), 'REVIEW');
    expect(notPass.json).toMatchObject({ status: 'SKIPPED_DECISION_NOT_PASS' });
    const noSigner = await certificateStep({ kind: 'push', ref: 'refs/heads/main' }, {});
    expect(noSigner.json).toMatchObject({ status: 'SKIPPED_NO_SIGNER' });
    expect((await registry.info()).certificates).toBe(0);
  });

  it('publishes the certificate of the staged bundle on PASS in a trusted job', async (ctx) => {
    need(ctx);
    const r = await certificateStep({ kind: 'push', ref: 'refs/heads/main' }, signerEnv());
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.json).toMatchObject({
      schema: 'routespec.ci-certificate/1',
      status: 'PUBLISHED',
      trust: 'TRUSTED',
      registry: registryAccount.accountId,
      bundleDigest,
      attester: attesterKey,
      certificateId: 0,
      error: null,
    });
    expect(r.out).toMatchObject({
      'certificate-status': 'PUBLISHED',
      'certificate-id': '0',
      'certificate-attester': attesterKey,
      'certificate-bundle-digest': bundleDigest,
    });
    expect(r.out['certificate-transaction']).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(r.summary).toContain('| Status | PUBLISHED |');
    const everything = `${r.stdout}${r.stderr}${r.summary}${JSON.stringify(r.out)}`;
    for (const secret of [secretText(attester), secretText(payer.signer)]) {
      expect(everything).not.toContain(secret.slice(8, 40));
    }

    const onchain = await registry.getCertificate(0);
    expect(onchain).toMatchObject({
      project: PROJECT,
      bundleDigest,
      verdict: 'PASS',
      commit: headSha(),
      attester: attesterKey,
      attesterRevoked: false,
    });
  });

  it('is idempotent on a rerun of the job', async (ctx) => {
    need(ctx);
    const r = await certificateStep({ kind: 'push', ref: 'refs/heads/main' }, signerEnv());
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.json).toMatchObject({ status: 'ALREADY_PUBLISHED', certificateId: 0, transactionHash: null });
    expect((await registry.info()).certificates).toBe(1);
  });

  it('the published certificate verifies for the staged bundle with the attester pinned', async (ctx) => {
    need(ctx);
    let stdout = '';
    const code = await runCli(
      [
        'certificate',
        'verify',
        '--bundle',
        gateOutputs['certificate-bundle'] as string,
        '--registry',
        registryAccount.accountId,
        '--rpc',
        (sandbox as { rpcUrl: string }).rpcUrl,
        '--attester',
        attesterKey,
        '--project-key',
        PROJECT,
      ],
      { stdout: (t) => (stdout += t), stderr: () => undefined, env: {} },
    );
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as { release: { decision: string; acceptedCertificateIds: number[] } };
    expect(json.release).toMatchObject({ decision: 'PASS', acceptedCertificateIds: [0] });
  });

  it('fails the step, publishing nothing, once the attester key is revoked', async (ctx) => {
    need(ctx);
    await registry.revokeAttester(attesterKey, 'ci key rotated', owner);
    // A new gate run gives a new bundle (new run identifiers), so this is not the idempotent path.
    const next = fixture('m47-sandbox-2');
    try {
      const config = writeConfig(
        next,
        baseConfig(next, { uploads: { include: ['gate-report-json', 'evidence-bundle'], retentionDays: 3 } }),
      );
      const gateEnv = githubEnv(next, { kind: 'push', ref: 'refs/heads/main' });
      const gate = await runAction(next, config, gateEnv.env);
      expect(gate.exitCode, gate.stderr).toBe(0);
      const out = outputs(gateEnv.files.output);
      const stepEnv = githubEnv(next, { kind: 'push', ref: 'refs/heads/main' }, signerEnv());
      const r = await runCi(
        [
          'certificate',
          `--bundle=${out['certificate-bundle'] as string}`,
          `--journal=${out['certificate-journal'] as string}`,
          '--decision=PASS',
          `--project-key=${PROJECT}`,
          `--registry=${registryAccount.accountId}`,
          `--rpc=${(sandbox as { rpcUrl: string }).rpcUrl}`,
        ],
        stepEnv.env,
      );
      expect(r.exitCode).toBe(6);
      expect(r.json).toMatchObject({
        status: 'FAILED',
        error: { code: 'RS_REGISTRY_REJECTED', details: { reason: 'RSREG_ATTESTER_REVOKED' } },
        certificateId: null,
      });
      expect((await registry.info()).certificates).toBe(1);
    } finally {
      next.cleanup();
    }
  });
});
