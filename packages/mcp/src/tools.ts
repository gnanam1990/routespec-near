/**
 * The five MCP tools (M52): run_gate, list_findings, explain_invariant, show_fix_pattern,
 * verify_certificate. Each returns one JSON document as `structuredContent` and the same
 * document as text. Input errors are tool results with `isError: true`, never thrown.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runCli } from '@routespec/cli';
import { buildFindings } from './findings.ts';
import {
  DEFAULT_SCENARIOS,
  REQUIRED_INVARIANTS,
  runGate,
  SCENARIO_SOURCES,
  type GateRunRecord,
} from './gate.ts';
import { explainInvariant, FIX_PATTERNS, INVARIANTS, normalizeInvariantId } from './knowledge.ts';

export interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  readonly structuredContent: Record<string, unknown>;
  readonly isError: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ServerOptions {
  /** Files the tools may read (client modules, bundles) must be inside this directory. */
  readonly root: string;
  /** Where gate run journals are written; a fresh temporary directory by default. */
  readonly workDir?: string;
  /** Environment for the certificate commands (no secrets are needed to verify). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (line: string) => void;
}

const CLIENT_EXTENSIONS = /\.(?:ts|mts|js|mjs)$/;

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  {
    name: 'run_gate',
    title: 'Run the RouteSpec gate',
    description:
      'Run the RouteSpec release gate on a 1Click client module: every scenario is a fresh process running the pinned official SDK against the local RouteSpec proxy, judged by the invariant kernel. Returns PASS, FAIL, REVIEW or NOT_RUN and a runId for list_findings. Networkless; uncontained (diagnostic, not release evidence). The module default-exports async (ctx, request) => result and uses ctx.sdk.OneClickService.',
    inputSchema: {
      type: 'object',
      properties: {
        client: {
          type: 'string',
          description: 'Path of the client module, relative to the server root (.ts, .mts, .js or .mjs).',
        },
        scenarios: {
          type: 'array',
          items: { type: 'string', enum: Object.keys(SCENARIO_SOURCES) },
          description: `Scenarios to run, in order. Default: ${DEFAULT_SCENARIOS.join(', ')}.`,
        },
      },
      required: ['client'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_findings',
    title: 'List gate findings',
    description:
      'List what a gate run found: per failing or review case, the violated invariants with the kernel explanation and remediation, and the fix patterns to apply (most severe first).',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'A runId from run_gate. Default: the latest run.' },
        includePassing: { type: 'boolean', description: 'Also list cases that passed.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'explain_invariant',
    title: 'Explain an invariant',
    description:
      'Explain a RouteSpec invariant (INV-01 to INV-09): the rule, every kernel explanation code with its verdict, the remediations and the fix patterns.',
    inputSchema: {
      type: 'object',
      properties: { invariant: { type: 'string', description: 'For example INV-03.' } },
      required: ['invariant'],
      additionalProperties: false,
    },
  },
  {
    name: 'show_fix_pattern',
    title: 'Show a fix pattern',
    description:
      'Show a concrete code fix for the official 1Click SDK: the problem, the rule, and before/after code. Give a pattern id, or an invariant to get its patterns; with neither, list all patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', enum: Object.keys(FIX_PATTERNS) },
        invariant: { type: 'string', description: 'For example INV-03.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'verify_certificate',
    title: 'Verify a release certificate',
    description:
      'Check a RouteSpec release certificate on the routespec-registry contract over NEAR JSON-RPC (read-only views; never signs or sends a transaction). Give a bundle file (inside the server root) or a bundle digest. PASS only when an enrolled, unrevoked attester certified exactly this bundle.',
    inputSchema: {
      type: 'object',
      properties: {
        registry: { type: 'string', description: 'Registry contract account id.' },
        network: { type: 'string', enum: ['testnet', 'mainnet'] },
        rpc: { type: 'string', description: 'NEAR JSON-RPC URL (instead of network).' },
        bundle: { type: 'string', description: 'Evidence bundle path, relative to the server root.' },
        digest: { type: 'string', description: 'Bundle digest (sha256:...).' },
        policy: { type: 'string', enum: ['require-onchain-attester', 'advisory'] },
        attesters: { type: 'array', items: { type: 'string' }, description: 'Trusted attester public keys.' },
        projectKey: { type: 'string' },
        codeHash: { type: 'string', description: 'Expected contract code hash.' },
      },
      required: ['registry'],
      additionalProperties: false,
    },
  },
]);

function result(structured: Record<string, unknown>, isError = false, headline?: string): ToolResult {
  const body = JSON.stringify(structured, null, 2);
  return {
    content: [{ type: 'text', text: headline === undefined ? body : `${headline}\n\n${body}` }],
    structuredContent: structured,
    isError,
  };
}

function inputError(code: string, message: string): ToolResult {
  return result({ error: { code, message } }, true, `Error ${code}: ${message}`);
}

class InputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function str(args: Record<string, unknown>, name: string, required = false): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) {
    if (required) throw new InputError('INPUT_MISSING', `${name} is required.`);
    return undefined;
  }
  if (typeof v !== 'string' || v.length === 0 || v.length > 512) {
    throw new InputError('INPUT_INVALID', `${name} must be a non-empty string of at most 512 characters.`);
  }
  return v;
}

export class RouteSpecTools {
  private readonly root: string;
  private readonly work: string;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly log: (line: string) => void;
  private readonly runs = new Map<string, GateRunRecord>();
  private latest: string | null = null;
  private counter = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ServerOptions) {
    this.root = realpathSync(resolve(options.root));
    this.work = options.workDir ?? mkdtempSync(join(tmpdir(), 'routespec-mcp-'));
    mkdirSync(this.work, { recursive: true });
    this.env = options.env ?? process.env;
    this.log = options.log ?? (() => undefined);
  }

  /** A path the caller named, confined to the server root (symbolic links resolved). */
  private confined(raw: string, kind: string): { abs: string; label: string } {
    const candidate = isAbsolute(raw) ? raw : resolve(this.root, raw);
    if (!existsSync(candidate)) throw new InputError('FILE_NOT_FOUND', `The ${kind} file does not exist.`);
    const abs = realpathSync(candidate);
    const rel = relative(this.root, abs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new InputError('PATH_OUTSIDE_ROOT', `The ${kind} file must be inside the server root.`);
    }
    if (!statSync(abs).isFile()) throw new InputError('FILE_NOT_FOUND', `The ${kind} path is not a file.`);
    return { abs, label: rel.split(sep).join('/') };
  }

  async call(name: string, rawArgs: unknown): Promise<ToolResult> {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    if (typeof args !== 'object' || Array.isArray(args))
      return inputError('INPUT_INVALID', 'Arguments must be an object.');
    const schema = TOOL_DEFINITIONS.find((t) => t.name === name)?.inputSchema as
      | { properties: Record<string, unknown> }
      | undefined;
    if (schema === undefined) return inputError('UNKNOWN_TOOL', `No tool named ${name.slice(0, 64)}.`);
    const unknown = Object.keys(args).filter((k) => !(k in schema.properties));
    if (unknown.length > 0)
      return inputError('INPUT_INVALID', `Unknown argument ${unknown[0]?.slice(0, 64)}.`);
    try {
      switch (name) {
        case 'run_gate':
          return await this.serial(() => this.runGate(args));
        case 'list_findings':
          return this.listFindings(args);
        case 'explain_invariant':
          return this.explain(args);
        case 'show_fix_pattern':
          return this.fixPattern(args);
        default:
          return await this.verifyCertificate(args);
      }
    } catch (error) {
      if (error instanceof InputError) return inputError(error.code, error.message);
      this.log(`routespec-mcp: ${name}: ${(error as Error).name}`);
      return inputError('INTERNAL', `The tool failed: ${String((error as Error).message).slice(0, 200)}`);
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runGate(args: Record<string, unknown>): Promise<ToolResult> {
    const client = this.confined(str(args, 'client', true) as string, 'client');
    if (!CLIENT_EXTENSIONS.test(client.abs)) {
      throw new InputError('INPUT_INVALID', 'The client module must be a .ts, .mts, .js or .mjs file.');
    }
    let scenarios: string[] = [...DEFAULT_SCENARIOS];
    if (args['scenarios'] !== undefined) {
      const s = args['scenarios'];
      if (!Array.isArray(s) || s.length === 0 || s.length > 12 || s.some((x) => typeof x !== 'string')) {
        throw new InputError('INPUT_INVALID', 'scenarios must be a list of 1 to 12 scenario ids.');
      }
      const bad = (s as string[]).find((x) => !(x in SCENARIO_SOURCES));
      if (bad !== undefined) {
        throw new InputError(
          'UNKNOWN_SCENARIO',
          `Unknown scenario ${bad.slice(0, 64)}. Known: ${Object.keys(SCENARIO_SOURCES).join(', ')}.`,
        );
      }
      scenarios = s as string[];
    }
    this.counter += 1;
    const runId = `run-${String(this.counter)}`;
    const started = Date.now();
    const run = await runGate({
      clientPath: client.abs,
      clientLabel: client.label,
      scenarios,
      dataDir: join(this.work, runId),
      runId,
    });
    this.runs.set(runId, run);
    this.latest = runId;
    const summary = {
      runId,
      client: run.client,
      decision: run.decision,
      exitCode: run.exitCode,
      artifactDigest: run.artifactDigest,
      decisionDigest: run.decisionDigest,
      counts: run.counts,
      cases: run.cases.map((c) => ({
        ordinal: c.ordinal,
        scenario: c.scenario,
        contribution: c.contribution,
        failing: [
          ...new Set(
            c.invariants
              .filter(
                (i) =>
                  i.verdict !== 'PASS' && (REQUIRED_INVARIANTS as readonly string[]).includes(i.invariantId),
              )
              .map((i) => `${i.invariantId}:${i.verdict}`),
          ),
        ],
        clientError: c.clientError,
      })),
      gateFindings: run.findings,
      requiredInvariants: REQUIRED_INVARIANTS,
      containment: run.containment,
      evidenceUse: run.evidenceUse,
      durationMs: Date.now() - started,
      error: run.error,
      next:
        run.decision === 'PASS'
          ? 'All required invariants passed on every scenario.'
          : 'Call list_findings for the violated invariants and the fix patterns.',
    };
    return result(summary, run.error !== null, `Gate ${run.decision} for ${run.client} (${runId}).`);
  }

  private listFindings(args: Record<string, unknown>): ToolResult {
    const runId = str(args, 'runId') ?? this.latest;
    if (runId === null)
      throw new InputError('NO_RUN', 'No gate run in this session yet. Call run_gate first.');
    const run = this.runs.get(runId);
    if (run === undefined)
      throw new InputError('UNKNOWN_RUN', `No gate run ${runId.slice(0, 64)} in this session.`);
    const includePassing = args['includePassing'];
    if (includePassing !== undefined && typeof includePassing !== 'boolean') {
      throw new InputError('INPUT_INVALID', 'includePassing must be a boolean.');
    }
    const report = buildFindings(run, { includePassing: includePassing === true });
    const n = report.cases.reduce((a, c) => a + c.invariants.length, 0);
    return result(
      report as unknown as Record<string, unknown>,
      false,
      `Gate ${report.decision} (${report.runId}): ${String(n)} finding(s). Fix patterns to apply: ${report.nextFixPatterns.join(', ') || 'none'}.`,
    );
  }

  private explain(args: Record<string, unknown>): ToolResult {
    const raw = str(args, 'invariant', true) as string;
    const id = normalizeInvariantId(raw);
    const e = id === null ? null : explainInvariant(id);
    if (e === null) {
      throw new InputError(
        'UNKNOWN_INVARIANT',
        `Unknown invariant. Known: ${Object.keys(INVARIANTS).join(', ')}.`,
      );
    }
    return result(e as unknown as Record<string, unknown>, false, `${e.id}: ${e.title}`);
  }

  private fixPattern(args: Record<string, unknown>): ToolResult {
    const pattern = str(args, 'pattern');
    const invariant = str(args, 'invariant');
    if (pattern !== undefined) {
      const p = FIX_PATTERNS[pattern];
      if (p === undefined) {
        throw new InputError(
          'UNKNOWN_PATTERN',
          `Unknown fix pattern. Known: ${Object.keys(FIX_PATTERNS).join(', ')}.`,
        );
      }
      return result({ patterns: [p] }, false, `Fix pattern ${p.id}: ${p.title}`);
    }
    if (invariant !== undefined) {
      const id = normalizeInvariantId(invariant);
      const info = id === null ? undefined : INVARIANTS[id];
      if (info === undefined) throw new InputError('UNKNOWN_INVARIANT', 'Unknown invariant.');
      const patterns = info.fixPatterns.map((p) => FIX_PATTERNS[p]);
      return result(
        { invariant: info.id, patterns },
        false,
        `Fix patterns for ${info.id}: ${info.fixPatterns.join(', ') || 'none'}`,
      );
    }
    return result(
      {
        patterns: Object.values(FIX_PATTERNS).map((p) => ({
          id: p.id,
          title: p.title,
          invariants: p.invariants,
        })),
      },
      false,
      'Fix patterns',
    );
  }

  private async verifyCertificate(args: Record<string, unknown>): Promise<ToolResult> {
    const argv = ['certificate', 'verify', '--registry', str(args, 'registry', true) as string];
    const network = str(args, 'network');
    const rpc = str(args, 'rpc');
    if ((network === undefined) === (rpc === undefined)) {
      throw new InputError('INPUT_INVALID', 'Give exactly one of network or rpc.');
    }
    if (network !== undefined) argv.push('--network', network);
    if (rpc !== undefined) {
      if (!/^https?:\/\//.test(rpc)) throw new InputError('INPUT_INVALID', 'rpc must be an http(s) URL.');
      argv.push('--rpc', rpc);
    }
    const bundle = str(args, 'bundle');
    const digest = str(args, 'digest');
    if ((bundle === undefined) === (digest === undefined)) {
      throw new InputError('INPUT_INVALID', 'Give exactly one of bundle or digest.');
    }
    if (bundle !== undefined) argv.push('--bundle', this.confined(bundle, 'bundle').abs);
    if (digest !== undefined) argv.push('--digest', digest);
    for (const [flag, name] of [
      ['--policy', 'policy'],
      ['--project-key', 'projectKey'],
      ['--code-hash', 'codeHash'],
    ] as const) {
      const v = str(args, name);
      if (v !== undefined) argv.push(flag, v);
    }
    const attesters = args['attesters'];
    if (attesters !== undefined) {
      if (
        !Array.isArray(attesters) ||
        attesters.length > 16 ||
        attesters.some((a) => typeof a !== 'string')
      ) {
        throw new InputError('INPUT_INVALID', 'attesters must be a list of at most 16 public keys.');
      }
      for (const a of attesters as string[]) argv.push('--attester', a);
    }
    let stdout = '';
    const env: Record<string, string | undefined> = { ...this.env };
    // Verification needs no secret; none is handed to the command.
    for (const k of ['ROUTESPEC_ATTESTER_KEY', 'ROUTESPEC_NEAR_SIGNER_KEY', 'ROUTESPEC_NEAR_SIGNER_ACCOUNT'])
      delete env[k];
    const exitCode = await runCli(argv, {
      stdout: (text) => (stdout += text),
      stderr: (line) => this.log(line),
      env,
    });
    let out: Record<string, unknown>;
    try {
      out = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      out = { error: { code: 'RS_INTERNAL', message: 'The certificate command printed no JSON.' } };
    }
    const release = (out['release'] ?? null) as { decision?: string } | null;
    const decision = release?.decision ?? null;
    const errored = out['error'] !== undefined && decision === null;
    return result(
      { ...out, exitCode },
      errored,
      decision === null
        ? `Certificate check did not complete (exit ${String(exitCode)}).`
        : `Release ${decision} for ${String(out['bundleDigest'] ?? '')}.`,
    );
  }
}
