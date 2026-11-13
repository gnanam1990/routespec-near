/**
 * M47 — `routespec certificate publish|verify|revoke-check` against the registry contract on a
 * real local NEAR node (near-sandbox).
 *
 * Real gate runs are exported to real bundles (one PASS, one FAIL). The CLI, as a separate
 * process, signs and submits their certificates, and a second CLI process with no journal and
 * another working directory verifies them from the chain. The owner's enrolment and revocation
 * transactions are sent by the test, the way the owner would send them with a NEAR tool.
 *
 * Without a container engine every test reports `NOT_RUN: <reason>`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it, type TestContext } from 'vitest';
import {
  base58Encode,
  generateSigner,
  jsonArgs,
  NearRpc,
  publicKeyText,
  REGISTRY_CALL_GAS,
  RegistryClient,
  signerFromSecret,
  type Ed25519Signer,
} from '@routespec/registry';
import { createAccount, deployRegistry, sandboxRoot, type SandboxAccount } from '@routespec/registry/sandbox';
import { makeBundle, type CertifiableBundle } from '../test/support/certificate-bundle.ts';
import { runCliProcess, tempDir } from '../test/support/product.ts';

const sandbox = inject('registrySandbox');
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const PROJECT = 'gnanam1990/routespec-near';

let tmpPass: ReturnType<typeof tempDir>;
let tmpFail: ReturnType<typeof tempDir>;
let elsewhere: ReturnType<typeof tempDir>;
let pass: CertifiableBundle;
let fail: CertifiableBundle;
let rpc: NearRpc;
let registry: RegistryClient;
let registryAccount: SandboxAccount;
let owner: SandboxAccount;
let payer: SandboxAccount;
let attesterKeyFile = '';
let payerKeyFile = '';
let attester: Ed25519Signer;
let attesterKey = '';

function need(ctx: TestContext): void {
  if (!sandbox.available) ctx.skip(`NOT_RUN: ${sandbox.reason}`);
}

function nearSecret(signer: Ed25519Signer): string {
  return `ed25519:${base58Encode(Buffer.concat([signer.seed, signer.publicKey]))}`;
}

function cli(args: string[], env: Record<string, string> = {}) {
  const base: Record<string, string | undefined> = { ...process.env, ...env };
  for (const name of [
    'ROUTESPEC_DATA_DIR',
    'ROUTESPEC_ATTESTER_KEY',
    'ROUTESPEC_NEAR_SIGNER_KEY',
    'ROUTESPEC_NEAR_SIGNER_ACCOUNT',
  ]) {
    if (!(name in env)) delete base[name];
  }
  base['HOME'] = elsewhere.dir;
  base['USERPROFILE'] = elsewhere.dir;
  return runCliProcess(args, { cwd: elsewhere.dir, env: base });
}

function chain(): string[] {
  return ['--registry', registryAccount.accountId, '--rpc', (sandbox as { rpcUrl: string }).rpcUrl];
}

function errorOf(json: Record<string, unknown> | null): { code: string; details: Record<string, unknown> } {
  return (json?.['error'] ?? { code: 'NONE', details: {} }) as {
    code: string;
    details: Record<string, unknown>;
  };
}

interface Release {
  decision: string;
  policy: string;
  localDecision: string | null;
  acceptedCertificateIds: number[];
  findings: string[];
}

function releaseOf(json: Record<string, unknown> | null): Release {
  return json?.['release'] as Release;
}

beforeAll(async () => {
  if (!sandbox.available) return;
  tmpPass = tempDir('routespec-m47-pass-');
  tmpFail = tempDir('routespec-m47-fail-');
  elsewhere = tempDir('routespec-m47-clean-');
  pass = await makeBundle(tmpPass.dir, { scenarios: ['happy-path'], label: 'm47pass' });
  fail = await makeBundle(tmpFail.dir, { scenarios: ['happy-path', 'refund-shortfall'], label: 'm47fail' });
  expect([pass.decision, fail.decision]).toEqual(['PASS', 'FAIL']);

  rpc = new NearRpc(sandbox.rpcUrl);
  registryAccount = { accountId: `cli-registry-${suffix}.test.near`, signer: generateSigner() };
  owner = { accountId: `cli-owner-${suffix}.test.near`, signer: generateSigner() };
  payer = { accountId: `cli-payer-${suffix}.test.near`, signer: generateSigner() };
  for (const a of [registryAccount, owner, payer]) await createAccount(rpc, sandboxRoot(sandbox), a);
  await deployRegistry(rpc, registryAccount, new Uint8Array(readFileSync(sandbox.wasmPath)), owner.accountId);
  registry = new RegistryClient(rpc, registryAccount.accountId);

  // The attester key comes from the CLI itself; the owner enrols its public key.
  attesterKeyFile = join(elsewhere.dir, 'attester.pem');
  const made = await cli(['certificate', 'keygen', '--out', attesterKeyFile]);
  expect(made.exitCode, made.stderr).toBe(0);
  attesterKey = String(made.json?.['publicKey']);
  attester = signerFromSecret(readFileSync(attesterKeyFile, 'utf8'));
  payerKeyFile = join(elsewhere.dir, 'payer.json');
  writeFileSync(
    payerKeyFile,
    JSON.stringify({
      account_id: payer.accountId,
      public_key: publicKeyText(payer.signer.publicKey),
      private_key: nearSecret(payer.signer),
    }),
  );
});

afterAll(() => {
  tmpPass?.cleanup();
  tmpFail?.cleanup();
  elsewhere?.cleanup();
});

function publishArgs(b: CertifiableBundle, extra: string[] = []): string[] {
  return [
    'certificate',
    'publish',
    '--data',
    b.dataDir,
    '--bundle',
    b.bundlePath,
    '--project-key',
    PROJECT,
    ...chain(),
    '--attester-key',
    attesterKeyFile,
    '--near-account',
    payer.accountId,
    '--near-key',
    payerKeyFile,
    '--submit',
    ...extra,
  ];
}

describe('before the attester is enrolled', () => {
  it('verify reports REVIEW: no certificate for the bundle', async (ctx) => {
    need(ctx);
    const r = await cli(['certificate', 'verify', '--bundle', pass.bundlePath, ...chain()]);
    expect(r.exitCode, r.stderr).toBe(3);
    expect(releaseOf(r.json)).toMatchObject({
      decision: 'REVIEW',
      localDecision: 'PASS',
      policy: 'REQUIRE_ONCHAIN_ATTESTER',
      findings: ['CERTIFICATE_NOT_FOUND', 'ONCHAIN_ATTESTATION_REQUIRED'],
    });
    const advisory = await cli([
      'certificate',
      'verify',
      '--bundle',
      pass.bundlePath,
      '--policy',
      'advisory',
      ...chain(),
    ]);
    expect(advisory.exitCode).toBe(0);
    expect(releaseOf(advisory.json)).toMatchObject({ decision: 'PASS', findings: ['CERTIFICATE_NOT_FOUND'] });
  });

  it('publish is refused for a key the registry does not know, and nothing is recorded', async (ctx) => {
    need(ctx);
    const r = await cli(publishArgs(pass));
    expect(r.exitCode).toBe(6);
    expect(errorOf(r.json)).toMatchObject({
      code: 'RS_REGISTRY_REJECTED',
      details: { reason: 'RSREG_ATTESTER_UNKNOWN' },
    });
    expect((await registry.info()).certificates).toBe(0);
  });

  it('refuses an account that is not a registry, and a named network the endpoint does not serve', async (ctx) => {
    need(ctx);
    const notRegistry = await cli([
      'certificate',
      'verify',
      '--digest',
      pass.bundleDigest,
      '--registry',
      payer.accountId,
      '--rpc',
      (sandbox as { rpcUrl: string }).rpcUrl,
    ]);
    expect(notRegistry.exitCode).toBe(6);
    expect(errorOf(notRegistry.json).code).toBe('RS_REGISTRY_REJECTED');
    const wrongNetwork = await cli([
      'certificate',
      'verify',
      '--digest',
      pass.bundleDigest,
      ...chain(),
      '--network',
      'testnet',
    ]);
    expect(wrongNetwork.exitCode).toBe(4);
    expect(errorOf(wrongNetwork.json)).toMatchObject({
      code: 'RS_IDENTITY_MISMATCH',
      details: { expected: 'testnet' },
    });
  });
});

describe('publish and verify', () => {
  it('submits the certificate of the PASS bundle and reports the certificate id', async (ctx) => {
    need(ctx);
    await registry.enrolAttester(attesterKey, 'release attester', owner);
    const r = await cli(publishArgs(pass));
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.json).toMatchObject({
      ok: true,
      submitted: true,
      alreadyPublished: false,
      certificateId: 0,
      registry: registryAccount.accountId,
      attester: attesterKey,
      identitySource: 'JOURNAL',
    });
    expect(String(r.json?.['transactionHash'])).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    const output = `${r.stdout}${r.stderr}`;
    expect(output).not.toContain(base58Encode(attester.seed));
    expect(output).not.toContain(nearSecret(payer.signer).slice(8));

    const onchain = await registry.getCertificate(0);
    expect(onchain).toMatchObject({
      project: PROJECT,
      bundleDigest: pass.bundleDigest,
      verdict: 'PASS',
      corpusDigest: pass.corpusDigest,
      artifactDigest: pass.journal.artifactDigest,
      commit: pass.commit,
      attester: attesterKey,
      signature: r.json?.['signature'],
    });
  });

  it('is idempotent: a second publish reports the existing certificate and sends nothing', async (ctx) => {
    need(ctx);
    const r = await cli(publishArgs(pass));
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.json).toMatchObject({ submitted: false, alreadyPublished: true, certificateId: 0 });
    expect(r.json?.['transactionHash']).toBeUndefined();
    expect((await registry.info()).certificates).toBe(1);
  });

  it('verifies the bundle from another directory with no journal: PASS', async (ctx) => {
    need(ctx);
    const r = await cli(['certificate', 'verify', '--bundle', pass.bundlePath, ...chain()]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.json).toMatchObject({ ok: true, bundleDigest: pass.bundleDigest });
    expect(releaseOf(r.json)).toEqual({
      decision: 'PASS',
      policy: 'REQUIRE_ONCHAIN_ATTESTER',
      localDecision: 'PASS',
      acceptedCertificateIds: [0],
      findings: [],
      trustedAttesters: [],
    });
    expect(r.json?.['registry']).toMatchObject({
      accountId: registryAccount.accountId,
      contract: 'routespec-registry',
      ownerId: owner.accountId,
    });
    const listed = r.json?.['certificates'] as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: 0,
      attester: attesterKey,
      verdict: 'PASS',
      commit: pass.commit,
      assessment: { accepted: true, findings: [] },
    });

    const pinned = await cli([
      'certificate',
      'verify',
      '--bundle',
      pass.bundlePath,
      '--attester',
      attesterKey,
      '--project-key',
      PROJECT,
      ...chain(),
    ]);
    expect(pinned.exitCode).toBe(0);
    expect(releaseOf(pinned.json).acceptedCertificateIds).toEqual([0]);
  });

  it('is REVIEW when the pinned attester or the pinned project is another one', async (ctx) => {
    need(ctx);
    const other = publicKeyText(generateSigner().publicKey);
    const r = await cli([
      'certificate',
      'verify',
      '--bundle',
      pass.bundlePath,
      '--attester',
      other,
      ...chain(),
    ]);
    expect(r.exitCode).toBe(3);
    expect(releaseOf(r.json)).toMatchObject({
      decision: 'REVIEW',
      findings: ['ATTESTER_NOT_TRUSTED', 'ONCHAIN_ATTESTATION_REQUIRED'],
    });
    const project = await cli([
      'certificate',
      'verify',
      '--bundle',
      pass.bundlePath,
      '--project-key',
      'someone/else',
      ...chain(),
    ]);
    expect(project.exitCode).toBe(3);
    expect(releaseOf(project.json).findings).toEqual([
      'CERTIFICATE_PROJECT_MISMATCH',
      'ONCHAIN_ATTESTATION_REQUIRED',
    ]);
  });

  it('verifies by digest alone and says the bundle was not checked locally', async (ctx) => {
    need(ctx);
    const r = await cli(['certificate', 'verify', '--digest', pass.bundleDigest, ...chain()]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(releaseOf(r.json)).toMatchObject({
      decision: 'PASS',
      localDecision: null,
      findings: ['BUNDLE_NOT_CHECKED_LOCALLY'],
    });
    const unknown = await cli(['certificate', 'verify', '--digest', `sha256:${'12'.repeat(32)}`, ...chain()]);
    expect(unknown.exitCode).toBe(3);
    expect(releaseOf(unknown.json).findings).toContain('CERTIFICATE_NOT_FOUND');
  });

  it('certifies a FAIL as a FAIL: verify exits 2', async (ctx) => {
    need(ctx);
    const published = await cli(publishArgs(fail), {});
    expect(published.exitCode, published.stderr).toBe(0);
    expect(published.json).toMatchObject({ submitted: true, certificateId: 1 });
    expect((published.json?.['certificate'] as { verdict: string }).verdict).toBe('FAIL');
    const r = await cli(['certificate', 'verify', '--bundle', fail.bundlePath, ...chain()]);
    expect(r.exitCode).toBe(2);
    expect(releaseOf(r.json)).toMatchObject({ decision: 'FAIL', localDecision: 'FAIL' });
    const byDigest = await cli(['certificate', 'verify', '--digest', fail.bundleDigest, ...chain()]);
    expect(byDigest.exitCode).toBe(2);
  });

  it('accepts the signed envelope when another account submits it, as the owner would with a NEAR tool', async (ctx) => {
    need(ctx);
    // A second attester signs offline (`--out`); the envelope file is the publish argument.
    const second = generateSigner();
    const secondKey = publicKeyText(second.publicKey);
    await registry.enrolAttester(secondKey, 'second attester', owner);
    const envelopeFile = join(elsewhere.dir, 'envelope.json');
    const signed = await cli(
      [
        'certificate',
        'publish',
        '--bundle',
        pass.bundlePath,
        '--project-key',
        PROJECT,
        '--registry',
        registryAccount.accountId,
        '--corpus-digest',
        pass.corpusDigest,
        '--commit',
        pass.commit,
        '--out',
        envelopeFile,
      ],
      { ROUTESPEC_ATTESTER_KEY: nearSecret(second) },
    );
    expect(signed.exitCode, signed.stderr).toBe(0);
    expect(signed.json).toMatchObject({ submitted: false, envelopeWritten: true });
    const outcome = await rpc.sendActions({
      signerId: owner.accountId,
      signer: owner.signer,
      receiverId: registryAccount.accountId,
      actions: [
        {
          type: 'FunctionCall',
          methodName: 'publish',
          args: jsonArgs(JSON.parse(readFileSync(envelopeFile, 'utf8'))),
          gas: REGISTRY_CALL_GAS,
          deposit: 0n,
        },
      ],
    });
    expect(outcome.returnValue).toBe(2);
    const r = await cli([
      'certificate',
      'verify',
      '--bundle',
      pass.bundlePath,
      '--attester',
      secondKey,
      ...chain(),
    ]);
    expect(r.exitCode).toBe(0);
    expect(releaseOf(r.json).acceptedCertificateIds).toEqual([2]);
  });

  it('reads the secrets from the environment when no key files are given', async (ctx) => {
    need(ctx);
    const third = generateSigner();
    await registry.enrolAttester(publicKeyText(third.publicKey), 'ci attester', owner);
    const args = publishArgs(pass).filter(
      (a, i, all) =>
        !['--attester-key', '--near-account', '--near-key'].includes(a) &&
        !['--attester-key', '--near-account', '--near-key'].includes(all[i - 1] ?? ''),
    );
    const r = await cli(args, {
      ROUTESPEC_ATTESTER_KEY: nearSecret(third),
      ROUTESPEC_NEAR_SIGNER_ACCOUNT: payer.accountId,
      ROUTESPEC_NEAR_SIGNER_KEY: nearSecret(payer.signer),
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.json).toMatchObject({ submitted: true, certificateId: 3 });
    const output = `${r.stdout}${r.stderr}`;
    expect(output).not.toContain(nearSecret(third).slice(8));
    expect(output).not.toContain(nearSecret(payer.signer).slice(8));
  });
});

describe('revoke-check and verification after a revocation', () => {
  it('is CLEAR while every attester of the bundle is enrolled', async (ctx) => {
    need(ctx);
    const r = await cli(['certificate', 'revoke-check', '--digest', fail.bundleDigest, ...chain()]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.json).toMatchObject({ status: 'CLEAR', bundleDigest: fail.bundleDigest });
    expect(r.json?.['certificates']).toMatchObject([
      { id: 1, attester: attesterKey, attesterStatus: 'ENROLLED', publishedBeforeRevocation: null },
    ]);
    const byBundle = await cli(['certificate', 'revoke-check', '--bundle', fail.bundlePath, ...chain()]);
    expect(byBundle.json).toMatchObject({ status: 'CLEAR', bundleDigest: fail.bundleDigest });
    const none = await cli([
      'certificate',
      'revoke-check',
      '--digest',
      `sha256:${'34'.repeat(32)}`,
      ...chain(),
    ]);
    expect(none.exitCode).toBe(3);
    expect(none.json).toMatchObject({ status: 'NO_CERTIFICATE' });
    const unknownKey = await cli([
      'certificate',
      'revoke-check',
      '--attester',
      publicKeyText(generateSigner().publicKey),
      ...chain(),
    ]);
    expect(unknownKey.exitCode).toBe(3);
    expect((unknownKey.json?.['attesters'] as Array<{ status: string }>)[0]?.status).toBe('NOT_ENROLLED');
  });

  it('reports the revocation, stops trusting the certificate, and refuses new ones', async (ctx) => {
    need(ctx);
    await registry.revokeAttester(attesterKey, 'key rotated after release', owner);

    const check = await cli(['certificate', 'revoke-check', '--digest', fail.bundleDigest, ...chain()]);
    expect(check.exitCode).toBe(3);
    expect(check.json).toMatchObject({ status: 'REVOKED' });
    expect(check.json?.['certificates']).toMatchObject([
      {
        id: 1,
        attesterStatus: 'REVOKED',
        revocationReason: 'key rotated after release',
        publishedBeforeRevocation: true,
      },
    ]);
    const byKey = await cli(['certificate', 'revoke-check', '--attester', attesterKey, ...chain()]);
    expect(byKey.exitCode).toBe(3);
    expect(byKey.json?.['attesters']).toMatchObject([{ attester: attesterKey, status: 'REVOKED' }]);

    // The PASS bundle: the revoked attester's certificate no longer counts when it is the pinned one.
    const pinned = await cli([
      'certificate',
      'verify',
      '--bundle',
      pass.bundlePath,
      '--attester',
      attesterKey,
      ...chain(),
    ]);
    expect(pinned.exitCode).toBe(3);
    expect(releaseOf(pinned.json)).toMatchObject({
      decision: 'REVIEW',
      findings: ['ATTESTER_NOT_TRUSTED', 'ATTESTER_REVOKED', 'ONCHAIN_ATTESTATION_REQUIRED'],
    });
    // A FAIL stays a FAIL whatever happens to the attester.
    const failed = await cli(['certificate', 'verify', '--bundle', fail.bundlePath, ...chain()]);
    expect(failed.exitCode).toBe(2);

    // The revoked key cannot publish: refused before a transaction, and by the contract itself.
    const third = await makeBundle(tempDirFor('m47third'), { scenarios: ['happy-path'], label: 'm47third' });
    const refused = await cli(publishArgs(third));
    expect(refused.exitCode).toBe(6);
    expect(errorOf(refused.json)).toMatchObject({
      code: 'RS_REGISTRY_REJECTED',
      details: { reason: 'RSREG_ATTESTER_REVOKED' },
    });
    expect((await registry.certificatesByBundle(third.bundleDigest)).certificates).toEqual([]);
  });
});

const extraDirs: Array<ReturnType<typeof tempDir>> = [];
function tempDirFor(label: string): string {
  const t = tempDir(`routespec-${label}-`);
  extraDirs.push(t);
  return t.dir;
}
afterAll(() => {
  for (const t of extraDirs) t.cleanup();
});
