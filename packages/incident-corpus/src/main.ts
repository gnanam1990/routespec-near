/**
 * `routespec-incidents` command (M50).
 *
 *   import         read the real Intents Explorer API (needs ROUTESPEC_EXPLORER_JWT) and write
 *                  the `mainnet-observed-YYYY-MM` corpus directory
 *   build-fixture  build the shape-fixture corpus from a documented-shape recording file
 *   verify         verify a corpus directory
 *   register       register a verified corpus directory in a RouteSpec data directory
 *
 * Machine output: exactly one JSON document on stdout. Diagnostics: stderr. Exit codes are those
 * of the `routespec` CLI (0 ok, 4 usage/configuration/schema, 5 internal, 6 policy denial).
 * `import` is the only command that opens a network connection, and only to the pinned origin.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { RouteSpecError } from '@routespec/contracts';
import { checkLocalPathSyntax } from '@routespec/hardening';
import { RouteSpecStore, ensurePrivateDataDir } from '@routespec/store';
import { ExplorerHttpSource, loadExplorerToken } from './client.ts';
import {
  FIXTURE_CORPUS_LABEL,
  MAINNET_CORPUS_LABEL,
  MAINNET_LABEL_PATTERN,
  buildCorpus,
  verifyCorpusDir,
  writeCorpusDir,
} from './corpus.ts';
import { EXPLORER_ORIGIN, isIsoInstant } from './explorer-shape.ts';
import { runImport, type ImportOptions } from './import.ts';
import { registerObservedCorpus } from './register.ts';
import { STUCK_THRESHOLDS_SEC } from './sanitize.ts';
import { RecordingSource, type TransactionSource } from './source.ts';

export const INCIDENTS_CLI_REVISION = 'routespec-incidents@1.0.0' as const;
export const DEFAULT_REQUIRED_INVARIANTS = Object.freeze([
  'INV-01',
  'INV-02',
  'INV-03',
  'INV-05',
  'INV-06',
  'INV-07',
  'INV-08',
]);

const EXIT = Object.freeze({ PASS: 0, CONFIG: 4, INTERNAL: 5, POLICY_DENIED: 6 });
const POLICY_DENIED = new Set([
  'RS_MODE_POLICY_DENIED',
  'RS_TOKEN_INVALID',
  'RS_HOST_REJECTED',
  'RS_IMPORT_BLOCKED',
  'RS_EXPORT_OVERWRITE_DENIED',
]);
const INTERNAL = new Set(['RS_INTERNAL', 'RS_STORAGE_UNAVAILABLE', 'RS_STORAGE_CORRUPT', 'RS_STORAGE_BUSY']);

export interface IncidentsIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (line: string) => void;
  readonly env: Record<string, string | undefined>;
}

function usage(message: string, details: Record<string, string> = {}): never {
  throw new RouteSpecError('RS_CLI_USAGE', message, { details });
}

type Flags = Record<string, { type: 'string' | 'boolean' }>;

function parse(argv: readonly string[], options: Flags, required: readonly string[]) {
  let values: Record<string, string | boolean | undefined>;
  try {
    const parsed = parseArgs({ args: [...argv], options, strict: true, allowPositionals: false });
    values = parsed.values as Record<string, string | boolean | undefined>;
  } catch {
    usage('Unknown flag, missing value, or unexpected argument.', { flags: Object.keys(options).join(',') });
  }
  for (const name of required)
    if (values[name] === undefined) usage('Missing required flag.', { flag: name });
  const str = (name: string): string | undefined => values[name] as string | undefined;
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = str(name);
    if (raw === undefined) return fallback;
    if (!/^\d{1,9}$/.test(raw)) usage('Flag must be a non-negative integer.', { flag: name });
    const n = Number(raw);
    if (n < min || n > max)
      usage('Flag is out of range.', { flag: name, min: String(min), max: String(max) });
    return n;
  };
  const path = (name: string): string => {
    const raw = str(name) as string;
    const syntax = checkLocalPathSyntax(raw);
    if (!syntax.ok) usage('Path is not an accepted local path.', { flag: name, rule: String(syntax.rule) });
    return resolve(raw);
  };
  return { str, int, path, bool: (name: string) => values[name] === true };
}

const IMPORT_TUNING: Flags = {
  'stuck-after-sec': { type: 'string' },
  'recheck-after-sec': { type: 'string' },
  'recheck-max': { type: 'string' },
  'page-size': { type: 'string' },
  'max-pages': { type: 'string' },
  replace: { type: 'boolean' },
};

function tuning(args: ReturnType<typeof parse>, recheckDefault: number) {
  const stuckAfterSec = args.int('stuck-after-sec', 900, 0, 86_400);
  if (!STUCK_THRESHOLDS_SEC.includes(stuckAfterSec)) {
    usage('The stuck threshold must be one of the delay bucket bounds.', {
      allowed: STUCK_THRESHOLDS_SEC.join(','),
    });
  }
  return {
    stuckAfterSec,
    recheckAfterSec: args.int('recheck-after-sec', recheckDefault, 0, 86_400),
    recheckMax: args.int('recheck-max', 60, 0, 500),
    pageSize: args.int('page-size', 1000, 1, 1000),
    maxPages: args.int('max-pages', 20, 1, 500),
  };
}

async function importAndWrite(
  source: TransactionSource,
  options: ImportOptions,
  label: string,
  out: string,
  replace: boolean,
): Promise<Record<string, unknown>> {
  const summary = await runImport(source, options);
  const corpus = buildCorpus(summary, { label });
  writeCorpusDir(out, corpus, { replace });
  const verified = verifyCorpusDir(out);
  return {
    corpusLabel: verified.manifest.corpusLabel,
    importStatus: verified.manifest.importStatus,
    sourceKind: verified.manifest.source.kind,
    scenarioProvenanceClass: verified.manifest.scenarioProvenanceClass,
    manifestDigest: verified.manifest.manifestDigest,
    window: verified.manifest.window,
    observedAtHour: verified.manifest.observedAtHour,
    recheckedAtHour: verified.manifest.recheckedAtHour,
    counts: verified.manifest.counts,
    templates: verified.manifest.templates.length,
    scenarios: verified.manifest.templates.map((t) => ({ scenarioId: t.scenarioId, count: t.count })),
  };
}

type Run = (argv: readonly string[], io: IncidentsIo) => Promise<Record<string, unknown>>;

const COMMANDS: Readonly<Record<string, Run>> = Object.freeze({
  import: async (argv, io) => {
    const args = parse(
      argv,
      {
        out: { type: 'string' },
        label: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        ...IMPORT_TUNING,
      },
      ['out'],
    );
    const label = args.str('label') ?? MAINNET_CORPUS_LABEL;
    const month = MAINNET_LABEL_PATTERN.exec(label);
    if (month === null) usage('The label of a live import must be mainnet-observed-YYYY-MM.');
    const year = Number(month[1]);
    const monthIndex = Number(month[2]) - 1;
    const startTimestamp = args.str('start') ?? new Date(Date.UTC(year, monthIndex, 1)).toISOString();
    const endTimestamp = args.str('end') ?? new Date(Date.UTC(year, monthIndex + 1, 1)).toISOString();
    if (!isIsoInstant(startTimestamp) || !isIsoInstant(endTimestamp)) {
      usage('--start and --end must be ISO 8601 UTC instants such as 2026-11-01T00:00:00Z.');
    }
    if (!(Date.parse(startTimestamp) < Date.parse(endTimestamp))) usage('--start must be before --end.');
    const out = args.path('out');
    const options = {
      window: { startTimestamp, endTimestamp },
      ...tuning(args, 900),
      onProgress: (note: string) => io.stderr(`routespec-incidents: import: ${note}`),
    };
    // The key is read last, after every argument was accepted, and removed from the environment.
    const token = loadExplorerToken(io.env);
    const source = new ExplorerHttpSource({ origin: EXPLORER_ORIGIN, token });
    io.stderr(
      `routespec-incidents: import: reading ${EXPLORER_ORIGIN} (read-only, at most one request every 5 s, up to ${options.maxPages} pages)`,
    );
    return importAndWrite(source, options, label, out, args.bool('replace'));
  },
  'build-fixture': async (argv) => {
    const args = parse(
      argv,
      {
        recording: { type: 'string' },
        out: { type: 'string' },
        label: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        ...IMPORT_TUNING,
      },
      ['recording', 'out'],
    );
    const label = args.str('label') ?? FIXTURE_CORPUS_LABEL;
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(label)) usage('Label must be a lowercase identifier.');
    const startTimestamp = args.str('start') ?? null;
    const endTimestamp = args.str('end') ?? null;
    for (const t of [startTimestamp, endTimestamp]) {
      if (t !== null && !isIsoInstant(t)) usage('--start and --end must be ISO 8601 UTC instants.');
    }
    const source = RecordingSource.fromFile(args.path('recording'));
    const options = { window: { startTimestamp, endTimestamp }, ...tuning(args, 0) };
    return importAndWrite(source, options, label, args.path('out'), args.bool('replace'));
  },
  verify: async (argv) => {
    const args = parse(argv, { corpus: { type: 'string' } }, ['corpus']);
    const { manifest } = verifyCorpusDir(args.path('corpus'));
    return {
      valid: true,
      corpusLabel: manifest.corpusLabel,
      importStatus: manifest.importStatus,
      sourceKind: manifest.source.kind,
      manifestDigest: manifest.manifestDigest,
      counts: manifest.counts,
      templates: manifest.templates.length,
    };
  },
  register: async (argv, io) => {
    const args = parse(
      argv,
      {
        corpus: { type: 'string' },
        data: { type: 'string' },
        require: { type: 'string' },
        severity: { type: 'string' },
        reviewed: { type: 'boolean' },
        'require-all': { type: 'boolean' },
      },
      ['corpus'],
    );
    const dataRaw = args.str('data') ?? io.env['ROUTESPEC_DATA_DIR'];
    if (dataRaw === undefined) usage('A data directory is required (--data or ROUTESPEC_DATA_DIR).');
    const dataSyntax = checkLocalPathSyntax(dataRaw);
    if (!dataSyntax.ok) usage('Path is not an accepted local path.', { flag: 'data' });
    const corpusDir = args.path('corpus');
    const requiredInvariants = (args.str('require') ?? DEFAULT_REQUIRED_INVARIANTS.join(','))
      .split(',')
      .map((s) => s.trim());
    // Verify before the journal is created, so a refused corpus leaves no data directory behind.
    verifyCorpusDir(corpusDir);
    const dataDir = resolve(dataRaw);
    const options = {
      requiredInvariants,
      severity: (args.str('severity') ?? 'HIGH').toUpperCase(),
      reviewed: args.bool('reviewed'),
      requireAll: args.bool('require-all'),
    };
    if (verifyCorpusDir(corpusDir).scenarios.length === 0) {
      throw new RouteSpecError(
        'RS_IMPORT_STATE_INVALID',
        'This corpus has no cases yet: its live import is pending. Run the import first.',
      );
    }
    ensurePrivateDataDir(dataDir);
    const store = RouteSpecStore.open({ path: resolve(dataDir, 'journal.db') });
    try {
      const out = registerObservedCorpus(store, corpusDir, options);
      return { ...out, requiredInvariants, reviewStatus: options.reviewed ? 'REVIEWED' : 'UNREVIEWED' };
    } finally {
      store.close();
    }
  },
});

export const INCIDENTS_COMMAND_NAMES = Object.freeze(Object.keys(COMMANDS));

export async function runIncidentsCli(argv: readonly string[], io: IncidentsIo): Promise<number> {
  const name = argv[0] ?? '';
  let exitCode: number = EXIT.PASS;
  let result: Record<string, unknown>;
  try {
    const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
    if (command === undefined) usage('Unknown command.', { known: INCIDENTS_COMMAND_NAMES.join('|') });
    result = await command(argv.slice(1), io);
  } catch (error) {
    const known = error instanceof RouteSpecError;
    const code = known ? error.code : 'RS_INTERNAL';
    const message = known ? error.message : 'Internal error.';
    exitCode =
      !known || INTERNAL.has(code)
        ? EXIT.INTERNAL
        : POLICY_DENIED.has(code)
          ? EXIT.POLICY_DENIED
          : EXIT.CONFIG;
    result = { error: { code, message, details: known ? error.details : {} } };
    io.stderr(`routespec-incidents: ${name.slice(0, 32) || 'unknown'}: ${code}: ${message}`);
  }
  io.stdout(
    `${JSON.stringify({ ok: exitCode === EXIT.PASS, command: Object.hasOwn(COMMANDS, name) ? name : 'unknown', cli: INCIDENTS_CLI_REVISION, exitCode, ...result })}\n`,
  );
  return exitCode;
}

export async function runMain(): Promise<void> {
  process.exitCode = await runIncidentsCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await runMain();
