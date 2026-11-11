/**
 * `routespec` CLI entry point.
 *
 * Machine output: exactly one JSON document on stdout (`{"ok":..., "command":..., ...}`).
 * Diagnostics and structured logs: stderr only. Exit codes: see `exit.ts`.
 */
import { pathToFileURL } from 'node:url';
import { COMMAND_NAMES, COMMANDS, errorResult, type CommandResult } from './commands.ts';
import { parseArgs, usage } from './args.ts';
import { EXIT } from './exit.ts';

export const CLI_REVISION = 'routespec-cli@1.0.0' as const;

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
}

function resolveCommand(argv: readonly string[]): { name: string; rest: string[] } {
  const two = argv.slice(0, 2).join(' ');
  if (two in COMMANDS) return { name: two, rest: argv.slice(2) };
  usage('Unknown command.', { known: COMMAND_NAMES.join('|').slice(0, 400) });
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let name = 'unknown';
  let outcome: CommandResult;
  try {
    const resolved = resolveCommand(argv);
    name = resolved.name;
    const command = COMMANDS[name] as (typeof COMMANDS)[string];
    const args = parseArgs(resolved.rest, command.spec);
    const dataDir = args.strings['data'] ?? io.env['ROUTESPEC_DATA_DIR'] ?? null;
    outcome = await command.run(args, {
      env: io.env,
      stderr: io.stderr,
      dataDir: command.needsData ? dataDir : null,
    });
  } catch (error) {
    outcome = errorResult(error);
    const e = outcome.result['error'] as { code: string; message: string };
    io.stderr(`routespec: ${name}: ${e.code}: ${e.message}`);
  }
  const ok = outcome.exitCode === EXIT.PASS;
  io.stdout(
    `${JSON.stringify({ ok, command: name, cli: CLI_REVISION, exitCode: outcome.exitCode, ...outcome.result })}\n`,
  );
  return outcome.exitCode;
}

export async function runMain(): Promise<void> {
  const code = await runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
  });
  process.exitCode = code;
  if (process.connected) process.disconnect();
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await runMain();
