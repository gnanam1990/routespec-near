/**
 * M49 — the "RouteSpec Certified" badge (`certificate badge`) and the static verify page, against
 * the registry contract on a real local NEAR node (near-sandbox).
 *
 * Real gate runs are exported to real bundles (one PASS, one FAIL). The CLI, as a separate
 * process, publishes their certificates. Then, at each step (nothing published, PASS certified,
 * FAIL certified by a second attester, that attester revoked), the badge the CLI writes, the
 * decision `certificate verify --digest` reaches, and what the built page shows in Chromium are
 * compared. The page is the production build, served from a loopback port with its
 * `config.json`, and reads the node directly over JSON-RPC from the browser.
 *
 * Without a container engine every test reports `NOT_RUN: <reason>`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, inject, it, type TestContext } from 'vitest';
import {
  base58Encode,
  generateSigner,
  NearRpc,
  publicKeyText,
  RegistryClient,
  signerToPem,
  type Ed25519Signer,
} from '@routespec/registry';
import { createAccount, deployRegistry, sandboxRoot, type SandboxAccount } from '@routespec/registry/sandbox';
import { makeBundle, type CertifiableBundle } from '../../../packages/cli/test/support/certificate-bundle.ts';
import { runCliProcess, tempDir } from '../../../packages/cli/test/support/product.ts';

const sandbox = inject('registrySandbox');
const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const distDir = join(appDir, 'dist');
const PAGE_PORT = Number(process.env['ROUTESPEC_VERIFY_PAGE_PORT'] ?? '9553');
const DEAD_PORT = 9559;
const PROJECT = 'gnanam1990/routespec-near';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
/** The NEAR code hash of the reproducible registry build recorded in docs/status/M47.md. */
const REPRODUCIBLE_CODE_HASH = 'DgYXio822TH3CGJqfKU8gDFFSSqmxurWAwG1i4Jhqo5P';

let tmpPass: ReturnType<typeof tempDir>;
let tmpFail: ReturnType<typeof tempDir>;
let work: ReturnType<typeof tempDir>;
let pass: CertifiableBundle;
let fail: CertifiableBundle;
let rpc: NearRpc;
let registry: RegistryClient;
let registryAccount: SandboxAccount;
let owner: SandboxAccount;
let payer: SandboxAccount;
let attesterA = '';
let attesterB: Ed25519Signer;
let keyA = '';
let keyB = '';
let payerKeyFile = '';
let codeHash = '';
let chainId = '';
let server: Server;
let browser: Browser;
let pageConfig: Record<string, unknown> = {};
let badgeCount = 0;

function need(ctx: TestContext): void {
  if (!sandbox.available) ctx.skip(`NOT_RUN: ${sandbox.reason}`);
}

function rpcUrl(): string {
  return (sandbox as { rpcUrl: string }).rpcUrl;
}

function cli(args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of [
    'ROUTESPEC_DATA_DIR',
    'ROUTESPEC_ATTESTER_KEY',
    'ROUTESPEC_NEAR_SIGNER_KEY',
    'ROUTESPEC_NEAR_SIGNER_ACCOUNT',
  ]) {
    delete env[name];
  }
  env['HOME'] = work.dir;
  env['USERPROFILE'] = work.dir;
  return runCliProcess(args, { cwd: work.dir, env });
}

function chain(): string[] {
  return ['--registry', registryAccount.accountId, '--rpc', rpcUrl()];
}

async function publish(b: CertifiableBundle, keyFile: string): Promise<void> {
  const r = await cli([
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
    keyFile,
    '--near-account',
    payer.accountId,
    '--near-key',
    payerKeyFile,
    '--submit',
  ]);
  expect(r.exitCode, r.stderr).toBe(0);
  expect(r.json?.['submitted']).toBe(true);
}

interface BadgeRun {
  exitCode: number | null;
  json: Record<string, unknown> | null;
  file: string;
  badge: Record<string, unknown> | null;
}

async function badge(target: string[], extra: string[] = [], chainArgs = chain()): Promise<BadgeRun> {
  const file = join(work.dir, `badge-${String(badgeCount++)}.json`);
  const r = await cli(['certificate', 'badge', ...target, ...chainArgs, '--out', file, ...extra]);
  const written = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
    : null;
  return { exitCode: r.exitCode, json: r.json, file, badge: written };
}

async function verifyDigest(digest: string, extra: string[] = []) {
  const r = await cli(['certificate', 'verify', '--digest', digest, ...chain(), ...extra]);
  return r.json?.['release'] as { decision: string; findings: string[]; acceptedCertificateIds: number[] };
}

interface Shown {
  status: string;
  decision: string;
  findings: string[];
  accepted: number[];
  digest: string;
  reason: string;
}

async function shown(page: Page): Promise<Shown> {
  const verdict = page.locator('#result .verdict');
  await verdict.waitFor({ state: 'visible', timeout: 60_000 });
  const attr = async (name: string): Promise<string> => (await verdict.getAttribute(name)) ?? '';
  const list = (s: string): string[] => (s === '' ? [] : s.split(','));
  return {
    status: await attr('data-status'),
    decision: await attr('data-decision'),
    findings: list(await attr('data-findings')),
    accepted: list(await attr('data-accepted')).map(Number),
    digest: await attr('data-digest'),
    reason: await attr('data-reason'),
  };
}

async function openPage(query: string): Promise<{ page: Page; requests: string[]; shown: Shown }> {
  const page = await browser.newPage();
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(`http://127.0.0.1:${String(PAGE_PORT)}/${query}`);
  return { page, requests, shown: await shown(page) };
}

/** Badge, CLI verify and page agree for a digest. */
async function expectAgreement(digest: string, status: string): Promise<void> {
  const b = await badge(['--digest', digest]);
  expect(b.exitCode, JSON.stringify(b.json)).toBe(0);
  expect(b.json?.['status']).toBe(status);
  const release = await verifyDigest(digest);
  const { page, shown: s } = await openPage(`?digest=${digest}`);
  try {
    expect(s.status).toBe(status);
    expect(s.digest).toBe(digest);
    expect({ decision: s.decision, findings: s.findings, accepted: s.accepted }).toEqual({
      decision: release.decision,
      findings: release.findings,
      accepted: release.acceptedCertificateIds,
    });
  } finally {
    await page.close();
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

beforeAll(async () => {
  if (!sandbox.available) return;
  // The production build of the page, exactly what the Pages workflow publishes.
  const built = spawnSync(
    process.execPath,
    [join(appDir, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'],
    {
      cwd: appDir,
      encoding: 'utf8',
    },
  );
  expect(built.status, built.stderr).toBe(0);

  tmpPass = tempDir('routespec-m49-pass-');
  tmpFail = tempDir('routespec-m49-fail-');
  work = tempDir('routespec-m49-work-');
  pass = await makeBundle(tmpPass.dir, { scenarios: ['happy-path'], label: 'm49pass' });
  fail = await makeBundle(tmpFail.dir, { scenarios: ['happy-path', 'refund-shortfall'], label: 'm49fail' });
  expect([pass.decision, fail.decision]).toEqual(['PASS', 'FAIL']);

  rpc = new NearRpc(rpcUrl());
  chainId = await rpc.chainId();
  registryAccount = { accountId: `badge-registry-${suffix}.test.near`, signer: generateSigner() };
  owner = { accountId: `badge-owner-${suffix}.test.near`, signer: generateSigner() };
  payer = { accountId: `badge-payer-${suffix}.test.near`, signer: generateSigner() };
  for (const a of [registryAccount, owner, payer]) await createAccount(rpc, sandboxRoot(sandbox), a);
  await deployRegistry(rpc, registryAccount, new Uint8Array(readFileSync(sandbox.wasmPath)), owner.accountId);
  registry = new RegistryClient(rpc, registryAccount.accountId);
  codeHash = await rpc.codeHash(registryAccount.accountId);

  attesterA = join(work.dir, 'attester-a.pem');
  const made = await cli(['certificate', 'keygen', '--out', attesterA]);
  expect(made.exitCode, made.stderr).toBe(0);
  keyA = String(made.json?.['publicKey']);
  attesterB = generateSigner();
  keyB = publicKeyText(attesterB.publicKey);
  writeFileSync(join(work.dir, 'attester-b.pem'), signerToPem(attesterB));
  payerKeyFile = join(work.dir, 'payer.json');
  const seed = Buffer.concat([payer.signer.seed, payer.signer.publicKey]);
  writeFileSync(
    payerKeyFile,
    JSON.stringify({ account_id: payer.accountId, private_key: `ed25519:${base58Encode(seed)}` }),
  );

  pageConfig = {
    schema: 'routespec.verify-page-config/1',
    project: PROJECT,
    defaultNetwork: 'sandbox',
    networks: { sandbox: { chainId, rpcUrl: rpcUrl(), registry: registryAccount.accountId } },
    trustedAttesters: [],
    knownCodeHashes: [codeHash],
  };
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/config.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(pageConfig));
      return;
    }
    const file = normalize(join(distDir, path === '/' ? 'index.html' : path));
    if (!file.startsWith(distDir) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(PAGE_PORT, '127.0.0.1', r));
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  tmpPass?.cleanup();
  tmpFail?.cleanup();
  work?.cleanup();
});

describe('before any certificate', () => {
  it('badge, CLI verify and page all say: no certificate', async (ctx) => {
    need(ctx);
    await expectAgreement(pass.bundleDigest, 'NO_CERTIFICATE');
    const b = await badge(['--project-key', PROJECT]);
    expect(b.json).toMatchObject({ status: 'NO_CERTIFICATE', projectCertificates: 0, bundleDigest: null });
    expect(b.badge).toEqual({
      schemaVersion: 1,
      label: 'RouteSpec',
      message: 'no certificate',
      color: 'lightgrey',
      cacheSeconds: 3600,
    });
    const { page, shown: s } = await openPage(`?project=${encodeURIComponent(PROJECT)}`);
    expect(s).toMatchObject({ status: 'UNVERIFIED', reason: 'NO_PROJECT_CERTIFICATE' });
    await page.close();
  });
});

describe('a PASS certificate', () => {
  it('is "certified PASS" on the badge, in CLI verify and on the page', async (ctx) => {
    need(ctx);
    await registry.enrolAttester(keyA, 'release attester', owner);
    await registry.enrolAttester(keyB, 'second attester', owner);
    await publish(pass, attesterA);
    await expectAgreement(pass.bundleDigest, 'CERTIFIED_PASS');
    const b = await badge(['--digest', pass.bundleDigest], ['--label', 'RouteSpec testnet']);
    expect(b.badge).toEqual({
      schemaVersion: 1,
      label: 'RouteSpec testnet',
      message: 'certified PASS',
      color: 'brightgreen',
      cacheSeconds: 3600,
    });
    expect(b.json).toMatchObject({
      release: { decision: 'PASS', acceptedCertificateIds: [0], findings: ['BUNDLE_NOT_CHECKED_LOCALLY'] },
    });
  });

  it('recomputes the digest of a chosen bundle file in the browser', async (ctx) => {
    need(ctx);
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${String(PAGE_PORT)}/`);
    await page.locator('#bundle-file').setInputFiles(pass.bundlePath);
    await expect
      .poll(() => page.locator('#bundle-digest').textContent(), { timeout: 30_000 })
      .toContain(pass.bundleDigest);
    await page.locator('#verify').click();
    const s = await shown(page);
    expect(s).toMatchObject({ status: 'CERTIFIED_PASS', digest: pass.bundleDigest, decision: 'PASS' });
    await page.close();
  });

  it('finds the project newest certificate', async (ctx) => {
    need(ctx);
    const b = await badge(['--project-key', PROJECT]);
    expect(b.json).toMatchObject({
      status: 'CERTIFIED_PASS',
      bundleDigest: pass.bundleDigest,
      latestCertificateId: 0,
      projectCertificates: 1,
    });
    const { page, shown: s } = await openPage(`?project=${encodeURIComponent(PROJECT)}`);
    expect(s).toMatchObject({ status: 'CERTIFIED_PASS', digest: pass.bundleDigest });
    await page.close();
  });

  it('is not certified when the registry code is not a known build', async (ctx) => {
    need(ctx);
    if (codeHash === REPRODUCIBLE_CODE_HASH) ctx.skip('the sandbox runs the reproducible build itself');
    const unknown = await badge(
      ['--digest', pass.bundleDigest],
      ['--known-code-hash', REPRODUCIBLE_CODE_HASH],
    );
    expect(unknown.json).toMatchObject({
      status: 'REGISTRY_CODE_UNKNOWN',
      registry: { codeHashKnown: false },
    });
    const known = await badge(['--digest', pass.bundleDigest], ['--known-code-hash', codeHash]);
    expect(known.json).toMatchObject({ status: 'CERTIFIED_PASS', registry: { codeHashKnown: true } });
    pageConfig = { ...pageConfig, knownCodeHashes: [REPRODUCIBLE_CODE_HASH] };
    try {
      const { page, shown: s } = await openPage(`?digest=${pass.bundleDigest}`);
      expect(s.status).toBe('REGISTRY_CODE_UNKNOWN');
      await page.close();
    } finally {
      pageConfig = { ...pageConfig, knownCodeHashes: [codeHash] };
    }
  });
});

describe('a FAIL certificate from a second attester', () => {
  it('is "certified FAIL", and the project badge follows the newest certificate', async (ctx) => {
    need(ctx);
    await publish(fail, join(work.dir, 'attester-b.pem'));
    await expectAgreement(fail.bundleDigest, 'CERTIFIED_FAIL');
    const b = await badge(['--project-key', PROJECT]);
    expect(b.json).toMatchObject({
      status: 'CERTIFIED_FAIL',
      bundleDigest: fail.bundleDigest,
      latestCertificateId: 1,
    });
    expect(b.badge).toMatchObject({ message: 'certified FAIL', color: 'red' });
  });

  it('pinning attester A makes the project badge follow A only, on the badge and on the page', async (ctx) => {
    need(ctx);
    const b = await badge(['--project-key', PROJECT], ['--attester', keyA]);
    expect(b.json).toMatchObject({
      status: 'CERTIFIED_PASS',
      bundleDigest: pass.bundleDigest,
      latestCertificateId: 0,
    });
    const { page, shown: s } = await openPage(
      `?project=${encodeURIComponent(PROJECT)}&attester=${encodeURIComponent(keyA)}`,
    );
    expect(s).toMatchObject({ status: 'CERTIFIED_PASS', digest: pass.bundleDigest });
    expect(await page.locator('[data-notice="ATTESTERS_FROM_LINK"]').count()).toBe(1);
    await page.close();
    // A pinned key that did not sign the FAIL bundle: not certified.
    const pinned = await badge(['--digest', fail.bundleDigest], ['--attester', keyA]);
    expect(pinned.json).toMatchObject({ status: 'NOT_CERTIFIED' });
  });
});

describe('after the second attester is revoked', () => {
  it('its certificate no longer counts on the badge, in CLI verify and on the page', async (ctx) => {
    need(ctx);
    await registry.revokeAttester(keyB, 'key rotated', owner);
    await expectAgreement(fail.bundleDigest, 'ATTESTER_REVOKED');
    await expectAgreement(pass.bundleDigest, 'CERTIFIED_PASS');
    const b = await badge(['--project-key', PROJECT]);
    expect(b.json).toMatchObject({ status: 'ATTESTER_REVOKED', bundleDigest: fail.bundleDigest });
    expect(b.badge).toMatchObject({ message: 'attester revoked', color: 'orange' });
  });
});

describe('refusals', () => {
  it('an unreachable registry writes no badge, or an "unverified" one with --write-on-error', async (ctx) => {
    need(ctx);
    const dead = ['--registry', registryAccount.accountId, '--rpc', `http://127.0.0.1:${String(DEAD_PORT)}`];
    const plain = await badge(['--digest', pass.bundleDigest], [], dead);
    expect(plain.exitCode).toBe(5);
    expect(plain.badge).toBeNull();
    const marked = await badge(['--digest', pass.bundleDigest], ['--write-on-error'], dead);
    expect(marked.exitCode).toBe(0);
    expect(marked.json).toMatchObject({ status: 'UNVERIFIED', error: { code: 'RS_REGISTRY_UNAVAILABLE' } });
    expect(marked.badge).toMatchObject({ message: 'unverified', isError: true });
    const notRegistry = await badge(
      ['--digest', pass.bundleDigest],
      ['--write-on-error'],
      ['--registry', payer.accountId, '--rpc', rpcUrl()],
    );
    expect(notRegistry.json).toMatchObject({ status: 'UNVERIFIED', error: { code: 'RS_REGISTRY_REJECTED' } });
  });

  it('the page refuses a link that names a public RPC endpoint and contacts nothing for it', async (ctx) => {
    need(ctx);
    const {
      page,
      requests,
      shown: s,
    } = await openPage(`?digest=${pass.bundleDigest}&rpc=${encodeURIComponent('https://rpc.example.com')}`);
    expect(s).toMatchObject({ status: 'UNVERIFIED', reason: 'LINK_INVALID' });
    expect(requests.filter((u) => new URL(u).hostname.endsWith('example.com'))).toEqual([]);
    await page.close();
  });

  it('the page refuses an account from a link that is not a registry', async (ctx) => {
    need(ctx);
    const { page, shown: s } = await openPage(`?digest=${pass.bundleDigest}&registry=${payer.accountId}`);
    expect(s.status).toBe('UNVERIFIED');
    expect(s.reason).toMatch(/CodeDoesNotExist|NO_CONTRACT_CODE|MethodNotFound|NOT_A_ROUTESPEC_REGISTRY/);
    await page.close();
  });
});
