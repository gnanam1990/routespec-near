/**
 * @routespec/cli — the `routespec` command line (M06): stable JSON on stdout, diagnostics on
 * stderr, documented exit codes, and the reviewed launcher adapter for `gate run`.
 */
export * from './exit.ts';
export * from './args.ts';
export { COMMANDS, COMMAND_NAMES, errorResult } from './commands.ts';
export { runCli, runMain, CLI_REVISION, type CliIo } from './main.ts';
export * from './launcher.ts';
