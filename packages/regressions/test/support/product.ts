/**
 * Product harness for M05 tests. It drives only real product APIs: the M01 journal, the M02
 * networkless proxy and case supervisor, the M03 compiler/runtime, the M04 kernel, and a
 * separately launched installed subject process (official SDK + RouteSpec adapter). No journal
 * row is written directly and no verdict is seeded.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_REVISION, digestValue, type CaseLineageRole } from '@routespec/contracts';
import {
  EVALUATOR_REVISION,
  evaluateCase,
  snapshotFromJournal,
  toPersistableEvaluation,
  type CaseEvaluation,
  type KernelInput,
} from '@routespec/kernel';
import { CaseSupervisor, ScenarioProxy, type LaunchCredentials } from '@routespec/proxy';
import type { CompiledScenario } from '@routespec/scenario';
import { ImportJournal, RouteSpecStore } from '@routespec/store';

export const LIVE_INVARIANTS = ['INV-01', 'INV-02', 'INV-03', 'INV-05', 'INV-06', 'INV-07', 'INV-08'];

export function d(label: string): `sha256:${string}` {
  return digestValue('routespec.test.digest/1', label);
}

export function tempDir(prefix = 'routespec-m05-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

export type SubjectBuild = 'baseline-client' | 'corrected-client';

export function subjectScript(build: SubjectBuild): string {
  return fileURLToPath(new URL(`./subject/${build}.ts`, import.meta.url));
}

/** The installed artifact digest: the exact bytes of the subject build's code. */
export function subjectArtifactDigest(build: SubjectBuild): `sha256:${string}` {
  const bytes = Buffer.concat([
    readFileSync(subjectScript(build)),
    readFileSync(subjectScript(build).replace(/[^\\/]+$/, 'runtime.ts')),
  ]);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export interface Build {
  readonly buildRevisionId: string;
  readonly artifactDigest: string;
  readonly manifestDigest: string;
  readonly build: SubjectBuild;
}

export interface CaseSpecInput {
  readonly compiled: CompiledScenario;
  readonly scenarioRevisionId: string;
  readonly lineageRole: CaseLineageRole;
  readonly requiredInvariants: readonly string[];
}

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
          if (msg['type'] === 'error')
            reject(new Error(`subject error ${String(msg['code'])}: ${String(msg['message'])}`));
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
  /** Fire-and-forget credential push (used while a job is in flight). */
  push(credentials: LaunchCredentials): void {
    this.child.send({ type: 'credentials', credentials });
  }
  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    await this.send({ type: 'detach' }).catch(() => undefined);
    await new Promise<void>((r) => (this.child.exitCode !== null ? r() : this.child.once('exit', () => r())));
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

export class Product {
  readonly store: RouteSpecStore;
  readonly journal: ImportJournal;
  readonly supervisor: CaseSupervisor;
  proxy!: ScenarioProxy;
  readonly projectId: string;
  readonly integrationRevisionId: string;
  readonly profileId: string;
  private readonly subjects = new Map<string, Subject>();

  private constructor(store: RouteSpecStore, label: string) {
    this.store = store;
    this.journal = new ImportJournal(store);
    this.supervisor = new CaseSupervisor(store, {
      ownerLabel: `m05-runner-${label}`,
      onCredentials: (caseRunId, creds) => this.subjects.get(caseRunId)?.push(creds),
    });
    this.projectId = store.createProject({
      name: `project ${label}`,
      idempotencyKey: `project-${label}-key`,
    }).projectId;
    this.profileId = store.registerProtocolProfile();
    this.integrationRevisionId = store.createIntegrationRevision({
      projectId: this.projectId,
      revisionLabel: 'r1',
      commitSha: null,
      configurationDigest: d('config'),
      protocolProfileId: this.profileId,
    }).integrationRevisionId;
  }

  static async open(dir: string, label = 'm05'): Promise<Product> {
    const store = RouteSpecStore.open({ path: join(dir, 'journal.db') });
    const p = new Product(store, label);
    p.proxy = await ScenarioProxy.start({ store, mode: 'SIMULATE', cases: p.supervisor });
    return p;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.proxy.port}`;
  }

  registerBuild(build: SubjectBuild): Build {
    const artifactDigest = subjectArtifactDigest(build);
    const { buildRevisionId } = this.store.registerBuild({
      projectId: this.projectId,
      integrationRevisionId: this.integrationRevisionId,
      repositoryLocator: `git+file:subject/${build}`,
      commitSha: createHash('sha1').update(build).digest('hex'),
      dirtyTreeDigest: null,
      artifactDigest,
      toolchainDigest: d('toolchain-node22'),
      lockDigest: d('lock'),
      effectManifestDigest: d(`manifest-${build}`),
      ciWorkflowRunId: null,
      launchRecipeDigest: d(`recipe-${build}`),
    });
    const { manifestDigest } = this.store.createEffectManifest({
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
    return { buildRevisionId, artifactDigest, manifestDigest, build };
  }

  /** One immutable gate run bound to an exact corpus revision, cases READY, gate RUNNING. */
  createGateRun(
    build: Build,
    corpusRevisionId: string,
    cases: readonly CaseSpecInput[],
  ): {
    gateRunId: string;
    caseRunIds: string[];
    identityDigest: string;
  } {
    const first = cases[0] as CaseSpecInput;
    const { policyDigest } = this.store.createEffectCoveragePolicy({
      buildRevisionId: build.buildRevisionId,
      artifactDigest: build.artifactDigest,
      selectedAttestationId: null,
      scenarioRevisionId: first.scenarioRevisionId,
      manifestDigest: build.manifestDigest,
      requiredSinkClasses: ['fulfilment-webhook'],
      interceptorProfileDigest: null,
      callsiteInventoryDigest: null,
      basis: 'DECLARED_HOOKS_ONLY',
    });
    const gate = this.store.createGateRun({
      projectId: this.projectId,
      integrationRevisionId: this.integrationRevisionId,
      buildRevisionId: build.buildRevisionId,
      artifactDigest: build.artifactDigest,
      buildAttestation: { attestationClass: 'USER_ASSERTED_LOCAL', attestationId: null },
      corpusRevisionId,
      protocolProfileId: this.profileId,
      adapterRevision: ADAPTER_REVISION,
      evaluatorRevision: EVALUATOR_REVISION,
      proxyRevision: 'routespec-proxy@1.0.0',
      configurationDigest: d('config'),
      effectManifestDigest: build.manifestDigest,
      effectCoveragePolicyDigest: policyDigest,
      callsiteInventoryDigest: null,
      interceptorProfileDigest: null,
      maxParallelCases: 4,
      cases: cases.map((c) => ({
        scenarioRevisionId: c.scenarioRevisionId,
        lineageRole: c.lineageRole,
        requiredInvariants: [...c.requiredInvariants],
      })),
    });
    this.store.transitionGateRun(gate.gateRunId, 'DRAFT', 'VALIDATING');
    for (const id of gate.caseRunIds) {
      this.store.transitionCaseRun(id, 'PENDING', 'VALIDATING');
      this.store.transitionCaseRun(id, 'VALIDATING', 'READY');
    }
    this.store.transitionGateRun(gate.gateRunId, 'VALIDATING', 'READY');
    this.store.transitionGateRun(gate.gateRunId, 'READY', 'RUNNING');
    return gate;
  }

  /**
   * Run one case with the installed subject: start the case, attach (or reset) the subject's
   * adapter, run the subject's own job logic, and close client input.
   */
  async runCase(
    subject: Subject,
    caseRunId: string,
    compiled: CompiledScenario,
    job: { logicalJob: string; txHash: string },
    attach: 'attach' | 'reset',
  ): Promise<Record<string, unknown>> {
    const creds = this.supervisor.startCase({ caseRunId, compiled, mode: 'SIMULATE' });
    this.subjects.set(caseRunId, subject);
    if (attach === 'attach') await subject.send({ type: 'attach', origin: this.origin, credentials: creds });
    else await subject.send({ type: 'reset', credentials: creds });
    const out = await subject.send({
      type: 'run',
      request: { logicalJob: job.logicalJob, quote: quoteBody(), txHash: job.txHash },
    });
    this.subjects.delete(caseRunId);
    return out['outcome'] as Record<string, unknown>;
  }

  /** Teardown, kernel evaluation from the journal snapshot, and fenced persistence. */
  evaluate(caseRunId: string): { input: KernelInput; evaluation: CaseEvaluation } {
    this.supervisor.teardown(caseRunId);
    const input = snapshotFromJournal(this.store.readEvaluationSnapshot(caseRunId));
    const evaluation = evaluateCase(input);
    const p = toPersistableEvaluation(input, evaluation);
    this.store.persistCaseEvaluation(this.supervisor.fenceFor(caseRunId), {
      verdict: p.verdict,
      evaluatorRevision: p.evaluatorRevision,
      invariantResults: p.invariantResults,
      canonical: p.canonical,
      envelope: {
        schemaVersion: '1.0',
        wallClockStartedAt: new Date(0).toISOString(),
        wallClockEndedAt: null,
        hostName: 'm05-test-host',
        platform: process.platform,
        arch: process.arch,
        runtimeVersion: process.version,
        dataDirectory: 'm05-test-data',
        workingDirectory: 'm05-test-cwd',
        artifactPaths: [],
        displayLabels: {},
      },
    });
    return { input, evaluation };
  }

  async close(): Promise<void> {
    await this.proxy.close();
    this.store.close();
  }
}
