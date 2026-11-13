/**
 * The gate run behind the MCP `run_gate` tool (M52).
 *
 * It drives the real product surfaces only: the M01 journal repositories for setup (project,
 * revision, build, effect manifest, reviewed scenarios, corpus, effect policy, gate), the
 * `routespec gate run` CLI started through the reviewed launcher, and, for every handed-off case,
 * a freshly started subject process that runs the caller's client module with the pinned official
 * SDK. Every verdict is the invariant kernel's result over what that client actually sent; no
 * verdict is stated, expected, or seeded here.
 *
 * Runs are uncontained (`DECLARED_HOOKS_ONLY`): the client runs as a local Node process, the same
 * trust as running its own tests. They are diagnostic, not release evidence (ADR-0031).
 */
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWithLauncher } from '@routespec/cli';
import { ADAPTER_REVISION, digestValue } from '@routespec/contracts';
import { evaluateCase, snapshotFromJournal } from '@routespec/kernel';
import type { LaunchCredentials } from '@routespec/proxy';
import type { CaseHandoff } from '@routespec/runner';
import { CORE_SCENARIO_SOURCES, compileScenario } from '@routespec/scenario';
import { GateJournal, RouteSpecStore } from '@routespec/store';
import { SLOW_DEPOSIT_ANSWER, SLOW_DEPOSIT_ANSWER_SOURCE } from './scenarios.ts';

/** Invariants evaluated live for an uncontained client (INV-04 needs containment, INV-09 is replay). */
export const REQUIRED_INVARIANTS = Object.freeze([
  'INV-01',
  'INV-02',
  'INV-03',
  'INV-05',
  'INV-06',
  'INV-07',
  'INV-08',
]);

/** Scenario sources the tool can run: the reviewed core scenarios plus the hedged-submission check. */
export const SCENARIO_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  ...CORE_SCENARIO_SOURCES,
  [SLOW_DEPOSIT_ANSWER]: SLOW_DEPOSIT_ANSWER_SOURCE,
});

/** Default corpus: an answered order, an accepted-then-lost answer, and a slow answer. */
export const DEFAULT_SCENARIOS = Object.freeze([
  'happy-path',
  'accepted-then-lost-response',
  SLOW_DEPOSIT_ANSWER,
]);

export const HOST_SCRIPT = fileURLToPath(new URL('./subject/host.ts', import.meta.url));
const RUNTIME_SCRIPT = fileURLToPath(new URL('./subject/runtime.ts', import.meta.url));
const CASE_TIMEOUT_MS = 90_000;

export interface InvariantFinding {
  readonly invariantId: string;
  readonly runOperationId: string | null;
  readonly verdict: string;
  /** Closed kernel explanation code (for example INV03_SECOND_MUTATION_UNDER_UNCERTAINTY). */
  readonly explanationCode: string | null;
  readonly remediationCode: string | null;
  readonly reasons: readonly string[];
  readonly missingPredicates: readonly string[];
}

export interface CaseRecord {
  readonly ordinal: number;
  readonly scenario: string;
  readonly lifecycle: string | null;
  readonly contribution: string;
  readonly findings: readonly string[];
  readonly invariants: readonly InvariantFinding[];
  /** What the client module itself returned (subject-reported, never evidence). */
  readonly clientOutcome: Record<string, unknown> | null;
  readonly clientError: string | null;
}

export interface GateRunRecord {
  readonly runId: string;
  readonly client: string;
  readonly artifactDigest: string;
  readonly scenarios: readonly string[];
  readonly decision: string;
  readonly exitCode: number | null;
  readonly gateRunId: string | null;
  readonly decisionDigest: string | null;
  readonly counts: Record<string, number> | null;
  readonly findings: readonly string[];
  readonly cases: readonly CaseRecord[];
  readonly containment: 'UNCONTAINED_DECLARED_HOOKS_ONLY';
  readonly evidenceUse: 'DIAGNOSTIC_ONLY';
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface GateRunOptions {
  /** Absolute path of the client module (default export: a `ClientJob`). */
  readonly clientPath: string;
  /** Path shown in records (relative to the server root). */
  readonly clientLabel: string;
  readonly scenarios: readonly string[];
  /** Fresh, empty data directory for this run's journal. */
  readonly dataDir: string;
  readonly runId: string;
}

function d(label: string): `sha256:${string}` {
  return digestValue('routespec.mcp.digest/1', label);
}

/** The artifact digest of a client build: its own bytes plus the subject harness bytes. */
export function clientArtifactDigest(clientPath: string): `sha256:${string}` {
  const h = createHash('sha256');
  h.update(readFileSync(clientPath));
  h.update(readFileSync(HOST_SCRIPT));
  h.update(readFileSync(RUNTIME_SCRIPT));
  return `sha256:${h.digest('hex')}`;
}

interface Setup {
  readonly gateId: string;
  readonly buildRevisionId: string;
  readonly artifactDigest: string;
  readonly manifestDigest: string;
  readonly policyDigest: string;
}

function setupJournal(options: GateRunOptions): Setup {
  mkdirSync(options.dataDir, { recursive: true });
  const store = RouteSpecStore.open({ path: join(options.dataDir, 'journal.db') });
  try {
    const { projectId } = store.createProject({
      name: 'coding agent gate run',
      idempotencyKey: `mcp-${options.runId}`,
    });
    const artifactDigest = clientArtifactDigest(options.clientPath);
    const { integrationRevisionId } = store.createIntegrationRevision({
      projectId,
      revisionLabel: options.runId,
      commitSha: null,
      configurationDigest: d(`scenarios:${options.scenarios.join(',')}`),
      protocolProfileId: store.registerProtocolProfile(),
    });
    const { buildRevisionId } = store.registerBuild({
      projectId,
      integrationRevisionId,
      repositoryLocator: `file:${options.clientLabel}`,
      commitSha: createHash('sha1').update(artifactDigest).digest('hex'),
      dirtyTreeDigest: null,
      artifactDigest,
      toolchainDigest: d(`node-${process.versions.node}`),
      lockDigest: d('workspace-lock'),
      effectManifestDigest: d(`manifest:${artifactDigest}`),
      ciWorkflowRunId: null,
      launchRecipeDigest: d(`node --no-warnings subject/host.ts ${options.clientLabel}`),
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
    const scenarioRevisionIds = options.scenarios.map(
      (id) =>
        store.createScenarioRevision({
          ...compileScenario(SCENARIO_SOURCES[id] as string).revisionInput,
          reviewStatus: 'REVIEWED',
        }).scenarioRevisionId,
    );
    const { corpusRevisionId } = store.createCorpusRevision({
      label: `mcp-${options.runId}`,
      cases: scenarioRevisionIds.map((scenarioRevisionId) => ({
        scenarioRevisionId,
        requiredInvariants: [...REQUIRED_INVARIANTS],
        severity: 'HIGH',
        gatePolicy: 'REQUIRED',
      })),
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
      projectId,
      name: `coding agent gate ${options.runId}`,
      corpusRevisionId,
      enforcementMode: 'LOCAL_ADVISORY',
      buildAttestationPolicy: 'ALLOW_USER_ASSERTED',
    });
    return { gateId, buildRevisionId, artifactDigest, manifestDigest, policyDigest };
  } finally {
    store.close();
  }
}

type J = Record<string, unknown>;

class SubjectProcess {
  readonly child: ChildProcess;
  private constructor(child: ChildProcess) {
    this.child = child;
  }

  static async launch(clientPath: string): Promise<SubjectProcess> {
    const child = fork(HOST_SCRIPT, [clientPath], {
      execArgv: ['--no-warnings'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    child.stderr?.resume();
    const s = new SubjectProcess(child);
    await s.wait('loaded', CASE_TIMEOUT_MS);
    return s;
  }

  private wait(type: string, timeoutMs: number): Promise<J> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(Object.assign(new Error(`client did not answer ${type}`), { code: 'CLIENT_TIMEOUT' }));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.child.off('message', onMessage);
        this.child.off('exit', onExit);
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(Object.assign(new Error(`client exited ${String(code)}`), { code: 'CLIENT_EXITED' }));
      };
      const onMessage = (m: unknown) => {
        const msg = m as J;
        if (msg['type'] === 'error' || msg['type'] === type) {
          cleanup();
          if (msg['type'] === 'error') {
            reject(
              Object.assign(new Error(String(msg['message'] ?? 'client error')), {
                code: String(msg['code'] ?? 'CLIENT_ERROR'),
              }),
            );
          } else resolve(msg);
        }
      };
      this.child.on('message', onMessage);
      this.child.once('exit', onExit);
    });
  }

  async send(msg: J, timeoutMs = CASE_TIMEOUT_MS): Promise<J> {
    const p = this.wait(`${String(msg['type'])}-done`, timeoutMs);
    this.child.send(msg);
    return p;
  }

  push(credentials: LaunchCredentials): void {
    if (this.child.connected) this.child.send({ type: 'credentials', credentials });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await this.send({ type: 'detach' }, 5_000).catch(() => undefined);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
  }
}

export function quoteBody(): J {
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

function strings(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw)) as unknown;
    return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : [];
  } catch {
    return [];
  }
}

/**
 * The stored invariant results of a case, each with the kernel's closed explanation and
 * remediation codes. The codes are not persisted, so the case is re-evaluated read-only from its
 * journal snapshot with the same kernel; a re-evaluation whose verdicts differ from the stored
 * rows is not used (the codes are then null).
 */
function readInvariants(dataDir: string, caseRunId: string | null): InvariantFinding[] {
  if (caseRunId === null) return [];
  const store = RouteSpecStore.open({ path: join(dataDir, 'journal.db') });
  try {
    const rows = store.listInvariantResults(caseRunId);
    if (rows.length === 0) return [];
    let codes = new Map<string, { explanationCode: string; remediationCode: string | null }>();
    try {
      const evaluation = evaluateCase(snapshotFromJournal(store.readEvaluationSnapshot(caseRunId)));
      const key = (id: string, op: string | null, v: string) => `${id}|${op ?? ''}|${v}`;
      const stored = rows
        .map((r) =>
          key(
            String(r['invariant_id']),
            (r['run_operation_id'] as string | null) ?? null,
            String(r['verdict']),
          ),
        )
        .sort();
      const again = evaluation.invariantResults
        .map((r) => key(r.invariantId, r.runOperationId, r.verdict))
        .sort();
      if (JSON.stringify(stored) === JSON.stringify(again)) {
        codes = new Map(
          evaluation.invariantResults.map((r) => [
            key(r.invariantId, r.runOperationId, r.verdict),
            { explanationCode: r.explanationCode, remediationCode: r.remediationCode },
          ]),
        );
      }
    } catch {
      codes = new Map();
    }
    return rows.map((r) => {
      const invariantId = String(r['invariant_id']);
      const runOperationId = (r['run_operation_id'] as string | null) ?? null;
      const verdict = String(r['verdict']);
      const c = codes.get(`${invariantId}|${runOperationId ?? ''}|${verdict}`) ?? null;
      return {
        invariantId,
        runOperationId,
        verdict,
        explanationCode: c?.explanationCode ?? null,
        remediationCode: c?.remediationCode ?? null,
        reasons: strings(r['reasons_json']),
        missingPredicates: strings(r['missing_predicates_json']),
      };
    });
  } finally {
    store.close();
  }
}

/** Run the gate for one client build. Never throws for a client failure: it is recorded. */
export async function runGate(options: GateRunOptions): Promise<GateRunRecord> {
  const setup = setupJournal(options);
  const outcomes = new Map<number, { outcome: J | null; error: string | null }>();
  const result = await runWithLauncher({
    args: [
      'gate',
      'run',
      '--data',
      options.dataDir,
      '--gate',
      setup.gateId,
      '--build',
      setup.buildRevisionId,
      '--artifact',
      setup.artifactDigest,
      '--effect-policy',
      setup.policyDigest,
      '--effect-manifest',
      setup.manifestDigest,
      '--mode',
      'simulate',
      '--json',
    ],
    onCase: async (handoff: CaseHandoff, control) => {
      let subject: SubjectProcess | null = null;
      try {
        subject = await SubjectProcess.launch(options.clientPath);
        const s = subject;
        control.onCredentials((c) => s.push(c));
        await s.send({ type: 'attach', origin: handoff.proxyOrigin, credentials: handoff.credentials });
        const run = await s.send({
          type: 'run',
          request: {
            logicalJob: `order-${handoff.ordinal + 1}`,
            quote: quoteBody(),
            txHash: `sim-tx-${handoff.ordinal + 1}`,
          },
        });
        outcomes.set(handoff.ordinal, { outcome: (run['outcome'] as J | undefined) ?? null, error: null });
        return 'INPUT_CLOSED';
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'CLIENT_ERROR';
        outcomes.set(handoff.ordinal, {
          outcome: null,
          error: `${code}: ${(error as Error).message}`.slice(0, 400),
        });
        return { failed: code.replace(/[^A-Z0-9_]/gi, '_').slice(0, 64) || 'CLIENT_ERROR' };
      } finally {
        await subject?.close();
      }
    },
  });
  const report = (result.json?.['report'] ?? null) as J | null;
  if (report === null) {
    const err = (result.json?.['error'] ?? {}) as J;
    return {
      runId: options.runId,
      client: options.clientLabel,
      artifactDigest: setup.artifactDigest,
      scenarios: options.scenarios,
      decision: 'NOT_RUN',
      exitCode: result.exitCode,
      gateRunId: null,
      decisionDigest: null,
      counts: null,
      findings: [],
      cases: [],
      containment: 'UNCONTAINED_DECLARED_HOOKS_ONLY',
      evidenceUse: 'DIAGNOSTIC_ONLY',
      error: {
        code: String(err['code'] ?? 'RS_GATE_RUN_FAILED'),
        message: String(err['message'] ?? 'The gate run printed no report.').slice(0, 400),
      },
    };
  }
  const cases = ((report['cases'] as J[] | undefined) ?? []).map((c): CaseRecord => {
    const ordinal = Number(c['ordinal']);
    const o = outcomes.get(ordinal);
    return {
      ordinal,
      scenario: options.scenarios[ordinal] ?? 'unknown',
      lifecycle: (c['lifecycle'] as string | null) ?? null,
      contribution: String(c['contribution']),
      findings: (c['findings'] as string[] | undefined) ?? [],
      invariants: readInvariants(options.dataDir, (c['caseRunId'] as string | null) ?? null),
      clientOutcome: o?.outcome ?? null,
      clientError: o?.error ?? null,
    };
  });
  return {
    runId: options.runId,
    client: options.clientLabel,
    artifactDigest: setup.artifactDigest,
    scenarios: options.scenarios,
    decision: String(report['decision']),
    exitCode: result.exitCode,
    gateRunId: String(report['gateRunId']),
    decisionDigest: (report['decisionDigest'] as string | undefined) ?? null,
    counts: (report['counts'] as Record<string, number> | undefined) ?? null,
    findings: (report['findings'] as string[] | undefined) ?? [],
    cases,
    containment: 'UNCONTAINED_DECLARED_HOOKS_ONLY',
    evidenceUse: 'DIAGNOSTIC_ONLY',
    error: null,
  };
}
