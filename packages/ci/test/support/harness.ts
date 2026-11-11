/**
 * M10 test harness. It runs the real `routespec-ci` entry point as a separate process with a
 * crafted runner environment (the variables a GitHub-hosted runner sets, an event payload file,
 * step output and summary files) against this repository's own checkout as the workspace. The
 * action then drives the real `routespec` CLI, the reviewed launcher, the networkless proxy,
 * the scenario runtime, the kernel, and the SQLite journal, and the sample client module starts
 * the installed subject (pinned official SDK with the RouteSpec adapter) for every case.
 *
 * What is simulated: the GitHub runner itself (environment variables and event payload). No
 * remote service is contacted and nothing is uploaded; staging stops at a local directory.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_SCENARIO_SOURCES } from '@routespec/scenario';

export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/[\\/]$/, '');
export const CI_ENTRY = fileURLToPath(new URL('../../bin/routespec-ci.mjs', import.meta.url));
export const SUBJECT_FILES = [
  'packages/cli/test/support/subject/reconciling-client.ts',
  'packages/cli/test/support/subject/runtime.ts',
];
export const LIVE_INVARIANTS = ['INV-01', 'INV-02', 'INV-03', 'INV-05', 'INV-06', 'INV-07', 'INV-08'];
export const REPO = 'example/routespec-subject';
export const WORKFLOW_REF = `${REPO}/.github/workflows/routespec-gate.yml@refs/heads/main`;

export function headSha(): string {
  return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

export interface Fixture {
  /** Absolute fixture directory inside the workspace (git-ignored `.data`). */
  readonly dir: string;
  /** Path of the fixture directory relative to the workspace. */
  readonly rel: string;
  /** Work directory outside the workspace. */
  readonly work: string;
  readonly stamp: string;
  cleanup(): void;
}

export function fixture(label: string): Fixture {
  const base = join(ROOT, '.data', 'ci-tests');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, `${label}-`));
  const work = mkdtempSync(join(tmpdir(), `routespec-m10-${label}-`));
  writeFileSync(join(dir, 'happy-path.yaml'), CORE_SCENARIO_SOURCES['happy-path'] as string);
  writeFileSync(
    join(dir, 'hooks.json'),
    JSON.stringify({
      hooks: [
        {
          hookId: 'fulfilment',
          hookRevision: '1',
          effectType: 'DELIVER_GOODS',
          sinkClass: 'fulfilment-webhook',
          sourceLocatorDigest: null,
          mechanism: 'subject-hook',
          scenarioSelectors: ['*'],
          coverageExpectation: 'REQUIRED',
        },
      ],
    }),
  );
  const stamp = join(dir, 'build-stamp.txt');
  writeFileSync(stamp, 'subject build stamp 1\n');
  return {
    dir,
    rel: relative(ROOT, dir).replace(/\\/g, '/'),
    work,
    stamp,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export function baseConfig(f: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'routespec.ci-config/1',
    project: 'ci subject',
    revisionLabel: 'r1',
    subject: {
      artifactFiles: [...SUBJECT_FILES, `${f.rel}/build-stamp.txt`],
      lockFile: 'pnpm-lock.yaml',
      manifestFile: `${f.rel}/hooks.json`,
      clientModule: 'packages/ci/test/support/sample-client.ts',
    },
    scenarios: [{ file: `${f.rel}/happy-path.yaml`, policy: 'REQUIRED' }],
    requiredInvariants: LIVE_INVARIANTS,
    effect: { sinks: ['fulfilment-webhook'] },
    gate: { name: 'release gate' },
    ...overrides,
  };
}

/** Write a configuration (object or raw text) and return its workspace-relative path. */
export function writeConfig(
  f: Fixture,
  config: Record<string, unknown> | string,
  name = 'routespec.ci.json',
): string {
  writeFileSync(join(f.dir, name), typeof config === 'string' ? config : JSON.stringify(config, null, 2));
  return `${f.rel}/${name}`;
}

export type GithubEvent =
  | { kind: 'push'; ref: string }
  | { kind: 'pull_request'; fork: boolean; headRepo?: string }
  | { kind: 'pull_request_target'; headRepo: string }
  | { kind: 'workflow_run' };

export interface RunnerFiles {
  readonly output: string;
  readonly summary: string;
  readonly envReport: string;
}

/** The variables a GitHub-hosted runner provides for one job. */
export function githubEnv(
  f: Fixture,
  event: GithubEvent,
  extra: Record<string, string> = {},
): {
  env: Record<string, string>;
  files: RunnerFiles;
} {
  const runner = mkdtempSync(join(f.work, 'runner-'));
  const payload: Record<string, unknown> = {};
  let name: string = event.kind;
  let ref = 'refs/heads/main';
  if (event.kind === 'push') ref = event.ref;
  if (event.kind === 'pull_request' || event.kind === 'pull_request_target') {
    const head =
      event.kind === 'pull_request'
        ? (event.headRepo ?? (event.fork ? 'someone/routespec-subject' : REPO))
        : event.headRepo;
    payload['pull_request'] = {
      number: 7,
      head: { repo: { full_name: head, fork: event.kind === 'pull_request' ? event.fork : true } },
      base: { repo: { full_name: REPO } },
    };
    ref = 'refs/pull/7/merge';
  }
  if (event.kind === 'workflow_run') name = 'workflow_run';
  const eventPath = join(runner, 'event.json');
  writeFileSync(eventPath, JSON.stringify(payload));
  const files: RunnerFiles = {
    output: join(runner, 'github_output'),
    summary: join(runner, 'step_summary.md'),
    envReport: join(runner, 'env-report.jsonl'),
  };
  writeFileSync(files.output, '');
  writeFileSync(files.summary, '');
  writeFileSync(files.envReport, '');
  return {
    env: {
      GITHUB_ACTIONS: 'true',
      CI: 'true',
      GITHUB_EVENT_NAME: name,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: REPO,
      GITHUB_REPOSITORY_ID: '424242',
      GITHUB_SHA: headSha(),
      GITHUB_REF: ref,
      GITHUB_WORKFLOW_REF: WORKFLOW_REF,
      GITHUB_RUN_ID: '9001',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_WORKSPACE: ROOT,
      RUNNER_TEMP: join(runner, 'tmp'),
      GITHUB_OUTPUT: files.output,
      GITHUB_STEP_SUMMARY: files.summary,
      ROUTESPEC_CI_TEST_ENV_REPORT: files.envReport,
      ...extra,
    },
    files,
  };
}

export interface CiRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly json: Record<string, unknown> | null;
}

/** Minimal host environment every child needs (no credentials). */
function hostEnv(): Record<string, string> {
  const keep = [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'ComSpec',
    'PATHEXT',
    'windir',
  ];
  const out: Record<string, string> = {};
  for (const k of keep) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function runCi(args: readonly string[], env: Record<string, string>): Promise<CiRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', CI_ENTRY, ...args], {
      cwd: ROOT,
      env: { ...hostEnv(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('close', (code) => {
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        json = null;
      }
      resolve({ exitCode: code, stdout, stderr, json });
    });
  });
}

export function runAction(
  f: Fixture,
  configRel: string,
  env: Record<string, string>,
  extraArgs: string[] = [],
): Promise<CiRun> {
  return runCi(
    ['run', '--config', configRel, '--workspace', ROOT, '--work-dir', join(f.work, 'work'), ...extraArgs],
    env,
  );
}

/** Every regular file under a directory (absolute paths). */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...filesUnder(p));
    else if (s.isFile()) out.push(p);
  }
  return out;
}

/** Whether any byte sequence of `needle` (utf8) appears in any file under `dir`. */
export function leaksIn(dir: string, needle: string): string[] {
  const n = Buffer.from(needle, 'utf8');
  return filesUnder(dir).filter((p) => readFileSync(p).includes(n));
}

export function outputs(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

export function stagedReport(result: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(String(result['uploadDirectory']), 'gate-report.json'), 'utf8'),
  ) as Record<string, unknown>;
}
