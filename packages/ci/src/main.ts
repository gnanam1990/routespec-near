/**
 * `routespec-ci` entry point.
 *
 *   routespec-ci run --config <path-in-workspace> [--workspace <dir>] [--work-dir <dir>]
 *   routespec-ci sbom --lock <pnpm-lock.yaml> --out <file>
 *
 * stdout carries exactly one JSON document; diagnostics go to stderr. `run` exits with the
 * RouteSpec exit code (0 only for a PASS decision) and appends step outputs and a job summary
 * when the runner provides `GITHUB_OUTPUT` / `GITHUB_STEP_SUMMARY`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RouteSpecError } from '@routespec/contracts';
import { errorResult } from '@routespec/cli';
import { runAction } from './action.ts';
import { writeGithubFiles } from './outputs.ts';
import { buildSbom } from './sbom.ts';

export interface CiIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (line: string) => void;
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
}

function parseFlags(argv: readonly string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      throw new RouteSpecError('RS_CLI_USAGE', 'Unexpected positional argument.');
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (name === '' || name in flags) throw new RouteSpecError('RS_CLI_USAGE', 'Flag repeated or empty.');
    if (eq !== -1) flags[name] = arg.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !(argv[i + 1] as string).startsWith('--'))
      flags[name] = argv[++i] as string;
    else flags[name] = true;
  }
  return flags;
}

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string')
    throw new RouteSpecError('RS_CLI_USAGE', 'Flag requires a value.', { details: { flag: name } });
  return v;
}

export async function runCi(argv: readonly string[], io: CiIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    const flags = parseFlags(rest);
    if (command === 'run') {
      const config = flagString(flags, 'config');
      if (config === undefined) throw new RouteSpecError('RS_CLI_USAGE', 'run needs --config.');
      const workspace = resolve(flagString(flags, 'workspace') ?? io.env['GITHUB_WORKSPACE'] ?? io.cwd);
      const workDirectory = resolve(
        flagString(flags, 'work-dir') ?? join(io.env['RUNNER_TEMP'] ?? tmpdir(), 'routespec-ci'),
      );
      const result = await runAction({
        workspace,
        configPath: config,
        workDirectory,
        env: io.env,
        flags,
        stderr: io.stderr,
      });
      writeGithubFiles(result, io.env);
      if (result.error) io.stderr(`routespec-ci: ${result.conclusion}: ${result.error.code}`);
      io.stdout(`${JSON.stringify(result)}\n`);
      return result.exitCode;
    }
    if (command === 'sbom') {
      const lock = flagString(flags, 'lock');
      const out = flagString(flags, 'out');
      if (lock === undefined || out === undefined)
        throw new RouteSpecError('RS_CLI_USAGE', 'sbom needs --lock and --out.');
      const sbom = buildSbom(readFileSync(resolve(io.cwd, lock), 'utf8'), {
        node: process.version,
        pnpm: io.env['npm_config_user_agent']?.match(/pnpm\/(\S+)/)?.[1] ?? null,
      });
      const text = `${JSON.stringify(sbom, null, 2)}\n`;
      writeFileSync(resolve(io.cwd, out), text, 'utf8');
      io.stdout(
        `${JSON.stringify({ ok: true, command: 'sbom', components: (sbom['components'] as unknown[]).length })}\n`,
      );
      return 0;
    }
    throw new RouteSpecError('RS_CLI_USAGE', 'Unknown command (expected run or sbom).');
  } catch (error) {
    const outcome = errorResult(error);
    const e = outcome.result['error'] as { code: string };
    io.stderr(`routespec-ci: ${e.code}`);
    io.stdout(`${JSON.stringify({ ok: false, exitCode: outcome.exitCode, ...outcome.result })}\n`);
    return outcome.exitCode;
  }
}

export async function runCiMain(): Promise<void> {
  const code = await runCi(process.argv.slice(2), {
    stdout: (t) => process.stdout.write(t),
    stderr: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    cwd: process.cwd(),
  });
  process.exitCode = code;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await runCiMain();
