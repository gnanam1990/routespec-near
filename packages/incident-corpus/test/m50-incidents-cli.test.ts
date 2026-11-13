/**
 * M50: the `routespec-incidents` command, run as a real separate process. stdout is one JSON
 * document; exit codes follow the `routespec` CLI (0 ok, 4 configuration, 6 policy denial).
 *
 * The live `import` is exercised only up to its preconditions: without the owner's key no
 * request is made, and nothing here contacts the real service.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURE_PATH } from './support/fixture.ts';

const ENTRY = fileURLToPath(new URL('../bin/routespec-incidents.mjs', import.meta.url));
const COMMITTED = fileURLToPath(new URL('../corpora/mainnet-observed-2026-11', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'routespec-m50-cli-'));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function run(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string; json: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ROUTESPEC_EXPLORER_JWT: undefined, ...env })) {
      if (v !== undefined) merged[k] = v;
    }
    const child = spawn(process.execPath, ['--no-warnings', ENTRY, ...args], {
      env: merged,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('close', (exitCode) => {
      expect(stdout.trim().split('\n'), stdout + stderr).toHaveLength(1);
      const json = JSON.parse(stdout) as Record<string, unknown>;
      expect(json['exitCode']).toBe(exitCode);
      expect(json['ok']).toBe(exitCode === 0);
      resolve({ exitCode, stdout, stderr, json });
    });
  });
}
const errorCode = (r: { json: Record<string, unknown> }) => (r.json['error'] as { code: string }).code;

describe('M50 routespec-incidents command', () => {
  it('builds, verifies and registers the shape-fixture corpus', async () => {
    const out = join(root, 'fixture-corpus');
    const built = await run(['build-fixture', '--recording', FIXTURE_PATH, '--out', out, '--recheck-after-sec', '3600']);
    expect(built.exitCode, built.stdout + built.stderr).toBe(0);
    expect(built.json).toMatchObject({
      command: 'build-fixture',
      corpusLabel: 'explorer-shape-fixture',
      importStatus: 'PENDING_LIVE_IMPORT',
      sourceKind: 'DOCUMENTED_SHAPE_FIXTURE',
      templates: 10,
      counts: { recordsRead: 12, incidents: 11 },
    });
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { manifestDigest: string };
    expect(built.json['manifestDigest']).toBe(manifest.manifestDigest);

    const verified = await run(['verify', '--corpus', out]);
    expect(verified.exitCode).toBe(0);
    expect(verified.json).toMatchObject({ valid: true, templates: 10, manifestDigest: manifest.manifestDigest });

    const data = join(root, 'data');
    const registered = await run(['register', '--corpus', out, '--data', data]);
    expect(registered.exitCode, registered.stdout + registered.stderr).toBe(0);
    expect(registered.json['corpusRevisionId']).toMatch(/^[0-9a-f-]{36}$/);
    expect(registered.json['corpusDigest']).toMatch(/^sha256:/);
    expect(registered.json['cases']).toHaveLength(10);
    expect(registered.json['requiredInvariants']).toEqual([
      'INV-01',
      'INV-02',
      'INV-03',
      'INV-05',
      'INV-06',
      'INV-07',
      'INV-08',
    ]);

    // Without --replace the existing corpus directory is not overwritten.
    const again = await run(['build-fixture', '--recording', FIXTURE_PATH, '--out', out]);
    expect(again.exitCode).toBe(6);
    expect(errorCode(again)).toBe('RS_EXPORT_OVERWRITE_DENIED');
  });

  it('refuses to give fixture data the mainnet label', async () => {
    const r = await run([
      'build-fixture',
      '--recording',
      FIXTURE_PATH,
      '--out',
      join(root, 'mislabelled'),
      '--label',
      'mainnet-observed-2026-11',
    ]);
    expect(r.exitCode).toBe(6);
    expect(errorCode(r)).toBe('RS_MODE_POLICY_DENIED');
  });

  it('the live import needs the key in the environment and names the variable, not a value', async () => {
    const out = join(root, 'live');
    const missing = await run(['import', '--out', out]);
    expect(missing.exitCode).toBe(4);
    expect(errorCode(missing)).toBe('RS_CLI_USAGE');
    expect(missing.stdout + missing.stderr).toContain('ROUTESPEC_EXPLORER_JWT');

    const malformed = 'this-is-not-a-compact-token-value';
    const bad = await run(['import', '--out', out], { ROUTESPEC_EXPLORER_JWT: malformed });
    expect(bad.exitCode).toBe(6);
    expect(errorCode(bad)).toBe('RS_TOKEN_INVALID');
    expect(bad.stdout + bad.stderr).not.toContain(malformed);

    for (const args of [
      ['import', '--out', out, '--label', 'explorer-shape-fixture'],
      ['import', '--out', out, '--label', 'mainnet-observed-2026-13'],
      ['import', '--out', out, '--stuck-after-sec', '1234'],
      ['import', '--out', out, '--start', 'yesterday'],
      ['import', '--out', out, '--origin', 'http://127.0.0.1:9511'],
      ['import'],
      ['nonsense'],
    ]) {
      const r = await run(args);
      expect(r.exitCode, args.join(' ')).toBe(4);
      expect(errorCode(r), args.join(' ')).toBe('RS_CLI_USAGE');
    }
  });

  it('verifies the committed mainnet corpus directory and refuses to register it while pending', async () => {
    const verified = await run(['verify', '--corpus', COMMITTED]);
    expect(verified.exitCode).toBe(0);
    expect(verified.json['corpusLabel']).toBe('mainnet-observed-2026-11');
    if (verified.json['importStatus'] === 'PENDING_LIVE_IMPORT') {
      const r = await run(['register', '--corpus', COMMITTED, '--data', join(root, 'pending-data')]);
      expect(r.exitCode).toBe(4);
      expect(errorCode(r)).toBe('RS_IMPORT_STATE_INVALID');
    }
  });
});
