/**
 * M47 â€” the routespec-registry contract on a real local NEAR node (near-sandbox).
 *
 * The wasm under test is deployed to a fresh account and driven through real signed
 * transactions and view calls. Covered: initialisation, owner-only enrolment and revocation,
 * signature-gated publication by any account, every tampered-field case, replay, the timestamp
 * window, refusal of deposits, append-only storage, the views by id, by bundle digest and by
 * project, and the release aggregation over what the chain returns.
 *
 * Without a container engine every test reports `NOT_RUN: <reason>`.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, inject, it, type TestContext } from 'vitest';
import { RouteSpecError } from '@routespec/contracts';
import {
  aggregateRelease,
  base58Encode,
  generateSigner,
  jsonArgs,
  MAX_AGE_MS,
  MAX_FUTURE_SKEW_MS,
  NearRpc,
  publicKeyText,
  REGISTRY_CALL_GAS,
  RegistryClient,
  signCertificate,
  verifySignedCertificate,
  type CertificateFields,
  type OnchainCertificate,
  type SignedCertificate,
} from '../src/index.ts';
import {
  createAccount,
  deployRegistry,
  sandboxRoot,
  wasmInterface,
  type SandboxAccount,
} from '../src/sandbox.ts';

const sandbox = inject('registrySandbox');
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let rpc: NearRpc;
let registry: RegistryClient;
let registryAccount: SandboxAccount;
let owner: SandboxAccount;
let relayer: SandboxAccount;
let stranger: SandboxAccount;
let wasm: Uint8Array;
const attesterA = generateSigner();
const attesterB = generateSigner();
const keyA = publicKeyText(attesterA.publicKey);
const keyB = publicKeyText(attesterB.publicKey);

function need(ctx: TestContext): void {
  if (!sandbox.available) ctx.skip(`NOT_RUN: ${sandbox.reason}`);
}

function digest(label: string): string {
  return `sha256:${Buffer.from(label.padEnd(32, '.').slice(0, 32), 'utf8').toString('hex')}`;
}

function fields(patch: Partial<CertificateFields> = {}): CertificateFields {
  return {
    registry: registryAccount.accountId,
    project: 'org/repo',
    bundleDigest: digest('bundle-1'),
    verdict: 'PASS',
    corpusDigest: digest('corpus-1'),
    artifactDigest: digest('artifact-1'),
    commit: '0123456789abcdef0123456789abcdef01234567',
    timestampMs: Date.now(),
    ...patch,
  };
}

async function refusal(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    if (error instanceof RouteSpecError && error.code === 'RS_REGISTRY_REJECTED') {
      return String(error.details['reason']);
    }
    throw error;
  }
  return 'ACCEPTED';
}

function publish(signed: SignedCertificate, by: SandboxAccount = relayer): Promise<unknown> {
  return registry.publish(signed, by);
}

beforeAll(async () => {
  if (!sandbox.available) return;
  rpc = new NearRpc(sandbox.rpcUrl);
  wasm = new Uint8Array(readFileSync(sandbox.wasmPath));
  registryAccount = { accountId: `registry-${suffix}.test.near`, signer: generateSigner() };
  owner = { accountId: `owner-${suffix}.test.near`, signer: generateSigner() };
  relayer = { accountId: `relayer-${suffix}.test.near`, signer: generateSigner() };
  stranger = { accountId: `stranger-${suffix}.test.near`, signer: generateSigner() };
  // One payer key: account creation is sequential so nonces do not collide.
  for (const a of [registryAccount, owner, relayer, stranger]) {
    await createAccount(rpc, sandboxRoot(sandbox), a);
  }
  await deployRegistry(rpc, registryAccount, wasm, owner.accountId);
  registry = new RegistryClient(rpc, registryAccount.accountId);
});

describe('deployment', () => {
  it('exports only the documented methods and no promise or balance host function', (ctx) => {
    need(ctx);
    const { exports: methods, imports } = wasmInterface(wasm);
    expect(methods).toEqual([
      'contract_source_metadata',
      'enrol_attester',
      'get_attester',
      'get_certificate',
      'get_certificates_by_bundle',
      'get_certificates_by_project',
      'get_info',
      'get_project_certificate_count',
      'list_attesters',
      'new',
      'publish',
      'revoke_attester',
    ]);
    expect(imports.filter((n) => n.startsWith('promise_') || n.includes('balance'))).toEqual([]);
  });

  it('reports its identity and starts empty', async (ctx) => {
    need(ctx);
    const info = await registry.info();
    expect(info).toMatchObject({
      contract: 'routespec-registry',
      version: '1.0.0',
      payloadDomain: 'routespec.certificate/1',
      ownerId: owner.accountId,
      attesters: 0,
      certificates: 0,
      maxFutureSkewMs: MAX_FUTURE_SKEW_MS,
      maxAgeMs: MAX_AGE_MS,
    });
    expect(await registry.listAttesters()).toEqual([]);
    expect((await registry.certificatesByBundle(digest('bundle-1'))).certificates).toEqual([]);
    expect(await registry.getCertificate(0)).toBeNull();
    expect(await registry.projectCertificateCount('org/repo')).toBe(0);
  });

  it('a deployment that was not initialised can only be initialised by its own account', async (ctx) => {
    need(ctx);
    const fresh = { accountId: `fresh-${suffix}.test.near`, signer: generateSigner() };
    await createAccount(rpc, sandboxRoot(sandbox as { rootSecret: string }), fresh);
    await rpc.sendActions({
      signerId: fresh.accountId,
      signer: fresh.signer,
      receiverId: fresh.accountId,
      actions: [{ type: 'DeployContract', code: wasm }],
    });
    const init = (by: SandboxAccount) =>
      rpc.sendActions({
        signerId: by.accountId,
        signer: by.signer,
        receiverId: fresh.accountId,
        actions: [
          {
            type: 'FunctionCall',
            methodName: 'new',
            args: jsonArgs({ owner_id: by.accountId }),
            gas: REGISTRY_CALL_GAS,
            deposit: 0n,
          },
        ],
      });
    const uninitialised = new RegistryClient(rpc, fresh.accountId);
    // No state yet: nothing can be read, enrolled or published.
    await expect(uninitialised.info()).rejects.toMatchObject({ code: 'RS_REGISTRY_REJECTED' });
    expect(await refusal(uninitialised.enrolAttester(keyA, 'too early', stranger))).not.toBe('ACCEPTED');
    expect(await refusal(init(stranger))).not.toBe('ACCEPTED');
    expect(await refusal(init(owner))).not.toBe('ACCEPTED');
    await expect(uninitialised.info()).rejects.toMatchObject({ code: 'RS_REGISTRY_REJECTED' });
    await init(fresh);
    expect((await uninitialised.info()).ownerId).toBe(fresh.accountId);
  });

  it('cannot be initialised again, by anyone', async (ctx) => {
    need(ctx);
    const init = (by: SandboxAccount) =>
      rpc.sendActions({
        signerId: by.accountId,
        signer: by.signer,
        receiverId: registryAccount.accountId,
        actions: [
          {
            type: 'FunctionCall',
            methodName: 'new',
            args: jsonArgs({ owner_id: by.accountId }),
            gas: REGISTRY_CALL_GAS,
            deposit: 0n,
          },
        ],
      });
    expect(await refusal(init(stranger))).not.toBe('ACCEPTED');
    expect(await refusal(init(registryAccount))).not.toBe('ACCEPTED');
    expect((await registry.info()).ownerId).toBe(owner.accountId);
  });
});

describe('attester enrolment', () => {
  it('is refused for anyone but the owner', async (ctx) => {
    need(ctx);
    expect(await refusal(registry.enrolAttester(keyA, 'attester A', stranger))).toBe('RSREG_NOT_OWNER');
    expect(await refusal(registry.enrolAttester(keyA, 'attester A', registryAccount))).toBe(
      'RSREG_NOT_OWNER',
    );
    expect(await registry.getAttester(keyA)).toBeNull();
  });

  it('refuses a publication signed by a key that is not enrolled', async (ctx) => {
    need(ctx);
    expect(await refusal(publish(signCertificate(fields(), attesterA)))).toBe('RSREG_ATTESTER_UNKNOWN');
    expect((await registry.info()).certificates).toBe(0);
  });

  it('enrols an Ed25519 key once, with a plain label', async (ctx) => {
    need(ctx);
    const secp = `secp256k1:${base58Encode(new Uint8Array(64).fill(7))}`;
    expect(await refusal(registry.enrolAttester(secp, 'wrong curve', owner))).toBe('RSREG_KEY_NOT_ED25519');
    expect(await refusal(registry.enrolAttester(keyA, 'line\nbreak', owner))).toBe(
      'RSREG_FIELD_INVALID:label',
    );
    expect(await refusal(registry.enrolAttester(keyA, 'x'.repeat(65), owner))).toBe(
      'RSREG_FIELD_INVALID:label',
    );
    const outcome = await registry.enrolAttester(keyA, 'attester A', owner);
    expect(outcome.logs.some((l) => l.includes('"event":"attester_enrolled"') && l.includes(keyA))).toBe(
      true,
    );
    expect(await refusal(registry.enrolAttester(keyA, 'again', owner))).toBe('RSREG_ATTESTER_EXISTS');
    const state = await registry.getAttester(keyA);
    expect(state).toMatchObject({
      publicKey: keyA,
      label: 'attester A',
      revoked: false,
      revokedAtMs: null,
      revocationReason: null,
      certificates: 0,
    });
    expect(state?.enrolledAtMs).toBeGreaterThan(Date.now() - 10 * 60_000);
    expect((await registry.listAttesters()).map((a) => a.publicKey)).toEqual([keyA]);
  });
});

describe('publication', () => {
  let first: SignedCertificate;
  let firstView: OnchainCertificate;

  it('accepts a certificate signed by an enrolled attester from any submitting account', async (ctx) => {
    need(ctx);
    first = signCertificate(fields(), attesterA);
    const before = Date.now();
    const published = await registry.publish(first, relayer);
    expect(published.certificateId).toBe(0);
    expect(published.transactionHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);

    const { certificates } = await registry.certificatesByBundle(first.certificate.bundle_digest);
    expect(certificates).toHaveLength(1);
    firstView = certificates[0] as OnchainCertificate;
    expect(firstView).toMatchObject({
      id: 0,
      registry: registryAccount.accountId,
      project: 'org/repo',
      bundleDigest: first.certificate.bundle_digest,
      verdict: 'PASS',
      corpusDigest: first.certificate.corpus_digest,
      artifactDigest: first.certificate.artifact_digest,
      commit: first.certificate.commit,
      timestampMs: first.certificate.timestamp_ms,
      attester: keyA,
      signature: first.signature,
      attesterRevoked: false,
      attesterRevokedAtMs: null,
    });
    expect(firstView.publishedAtMs).toBeGreaterThan(before - 10 * 60_000);
    expect(firstView.publishedBlockHeight).toBeGreaterThan(0);
    expect(await registry.getCertificate(0)).toEqual(firstView);
    expect(await registry.certificatesByProject('org/repo')).toEqual([firstView]);
    expect(await registry.projectCertificateCount('org/repo')).toBe(1);
    expect((await registry.getAttester(keyA))?.certificates).toBe(1);
    expect((await registry.info()).certificates).toBe(1);

    // What the chain returns verifies offline, for this registry account only.
    const fromChain: SignedCertificate = {
      certificate: first.certificate,
      attester: firstView.attester,
      signature: firstView.signature,
    };
    expect(verifySignedCertificate(registryAccount.accountId, fromChain).ok).toBe(true);
    expect(verifySignedCertificate('other.test.near', fromChain).ok).toBe(false);
  });

  it('refuses a certificate when any signed field was changed after signing', async (ctx) => {
    need(ctx);
    const signed = signCertificate(fields({ bundleDigest: digest('bundle-tamper') }), attesterA);
    const changes: Array<Partial<SignedCertificate['certificate']>> = [
      { project: 'someone/else' },
      { bundle_digest: digest('bundle-other') },
      { verdict: 'FAIL' },
      { corpus_digest: digest('corpus-other') },
      { artifact_digest: digest('artifact-other') },
      { commit: 'f'.repeat(40) },
      { timestamp_ms: signed.certificate.timestamp_ms + 1 },
    ];
    for (const change of changes) {
      const tampered = { ...signed, certificate: { ...signed.certificate, ...change } };
      expect(await refusal(publish(tampered)), Object.keys(change)[0]).toBe('RSREG_SIGNATURE_INVALID');
    }
    expect((await registry.certificatesByBundle(digest('bundle-tamper'))).certificates).toEqual([]);
    expect((await registry.certificatesByBundle(digest('bundle-other'))).certificates).toEqual([]);
    expect((await registry.info()).certificates).toBe(1);
  });

  it('refuses a wrong signature, a signature for another registry, and another signer', async (ctx) => {
    need(ctx);
    const f = fields({ bundleDigest: digest('bundle-sig') });
    const signed = signCertificate(f, attesterA);
    const flipped = Buffer.from(signed.signature, 'base64');
    flipped[0] = (flipped[0] as number) ^ 1;
    expect(await refusal(publish({ ...signed, signature: flipped.toString('base64') }))).toBe(
      'RSREG_SIGNATURE_INVALID',
    );
    expect(await refusal(publish({ ...signed, signature: Buffer.alloc(63, 1).toString('base64') }))).toBe(
      'RSREG_SIGNATURE_INVALID',
    );
    // Signed for a different registry account (for example another network's registry).
    const elsewhere = signCertificate({ ...f, registry: 'registry.other.near' }, attesterA);
    expect(await refusal(publish(elsewhere))).toBe('RSREG_SIGNATURE_INVALID');
    // A valid signature by a key that is not enrolled, presented under the enrolled key.
    const outsider = signCertificate(f, generateSigner());
    expect(await refusal(publish(outsider))).toBe('RSREG_ATTESTER_UNKNOWN');
    expect(await refusal(publish({ ...outsider, attester: keyA }))).toBe('RSREG_SIGNATURE_INVALID');
    expect((await registry.certificatesByBundle(digest('bundle-sig'))).certificates).toEqual([]);
  });

  it('refuses malformed fields and unknown fields before looking at the signature', async (ctx) => {
    need(ctx);
    const good = signCertificate(fields({ bundleDigest: digest('bundle-fields') }), attesterA);
    const cases: Array<[Partial<SignedCertificate['certificate']>, string]> = [
      [{ project: 'Org/Repo' }, 'RSREG_FIELD_INVALID:project'],
      [{ project: 'a\nverdict:PASS' }, 'RSREG_FIELD_INVALID:project'],
      [{ bundle_digest: 'sha256:abc' }, 'RSREG_FIELD_INVALID:bundle_digest'],
      [{ verdict: 'pass' }, 'RSREG_FIELD_INVALID:verdict'],
      [{ corpus_digest: `sha512:${'a'.repeat(64)}` }, 'RSREG_FIELD_INVALID:corpus_digest'],
      [{ artifact_digest: `sha256:${'G'.repeat(64)}` }, 'RSREG_FIELD_INVALID:artifact_digest'],
      [{ commit: 'abc1234' }, 'RSREG_FIELD_INVALID:commit'],
      [{ timestamp_ms: 0 }, 'RSREG_FIELD_INVALID:timestamp_ms'],
    ];
    for (const [change, code] of cases) {
      expect(await refusal(publish({ ...good, certificate: { ...good.certificate, ...change } })), code).toBe(
        code,
      );
    }
    const extra = { ...good, certificate: { ...good.certificate, note: 'x' } } as SignedCertificate;
    expect(await refusal(publish(extra))).not.toBe('ACCEPTED');
    expect((await registry.info()).certificates).toBe(1);
  });

  it('refuses a timestamp outside the window around the block time', async (ctx) => {
    need(ctx);
    const now = Date.now();
    const future = signCertificate(
      fields({ bundleDigest: digest('bundle-time'), timestampMs: now + MAX_FUTURE_SKEW_MS + 5 * 60_000 }),
      attesterA,
    );
    expect(await refusal(publish(future))).toBe('RSREG_TIMESTAMP_FUTURE');
    const stale = signCertificate(
      fields({ bundleDigest: digest('bundle-time'), timestampMs: now - MAX_AGE_MS - 5 * 60_000 }),
      attesterA,
    );
    expect(await refusal(publish(stale))).toBe('RSREG_TIMESTAMP_STALE');
    expect((await registry.certificatesByBundle(digest('bundle-time'))).certificates).toEqual([]);
  });

  it('refuses a replay and never lets an attester replace its certificate', async (ctx) => {
    need(ctx);
    expect(await refusal(publish(first))).toBe('RSREG_ALREADY_PUBLISHED');
    expect(await refusal(publish(first, stranger))).toBe('RSREG_ALREADY_PUBLISHED');
    const changedMind = signCertificate(fields({ verdict: 'FAIL', timestampMs: Date.now() }), attesterA);
    expect(await refusal(publish(changedMind))).toBe('RSREG_ALREADY_PUBLISHED');
    expect(await registry.getCertificate(0)).toEqual(firstView);
    expect((await registry.info()).certificates).toBe(1);
  });

  it('refuses any attached deposit and keeps no record of the attempt', async (ctx) => {
    need(ctx);
    const signed = signCertificate(fields({ bundleDigest: digest('bundle-deposit') }), attesterA);
    const withDeposit = rpc.sendActions({
      signerId: relayer.accountId,
      signer: relayer.signer,
      receiverId: registryAccount.accountId,
      actions: [
        {
          type: 'FunctionCall',
          methodName: 'publish',
          args: jsonArgs(signed),
          gas: REGISTRY_CALL_GAS,
          deposit: 1n,
        },
      ],
    });
    expect(await refusal(withDeposit)).not.toBe('ACCEPTED');
    expect((await registry.certificatesByBundle(digest('bundle-deposit'))).certificates).toEqual([]);
    const enrolWithDeposit = rpc.sendActions({
      signerId: owner.accountId,
      signer: owner.signer,
      receiverId: registryAccount.accountId,
      actions: [
        {
          type: 'FunctionCall',
          methodName: 'enrol_attester',
          args: jsonArgs({ public_key: keyB, label: 'attester B' }),
          gas: REGISTRY_CALL_GAS,
          deposit: 10n ** 24n,
        },
      ],
    });
    expect(await refusal(enrolWithDeposit)).not.toBe('ACCEPTED');
    expect(await registry.getAttester(keyB)).toBeNull();
  });

  it('keeps one certificate per attester for a bundle and lists a project in publication order', async (ctx) => {
    need(ctx);
    await registry.enrolAttester(keyB, 'attester B', owner);
    const second = signCertificate(fields({ timestampMs: Date.now() }), attesterB);
    expect((await registry.publish(second, stranger)).certificateId).toBe(1);
    const other = signCertificate(
      fields({ bundleDigest: digest('bundle-2'), verdict: 'FAIL', project: 'other/project' }),
      attesterA,
    );
    expect((await registry.publish(other, relayer)).certificateId).toBe(2);
    const third = signCertificate(fields({ bundleDigest: digest('bundle-3'), verdict: 'REVIEW' }), attesterA);
    expect((await registry.publish(third, relayer)).certificateId).toBe(3);

    const forBundle = (await registry.certificatesByBundle(digest('bundle-1'))).certificates;
    expect(forBundle.map((c) => [c.id, c.attester])).toEqual([
      [0, keyA],
      [1, keyB],
    ]);
    expect((await registry.certificatesByProject('org/repo')).map((c) => c.id)).toEqual([0, 1, 3]);
    expect((await registry.certificatesByProject('org/repo', 1, 1)).map((c) => c.id)).toEqual([1]);
    expect((await registry.certificatesByProject('org/repo', 2, 50)).map((c) => c.id)).toEqual([3]);
    expect(await registry.certificatesByProject('org/repo', 9, 5)).toEqual([]);
    expect((await registry.certificatesByProject('other/project')).map((c) => [c.id, c.verdict])).toEqual([
      [2, 'FAIL'],
    ]);
    expect(await registry.projectCertificateCount('org/repo')).toBe(3);
    expect(await registry.projectCertificateCount('nobody/nothing')).toBe(0);
    expect((await registry.getAttester(keyA))?.certificates).toBe(3);
    expect((await registry.listAttesters()).map((a) => a.publicKey)).toEqual([keyA, keyB]);
    expect((await registry.listAttesters(1, 1)).map((a) => a.publicKey)).toEqual([keyB]);
  });

  it('aggregates to PASS for the certified bundle while its attester is in good standing', async (ctx) => {
    need(ctx);
    const { certificates } = await registry.certificatesByBundle(digest('bundle-1'));
    const out = aggregateRelease({
      registry: registryAccount.accountId,
      bundleDigest: digest('bundle-1'),
      local: {
        decision: 'PASS',
        artifactDigest: digest('artifact-1'),
        corpusDigest: digest('corpus-1'),
        commit: first.certificate.commit,
        project: 'org/repo',
      },
      certificates,
      attesters: { [keyA]: await registry.getAttester(keyA), [keyB]: await registry.getAttester(keyB) },
      policy: 'REQUIRE_ONCHAIN_ATTESTER',
      trustedAttesters: [keyA],
    });
    expect(out.decision).toBe('PASS');
    expect(out.acceptedCertificateIds).toEqual([0]);
  });
});

describe('revocation', () => {
  it('is refused for anyone but the owner and for unknown keys', async (ctx) => {
    need(ctx);
    expect(await refusal(registry.revokeAttester(keyA, 'not yours', stranger))).toBe('RSREG_NOT_OWNER');
    expect(await refusal(registry.revokeAttester(keyA, 'not yours', relayer))).toBe('RSREG_NOT_OWNER');
    const unknown = publicKeyText(generateSigner().publicKey);
    expect(await refusal(registry.revokeAttester(unknown, 'unknown', owner))).toBe('RSREG_ATTESTER_UNKNOWN');
    expect(await refusal(registry.revokeAttester(keyA, 'bad\treason', owner))).toBe(
      'RSREG_FIELD_INVALID:reason',
    );
    expect((await registry.getAttester(keyA))?.revoked).toBe(false);
  });

  it('stops a revoked key from publishing, keeps what it published, and is permanent', async (ctx) => {
    need(ctx);
    const before = await registry.getCertificate(0);
    // A certificate signed while the key was still enrolled, not yet submitted.
    const pending = signCertificate(fields({ bundleDigest: digest('bundle-pending') }), attesterA);

    const outcome = await registry.revokeAttester(keyA, 'key rotated', owner);
    expect(outcome.logs.some((l) => l.includes('"event":"attester_revoked"') && l.includes(keyA))).toBe(true);
    const state = await registry.getAttester(keyA);
    expect(state).toMatchObject({ revoked: true, revocationReason: 'key rotated', certificates: 3 });
    expect(state?.revokedAtMs).toBeGreaterThanOrEqual((before as OnchainCertificate).publishedAtMs);
    expect(state?.revokedBlockHeight).toBeGreaterThan((before as OnchainCertificate).publishedBlockHeight);

    expect(await refusal(publish(pending))).toBe('RSREG_ATTESTER_REVOKED');
    const fresh = signCertificate(fields({ bundleDigest: digest('bundle-after') }), attesterA);
    expect(await refusal(publish(fresh, owner))).toBe('RSREG_ATTESTER_REVOKED');
    expect((await registry.certificatesByBundle(digest('bundle-pending'))).certificates).toEqual([]);

    expect(await refusal(registry.revokeAttester(keyA, 'again', owner))).toBe('RSREG_ALREADY_REVOKED');
    expect(await refusal(registry.enrolAttester(keyA, 'back again', owner))).toBe('RSREG_ATTESTER_EXISTS');

    // The log is append-only: the earlier certificate is unchanged apart from the attester state.
    const after = await registry.getCertificate(0);
    expect(after).toEqual({
      ...(before as OnchainCertificate),
      attesterRevoked: true,
      attesterRevokedAtMs: state?.revokedAtMs,
    });
    expect((await registry.info()).certificates).toBe(4);
    // The other attester is unaffected.
    const stillGood = signCertificate(fields({ bundleDigest: digest('bundle-b-only') }), attesterB);
    expect((await registry.publish(stillGood, relayer)).certificateId).toBe(4);
  });

  it('aggregates to REVIEW once the pinned attester is revoked', async (ctx) => {
    need(ctx);
    const { certificates } = await registry.certificatesByBundle(digest('bundle-1'));
    const base = {
      registry: registryAccount.accountId,
      bundleDigest: digest('bundle-1'),
      local: {
        decision: 'PASS' as const,
        artifactDigest: digest('artifact-1'),
        corpusDigest: digest('corpus-1'),
        commit: null,
        project: 'org/repo',
      },
      certificates,
      attesters: { [keyA]: await registry.getAttester(keyA), [keyB]: await registry.getAttester(keyB) },
      policy: 'REQUIRE_ONCHAIN_ATTESTER' as const,
    };
    const pinnedRevoked = aggregateRelease({ ...base, trustedAttesters: [keyA] });
    expect(pinnedRevoked.decision).toBe('REVIEW');
    expect(pinnedRevoked.findings).toContain('ATTESTER_REVOKED');
    expect(pinnedRevoked.acceptedCertificateIds).toEqual([]);
    // The second attester's certificate for the same bundle still stands.
    expect(aggregateRelease({ ...base, trustedAttesters: [] }).acceptedCertificateIds).toEqual([1]);
  });
});

describe('small-order attester keys', () => {
  it('cannot be enrolled, so nobody can forge a certificate for one', async (ctx) => {
    need(ctx);
    const fresh: SandboxAccount = { accountId: `weak-${suffix}.test.near`, signer: generateSigner() };
    await createAccount(rpc, sandboxRoot(sandbox as { rootSecret: string }), fresh);
    await deployRegistry(rpc, fresh, wasm, owner.accountId);
    const weakRegistry = new RegistryClient(rpc, fresh.accountId);

    // The identity point as a public key: R = identity and s = 0 verify for every payload.
    const identity = new Uint8Array(32);
    identity[0] = 1;
    const weak = publicKeyText(identity);
    expect.soft(await refusal(weakRegistry.enrolAttester(weak, 'weak key', owner))).toBe('RSREG_KEY_WEAK');

    const f = fields({ registry: fresh.accountId, bundleDigest: digest('forged-bundle') });
    const forged: SignedCertificate = {
      ...signCertificate(f, attesterA),
      attester: weak,
      signature: Buffer.concat([Buffer.from(identity), Buffer.alloc(32)]).toString('base64'),
    };
    // A stranger with no key at all submits it.
    expect.soft(await refusal(weakRegistry.publish(forged, stranger))).toBe('RSREG_ATTESTER_UNKNOWN');
    expect.soft((await weakRegistry.info()).certificates).toBe(0);

    // Every other small-order encoding is refused as well.
    for (const hex of [
      '0000000000000000000000000000000000000000000000000000000000000000',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    ]) {
      const k = publicKeyText(new Uint8Array(Buffer.from(hex, 'hex')));
      expect.soft(await refusal(weakRegistry.enrolAttester(k, 'weak key', owner))).toBe('RSREG_KEY_WEAK');
    }
    expect((await weakRegistry.info()).attesters).toBe(0);
  });
});
