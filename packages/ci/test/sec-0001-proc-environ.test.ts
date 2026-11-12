/**
 * SEC vuln-0001 — withheld credentials must not survive in the action's initial environment.
 * Extends T-058 (FR-17, NFR-03, INV-11).
 *
 * Deleting a variable from `process.env` only edits the C `environ` array. On Linux the kernel
 * still serves the original block through `/proc/<pid>/environ`, so a client module loaded into
 * the action, or any same-user subject it starts, could read a withheld credential there. The
 * gate step must therefore start the action process without those variables at all.
 *
 * This test takes the gate step's `run:` text from the shipped composite action, runs it the way
 * a GitHub runner does (a script file under `bash --noprofile --norc -eo pipefail`) with canary
 * credentials planted in the step environment, and has the sample client module report which
 * planted names appear in `/proc/self/environ` (the action process, the subject's parent) and in
 * the action's parent. Names only are reported, never values. Linux only: `/proc` is required.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ROOT,
  baseConfig,
  fixture,
  githubEnv,
  leaksIn,
  outputs,
  writeConfig,
  type Fixture,
} from './support/harness.ts';
import { parseLauncherWithheld, withheldNames, withholdSecrets } from '../src/secrets.ts';

describe('SEC vuln-0001 — the withheld-credentials handoff from the step shell', () => {
  const entry = (name: string, value: string) => `${name}=${value}\0`;

  it('names only withheld variables the shell can unexport', () => {
    expect(
      withheldNames({
        GITHUB_TOKEN: 'x',
        ROUTESPEC_PROVIDER_JWT: 'y',
        INPUT_API_KEY: 'z',
        PATH: '/usr/bin',
        GITHUB_SHA: 'abc',
      }),
    ).toEqual(['GITHUB_TOKEN', 'INPUT_API_KEY', 'ROUTESPEC_PROVIDER_JWT']);
  });

  it('parses NUL-terminated NAME=VALUE entries, keeping "=" and newlines inside values', () => {
    const bytes = Buffer.from(entry('ROUTESPEC_PROVIDER_JWT', 'a=b\nc-value') + entry('GITHUB_TOKEN', ''));
    expect(parseLauncherWithheld(bytes)).toEqual({
      ROUTESPEC_PROVIDER_JWT: 'a=b\nc-value',
      GITHUB_TOKEN: '',
    });
    expect(parseLauncherWithheld(Buffer.alloc(0))).toEqual({});
  });

  it('fails closed on a malformed handoff or a name that is not withheld', () => {
    for (const bad of [
      'GITHUB_TOKEN=unterminated',
      entry('PATH', '/usr/bin'),
      '=value\0',
      entry('GITHUB_TOKEN', 'a') + entry('GITHUB_TOKEN', 'b'),
    ]) {
      expect(() => parseLauncherWithheld(Buffer.from(bad)), JSON.stringify(bad)).toThrow(
        expect.objectContaining({ code: 'RS_INTERNAL' }),
      );
    }
  });

  it('records shell-withheld credentials like in-process ones (names, provider finding, scan values)', () => {
    const env: Record<string, string | undefined> = { NPM_TOKEN: 'npm-token-value-1', PATH: '/usr/bin' };
    const w = withholdSecrets(env, {
      ROUTESPEC_PROVIDER_JWT: 'provider-value-1',
      GITHUB_TOKEN: 'short',
      PATH: 'ignored-not-withheld',
    });
    expect(w.names).toEqual(['GITHUB_TOKEN', 'NPM_TOKEN', 'ROUTESPEC_PROVIDER_JWT']);
    expect(w.providerSecretPresent).toBe(true);
    expect([...w.values].sort()).toEqual(['npm-token-value-1', 'provider-value-1']);
    expect(env).toEqual({ PATH: '/usr/bin' });
  });
});

const PROVIDER = `rs-canary-provider-${randomBytes(12).toString('hex')}`;
const ID_TOKEN = `rs-canary-id-token-${randomBytes(12).toString('hex')}`;
const RUNTIME = `rs-canary-runtime-${randomBytes(12).toString('hex')}`;
const GH_TOKEN = `rs-canary-gh-${randomBytes(12).toString('hex')}`;
const CANARIES = [PROVIDER, ID_TOKEN, RUNTIME, GH_TOKEN];
const PLANTED: Record<string, string> = {
  ROUTESPEC_PROVIDER_JWT: PROVIDER,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: ID_TOKEN,
  ACTIONS_RUNTIME_TOKEN: RUNTIME,
  GITHUB_TOKEN: GH_TOKEN,
};

/** The `run:` text of the composite action's `gate` step (single line or `|` block). */
function gateRunScript(): string {
  const yml = readFileSync(join(ROOT, '.github', 'actions', 'routespec-gate', 'action.yml'), 'utf8');
  const lines = yml.split(/\r?\n/);
  const idAt = lines.findIndex((l) => /^\s+id: gate\s*$/.test(l));
  expect(idAt).toBeGreaterThan(0);
  const runAt = lines.findIndex((l, i) => i > idAt && /^\s+run:/.test(l));
  expect(runAt).toBeGreaterThan(idAt);
  const head = lines[runAt] as string;
  const inline = head.replace(/^\s+run:\s*/, '');
  if (inline !== '|' && inline !== '>') return `${inline}\n`;
  const indent = (lines[runAt + 1]?.match(/^\s*/) as RegExpMatchArray)[0].length;
  const body: string[] = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i] as string;
    if (l.trim() !== '' && (l.match(/^\s*/) as RegExpMatchArray)[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return `${body.join('\n')}\n`;
}

interface StepRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly json: Record<string, unknown>;
}

function runGateStep(f: Fixture, cfg: string, env: Record<string, string>): Promise<StepRun> {
  const script = join(f.work, 'gate-step.sh');
  writeFileSync(script, gateRunScript());
  return new Promise((resolve) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
      cwd: ROOT,
      env: {
        PATH: `${dirname(process.execPath)}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
        HOME: process.env['HOME'] ?? f.work,
        TMPDIR: process.env['TMPDIR'] ?? '/tmp',
        ...env,
        ROUTESPEC_ACTION_ROOT: ROOT,
        ROUTESPEC_CI_CONFIG: cfg,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('close', (code) => {
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        json = {};
      }
      resolve({ exitCode: code, stdout, stderr, json });
    });
  });
}

const fixtures: Fixture[] = [];
afterAll(() => fixtures.forEach((f) => f.cleanup()));

describe.skipIf(process.platform !== 'linux')(
  'SEC vuln-0001 — withheld credentials are absent from the action process environment block',
  () => {
    it('the client module and the subject cannot recover a withheld credential through /proc', async () => {
      const f = fixture('sec0001');
      fixtures.push(f);
      writeFileSync(join(f.dir, 'client.log'), `connecting with provider credential ${PROVIDER}\n`);
      const cfg = writeConfig(
        f,
        baseConfig(f, {
          uploads: { include: ['gate-report-json'], extraPaths: [`${f.rel}/client.log`] },
        }),
      );
      const { env, files } = githubEnv(
        f,
        { kind: 'push', ref: 'refs/heads/main' },
        {
          ...PLANTED,
          ROUTESPEC_CI_TEST_PROC_ENVIRON: Object.keys(PLANTED).join(','),
        },
      );
      const r = await runGateStep(f, cfg, env);
      expect(r.exitCode, r.stderr.slice(-600)).toBe(0);
      expect(r.json['decision']).toBe('PASS');

      // The action still knows what it withheld and still reports it truthfully.
      expect(r.json['withheldEnvironment']).toEqual(expect.arrayContaining(Object.keys(PLANTED)));
      expect(r.json['findings']).toContain('PROVIDER_SECRET_WITHHELD');

      // Nothing the action loads or starts can read a planted credential from an environment block.
      const seen = readFileSync(files.envReport, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { where: string; names: string[] });
      const where = seen.map((s) => s.where);
      expect(where).toEqual(
        expect.arrayContaining([
          'client-module',
          'subject',
          'client-module-initial-environ',
          'action-parent-initial-environ',
        ]),
      );
      for (const s of seen) expect(s.names, s.where).toEqual([]);

      // The withheld values still reach the in-memory leak scan: the secret-bearing log is refused.
      const refused = (r.json['uploads'] as { refused: Array<{ name: string; reason: string }> }).refused;
      expect(refused.find((x) => x.name === 'client.log')?.reason).toBe('SECRET_BEARING');

      for (const c of CANARIES) {
        expect(r.stdout.includes(c) || r.stderr.includes(c)).toBe(false);
        expect(readFileSync(files.output, 'utf8').includes(c)).toBe(false);
        expect(readFileSync(files.envReport, 'utf8').includes(c)).toBe(false);
        expect(leaksIn(f.work, c)).toEqual([]);
      }
      expect(outputs(files.output)['decision']).toBe('PASS');
      rmSync(join(f.dir, 'client.log'), { force: true });
    }, 120_000);
  },
);
