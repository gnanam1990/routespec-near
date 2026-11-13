/**
 * The RouteSpec gate action (M10 deliverables 1–3, 5, 6).
 *
 * One invocation, in a fixed order:
 *
 * 1. Withhold provider and CI credentials from this process before anything else runs.
 * 2. Load the reviewed configuration (strict JSON, closed schema; enforcement claims refused).
 * 3. Classify the job's trust from the runner environment and event payload.
 * 4. Refuse a live-dry probe request in an untrusted job (the gate itself never launches one).
 * 5. Measure identity from bytes: artifact, lockfile, manifest, client module, configuration,
 *    workspace commit (must equal the runner's commit), and a dirty-tree digest.
 * 6. Register project, revision, build (always USER_ASSERTED_LOCAL), effect manifest, scenarios,
 *    corpus, coverage policy, and gate definition through the real `routespec` CLI commands in a
 *    fresh journal outside the workspace.
 * 7. Re-measure the artifact, then run `routespec gate run` through the reviewed launcher. Each
 *    case handoff goes to the configured client module's `onCase`, which connects the user's
 *    separately started client to the printed proxy origin. Tokens cross only the launcher pipe
 *    and the client handoff object; they are never printed, written, or passed as arguments.
 * 8. Re-measure the artifact after the run. A changed artifact means the decision does not apply
 *    to the bytes in the workspace: the conclusion becomes an identity mismatch.
 * 9. In a trusted job, optionally plan and write the redacted evidence bundle (artifact readiness
 *    changes, the decision does not), then re-render the reports from the persisted evaluation.
 * 10. Stage only configured, permitted, scanned files for upload and report outputs.
 *
 * The exit code is the RouteSpec exit code: only a PASS decision exits 0.
 */
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RouteSpecError, type Verdict } from '@routespec/contracts';
import {
  exitCodeForError,
  runCli,
  runWithLauncher,
  type LauncherCaseControl,
  type LauncherCaseResult,
} from '@routespec/cli';
import type { CaseHandoff } from '@routespec/runner';
import { ciAttestationState, type CiAttestationState } from './attestation.ts';
import {
  isWithin,
  loadCiConfig,
  parseEnforcementRequest,
  rejectEnforcementClaims,
  resolveInside,
  type CiConfig,
  type UploadKind,
} from './config.ts';
import { isTrusted, readCiContext, type CiContext } from './context.ts';
import {
  conclusionFor,
  resolveEnforcement,
  type CiConclusion,
  type EnforcementState,
} from './enforcement.ts';
import { artifactDigest, measureIdentity, type MeasuredIdentity } from './identity.ts';
import { childEnvironment, secretFindings, withholdSecrets } from './secrets.ts';
import { stageUploads, type UploadCandidate, type UploadManifest } from './uploads.ts';

export const ACTION_REVISION = 'routespec-ci-action@1.0.0' as const;
export const ACTION_RESULT_SCHEMA = 'routespec.ci-result/1' as const;

/** The contract a configured client module implements (same shape as the launcher's `onCase`). */
export interface ClientModule {
  onCase(
    handoff: CaseHandoff,
    control: LauncherCaseControl,
    context: { readonly workspace: string; readonly artifactFiles: readonly string[] },
  ): Promise<LauncherCaseResult>;
}

export interface ActionOptions {
  /** Workspace root (the checkout). */
  readonly workspace: string;
  /** Configuration path relative to the workspace. */
  readonly configPath: string;
  /** Directory for the journal, reports, and staging; must be outside the workspace. */
  readonly workDirectory: string;
  /** The runner environment. Credentials are removed from it in place. */
  readonly env: Record<string, string | undefined>;
  /** Credentials the step shell removed before starting this process (values for the leak scan). */
  readonly launcherWithheld?: Readonly<Record<string, string>>;
  /** Caller-supplied flags (from the action inputs); enforcement claims are refused. */
  readonly flags?: Readonly<Record<string, string | boolean>>;
  readonly stderr: (line: string) => void;
}

export type LiveDryState = 'NOT_REQUESTED' | 'ELIGIBLE_NOT_RUN' | 'DENIED_UNTRUSTED_CONTEXT';

export interface ActionResult {
  readonly schema: typeof ACTION_RESULT_SCHEMA;
  readonly action: typeof ACTION_REVISION;
  readonly exitCode: number;
  readonly conclusion: CiConclusion;
  readonly decision: Verdict | null;
  readonly context: CiContext;
  readonly enforcement: EnforcementState | null;
  readonly attestation: CiAttestationState;
  readonly buildAttestation: 'USER_ASSERTED_LOCAL';
  readonly identity: Omit<MeasuredIdentity, 'repositoryLocator'> | null;
  readonly gateRunId: string | null;
  readonly gateEvaluationId: string | null;
  readonly artifactReady: boolean;
  readonly liveDry: LiveDryState;
  readonly withheldEnvironment: readonly string[];
  readonly uploads: UploadManifest | null;
  readonly uploadDirectory: string | null;
  /**
   * What the separate certificate step needs (M47): the staged, scanned evidence bundle and the
   * journal of this run. Null unless a trusted job staged the bundle. The gate step itself never
   * signs or publishes anything and never sees a signer secret.
   */
  readonly certificate: { readonly bundlePath: string; readonly journalDirectory: string } | null;
  readonly findings: readonly string[];
  readonly error: { readonly code: string; readonly details: Record<string, string> } | null;
}

interface CliOutcome {
  readonly exitCode: number;
  readonly json: Record<string, unknown>;
}

class CliStepFailed extends Error {
  readonly outcome: CliOutcome;
  readonly step: string;
  constructor(step: string, outcome: CliOutcome) {
    super(`routespec ${step} exited ${outcome.exitCode}`);
    this.step = step;
    this.outcome = outcome;
  }
}

const REPORT_FILES = {
  'gate-report-json': 'gate-report.json',
  junit: 'junit.xml',
  sarif: 'routespec.sarif',
  'evidence-bundle': 'evidence-bundle.tar',
} as const satisfies Record<UploadKind, string>;

const FLAG_NAMES = new Set(['config', 'workspace', 'work-dir']);

function str(v: unknown): string {
  return typeof v === 'string' ? v : String(v);
}

export async function runAction(options: ActionOptions): Promise<ActionResult> {
  // 1. Credentials leave the environment before any configuration or client code is read.
  const withheld = withholdSecrets(options.env, options.launcherWithheld);
  const childEnv = childEnvironment(options.env);
  const findings: string[] = [];
  let ctx = readCiContext(options.env);
  let enforcement: EnforcementState | null = null;
  let identity: MeasuredIdentity | null = null;
  let decision: Verdict | null = null;
  let gateRunId: string | null = null;
  let gateEvaluationId: string | null = null;
  let artifactReady = false;
  let liveDry: LiveDryState = 'NOT_REQUESTED';
  let uploads: UploadManifest | null = null;
  let uploadDirectory: string | null = null;
  let certificate: ActionResult['certificate'] = null;
  let exitCode = 5;
  let error: ActionResult['error'] = null;

  const cliAny = async (args: string[]): Promise<CliOutcome> => {
    let stdout = '';
    const code = await runCli(args, {
      stdout: (t) => (stdout += t),
      stderr: (line) => options.stderr(line),
      env: childEnv,
    });
    return { exitCode: code, json: JSON.parse(stdout) as Record<string, unknown> };
  };
  const cli = async (step: string, args: string[]): Promise<CliOutcome> => {
    const outcome = await cliAny(args);
    if (outcome.exitCode !== 0) throw new CliStepFailed(step, outcome);
    return outcome;
  };

  try {
    // 2. Flags and configuration.
    const flags = options.flags ?? {};
    rejectEnforcementClaims(flags, 'inputs');
    for (const k of Object.keys(flags)) {
      if (!FLAG_NAMES.has(k)) {
        throw new RouteSpecError('RS_CLI_USAGE', 'Unknown action input.', {
          details: { flag: k.slice(0, 64) },
        });
      }
    }
    const workspace = realpathSync(options.workspace);
    mkdirSync(options.workDirectory, { recursive: true });
    const workRoot = realpathSync(options.workDirectory);
    if (isWithin(workspace, workRoot)) {
      throw new RouteSpecError('RS_SCHEMA_INVALID', 'The work directory must be outside the workspace.');
    }
    const config: CiConfig = loadCiConfig(options.configPath, workspace);

    // 3. Trust and enforcement.
    ctx = readCiContext(options.env, config.trustedRefs ? { trustedRefs: config.trustedRefs } : {});
    findings.push(...ctx.findings, ...secretFindings(withheld, ctx));
    const trusted = isTrusted(ctx);
    enforcement = resolveEnforcement(ctx, parseEnforcementRequest(config.gate.enforcement));
    findings.push(...enforcement.findings);

    // 4. Live dry: never launched by the gate; refused outright in an untrusted job.
    if (config.liveDry.requested) {
      if (!trusted) {
        liveDry = 'DENIED_UNTRUSTED_CONTEXT';
        throw new RouteSpecError(
          'RS_MODE_POLICY_DENIED',
          'An untrusted CI job cannot start the live-dry adapter.',
          { details: { trust: ctx.trust } },
        );
      }
      liveDry = 'ELIGIBLE_NOT_RUN';
      findings.push('LIVE_DRY_IS_A_SEPARATE_OPERATOR_PROBE');
    }

    // 5. Identity measured from bytes.
    identity = measureIdentity(workspace, options.configPath, config, ctx);
    if (identity.dirtyTreeDigest !== null) findings.push('WORKSPACE_DIRTY');

    // 6. Registration through the real CLI commands in a fresh journal.
    const run = mkdtempSync(join(workRoot, 'rs-'));
    const data = join(run, 'journal');
    const reports = join(run, 'reports');
    const staging = join(run, 'upload');
    mkdirSync(data);
    mkdirSync(reports);
    const D = ['--data', data];
    const project = await cli('project create', ['project', 'create', ...D, '--name', config.project]);
    const projectId = str(project.json['projectId']);
    const revision = await cli('revision register', [
      'revision',
      'register',
      ...D,
      '--project',
      projectId,
      '--label',
      config.revisionLabel,
      '--config-digest',
      identity.configurationDigest,
      '--commit',
      identity.commitSha,
    ]);
    const build = await cli('build register', [
      'build',
      'register',
      ...D,
      '--project',
      projectId,
      '--revision',
      str(revision.json['integrationRevisionId']),
      '--artifact',
      identity.artifactDigest,
      '--repository',
      identity.repositoryLocator,
      '--commit',
      identity.commitSha,
      '--toolchain-digest',
      identity.toolchainDigest,
      '--lock-digest',
      identity.lockDigest,
      '--declared-manifest-digest',
      identity.manifestDigest,
      '--launch-recipe-digest',
      identity.launchRecipeDigest,
      ...(identity.dirtyTreeDigest ? ['--dirty-tree-digest', identity.dirtyTreeDigest] : []),
      ...(identity.ciWorkflowRunId ? ['--ci-workflow-run', identity.ciWorkflowRunId] : []),
    ]);
    const buildRevisionId = str(build.json['buildRevisionId']);
    const manifest = await cli('effect manifest', [
      'effect',
      'manifest',
      ...D,
      '--build',
      buildRevisionId,
      '--file',
      resolveInside(workspace, config.subject.manifestFile, 'subject.manifestFile'),
    ]);
    const manifestDigest = str(manifest.json['manifestDigest']);
    if (!trusted) findings.push('SCENARIOS_UNREVIEWED_UNTRUSTED_CONTEXT');
    const required: string[] = [];
    const advisory: string[] = [];
    for (const [i, s] of config.scenarios.entries()) {
      const added = await cli('scenario add', [
        'scenario',
        'add',
        ...D,
        resolveInside(workspace, s.file, `scenarios.${i}.file`),
        ...(trusted ? ['--reviewed'] : []),
      ]);
      (s.policy === 'ADVISORY' ? advisory : required).push(str(added.json['scenarioRevisionId']));
    }
    if (required.length === 0) {
      throw new RouteSpecError(
        'RS_SCHEMA_INVALID',
        'The CI configuration needs at least one REQUIRED scenario.',
      );
    }
    const corpus = await cli('corpus create', [
      'corpus',
      'create',
      ...D,
      '--name',
      `${config.gate.name} corpus`,
      ...required.flatMap((id) => ['--scenario', id]),
      ...advisory.flatMap((id) => ['--advisory', id]),
      '--require',
      config.requiredInvariants.join(','),
    ]);
    const policy = await cli('effect policy', [
      'effect',
      'policy',
      ...D,
      '--build',
      buildRevisionId,
      '--scenario',
      required[0] as string,
      '--manifest',
      manifestDigest,
      ...config.effect.sinks.flatMap((s) => ['--sink', s]),
      '--basis',
      config.effect.basis,
    ]);
    const gate = await cli('gate create', [
      'gate',
      'create',
      ...D,
      '--project',
      projectId,
      '--name',
      config.gate.name,
      '--corpus',
      str(corpus.json['corpusRevisionId']),
      '--enforcement',
      enforcement.mode,
      ...(config.gate.requireAttestedBuild ? ['--require-attested-build'] : []),
    ]);

    // 7. Gate run through the reviewed launcher.
    const artifactFiles = config.subject.artifactFiles.map((f, i) =>
      resolveInside(workspace, f, `subject.artifactFiles.${i}`),
    );
    if (artifactDigest(workspace, config.subject.artifactFiles) !== identity.artifactDigest) {
      throw new RouteSpecError('RS_IDENTITY_MISMATCH', 'The artifact changed after registration.', {
        details: { reason: 'ARTIFACT_SWAPPED_BEFORE_RUN' },
      });
    }
    const clientPath = resolveInside(workspace, config.subject.clientModule, 'subject.clientModule');
    const client = (await import(pathToFileURL(clientPath).href)) as Partial<ClientModule>;
    if (typeof client.onCase !== 'function') {
      throw new RouteSpecError('RS_SCHEMA_INVALID', 'The client module must export an onCase function.');
    }
    const onCase = client.onCase.bind(client);
    const launched = await runWithLauncher({
      args: [
        'gate',
        'run',
        ...D,
        '--gate',
        str(gate.json['gateId']),
        '--build',
        buildRevisionId,
        '--artifact',
        identity.artifactDigest,
        '--effect-policy',
        str(policy.json['policyDigest']),
        '--effect-manifest',
        manifestDigest,
        '--mode',
        config.gate.mode,
        '--parallelism',
        String(config.gate.parallelism),
        '--json-out',
        join(reports, REPORT_FILES['gate-report-json']),
        '--junit',
        join(reports, REPORT_FILES.junit),
        '--sarif',
        join(reports, REPORT_FILES.sarif),
      ],
      cwd: run,
      env: childEnv,
      onCase: (handoff, control) => onCase(handoff, control, { workspace, artifactFiles }),
    });
    for (const line of launched.stderr.split(/\r?\n/)) if (line.trim() !== '') options.stderr(line);
    const json = launched.json ?? {};
    exitCode = launched.exitCode ?? 5;
    gateRunId = typeof json['gateRunId'] === 'string' ? json['gateRunId'] : null;
    const report = (json['report'] ?? null) as Record<string, unknown> | null;
    if (report) {
      decision = report['decision'] as Verdict;
      gateEvaluationId = str(report['gateEvaluationId']);
      artifactReady = (report['artifact'] as { ready?: boolean } | undefined)?.ready === true;
    }
    if (![0, 2, 3].includes(exitCode)) {
      const e = (json['error'] ?? {}) as { code?: string };
      error = { code: e.code ?? 'RS_INTERNAL', details: { step: 'gate run' } };
    }

    // 8. The decision binds the registered artifact; a changed artifact invalidates it here.
    if (
      error === null &&
      artifactDigest(workspace, config.subject.artifactFiles) !== identity.artifactDigest
    ) {
      findings.push('ARTIFACT_CHANGED_DURING_RUN');
      exitCode = 4;
      error = { code: 'RS_IDENTITY_MISMATCH', details: { reason: 'ARTIFACT_CHANGED_DURING_RUN' } };
    }

    // 9. Evidence bundle (trusted jobs only); readiness is separate from the decision.
    const wantBundle = config.uploads.include.includes('evidence-bundle');
    const bundlePath = join(reports, REPORT_FILES['evidence-bundle']);
    if (wantBundle && trusted && gateEvaluationId !== null && error === null) {
      try {
        const plan = await cli('export plan', [
          'export',
          'plan',
          ...D,
          '--gate-evaluation',
          gateEvaluationId,
        ]);
        await cli('export write', [
          'export',
          'write',
          ...D,
          '--export',
          str(plan.json['exportId']),
          '--out',
          bundlePath,
          '--confirm',
          str(plan.json['planDigest']),
        ]);
      } catch (e) {
        if (!(e instanceof CliStepFailed)) throw e;
        findings.push(
          `EVIDENCE_BUNDLE_NOT_WRITTEN:${str((e.outcome.json['error'] as { code?: string })?.code)}`,
        );
      }
      const reportArgs = [
        '--json-out',
        join(reports, REPORT_FILES['gate-report-json']),
        '--junit',
        join(reports, REPORT_FILES.junit),
        '--sarif',
        join(reports, REPORT_FILES.sarif),
      ];
      const refreshed = await cliAny([
        'gate',
        'evaluate',
        ...D,
        '--gate-run',
        gateRunId as string,
        ...reportArgs,
      ]);
      const r = (refreshed.json['report'] ?? {}) as { decision?: Verdict; artifact?: { ready?: boolean } };
      if (refreshed.exitCode !== exitCode || r.decision !== decision) {
        throw new RouteSpecError('RS_INTERNAL', 'Re-rendering the reports changed the decision.');
      }
      artifactReady = r.artifact?.ready === true;
    }

    // 10. Upload staging.
    const candidates: UploadCandidate[] = [
      ...config.uploads.include.map((kind) => ({ kind, path: join(reports, REPORT_FILES[kind]) })),
      ...config.uploads.extraPaths.map((p) => ({ kind: 'extra' as const, path: resolve(workspace, p) })),
    ];
    uploads = stageUploads(candidates, {
      trusted,
      trust: ctx.trust,
      retentionDays: config.uploads.retentionDays,
      allowedRoots: [workspace, reports],
      dataDirectory: data,
      stagingDirectory: staging,
      configuredSecrets: withheld.values,
      pathMarkers: [workspace, workRoot, homedir()],
    });
    uploadDirectory = staging;
    const stagedBundle = uploads.staged.find((s) => s.kind === 'evidence-bundle');
    if (trusted && stagedBundle !== undefined && error === null) {
      certificate = { bundlePath: join(staging, stagedBundle.name), journalDirectory: data };
    }
  } catch (e) {
    if (e instanceof CliStepFailed) {
      exitCode = e.outcome.exitCode;
      const err = (e.outcome.json['error'] ?? {}) as { code?: string };
      error = { code: err.code ?? 'RS_INTERNAL', details: { step: e.step } };
    } else {
      exitCode = exitCodeForError(e);
      error =
        e instanceof RouteSpecError
          ? {
              code: e.code,
              details: Object.fromEntries(Object.entries(e.details).map(([k, v]) => [k, String(v)])),
            }
          : { code: 'RS_INTERNAL', details: {} };
    }
  }
  const conclusion =
    error !== null && exitCode === 4 && error.code === 'RS_IDENTITY_MISMATCH'
      ? 'identity_mismatch'
      : conclusionFor(exitCode, decision);
  const { repositoryLocator: _locator, ...publicIdentity } = identity ?? ({} as MeasuredIdentity);
  return {
    schema: ACTION_RESULT_SCHEMA,
    action: ACTION_REVISION,
    exitCode,
    conclusion,
    decision,
    context: ctx,
    enforcement,
    attestation: ciAttestationState(ctx),
    buildAttestation: 'USER_ASSERTED_LOCAL',
    identity: identity === null ? null : publicIdentity,
    gateRunId,
    gateEvaluationId,
    artifactReady,
    liveDry,
    withheldEnvironment: withheld.names,
    uploads,
    uploadDirectory,
    certificate,
    findings,
    error,
  };
}
