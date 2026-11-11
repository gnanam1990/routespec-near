/**
 * M06 product harness. It drives only real product surfaces: the `routespec` CLI (spawned as
 * a separate process through the reviewed launcher), the M01 journal repositories for setup,
 * the M02 proxy/supervisor and M04 kernel inside the CLI process, and separately launched
 * installed subject processes running the pinned official SDK with the RouteSpec adapter.
 * No journal row is written directly and no verdict is seeded.
 */
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_REVISION, digestValue } from '@routespec/contracts';
import type { LaunchCredentials } from '@routespec/proxy';
import type { CaseHandoff } from '@routespec/runner';
import { CORE_SCENARIO_SOURCES, compileScenario } from '@routespec/scenario';
import { GateJournal, RouteSpecStore, type BuildAttestationPolicy } from '@routespec/store';
import type { EnforcementMode } from '@routespec/contracts';
import { CLI_ENTRY, runWithLauncher, type LauncherResult } from '../../src/launcher.ts';

export const LIVE_INVARIANTS = ['INV-01', 'INV-02', 'INV-03', 'INV-05', 'INV-06', 'INV-07', 'INV-08'];

export function d(label: string): `sha256:${string}` {
  return digestValue('routespec.test.digest/1', label);
}

export function tempDir(prefix = 'routespec-m06-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

export type SubjectBuild = 'reconciling-client' | 'naive-client';

export function subjectScript(build: SubjectBuild): string {
  return fileURLToPath(new URL(`./subject/${build}.ts`, import.meta.url));
}

export function subjectArtifactDigest(build: SubjectBuild): `sha256:${string}` {
  const bytes = Buffer.concat([
    readFileSync(subjectScript(build)),
    readFileSync(fileURLToPath(new URL('./subject/runtime.ts', import.meta.url))),
  ]);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Scenario sources: the reviewed core scenarios plus two test variants derived from them. */
export function scenarioSource(id: string): string {
  if (id === 'refund-shortfall') {
    return (CORE_SCENARIO_SOURCES['incomplete-deposit-refund'] as string)
      .replace('scenarioId: incomplete-deposit-refund', 'scenarioId: refund-shortfall')
      .replace('seed: core-refund-1', 'seed: m06-refund-shortfall-1')
      .replace(
        '{ id: refund-settled, fact: REFUND, assetId: nep141:origin.sim, amount: "400000", recipient: refund.sim }',
        '{ id: refund-settled, fact: REFUND, assetId: nep141:origin.sim, amount: "300000", recipient: refund.sim }',
      );
  }
  const s = CORE_SCENARIO_SOURCES[id];
  if (!s) throw new Error(`unknown scenario ${id}`);
  return s;
}

export interface Journal {
  readonly dataDir: string;
  readonly projectId: string;
  readonly integrationRevisionId: string;
  readonly buildRevisionId: string;
  readonly artifactDigest: string;
  readonly manifestDigest: string;
  readonly policyDigest: string;
  readonly scenarioRevisionIds: string[];
  readonly corpusRevisionId: string;
  readonly gateId: string;
  readonly build: SubjectBuild;
}

export interface JournalOptions {
  readonly scenarios: readonly string[];
  readonly build: SubjectBuild;
  readonly requiredInvariants?: readonly string[];
  readonly enforcementMode?: EnforcementMode;
  readonly buildAttestationPolicy?: BuildAttestationPolicy;
  readonly label?: string;
  readonly configurationDigest?: string;
  readonly advisoryScenarios?: readonly string[];
}

/** Register project/revision/build/manifest/scenarios/corpus/policy/gate via the repositories. */
export function setupJournal(dataDir: string, options: JournalOptions): Journal {
  mkdirSync(dataDir, { recursive: true });
  const store = RouteSpecStore.open({ path: join(dataDir, 'journal.db') });
  try {
    const label = options.label ?? 'm06';
    const { projectId } = store.createProject({
      name: `project ${label}`,
      idempotencyKey: `project-${label}-key`,
    });
    const profileId = store.registerProtocolProfile();
    const { integrationRevisionId } = store.createIntegrationRevision({
      projectId,
      revisionLabel: 'r1',
      commitSha: null,
      configurationDigest: options.configurationDigest ?? d('config'),
      protocolProfileId: profileId,
    });
    return addBuildAndGate(store, dataDir, { projectId, integrationRevisionId }, options);
  } finally {
    store.close();
  }
}

export function addBuildAndGate(
  store: RouteSpecStore,
  dataDir: string,
  base: { projectId: string; integrationRevisionId: string },
  options: JournalOptions,
): Journal {
  const label = options.label ?? 'm06';
  const artifactDigest = subjectArtifactDigest(options.build);
  const { buildRevisionId } = store.registerBuild({
    projectId: base.projectId,
    integrationRevisionId: base.integrationRevisionId,
    repositoryLocator: `git+file:subject/${options.build}`,
    commitSha: createHash('sha1').update(options.build).digest('hex'),
    dirtyTreeDigest: null,
    artifactDigest,
    toolchainDigest: d('toolchain-node22'),
    lockDigest: d('lock'),
    effectManifestDigest: d(`manifest-${options.build}`),
    ciWorkflowRunId: null,
    launchRecipeDigest: d(`recipe-${options.build}`),
  });
  const { manifestDigest } = store.createEffectManifest({
    buildRevisionId,
    artifactDigest,
    adapterRevision: ADAPTER_REVISION,
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
  });
  const required = options.requiredInvariants ?? LIVE_INVARIANTS;
  const scenarioRevisionIds = options.scenarios.map(
    (id) =>
      store.createScenarioRevision({
        ...compileScenario(scenarioSource(id)).revisionInput,
        reviewStatus: 'REVIEWED',
      }).scenarioRevisionId,
  );
  const advisoryIds = (options.advisoryScenarios ?? []).map(
    (id) =>
      store.createScenarioRevision({
        ...compileScenario(scenarioSource(id)).revisionInput,
        reviewStatus: 'REVIEWED',
      }).scenarioRevisionId,
  );
  const { corpusRevisionId } = store.createCorpusRevision({
    label: `corpus-${label}`,
    cases: [
      ...scenarioRevisionIds.map((s) => ({
        scenarioRevisionId: s,
        requiredInvariants: required,
        severity: 'HIGH',
        gatePolicy: 'REQUIRED',
      })),
      ...advisoryIds.map((s) => ({
        scenarioRevisionId: s,
        requiredInvariants: required,
        severity: 'LOW',
        gatePolicy: 'ADVISORY',
      })),
    ],
  });
  const { policyDigest } = store.createEffectCoveragePolicy({
    buildRevisionId,
    artifactDigest,
    selectedAttestationId: null,
    scenarioRevisionId: scenarioRevisionIds[0] as string,
    manifestDigest,
    requiredSinkClasses: ['fulfilment-webhook'],
    interceptorProfileDigest: null,
    callsiteInventoryDigest: null,
    basis: 'DECLARED_HOOKS_ONLY',
  });
  const { gateId } = new GateJournal(store).createGateDefinition({
    projectId: base.projectId,
    name: `gate ${label}`,
    corpusRevisionId,
    enforcementMode: options.enforcementMode ?? 'LOCAL_ADVISORY',
    buildAttestationPolicy: options.buildAttestationPolicy ?? 'ALLOW_USER_ASSERTED',
  });
  return {
    dataDir,
    projectId: base.projectId,
    integrationRevisionId: base.integrationRevisionId,
    buildRevisionId,
    artifactDigest,
    manifestDigest,
    policyDigest,
    scenarioRevisionIds,
    corpusRevisionId,
    gateId,
    build: options.build,
  };
}

export function gateRunArgs(j: Journal, extra: readonly string[] = []): string[] {
  return [
    'gate',
    'run',
    '--data',
    j.dataDir,
    '--gate',
    j.gateId,
    '--build',
    j.buildRevisionId,
    '--artifact',
    j.artifactDigest,
    '--effect-policy',
    j.policyDigest,
    '--effect-manifest',
    j.manifestDigest,
    '--mode',
    'simulate',
    '--json',
    ...extra,
  ];
}

// ---------------------------------------------------------------------------------------------
// Separately launched installed subject (user/CI-started client).

export class Subject {
  readonly child: ChildProcess;
  private constructor(child: ChildProcess) {
    this.child = child;
  }
  static async launch(build: SubjectBuild): Promise<Subject> {
    const child = fork(subjectScript(build), [], {
      execArgv: ['--no-warnings'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const s = new Subject(child);
    await s.wait('loaded');
    return s;
  }
  private wait(type: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const onExit = (code: number | null) => reject(new Error(`subject exited ${code}`));
      const onMessage = (m: unknown) => {
        const msg = m as Record<string, unknown>;
        if (msg['type'] === 'error' || msg['type'] === type) {
          this.child.off('message', onMessage);
          this.child.off('exit', onExit);
          if (msg['type'] === 'error') reject(new Error(`subject error ${String(msg['code'])}`));
          else resolve(msg);
        }
      };
      this.child.on('message', onMessage);
      this.child.once('exit', onExit);
    });
  }
  async send(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const p = this.wait(`${String(msg['type'])}-done`);
    this.child.send(msg);
    return p;
  }
  push(credentials: LaunchCredentials): void {
    if (this.child.connected) this.child.send({ type: 'credentials', credentials });
  }
  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    await this.send({ type: 'detach' }).catch(() => undefined);
    await new Promise<void>((r) => (this.child.exitCode !== null ? r() : this.child.once('exit', () => r())));
  }
  kill(): void {
    this.child.kill('SIGKILL');
  }
}

export function quoteBody(): Record<string, unknown> {
  return {
    dry: false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: 'nep141:origin.sim',
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: 'nep141:destination.sim',
    amount: '1000000',
    refundTo: 'refund.sim',
    refundType: 'ORIGIN_CHAIN',
    recipient: 'recipient.sim',
    recipientType: 'DESTINATION_CHAIN',
    deadline: '2026-11-11T12:00:00Z',
  };
}

export interface CaseBehaviour {
  /** What the launcher does for the case at this ordinal (default: run the client). */
  readonly [ordinal: number]: 'run' | 'cancel' | 'client-fails' | undefined;
}

/**
 * Run `routespec gate run` through the reviewed launcher. Each handed-off case gets a freshly
 * launched subject process (fresh client lifecycle) that attaches to the printed proxy origin
 * with the delivered credentials and runs its own job logic.
 */
export async function runGateWithSubjects(
  j: Journal,
  options: {
    extraArgs?: readonly string[];
    behaviour?: CaseBehaviour;
    build?: SubjectBuild;
    env?: Record<string, string>;
  } = {},
): Promise<LauncherResult & { handoffSnapshots: CaseHandoff[] }> {
  const handoffSnapshots: CaseHandoff[] = [];
  const result = await runWithLauncher({
    args: gateRunArgs(j, options.extraArgs ?? []),
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    onCase: async (handoff, control) => {
      handoffSnapshots.push(handoff);
      const behaviour = options.behaviour?.[handoff.ordinal] ?? 'run';
      if (behaviour === 'cancel') return { cancelled: 'OPERATOR_CANCELLED' };
      if (behaviour === 'client-fails') return { failed: 'CLIENT_CRASHED' };
      const subject = await Subject.launch(options.build ?? j.build);
      control.onCredentials((c) => subject.push(c));
      try {
        await subject.send({ type: 'attach', origin: handoff.proxyOrigin, credentials: handoff.credentials });
        await subject.send({
          type: 'run',
          request: {
            logicalJob: `order-${handoff.ordinal + 1}`,
            quote: quoteBody(),
            txHash: `sim-tx-${handoff.ordinal + 1}`,
          },
        });
      } finally {
        await subject.close();
      }
      return 'INPUT_CLOSED';
    },
  });
  return { ...result, handoffSnapshots };
}

/** Run the CLI without a launcher (plain child process: no IPC channel). */
export function runCliProcess(
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
}> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', CLI_ENTRY, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: { ...(options.env ?? process.env) } as NodeJS.ProcessEnv,
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
