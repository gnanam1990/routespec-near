/**
 * `routespec` command implementations. Each command returns a machine result (printed as one
 * JSON document on stdout by `main.ts`) and an exit code. Human diagnostics go to stderr.
 *
 * The CLI never evaluates shell strings, package scripts, or project binaries. `gate run`
 * hands cases to a reviewed launcher over the inherited IPC channel of the process that
 * started it; without one it can only plan (`--plan-only`, which runs zero cases: NOT_RUN).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ADAPTER_HEADERS,
  ADAPTER_REVISION,
  ENFORCEMENT_MODES,
  RouteSpecError,
  digestValue,
  type EnforcementMode,
} from '@routespec/contracts';
import {
  GateService,
  IpcCaseDriver,
  Logger,
  buildGateReport,
  exitCodeForDecision,
  planExport,
  recordExportFailure,
  renderJUnit,
  renderJson,
  renderSarif,
  resolveOutputPath,
  verifyBundle,
  writeExport,
  type RunnerMode,
} from '@routespec/runner';
import { compileScenario } from '@routespec/scenario';
import { GateJournal, RouteSpecStore } from '@routespec/store';
import { checkLocalPathSyntax } from '@routespec/hardening';
import { intFlag, usage, type CommandSpec, type ParsedArgs } from './args.ts';
import { EXIT, exitCodeForError, type ExitCode } from './exit.ts';

export interface CommandContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stderr: (line: string) => void;
}

export interface CommandResult {
  readonly exitCode: ExitCode;
  readonly result: Record<string, unknown>;
}

interface Command {
  readonly spec: CommandSpec;
  readonly needsData: boolean;
  run(args: ParsedArgs, ctx: CommandContext & { dataDir: string | null }): Promise<CommandResult>;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function digestArg(args: ParsedArgs, name: string): string {
  const v = args.strings[name] as string;
  if (!DIGEST.test(v)) usage('Flag must be a sha256: digest.', { flag: name });
  return v;
}

function idArg(args: ParsedArgs, name: string): string {
  const v = args.strings[name] as string;
  if (!ID.test(v)) usage('Flag must be a RouteSpec identifier.', { flag: name });
  return v;
}

function optional(args: ParsedArgs, name: string): string | null {
  return args.strings[name] ?? null;
}

function keyFor(scope: string, value: unknown): string {
  return `cli.${scope}.${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 40)}`;
}

function openStore(dataDir: string | null): RouteSpecStore {
  if (dataDir === null) usage('A data directory is required (--data or ROUTESPEC_DATA_DIR).');
  mkdirSync(dataDir, { recursive: true });
  return RouteSpecStore.open({ path: resolve(dataDir, 'journal.db') });
}

async function withStore<T>(
  dataDir: string | null,
  fn: (store: RouteSpecStore) => Promise<T> | T,
): Promise<T> {
  const store = openStore(dataDir);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

function readSource(file: string, maxBytes: number): string {
  // Plain local paths only: a UNC or device path is refused before any file-system call
  // (opening a UNC path can send the operator's credentials to a remote host).
  const syntax = checkLocalPathSyntax(file);
  if (!syntax.ok) usage('Input path is not an accepted local path.', { rule: syntax.rule as string });
  const full = resolve(file);
  if (!existsSync(full) || !statSync(full).isFile())
    usage('Input file not found.', { file: file.slice(-128) });
  if (statSync(full).size > maxBytes)
    usage('Input file exceeds the size limit.', { maxBytes: String(maxBytes) });
  return readFileSync(full, 'utf8');
}

function parseEnforcement(raw: string | null): EnforcementMode {
  if (raw === null) return 'LOCAL_ADVISORY';
  const v = raw.toUpperCase().replace(/-/g, '_');
  if ((ENFORCEMENT_MODES as readonly string[]).includes(v)) return v as EnforcementMode;
  throw new RouteSpecError(
    'RS_ENFORCEMENT_CLAIM_REJECTED',
    'Only LOCAL_ADVISORY, CI_CHECK, or REQUIRED_CHECK_UNVERIFIED can be recorded; RouteSpec never claims verified or blocking enforcement.',
    { details: { requested: v.slice(0, 48) } },
  );
}

function parseMode(raw: string): RunnerMode | string {
  const v = raw.toUpperCase().replace(/-/g, '_');
  if (v === 'SIMULATE' || v === 'REPLAY') return v;
  if (v === 'LIVE_DRY' || v === 'LIVE_DRY_PROBE' || v === 'LIVE') return 'LIVE_DRY_PROBE';
  usage('Mode must be simulate or replay.', { mode: raw.slice(0, 32) });
}

function writeReportFile(path: string, content: string): string {
  const full = resolveOutputPath(path);
  writeFileSync(full, content, { encoding: 'utf8', mode: 0o644 });
  return digestValue('routespec.report-file/1', content);
}

function writeReports(
  args: ParsedArgs,
  report: ReturnType<typeof buildGateReport>,
): Record<string, { digest: string }> {
  const written: Record<string, { digest: string }> = {};
  const targets: Array<[string, () => string]> = [
    ['json-out', () => renderJson(report)],
    ['junit', () => renderJUnit(report)],
    ['sarif', () => renderSarif(report)],
  ];
  for (const [flag, render] of targets) {
    const p = args.strings[flag] ?? (flag === 'json-out' ? args.strings['json'] : undefined);
    if (p !== undefined) written[flag] = { digest: writeReportFile(p, render()) };
  }
  return written;
}

const REPORT_FLAGS = {
  'json-out': { kind: 'string' },
  junit: { kind: 'string' },
  sarif: { kind: 'string' },
} as const;

const BLOCKING_CLAIM_FLAGS = ['branch-protection', 'required-check-verified', 'blocking'] as const;

function rejectBlockingClaims(args: ParsedArgs): void {
  for (const f of BLOCKING_CLAIM_FLAGS) {
    if (args.strings[f] !== undefined || args.booleans.has(f)) {
      throw new RouteSpecError(
        'RS_ENFORCEMENT_CLAIM_REJECTED',
        'Caller-supplied branch-protection or blocking state is not accepted as proof; v2 has no repository-settings verification adapter.',
        { details: { flag: f } },
      );
    }
  }
}

const CLAIM_FLAGS = {
  'branch-protection': { kind: 'string' },
  'required-check-verified': { kind: 'boolean' },
  blocking: { kind: 'boolean' },
} as const;

export const COMMANDS: Readonly<Record<string, Command>> = Object.freeze({
  'project create': {
    needsData: true,
    spec: { flags: { name: { kind: 'string', required: true }, 'idempotency-key': { kind: 'string' } } },
    run: (args, ctx) =>
      withStore(ctx.dataDir, (store) => {
        const name = args.strings['name'] as string;
        const out = store.createProject({
          name,
          idempotencyKey: args.strings['idempotency-key'] ?? keyFor('project', name),
        });
        return { exitCode: EXIT.PASS, result: out };
      }),
  },
  'revision register': {
    needsData: true,
    spec: {
      flags: {
        project: { kind: 'string', required: true },
        label: { kind: 'string', required: true },
        'config-digest': { kind: 'string', required: true },
        commit: { kind: 'string' },
      },
    },
    run: (args, ctx) =>
      withStore(ctx.dataDir, (store) => {
        const protocolProfileId = store.registerProtocolProfile();
        const out = store.createIntegrationRevision({
          projectId: idArg(args, 'project'),
          revisionLabel: args.strings['label'] as string,
          commitSha: optional(args, 'commit'),
          configurationDigest: digestArg(args, 'config-digest'),
          protocolProfileId,
        });
        return { exitCode: EXIT.PASS, result: { ...out, protocolProfileId } };
      }),
  },
  'build register': {
    needsData: true,
    spec: {
      flags: {
        project: { kind: 'string', required: true },
        revision: { kind: 'string', required: true },
        artifact: { kind: 'string', required: true },
        repository: { kind: 'string', required: true },
        commit: { kind: 'string', required: true },
        'toolchain-digest': { kind: 'string', required: true },
        'lock-digest': { kind: 'string', required: true },
        'declared-manifest-digest': { kind: 'string', required: true },
        'launch-recipe-digest': { kind: 'string', required: true },
        'dirty-tree-digest': { kind: 'string' },
        'ci-workflow-run': { kind: 'string' },
      },
    },
    run: (args, ctx) =>
      withStore(ctx.dataDir, (store) => {
        const out = store.registerBuild({
          projectId: idArg(args, 'project'),
          integrationRevisionId: idArg(args, 'revision'),
          repositoryLocator: args.strings['repository'] as string,
          commitSha: args.strings['commit'] as string,
          dirtyTreeDigest:
            args.strings['dirty-tree-digest'] === undefined ? null : digestArg(args, 'dirty-tree-digest'),
          artifactDigest: digestArg(args, 'artifact'),
          toolchainDigest: digestArg(args, 'toolchain-digest'),
          lockDigest: digestArg(args, 'lock-digest'),
          effectManifestDigest: digestArg(args, 'declared-manifest-digest'),
          ciWorkflowRunId: optional(args, 'ci-workflow-run'),
          launchRecipeDigest: digestArg(args, 'launch-recipe-digest'),
        });
        return {
          exitCode: EXIT.PASS,
          result: {
            ...out,
            attestation: 'USER_ASSERTED_LOCAL',
            note: 'Build identity is user-asserted; no attestation is claimed.',
          },
        };
      }),
  },
  'effect manifest': {
    needsData: true,
    spec: { flags: { build: { kind: 'string', required: true }, file: { kind: 'string', required: true } } },
    run: (args, ctx) =>
      withStore(ctx.dataDir, (store) => {
        const buildRevisionId = idArg(args, 'build');
        const build = new GateJournal(store).getBuildRevision(buildRevisionId);
        if (!build) throw new RouteSpecError('RS_NOT_FOUND', 'Build revision not found.');
        let doc: { hooks?: unknown };
        try {
          doc = JSON.parse(readSource(args.strings['file'] as string, 256 * 1024)) as { hooks?: unknown };
        } catch (error) {
          if (error instanceof RouteSpecError) throw error;
          throw new RouteSpecError('RS_SCHEMA_INVALID', 'Effect manifest file is not valid JSON.');
        }
        if (!Array.isArray(doc.hooks))
          throw new RouteSpecError('RS_SCHEMA_INVALID', 'Effect manifest needs a hooks array.');
        const out = store.createEffectManifest({
          buildRevisionId,
          artifactDigest: String(build['artifact_digest']),
          adapterRevision: ADAPTER_REVISION,
          hooks: doc.hooks as Parameters<RouteSpecStore['createEffectManifest']>[0]['hooks'],
        });
        return { exitCode: EXIT.PASS, result: out };
      }),
  },
  'effect policy': {
    needsData: true,
    spec: {
      flags: {
        build: { kind: 'string', required: true },
        scenario: { kind: 'string', required: true },
        manifest: { kind: 'string', required: true },
        sink: { kind: 'multi', required: true },
        basis: { kind: 'string' },
        'interceptor-profile': { kind: 'string' },
        inventory: { kind: 'string' },
      },
    },
    run: (args, ctx) =>
      withStore(ctx.dataDir, (store) => {
        const buildRevisionId = idArg(args, 'build');
        const build = new GateJournal(store).getBuildRevision(buildRevisionId);
        if (!build) throw new RouteSpecError('RS_NOT_FOUND', 'Build revision not found.');
        const basis = (args.strings['basis'] ?? 'DECLARED_HOOKS_ONLY').toUpperCase();
        if (
          ![
            'INDEPENDENT_BOUNDARY_INTERCEPT',
            'TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT',
            'DECLARED_HOOKS_ONLY',
          ].includes(basis)
        ) {
          usage('Unknown effect coverage basis.');
        }
        const out = store.createEffectCoveragePolicy({
          buildRevisionId,
          artifactDigest: String(build['artifact_digest']),
          selectedAttestationId: null,
          scenarioRevisionId: idArg(args, 'scenario'),
          manifestDigest: digestArg(args, 'manifest'),
          requiredSinkClasses: args.multi['sink'] ?? [],
          interceptorProfileDigest:
            args.strings['interceptor-profile'] === undefined ? null : digestArg(args, 'interceptor-profile'),
          callsiteInventoryDigest:
            args.strings['inventory'] === undefined ? null : digestArg(args, 'inventory'),
          basis: basis as 'DECLARED_HOOKS_ONLY',
        });
        return { exitCode: EXIT.PASS, result: { ...out, basis } };
      }),
  },
  'scenario validate': {
    needsData: false,
    spec: { flags: {}, positionals: 1 },
    run: async (args) => {
      const compiled = compileScenario(readSource(args.positionals[0] as string, 1024 * 1024));
      return {
        exitCode: EXIT.PASS,
        result: {
          valid: true,
          scenarioId: compiled.plan.scenarioId,
          revisionDigest: compiled.revisionDigest,
          provenance: compiled.revisionInput.provenanceClass,
          networkAccess: false,
        },
      };
    },
  },
  'scenario add': {
    needsData: true,
    spec: { flags: { reviewed: { kind: 'boolean' } }, positionals: 1 },
    run: (args, ctx) =>
      withStore(ctx.dataDir, (store) => {
        const compiled = compileScenario(readSource(args.positionals[0] as string, 1024 * 1024));
        const out = store.createScenarioRevision({
          ...compiled.revisionInput,
          reviewStatus: args.booleans.has('reviewed') ? 'REVIEWED' : 'UNREVIEWED',
        });
        return { exitCode: EXIT.PASS, result: { ...out, scenarioId: compiled.plan.scenarioId } };
      }),
  },
  'corpus create': {
    needsData: true,
    spec: {
      flags: {
        name: { kind: 'string', required: true },
        scenario: { kind: 'multi', required: true },
        advisory: { kind: 'multi' },
        require: { kind: 'string', required: true },
        severity: { kind: 'string' },
      },
    },
    run: (args, ctx) =>
      withStore(ctx.dataDir, (store) => {
        const requiredInvariants = (args.strings['require'] as string).split(',').map((s) => s.trim());
        if (requiredInvariants.some((i) => !/^INV-(0[1-9]|1[0-2])$/.test(i)))
          usage('Invalid invariant identifier.');
        const cases = [
          ...(args.multi['scenario'] ?? []).map((id) => ({ id, gatePolicy: 'REQUIRED' })),
          ...(args.multi['advisory'] ?? []).map((id) => ({ id, gatePolicy: 'ADVISORY' })),
        ].map((c) => {
          if (!ID.test(c.id)) usage('Scenario revision must be a RouteSpec identifier.');
          if (!store.getScenarioRevision(c.id))
            throw new RouteSpecError('RS_NOT_FOUND', 'Scenario revision not found.');
          return {
            scenarioRevisionId: c.id,
            requiredInvariants,
            severity: (args.strings['severity'] ?? 'HIGH').toUpperCase(),
            gatePolicy: c.gatePolicy,
          };
        });
        const out = store.createCorpusRevision({ label: args.strings['name'] as string, cases });
        return { exitCode: EXIT.PASS, result: { ...out, cases: cases.length } };
      }),
  },
  'gate create': {
    needsData: true,
    spec: {
      flags: {
        project: { kind: 'string', required: true },
        name: { kind: 'string', required: true },
        corpus: { kind: 'string', required: true },
        enforcement: { kind: 'string' },
        'require-attested-build': { kind: 'boolean' },
        gate: { kind: 'string' },
        ...CLAIM_FLAGS,
      },
    },
    run: (args, ctx) => {
      rejectBlockingClaims(args);
      const enforcementMode = parseEnforcement(optional(args, 'enforcement'));
      return withStore(ctx.dataDir, (store) => {
        const out = new GateJournal(store).createGateDefinition({
          projectId: idArg(args, 'project'),
          name: args.strings['name'] as string,
          corpusRevisionId: idArg(args, 'corpus'),
          enforcementMode,
          buildAttestationPolicy: args.booleans.has('require-attested-build')
            ? 'REQUIRE_TRUSTED'
            : 'ALLOW_USER_ASSERTED',
          ...(args.strings['gate'] !== undefined ? { gateId: idArg(args, 'gate') } : {}),
        });
        return {
          exitCode: EXIT.PASS,
          result: { ...out, enforcementMode, enforcementVerified: false, blocking: false },
        };
      });
    },
  },
  'gate run': {
    needsData: true,
    spec: {
      flags: {
        gate: { kind: 'string', required: true },
        build: { kind: 'string', required: true },
        artifact: { kind: 'string', required: true },
        corpus: { kind: 'string' },
        'effect-policy': { kind: 'string', required: true },
        'effect-manifest': { kind: 'string', required: true },
        mode: { kind: 'string', required: true },
        parallelism: { kind: 'string' },
        'plan-only': { kind: 'boolean' },
        'lease-ttl-ms': { kind: 'string' },
        json: { kind: 'boolean' },
        ...REPORT_FLAGS,
        ...CLAIM_FLAGS,
      },
    },
    run: async (args, ctx) => {
      rejectBlockingClaims(args);
      const mode = parseMode(args.strings['mode'] as string);
      if (mode !== 'SIMULATE' && mode !== 'REPLAY') {
        throw new RouteSpecError(
          'RS_MODE_POLICY_DENIED',
          'Gate runs execute only in the networkless SIMULATE or REPLAY modes; LIVE_DRY_PROBE is a separately authorized compatibility probe.',
        );
      }
      const planOnly = args.booleans.has('plan-only');
      const launcher = typeof process.send === 'function' && process.connected;
      if (!planOnly && !launcher) {
        throw new RouteSpecError(
          'RS_LAUNCHER_UNAVAILABLE',
          'No reviewed launcher channel: start this command through the RouteSpec launcher, or use --plan-only.',
        );
      }
      const leaseTtlMs = intFlag(args, 'lease-ttl-ms', 300_000, 1_000, 3_600_000);
      return withStore(ctx.dataDir, async (store) => {
        const logger = new Logger({
          sink: ctx.stderr,
          level: (ctx.env['ROUTESPEC_LOG_LEVEL'] as 'info') ?? 'info',
        });
        const service = new GateService(store, {
          leaseTtlMs,
          logger,
          dataDirectory: ctx.dataDir ?? 'unspecified',
        });
        const gates = new GateJournal(store);
        const gate = gates.latestGateDefinition(idArg(args, 'gate'));
        const created = service.createGateRun({
          gate,
          buildRevisionId: idArg(args, 'build'),
          artifactDigest: digestArg(args, 'artifact'),
          corpusRevisionId:
            args.strings['corpus'] === undefined ? gate.corpusRevisionId : idArg(args, 'corpus'),
          effectManifestDigest: digestArg(args, 'effect-manifest'),
          effectCoveragePolicyDigest: digestArg(args, 'effect-policy'),
          mode,
          maxParallelCases: intFlag(args, 'parallelism', 1, 1, 64),
        });
        const validation = service.validateGateRun(created.gateRunId);
        let cases: unknown[] = [];
        const controller = new AbortController();
        const onSignal = () => controller.abort();
        let driver: IpcCaseDriver | null = null;
        try {
          if (validation.ready && planOnly) service.abortBeforeStart(created.gateRunId);
          else if (validation.ready) {
            service.startGateRun(created.gateRunId);
            process.once('SIGINT', onSignal);
            process.once('SIGTERM', onSignal);
            driver = new IpcCaseDriver();
            cases = await service.executeCases(created.gateRunId, driver, {
              mode,
              signal: controller.signal,
            });
          }
        } finally {
          process.off('SIGINT', onSignal);
          process.off('SIGTERM', onSignal);
          driver?.close();
          await service.close();
        }
        const { evaluation } = service.evaluateGate(created.gateRunId);
        const report = buildGateReport(evaluation);
        const files = writeReports(args, report);
        const result = {
          gateRunId: created.gateRunId,
          gateRunIdentityDigest: created.identityDigest,
          mode,
          validation,
          handoff: {
            protocol: 'routespec.launcher/1',
            channel: launcher ? 'INHERITED_IPC' : 'NONE',
            headers: Object.values(ADAPTER_HEADERS).sort(),
            tokens: 'delivered only over the launcher channel; never printed or persisted in clear',
            tokenTtlMs: service.tokenTtlMs,
            attestation: 'USER_ASSERTED_LOCAL',
          },
          cases,
          report,
          files,
          metrics: logger.metrics.snapshot(),
        };
        if (!validation.ready) {
          return {
            exitCode: EXIT.CONFIG,
            result: { ...result, error: { code: 'RS_GATE_VALIDATION_FAILED' } },
          };
        }
        return { exitCode: exitCodeForDecision(report.decision), result };
      });
    },
  },
  'gate evaluate': {
    needsData: true,
    spec: {
      flags: {
        'gate-run': { kind: 'string', required: true },
        json: { kind: 'string' },
        ...REPORT_FLAGS,
        ...CLAIM_FLAGS,
      },
    },
    run: (args, ctx) => {
      rejectBlockingClaims(args);
      return withStore(ctx.dataDir, (store) => {
        const service = new GateService(store, { logger: new Logger({ sink: ctx.stderr }) });
        const { evaluation, created } = service.evaluateGate(idArg(args, 'gate-run'));
        const report = buildGateReport(evaluation);
        const files = writeReports(args, report);
        return { exitCode: exitCodeForDecision(report.decision), result: { created, report, files } };
      });
    },
  },
  'gate show': {
    needsData: true,
    spec: { flags: { 'gate-evaluation': { kind: 'string', required: true } } },
    run: (args, ctx) =>
      withStore(ctx.dataDir, (store) => {
        const report = buildGateReport(
          new GateJournal(store).getGateEvaluation(idArg(args, 'gate-evaluation')),
        );
        return { exitCode: exitCodeForDecision(report.decision), result: { report } };
      }),
  },
  'case recover': {
    needsData: true,
    spec: { flags: { 'case-run': { kind: 'string', required: true }, json: { kind: 'boolean' } } },
    run: (args, ctx) =>
      withStore(ctx.dataDir, (store) => {
        const service = new GateService(store, { logger: new Logger({ sink: ctx.stderr }) });
        const out = service.recoverCase(idArg(args, 'case-run'));
        if (out.code !== null) {
          throw new RouteSpecError('RS_INTERNAL', 'Case recovery did not complete.', {
            details: { cause: out.code },
          });
        }
        return {
          exitCode: EXIT.PASS,
          result: {
            ...out,
            interrupted: true,
            note: 'Recovered with exactly one reconciliation-only token (not handed to any client); an interrupted case never contributes PASS.',
          },
        };
      }),
  },
  'probe dry': {
    needsData: false,
    spec: { flags: { revision: { kind: 'string' }, profile: { kind: 'string' } } },
    run: async () => {
      throw new RouteSpecError(
        'RS_MODE_POLICY_DENIED',
        'LIVE_DRY_PROBE runs only in the separately launched live-dry adapter after explicit user authorization; the gate CLI never contacts the official endpoint.',
      );
    },
  },
  'export plan': {
    needsData: true,
    spec: {
      flags: {
        'gate-evaluation': { kind: 'string', required: true },
        attach: { kind: 'multi' },
        'include-addresses': { kind: 'boolean' },
        'acknowledge-addresses': { kind: 'boolean' },
        'idempotency-key': { kind: 'string' },
      },
    },
    run: (args, ctx) =>
      withStore(ctx.dataDir, (store) => {
        const gateEvaluationId = idArg(args, 'gate-evaluation');
        const attachments = (args.multi['attach'] ?? []).map((file) => ({
          name: file,
          content: readSource(file, 256 * 1024),
        }));
        const request = {
          gateEvaluationId,
          attachments: attachments.map((a) => digestValue('routespec.cli-attachment/1', a.content)),
          include: args.booleans.has('include-addresses'),
          ack: args.booleans.has('acknowledge-addresses'),
        };
        const plan = planExport(store, gateEvaluationId, {
          idempotencyKey: args.strings['idempotency-key'] ?? keyFor('export-plan', request),
          attachments,
          includeAddresses: request.include,
          acknowledgeAddresses: request.ack,
          localPathMarkers: ctx.dataDir === null ? [] : [resolve(ctx.dataDir)],
        });
        const result = {
          ...plan,
          confirm: plan.blocked ? null : plan.planDigest,
          note: plan.blocked
            ? 'Export blocked by the privacy scan; findings list category and location only.'
            : 'Nothing was written. Run export write with --confirm <planDigest> and an explicit --out path.',
        };
        if (plan.blocked) {
          ctx.stderr(
            `routespec: export blocked: ${plan.findings.filter((f) => f.blocking).length} blocking finding(s)`,
          );
          return {
            exitCode: EXIT.POLICY_DENIED,
            result: { ...result, error: { code: 'RS_EXPORT_BLOCKED' } },
          };
        }
        return { exitCode: EXIT.PASS, result };
      }),
  },
  'export write': {
    needsData: true,
    spec: {
      flags: {
        export: { kind: 'string', required: true },
        out: { kind: 'string', required: true },
        confirm: { kind: 'string', required: true },
        overwrite: { kind: 'boolean' },
        'retain-path': { kind: 'boolean' },
        'idempotency-key': { kind: 'string' },
      },
    },
    run: (args, ctx) =>
      withStore(ctx.dataDir, (store) => {
        const exportId = idArg(args, 'export');
        const plan = new GateJournal(store).getExportPlan(exportId);
        const key =
          args.strings['idempotency-key'] ??
          keyFor('export-write', {
            exportId,
            out: resolve(args.strings['out'] as string),
            revision: plan.revision,
          });
        try {
          const out = writeExport(store, exportId, {
            outPath: args.strings['out'] as string,
            confirm: args.strings['confirm'] as string,
            overwrite: args.booleans.has('overwrite'),
            retainPath: args.booleans.has('retain-path'),
            idempotencyKey: key,
          });
          return { exitCode: EXIT.PASS, result: { ...out, decisionUnchanged: true } };
        } catch (error) {
          if (error instanceof RouteSpecError && error.code === 'RS_EXPORT_PATH_INVALID') {
            recordExportFailure(store, exportId, error.code, `${key}.path`);
          }
          throw error;
        }
      }),
  },
  'export verify': {
    needsData: false,
    spec: {
      flags: { bundle: { kind: 'string', required: true }, 'extract-to': { kind: 'string', required: true } },
    },
    run: async (args) => {
      const v = verifyBundle(args.strings['bundle'] as string, args.strings['extract-to'] as string);
      if (!v.verified) {
        return { exitCode: EXIT.INTERNAL, result: { ...v, error: { code: 'RS_BUNDLE_VERIFY_FAILED' } } };
      }
      return { exitCode: EXIT.PASS, result: { ...v } };
    },
  },
});

export const COMMAND_NAMES = Object.freeze(Object.keys(COMMANDS).sort());

export function errorResult(error: unknown): CommandResult {
  const exitCode = exitCodeForError(error);
  if (error instanceof RouteSpecError) {
    return {
      exitCode,
      result: {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          recoverable: error.recoverable,
        },
      },
    };
  }
  return {
    exitCode,
    result: { error: { code: 'RS_INTERNAL', message: 'Unexpected internal error.', details: {} } },
  };
}

export { exitCodeForError };
