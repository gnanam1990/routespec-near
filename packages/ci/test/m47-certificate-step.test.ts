/**
 * M47 — the CI certificate step without a chain: when it must do nothing, what it refuses, and
 * the workflow policy around the signer secrets.
 *
 * The real `routespec-ci` entry point runs as a separate process with a crafted runner
 * environment (see `support/harness.ts`). A real gate run in a trusted job provides the staged
 * bundle and the journal. Publication against a real node is in the near-sandbox suite.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseScenarioSource } from '@routespec/scenario';
import { base58Encode, generateSigner, type Ed25519Signer } from '@routespec/registry';
import { childEnvironment, isWithheldName, withheldNames, withholdSecrets } from '../src/index.ts';
import {
  ROOT,
  baseConfig,
  fixture,
  githubEnv,
  outputs,
  runAction,
  runCi,
  writeConfig,
  type CiRun,
  type Fixture,
} from './support/harness.ts';

type J = Record<string, unknown>;
const LIMITS = { maxSourceBytes: 256 * 1024, maxDepth: 32, maxAliases: 0, maxStringLength: 16 * 1024 };
const REGISTRY = 'gnanam1990-routespec.testnet';

function secretText(signer: Ed25519Signer): string {
  return `ed25519:${base58Encode(Buffer.concat([signer.seed, signer.publicKey]))}`;
}

let f: Fixture;
let gate: CiRun;
let gateOutputs: Record<string, string>;
const attester = generateSigner();
const payer = generateSigner();
const SIGNER = {
  ROUTESPEC_ATTESTER_KEY: secretText(attester),
  ROUTESPEC_NEAR_SIGNER_ACCOUNT: 'payer.testnet',
  ROUTESPEC_NEAR_SIGNER_KEY: secretText(payer),
};

function step(
  event: Parameters<typeof githubEnv>[1],
  flags: Record<string, string>,
  extraEnv: Record<string, string> = {},
): Promise<CiRun & { files: ReturnType<typeof githubEnv>['files'] }> {
  const { env, files } = githubEnv(f, event, extraEnv);
  const args = [
    'certificate',
    ...Object.entries({
      bundle: gateOutputs['certificate-bundle'] as string,
      journal: gateOutputs['certificate-journal'] as string,
      decision: 'PASS',
      'project-key': 'example/routespec-subject',
      registry: REGISTRY,
      rpc: 'http://127.0.0.1:9508',
      ...flags,
    }).map(([k, v]) => `--${k}=${v}`),
  ];
  return runCi(args, env).then((r) => ({ ...r, files }));
}

function noSecret(run: CiRun, files: { output: string; summary: string }): void {
  const text = `${run.stdout}${run.stderr}${readFileSync(files.output, 'utf8')}${readFileSync(files.summary, 'utf8')}`;
  for (const value of [SIGNER.ROUTESPEC_ATTESTER_KEY, SIGNER.ROUTESPEC_NEAR_SIGNER_KEY]) {
    expect(text).not.toContain(value);
    expect(text).not.toContain(value.slice(8, 40));
  }
}

beforeAll(async () => {
  f = fixture('m47-step');
  const config = writeConfig(
    f,
    baseConfig(f, { uploads: { include: ['gate-report-json', 'evidence-bundle'], retentionDays: 3 } }),
  );
  const { env, files } = githubEnv(f, { kind: 'push', ref: 'refs/heads/main' }, SIGNER);
  gate = await runAction(f, config, env);
  gateOutputs = outputs(files.output);
});

afterAll(() => f?.cleanup());

describe('the gate step and the signer secrets', () => {
  it('withholds the signer secrets from everything the gate step starts or loads', () => {
    expect(isWithheldName('ROUTESPEC_ATTESTER_KEY')).toBe(true);
    expect(isWithheldName('ROUTESPEC_NEAR_SIGNER_KEY')).toBe(true);
    expect(withheldNames({ ...SIGNER, PATH: '/bin' })).toEqual([
      'ROUTESPEC_ATTESTER_KEY',
      'ROUTESPEC_NEAR_SIGNER_KEY',
    ]);
    const env: Record<string, string | undefined> = { ...SIGNER, PATH: '/bin' };
    const withheld = withholdSecrets(env);
    expect(withheld.names).toEqual(['ROUTESPEC_ATTESTER_KEY', 'ROUTESPEC_NEAR_SIGNER_KEY']);
    expect(env['ROUTESPEC_ATTESTER_KEY']).toBeUndefined();
    expect(env['ROUTESPEC_NEAR_SIGNER_KEY']).toBeUndefined();
    const child = childEnvironment({ ...SIGNER, PATH: '/bin' });
    expect(Object.keys(child).sort()).toEqual(['PATH', 'ROUTESPEC_NEAR_SIGNER_ACCOUNT']);
  });

  it('passes in a trusted job, reports the secrets as withheld, and names the bundle to certify', () => {
    expect(gate.exitCode, gate.stderr).toBe(0);
    expect(gate.json).toMatchObject({ decision: 'PASS', context: { trust: 'TRUSTED' } });
    expect(gate.json?.['withheldEnvironment']).toEqual(
      expect.arrayContaining(['ROUTESPEC_ATTESTER_KEY', 'ROUTESPEC_NEAR_SIGNER_KEY']),
    );
    const certificate = gate.json?.['certificate'] as { bundlePath: string; journalDirectory: string };
    expect(existsSync(certificate.bundlePath)).toBe(true);
    expect(existsSync(join(certificate.journalDirectory, 'journal.db'))).toBe(true);
    expect(gateOutputs['certificate-bundle']).toBe(certificate.bundlePath);
    expect(gateOutputs['certificate-journal']).toBe(certificate.journalDirectory);
    expect(certificate.bundlePath.startsWith(String(gate.json?.['uploadDirectory']))).toBe(true);
    expect(`${gate.stdout}${gate.stderr}`).not.toContain(SIGNER.ROUTESPEC_ATTESTER_KEY.slice(8, 40));
  });

  it('names no bundle to certify in a pull-request job', async () => {
    const pr = fixture('m47-pr');
    try {
      const config = writeConfig(
        pr,
        baseConfig(pr, { uploads: { include: ['gate-report-json', 'evidence-bundle'], retentionDays: 3 } }),
      );
      const { env, files } = githubEnv(pr, { kind: 'pull_request', fork: false }, SIGNER);
      const r = await runAction(pr, config, env);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.json).toMatchObject({ decision: 'PASS', certificate: null });
      expect(outputs(files.output)['certificate-bundle']).toBe('');
    } finally {
      pr.cleanup();
    }
  });
});

describe('routespec-ci certificate: when it does nothing', () => {
  it('skips a decision that is not PASS, even with a signer configured', async () => {
    for (const decision of ['FAIL', 'REVIEW', 'NOT_RUN', 'NONE']) {
      const r = await step({ kind: 'push', ref: 'refs/heads/main' }, { decision }, SIGNER);
      expect(r.exitCode, decision).toBe(0);
      expect(r.json).toMatchObject({
        schema: 'routespec.ci-certificate/1',
        status: 'SKIPPED_DECISION_NOT_PASS',
        certificateId: null,
        transactionHash: null,
      });
      expect(outputs(r.files.output)['certificate-status']).toBe('SKIPPED_DECISION_NOT_PASS');
      noSecret(r, r.files);
    }
  });

  it('skips every untrusted job and flags a signer secret found there', async () => {
    const events: Array<[Parameters<typeof githubEnv>[1], string]> = [
      [{ kind: 'pull_request', fork: false }, 'PULL_REQUEST'],
      [{ kind: 'pull_request', fork: true }, 'FORK'],
      [{ kind: 'pull_request_target', headRepo: 'someone/routespec-subject' }, 'FORK'],
      [{ kind: 'push', ref: 'refs/heads/feature' }, 'UNTRUSTED'],
      [{ kind: 'workflow_run' }, 'UNTRUSTED'],
    ];
    for (const [event, trust] of events) {
      const r = await step(event, {}, SIGNER);
      expect(r.exitCode, trust).toBe(0);
      expect(r.json, trust).toMatchObject({
        status: 'SKIPPED_UNTRUSTED_CONTEXT',
        trust,
        findings: ['SIGNER_SECRET_PRESENT_IN_UNTRUSTED_JOB'],
        certificateId: null,
      });
      noSecret(r, r.files);
    }
    const clean = await step({ kind: 'pull_request', fork: true }, {});
    expect(clean.json).toMatchObject({ status: 'SKIPPED_UNTRUSTED_CONTEXT', findings: [] });
  });

  it('skips when no signer is configured and says so in the summary', async () => {
    const r = await step({ kind: 'push', ref: 'refs/heads/main' }, {});
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ status: 'SKIPPED_NO_SIGNER', trust: 'TRUSTED' });
    expect(readFileSync(r.files.summary, 'utf8')).toContain('| Status | SKIPPED_NO_SIGNER |');
  });

  it('honours a custom trusted ref list', async () => {
    const r = await step(
      { kind: 'push', ref: 'refs/heads/release' },
      { 'trusted-refs': 'refs/heads/main,refs/heads/release' },
    );
    expect(r.json).toMatchObject({ status: 'SKIPPED_NO_SIGNER', trust: 'TRUSTED' });
    const bad = await step({ kind: 'push', ref: 'refs/heads/main' }, { 'trusted-refs': 'main' });
    expect(bad.exitCode).toBe(4);
  });
});

describe('routespec-ci certificate: refusals', () => {
  it('treats a partly configured signer as a configuration error', async () => {
    for (const missing of Object.keys(SIGNER)) {
      const partial = Object.fromEntries(Object.entries(SIGNER).filter(([k]) => k !== missing));
      const r = await step({ kind: 'push', ref: 'refs/heads/main' }, {}, partial);
      expect(r.exitCode, missing).toBe(4);
      expect(r.json).toMatchObject({
        status: 'FAILED',
        error: { code: 'RS_SCHEMA_INVALID', details: { missing } },
      });
      noSecret(r, r.files);
    }
  });

  it('fails visibly, without a certificate, when the registry cannot be reached', async () => {
    const r = await step({ kind: 'push', ref: 'refs/heads/main' }, {}, SIGNER);
    expect(r.exitCode).toBe(5);
    expect(r.json).toMatchObject({
      status: 'FAILED',
      trust: 'TRUSTED',
      error: { code: 'RS_REGISTRY_UNAVAILABLE' },
      certificateId: null,
    });
    expect(outputs(r.files.output)).toMatchObject({ 'certificate-status': 'FAILED', 'certificate-id': '' });
    noSecret(r, r.files);
  });

  it('refuses unknown inputs, missing inputs and an endpoint that is not https', async () => {
    const unknown = await step({ kind: 'push', ref: 'refs/heads/main' }, { blocking: 'true' }, SIGNER);
    expect(unknown.exitCode).toBe(4);
    const noBundle = await step({ kind: 'push', ref: 'refs/heads/main' }, { bundle: '' }, SIGNER);
    expect(noBundle.exitCode).toBe(4);
    expect(noBundle.json).toMatchObject({ error: { code: 'RS_CLI_USAGE', details: { flag: 'bundle' } } });
    const plainHttp = await step(
      { kind: 'push', ref: 'refs/heads/main' },
      { rpc: 'http://rpc.example.com' },
      SIGNER,
    );
    expect(plainHttp.exitCode).toBe(4);
    noSecret(plainHttp, plainHttp.files);
  });
});

describe('certificate workflow policy', () => {
  function load(rel: string): { text: string; doc: J } {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    return { text, doc: parseScenarioSource(text, 'yaml', LIMITS) as J };
  }

  it('runs only on push to main or by hand, read-only, with every third-party action pinned', () => {
    const { doc } = load('.github/workflows/routespec-certificate.yml');
    expect(Object.keys(doc['on'] as J).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(((doc['on'] as J)['push'] as J)['branches']).toEqual(['main']);
    expect(doc['permissions']).toEqual({ contents: 'read' });
    const jobs = doc['jobs'] as Record<string, J>;
    for (const rel of [
      '.github/workflows/routespec-certificate.yml',
      '.github/actions/routespec-certificate/action.yml',
    ]) {
      const d = load(rel).doc;
      const steps = ((d['runs'] as J | undefined)?.['steps'] ??
        Object.values(d['jobs'] as Record<string, J>).flatMap((j) => j['steps'] as J[])) as J[];
      for (const s of steps) {
        const uses = s['uses'];
        if (typeof uses === 'string' && !uses.startsWith('./')) {
          expect(uses, rel).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
        }
        if (typeof s['run'] === 'string') expect(s['run'], rel).not.toContain('${{');
        if (String(uses ?? '').startsWith('actions/checkout@')) {
          expect((s['with'] as J)['persist-credentials']).toBe(false);
        }
      }
    }
    expect(Object.values(jobs).every((j) => j['permissions'] === undefined)).toBe(true);
  });

  it('hands secrets to the certificate step only, and only after a PASS in a trusted job', () => {
    const { doc } = load('.github/workflows/routespec-certificate.yml');
    const steps = Object.values(doc['jobs'] as Record<string, J>).flatMap((j) => j['steps'] as J[]);
    const withSecrets = steps.filter((s) => JSON.stringify(s).includes('secrets.'));
    expect(withSecrets).toHaveLength(1);
    const certificate = withSecrets[0] as J;
    expect(certificate['uses']).toBe('./.github/actions/routespec-certificate');
    expect(certificate['if']).toBe(
      "${{ steps.gate.outputs.decision == 'PASS' && steps.gate.outputs.trust == 'TRUSTED' }}",
    );
    expect(certificate['with']).toMatchObject({
      bundle: '${{ steps.gate.outputs.certificate-bundle }}',
      journal: '${{ steps.gate.outputs.certificate-journal }}',
      decision: '${{ steps.gate.outputs.decision }}',
    });
    const gateStep = steps.find((s) => s['id'] === 'gate') as J;
    expect(JSON.stringify(gateStep)).not.toContain('secrets');
    expect(gateStep['env']).toBeUndefined();
    expect(steps.indexOf(gateStep)).toBeLessThan(steps.indexOf(certificate));
    // The pull-request workflows still reference no secret at all.
    for (const rel of ['.github/workflows/ci.yml', '.github/workflows/routespec-gate.yml']) {
      expect(load(rel).text, rel).not.toMatch(/\$\{\{[^}]*\bsecrets\b/);
    }
  });

  it('the action maps every input to an environment variable and passes no secret as an argument', () => {
    const { doc } = load('.github/actions/routespec-certificate/action.yml');
    const run = ((doc['runs'] as J)['steps'] as J[]).find((s) => s['id'] === 'certificate') as J;
    expect(run['env']).toMatchObject({
      ROUTESPEC_ATTESTER_KEY: '${{ inputs.attester-key }}',
      ROUTESPEC_NEAR_SIGNER_ACCOUNT: '${{ inputs.near-signer-account }}',
      ROUTESPEC_NEAR_SIGNER_KEY: '${{ inputs.near-signer-key }}',
    });
    const script = String(run['run']);
    expect(script).not.toMatch(
      /ROUTESPEC_ATTESTER_KEY|ROUTESPEC_NEAR_SIGNER_KEY|ROUTESPEC_NEAR_SIGNER_ACCOUNT/,
    );
    expect(script).toContain('routespec-ci.mjs" certificate');
  });
});
