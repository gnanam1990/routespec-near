/**
 * `pnpm judge` (M54): one command that runs the checks a reviewer would otherwise run by hand,
 * offline on 127.0.0.1, and prints what each one actually returned.
 *
 *  1. build        `tsc -b` over the workspace.
 *  2. journey      the full product journey without containment: three client builds through
 *                  the real control service; prints each gate decision and the offline bundle
 *                  check. Expected on any host: hedging FAIL (INV-03), baseline REVIEW, corrected
 *                  REVIEW (no containment, so no independent side-effect evidence).
 *  3. contained    the same journey with container containment, where the corrected build can
 *                  PASS. Runs only with `--contained` or when ROUTESPEC_CONTAINER_CLI is set;
 *                  otherwise SKIPPED with the reason.
 *  4. demo         the committed console demo recording: digests match its provenance, and the
 *                  RouteSpec CLI verifies its evidence bundle offline.
 *  5. package      builds the npm package, installs the tarball offline into an empty directory,
 *                  and gates the repository's self-gate configuration with the installed copy.
 *                  `--skip-package` skips it.
 *
 * A step is PASS when its command exited as documented and its record says what this list says;
 * the decisions it prints are the product's own (nothing here computes a verdict). Exit 0 only
 * when no step FAILED. A record is written to `.data/judge/judge.json`.
 *
 *   pnpm judge [--contained] [--skip-package]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, buildWorkspace, npm, packNpmPackage, stageNpmPackage } from './npm-package.ts';
import { checkRecording } from './console-demo/build.ts';
import { DEMO_DIR } from './console-demo/record.ts';

type J = Record<string, unknown>;
type Outcome = 'PASS' | 'FAIL' | 'SKIPPED';

export interface StepRecord {
  readonly step: string;
  readonly outcome: Outcome;
  readonly ms: number;
  readonly detail: string;
}

const WORK = join(ROOT, '.data', 'judge');

function node(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--no-warnings', ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function journey(label: string, contained: boolean): { ok: boolean; detail: string; summary: string } {
  const dir = join(WORK, label);
  const out = join(WORK, `${label}.json`);
  rmSync(dir, { recursive: true, force: true });
  const args = ['packages/delivery/src/journey.ts', '--work', dir, '--out', out, '--no-ui'];
  if (contained) args.push('--contained');
  const r = node(args);
  if (r.code !== 0)
    return { ok: false, detail: `journey exited ${String(r.code)}: ${r.stderr.slice(-400)}`, summary: '' };
  const j = JSON.parse(readFileSync(out, 'utf8')) as J;
  const summary = node(['scripts/journey-summary.mjs', out]).stdout;
  const verified = (j['bundleVerify'] as J)['verified'] === true;
  const mode = (j['containment'] as J)['mode'] as string;
  const baseline = (j['baselineRun'] as J)['decision'];
  const hedging = (j['hedgingRun'] as J)['decision'];
  const corrected = (j['correctedRun'] as J)['decision'];
  const expectedCorrected = contained ? 'PASS' : 'REVIEW';
  const ok =
    verified &&
    hedging === 'FAIL' &&
    baseline === 'REVIEW' &&
    corrected === expectedCorrected &&
    mode === (contained ? 'CONTAINED' : 'UNCONTAINED');
  return {
    ok,
    detail: `containment ${mode}; baseline ${String(baseline)}, hedging ${String(hedging)}, corrected ${String(corrected)}; bundle verified offline ${String(verified)}`,
    summary,
  };
}

function demo(): { ok: boolean; detail: string } {
  const provenance = checkRecording();
  const extract = join(WORK, 'demo-extract');
  rmSync(extract, { recursive: true, force: true });
  const r = node([
    'packages/cli/bin/routespec.mjs',
    'export',
    'verify',
    '--bundle',
    join(DEMO_DIR, 'evidence-bundle.tar'),
    '--extract-to',
    extract,
  ]);
  const v = JSON.parse(r.stdout) as J;
  const run = provenance['run'] as J;
  const ok = r.code === 0 && v['verified'] === true && (run['containment'] as J)['mode'] === 'CONTAINED';
  return {
    ok,
    detail: `recorded from a ${String((run['containment'] as J)['mode'])} run at ${String(run['commit']).slice(0, 12)}; bundle ${String(v['decision'])}, verified ${String(v['verified'])}`,
  };
}

function packageCheck(): { ok: boolean; detail: string } {
  const dir = join(WORK, 'npm');
  rmSync(dir, { recursive: true, force: true });
  const staged = stageNpmPackage({ outDir: join(dir, 'stage'), build: false });
  const packed = packNpmPackage(staged, join(dir, 'pack'));
  const consumer = join(dir, 'consumer');
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, 'package.json'), '{"name":"consumer","private":true}\n');
  const closed = 'http://127.0.0.1:9';
  npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', packed.tarball], consumer, {
    ...process.env,
    HTTP_PROXY: closed,
    HTTPS_PROXY: closed,
    npm_config_proxy: closed,
    npm_config_https_proxy: closed,
  });
  const entry = join(consumer, 'node_modules', staged.name, 'bin', 'routespec-ci.mjs');
  const ciWork = mkdtempSync(join(tmpdir(), 'routespec-judge-ci-'));
  const r = node([
    entry,
    'run',
    '--config',
    '.github/routespec/routespec.ci.json',
    '--workspace',
    ROOT,
    '--work-dir',
    // The CI entry point requires a work directory outside the workspace.
    ciWork,
  ]);
  rmSync(ciWork, { recursive: true, force: true });
  const json = JSON.parse(r.stdout) as J;
  return {
    ok: r.code === 0 && json['decision'] === 'PASS',
    detail: `${staged.name}@${staged.version} (${packed.entryCount} files, ${packed.integrity.slice(0, 20)}…) installed offline; self-gate ${String(json['decision'])}${json['error'] ? ` (${String((json['error'] as J)['code'])})` : ''}`,
  };
}

export function runJudge(argv: readonly string[]): { records: StepRecord[]; ok: boolean } {
  mkdirSync(WORK, { recursive: true });
  const records: StepRecord[] = [];
  const print = (line: string) => process.stdout.write(`${line}\n`);
  const step = (
    name: string,
    fn: () => { ok: boolean; detail: string; summary?: string } | Outcome,
  ): void => {
    const started = Date.now();
    let outcome: Outcome;
    let detail: string;
    try {
      const r = fn();
      if (typeof r === 'string') {
        outcome = r;
        detail = 'skipped';
      } else {
        outcome = r.ok ? 'PASS' : 'FAIL';
        detail = r.detail;
        if (r.summary) print(r.summary.trimEnd());
      }
    } catch (error) {
      outcome = 'FAIL';
      detail =
        error instanceof Error ? (error.message.split('\n')[0]?.slice(0, 400) ?? 'error') : String(error);
    }
    const ms = Date.now() - started;
    records.push({ step: name, outcome, ms, detail });
    print(`${outcome.padEnd(7)} ${name.padEnd(10)} ${(ms / 1000).toFixed(1).padStart(6)}s  ${detail}\n`);
  };

  print("routespec judge: every step runs offline on 127.0.0.1; decisions are the product's own.\n");
  step('build', () => {
    buildWorkspace();
    return { ok: true, detail: 'tsc -b exit 0' };
  });
  step('journey', () => journey('journey', false));
  const containerCli = process.env['ROUTESPEC_CONTAINER_CLI'];
  if (argv.includes('--contained') || (containerCli !== undefined && containerCli !== '')) {
    step('contained', () => journey('journey-contained', true));
  } else {
    records.push({
      step: 'contained',
      outcome: 'SKIPPED',
      ms: 0,
      detail: 'no container engine configured (set ROUTESPEC_CONTAINER_CLI or pass --contained)',
    });
    print(
      'SKIPPED contained     0.0s  no container engine configured (set ROUTESPEC_CONTAINER_CLI or pass --contained)\n',
    );
  }
  step('demo', demo);
  if (argv.includes('--skip-package')) {
    records.push({ step: 'package', outcome: 'SKIPPED', ms: 0, detail: '--skip-package' });
    print('SKIPPED package       0.0s  --skip-package\n');
  } else {
    step('package', packageCheck);
  }
  const ok = records.every((r) => r.outcome !== 'FAIL');
  writeFileSync(
    join(WORK, 'judge.json'),
    `${JSON.stringify({ schema: 'routespec.judge/1', platform: `${process.platform}/${process.arch}`, node: process.version, ok, records }, null, 2)}\n`,
  );
  print(
    `routespec judge: ${ok ? 'all steps passed or were skipped' : 'a step FAILED'} (record: .data/judge/judge.json)`,
  );
  return { records, ok };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ok } = runJudge(process.argv.slice(2));
  process.exitCode = ok ? 0 : 1;
}
