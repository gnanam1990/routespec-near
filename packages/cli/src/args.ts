/**
 * Strict argument parsing. Every command declares its flags; an unknown flag, a missing value,
 * a repeated single-value flag, or a missing required flag is a usage error (exit 4). Values
 * are never evaluated as code or shell text.
 */
import { RouteSpecError } from '@routespec/contracts';

export type FlagKind = 'string' | 'boolean' | 'multi';

export interface FlagSpec {
  readonly kind: FlagKind;
  readonly required?: boolean;
}

export interface CommandSpec {
  readonly flags: Readonly<Record<string, FlagSpec>>;
  readonly positionals?: number;
}

export interface ParsedArgs {
  readonly strings: Readonly<Record<string, string>>;
  readonly booleans: ReadonlySet<string>;
  readonly multi: Readonly<Record<string, readonly string[]>>;
  readonly positionals: readonly string[];
}

export function usage(message: string, details: Record<string, string> = {}): never {
  throw new RouteSpecError('RS_CLI_USAGE', message, { details });
}

export const GLOBAL_FLAGS: Readonly<Record<string, FlagSpec>> = Object.freeze({
  data: { kind: 'string' },
  'log-level': { kind: 'string' },
});

export function parseArgs(argv: readonly string[], spec: CommandSpec): ParsedArgs {
  const flags = { ...GLOBAL_FLAGS, ...spec.flags };
  const strings: Record<string, string> = {};
  const booleans = new Set<string>();
  const multi: Record<string, string[]> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    const f = flags[name];
    if (!f) usage('Unknown flag.', { flag: name.slice(0, 64) });
    if (f.kind === 'boolean') {
      if (eq !== -1) usage('Boolean flag takes no value.', { flag: name });
      booleans.add(name);
      continue;
    }
    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else {
      value = argv[i + 1];
      i++;
    }
    if (value === undefined || value.startsWith('--')) usage('Flag requires a value.', { flag: name });
    if (f.kind === 'multi') (multi[name] ??= []).push(value);
    else {
      if (name in strings) usage('Flag given more than once.', { flag: name });
      strings[name] = value;
    }
  }
  for (const [name, f] of Object.entries(flags)) {
    if (f.required && !(name in strings) && !(name in multi)) usage('Missing required flag.', { flag: name });
  }
  const expected = spec.positionals ?? 0;
  if (positionals.length !== expected) {
    usage('Unexpected number of positional arguments.', {
      expected: String(expected),
      got: String(positionals.length),
    });
  }
  return { strings, booleans, multi, positionals };
}

export function intFlag(args: ParsedArgs, name: string, fallback: number, min: number, max: number): number {
  const raw = args.strings[name];
  if (raw === undefined) return fallback;
  if (!/^\d{1,9}$/.test(raw)) usage('Flag must be a non-negative integer.', { flag: name });
  const n = Number(raw);
  if (n < min || n > max) usage('Flag is out of range.', { flag: name, min: String(min), max: String(max) });
  return n;
}
