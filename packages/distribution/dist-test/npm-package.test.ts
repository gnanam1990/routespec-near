/**
 * M54: the npm package is built from the compiled workspace, installed offline from its tarball
 * into an empty consumer directory outside the repository, and its commands run for real.
 *
 * - The tarball carries no TypeScript sources, no build-machine paths, provenance metadata, and
 *   every runtime dependency bundled.
 * - The installed `routespec` CLI answers with its JSON contract and exit codes.
 * - The installed `routespec-ci run` gates the repository's own self-gate configuration: the gate
 *   code that runs is the installed copy (the consumer directory is outside the repository, so
 *   nothing resolves back into the workspace); the subject is the repository's sample client.
 * - The installed CLI verifies the committed evidence bundle of the contained run offline.
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseScenarioSource } from '@routespec/scenario';
import {
  ROOT,
  npm,
  packNpmPackage,
  readPublishManifest,
  stageNpmPackage,
  type PackResult,
  type StagedPackage,
} from '../src/npm-package.ts';

type J = Record<string, unknown>;

const CLOSED_PROXY = 'http://127.0.0.1:9';
const work = mkdtempSync(join(tmpdir(), 'routespec-m54-npm-'));
let staged: StagedPackage;
let packed: PackResult;
let installed: string;

function hostEnv(extra: Record<string, string> = {}): Record<string, string> {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE'];
  const keepMore = ['APPDATA', 'LOCALAPPDATA', 'ComSpec', 'PATHEXT', 'windir'];
  const out: Record<string, string> = {};
  for (const k of [...keep, ...keepMore]) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return { ...out, ...extra };
}

function run(
  entry: string,
  args: readonly string[],
  cwd: string,
  options: { program?: string; env?: Record<string, string> } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; json: J | null }> {
  return new Promise((resolve) => {
    const child = spawn(options.program ?? process.execPath, [entry, ...args], {
      cwd,
      env: hostEnv(options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('close', (code) => {
      let json: J | null = null;
      try {
        json = JSON.parse(stdout) as J;
      } catch {
        json = null;
      }
      resolve({ code, stdout, stderr, json });
    });
  });
}

beforeAll(() => {
  staged = stageNpmPackage({ outDir: join(work, 'stage') });
  packed = packNpmPackage(staged, join(work, 'pack'));
  const consumer = join(work, 'consumer');
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, 'package.json'), '{"name":"consumer","private":true}\n');
  // Offline, with every proxy pointing at a closed port: an install that needed the registry fails.
  npm(
    ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', packed.tarball],
    consumer,
    hostEnv({
      HTTP_PROXY: CLOSED_PROXY,
      HTTPS_PROXY: CLOSED_PROXY,
      npm_config_proxy: CLOSED_PROXY,
      npm_config_https_proxy: CLOSED_PROXY,
      npm_config_cache: join(work, 'npm-cache'),
    }),
  );
  installed = join(consumer, 'node_modules', 'routespec');
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('M54 npm package', () => {
  it('has the publish metadata, bins, provenance, and every runtime dependency bundled', () => {
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as J;
    const template = readPublishManifest();
    expect(manifest).toMatchObject({
      name: template.name,
      version: template.version,
      license: 'MIT',
      type: 'module',
      bin: { routespec: 'bin/routespec.mjs', 'routespec-ci': 'bin/routespec-ci.mjs' },
      publishConfig: { access: 'public', provenance: true },
      repository: { url: 'git+https://github.com/gnanam1990/routespec-near.git' },
      engines: { node: '>=22.18.0' },
    });
    const deps = Object.keys(manifest['dependencies'] as J).sort();
    expect(manifest['bundleDependencies']).toEqual(deps);
    expect(deps).toEqual(expect.arrayContaining(['@routespec/cli', '@routespec/ci', 'zod', 'yaml']));
    expect([...packed.bundled].sort()).toEqual(deps);
    expect(packed.integrity).toMatch(/^sha512-/);
  });

  it('ships compiled JavaScript only and no build-machine paths', () => {
    const shipped = packed.files;
    expect(shipped.length).toBe(packed.entryCount);
    const ownFiles = shipped.filter((f) => f.startsWith('node_modules/@routespec/') || f.startsWith('bin/'));
    expect(ownFiles.length).toBeGreaterThan(100);
    expect(ownFiles.filter((f) => /\.(?:ts|mts|cts)$/.test(f))).toEqual([]);
    expect(
      shipped.filter((f) => /(?:^|\/)(?:test|sandbox-test)\//.test(f) && f.includes('@routespec/')),
    ).toEqual([]);
    const needles = [ROOT, ROOT.replace(/\\/g, '/'), homedir(), homedir().replace(/\\/g, '/')];
    const hits: string[] = [];
    for (const rel of ownFiles) {
      const text = readFileSync(join(staged.dir, rel), 'utf8');
      for (const n of needles) if (text.includes(n)) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });

  it('installed offline: the CLI answers with its JSON contract and usage exit code', async () => {
    expect(existsSync(join(installed, '..', '.bin'))).toBe(true);
    expect(readdirSync(join(installed, '..', '.bin'))).toEqual(
      expect.arrayContaining(['routespec', 'routespec-ci']),
    );
    const r = await run(join(installed, 'bin', 'routespec.mjs'), [], work);
    expect(r.code).toBe(4);
    expect(r.json).toMatchObject({ ok: false, cli: 'routespec-cli@1.0.0', error: { code: 'RS_CLI_USAGE' } });
    expect(r.stderr).not.toContain('ExperimentalWarning');
  });

  it('installed offline: routespec-ci gates the self-gate configuration to PASS', async () => {
    const r = await run(
      join(installed, 'bin', 'routespec-ci.mjs'),
      [
        'run',
        '--config',
        '.github/routespec/routespec.ci.json',
        '--workspace',
        ROOT,
        '--work-dir',
        join(work, 'ci-work'),
      ],
      ROOT,
    );
    expect(r.code, r.stderr.slice(-2000)).toBe(0);
    expect(r.json).toMatchObject({
      schema: 'routespec.ci-result/1',
      decision: 'PASS',
      conclusion: 'success',
      enforcement: { mode: 'LOCAL_ADVISORY', blocking: false },
    });
  });

  it('installed offline: the CLI verifies the committed contained-run bundle', async () => {
    const r = await run(
      join(installed, 'bin', 'routespec.mjs'),
      [
        'export',
        'verify',
        '--bundle',
        join(ROOT, 'packages', 'distribution', 'console-demo', 'evidence-bundle.tar'),
        '--extract-to',
        join(work, 'extract'),
      ],
      work,
    );
    expect(r.code, r.stderr.slice(-2000)).toBe(0);
    expect(r.json).toMatchObject({ verified: true, decision: 'PASS', findings: [] });
  });

  // The step hands withheld values to Node over file descriptor 3 from a bash process
  // substitution, as a Linux runner does; Git Bash on Windows cannot pass that descriptor to a
  // native Node process, so this check runs on Linux only (the in-repository action's step test,
  // SEC vuln-0001, has the same limit).
  it.skipIf(process.platform !== 'linux')(
    'the Marketplace gate step script runs the installed package to PASS and withholds a CI token',
    async () => {
      const action = parseScenarioSource(
        readFileSync(join(ROOT, 'packages', 'distribution', 'marketplace', 'action.yml'), 'utf8'),
        'yaml',
        { maxSourceBytes: 256 * 1024, maxDepth: 32, maxAliases: 0, maxStringLength: 16 * 1024 },
      ) as J;
      const gate = ((action['runs'] as J)['steps'] as J[]).find((s) => s['id'] === 'gate') as J;
      const runnerTemp = join(work, 'runner-temp');
      mkdirSync(runnerTemp, { recursive: true });
      const r = await run('-c', [gate['run'] as string], ROOT, {
        program: 'bash',
        env: {
          ROUTESPEC_PACKAGE_DIR: installed.split('\\').join('/'),
          ROUTESPEC_CI_CONFIG: '.github/routespec/routespec.ci.json',
          GITHUB_WORKSPACE: ROOT,
          RUNNER_TEMP: runnerTemp,
          GITHUB_TOKEN: 'm54-withheld-test-value',
        },
      });
      expect(r.code, r.stderr.slice(-2000)).toBe(0);
      expect(r.json).toMatchObject({ decision: 'PASS', conclusion: 'success' });
      expect(r.json?.['withheldEnvironment']).toEqual(['GITHUB_TOKEN']);
      expect(r.stdout).not.toContain('m54-withheld-test-value');
    },
  );
});
