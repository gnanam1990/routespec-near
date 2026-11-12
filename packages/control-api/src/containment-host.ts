/**
 * Contained subject cases (M14): the control host launches the registered subject build inside
 * a verified Linux container, binds an independent effect interceptor to it, has an enrolled
 * launcher attest the launch, and journals the containment record at teardown.
 *
 * Roles. The operator starts a case with `POST /case-runs/{id}/contained-start`. The service
 * (this module) then owns the subject: the one-time execution token and any reconciliation-only
 * token go to the subject over the container's private channel, never to the HTTP caller.
 *
 * 1. Identity: the artifact is the file named by the build's repository locator inside the
 *    configured subject root; its SHA-256 must equal the registered artifact digest.
 * 2. Containment: `ContainedSubject` starts the container (no network, read-only root, no
 *    capabilities, non-root, pids/memory limits, init) and `verifyInspect` checks the engine's
 *    own record and the shim's self-observation. Only a clean result is PROCESS_TREE_ENFORCED.
 *    The container's only routes out are two loopback tunnels: the RouteSpec proxy and the
 *    protected-effect sink.
 * 3. Attestation: when the operator names an enrolled launcher principal, the launcher measures
 *    the artifact and the container itself and completes a CASE_LAUNCH challenge (selected build
 *    attestation required) and, for the interceptor, an EFFECT_INTERCEPTOR_LAUNCH challenge.
 *    Both bind the sandbox-scope digest the service computed; the launcher's own measurement
 *    must equal it or nothing is attested.
 * 4. Interceptor: launched when the subject first connects to the effect sink, so it binds the
 *    case's fencing epoch at that moment (an accepted-then-lost response advances the epoch
 *    during the case). Until then the sink tunnel has no target and nothing can leave.
 * 5. Release: on the first ATTEMPTED frame the runner decides (ground truth must prove accepted
 *    completion) and only then releases the interceptor; otherwise every attempt stays BLOCKED.
 * 6. Teardown: the subject tree is stopped and the engine must forget the container; a container
 *    that does not disappear is journaled as a PROCESS_TREE_ESCAPE coverage finding before the
 *    interceptor is torn down. The containment record is then journaled (immutable).
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import { RouteSpecError, digestValue } from '@routespec/contracts';
import {
  ContainedSubject,
  detectContainerRuntime,
  type ContainerCli,
  type RuntimeStatus,
  type TeardownEvidence,
} from '@routespec/containment';
import {
  CANARY_INTERCEPTOR_PROFILE,
  InterceptorHost,
  type InterceptorFrame,
  type InterceptorFrameAck,
  type LaunchCredentials,
} from '@routespec/proxy';
import type { ChallengeOutcome, ControlJournal, RouteSpecStore } from '@routespec/store';
import type { GateService } from '@routespec/runner';
import type { AttesterChannel } from './attestation.ts';

type Row = Record<string, unknown>;

export const SINK_CONTAINER_PORT = 47801;
const ADAPTER_REVISION = 'routespec-adapter@1.0.0';

export interface ContainmentConfig {
  readonly cli: ContainerCli;
  readonly imageRef: string;
  /** Installed checkout that holds subject builds; mounted read-only into the container. */
  readonly subjectRoot: string;
}

export interface ContainedJob {
  readonly logicalJob: string;
  readonly quote: Record<string, unknown>;
  readonly txHash: string;
}

interface CaseState {
  readonly caseRunId: string;
  readonly gateRunId: string;
  readonly projectId: string;
  readonly principalId: string | null;
  readonly subject: ContainedSubject;
  readonly runtime: Extract<RuntimeStatus, { status: 'AVAILABLE' }>;
  readonly startedAtMs: number;
  readonly sinkClasses: Record<string, string>;
  interceptor: InterceptorHost | null;
  interceptorLaunch: Promise<number | null> | null;
  caseLaunchAttestationId: string | null;
  interceptorAttestationId: string | null;
  readonly attestations: Record<string, { outcome: string; reasonCode: string | null }>;
  job: 'STARTING' | 'RUNNING' | 'DONE' | 'FAILED';
  outcome: Record<string, unknown> | null;
  error: string | null;
  readonly credentialPurposes: string[];
  release: { decided: boolean; authorizationId: string | null; withheld: boolean; error: string | null };
  readonly frames: { attempted: number; blocked: number; released: number; refused: number };
  teardown: TeardownEvidence | null;
}

export interface ContainmentHostDeps {
  readonly store: RouteSpecStore;
  readonly control: ControlJournal;
  readonly service: GateService;
  readonly config: ContainmentConfig | null;
  readonly launcherFor: (principalId: string) => AttesterChannel | undefined;
  readonly challengeTtlMs: number;
}

function s(row: Row, key: string): string {
  return String(row[key]);
}

function fileSha(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

export class ContainmentHost {
  readonly #d: ContainmentHostDeps;
  readonly #cases = new Map<string, CaseState>();
  #runtime: Promise<RuntimeStatus> | null = null;

  constructor(deps: ContainmentHostDeps) {
    this.#d = deps;
  }

  get configured(): boolean {
    return this.#d.config !== null;
  }

  holds(caseRunId: string): boolean {
    return this.#cases.has(caseRunId);
  }

  /** Runtime detection (cached once it succeeds; retried while absent). */
  async runtime(): Promise<RuntimeStatus> {
    const config = this.#d.config;
    if (config === null) {
      return { status: 'ABSENT', reason: 'CONTAINER_RUNTIME_ABSENT', detail: 'NOT_CONFIGURED', cli: null };
    }
    const r = await (this.#runtime ??= detectContainerRuntime({ cli: config.cli, image: config.imageRef }));
    if (r.status !== 'AVAILABLE') this.#runtime = null;
    return r;
  }

  /** Resolve and verify the subject artifact named by the build's repository locator. */
  #artifact(build: Row): string {
    const config = this.#d.config as ContainmentConfig;
    const locator = String(build['repository_locator'] ?? '');
    if (!locator.startsWith('git+file:')) {
      throw new RouteSpecError(
        'RS_IDENTITY_MISMATCH',
        'A contained build needs a git+file repository locator inside the subject root.',
      );
    }
    const root = resolve(config.subjectRoot);
    const full = resolve(root, locator.slice('git+file:'.length));
    const rel = relative(root, full);
    if (rel.length === 0 || rel.startsWith('..') || rel.split(sep).includes('..')) {
      throw new RouteSpecError('RS_IDENTITY_MISMATCH', 'The build locator leaves the subject root.');
    }
    let digest: string;
    try {
      digest = fileSha(full);
    } catch {
      throw new RouteSpecError('RS_NOT_FOUND', 'The build artifact is not present in the subject root.');
    }
    if (digest !== build['artifact_digest']) {
      throw new RouteSpecError(
        'RS_IDENTITY_MISMATCH',
        'The artifact on disk is not the registered build artifact.',
      );
    }
    return full;
  }

  /**
   * Ask the principal's reviewed launcher to attest one launch. A refusal or an unavailable
   * launcher never stops the case: it runs unattested, and the kernel then reports the
   * missing attestation (REVIEW). The outcome is kept for the case view.
   */
  async #attest(
    st: CaseState,
    scope: 'CASE_LAUNCH' | 'EFFECT_INTERCEPTOR_LAUNCH',
    binding: Record<string, unknown>,
  ): Promise<ChallengeOutcome | null> {
    if (st.principalId === null) return null;
    try {
      const channel = this.#d.launcherFor(st.principalId);
      if (!channel) {
        throw new RouteSpecError(
          'RS_PEER_BINDING_UNAVAILABLE',
          'No reviewed launcher of this principal is available to the local service.',
        );
      }
      const created = this.#d.control.createChallenge({
        projectId: st.projectId,
        scope,
        principalId: st.principalId,
        binding,
        ttlMs: this.#d.challengeTtlMs,
      });
      const outcome = await channel.complete({
        challengeId: created.challengeId,
        nonce: created.nonce,
        scope,
        bindingDigest: created.bindingDigest,
        binding,
      });
      st.attestations[scope] = { outcome: outcome.outcome, reasonCode: outcome.reasonCode };
      return outcome;
    } catch (error) {
      st.attestations[scope] = {
        outcome: 'NOT_ATTESTED',
        reasonCode: error instanceof RouteSpecError ? error.code : 'ATTESTATION_ERROR',
      };
      return null;
    }
  }

  #caseBase(caseRunId: string): Record<string, unknown> {
    const c = this.#d.store.getCaseRun(caseRunId) as Row;
    const g = this.#d.store.getGateRun(s(c, 'gate_run_id')) as Row;
    const build = this.#d.control.getBuild(s(g, 'build_revision_id')) as Row;
    return {
      projectId: s(g, 'project_id'),
      gateRunId: s(g, 'gate_run_id'),
      caseRunId,
      sessionId: s(c, 'session_id'),
      fencingEpoch: Number(c['fencing_epoch']),
      buildRevisionId: s(g, 'build_revision_id'),
      commitSha: s(build, 'commit_sha'),
    };
  }

  #sandboxBinding(st: CaseState): Record<string, unknown> {
    const v = st.subject.verdict;
    if (v.containment !== 'PROCESS_TREE_ENFORCED' || v.sandboxScopeDigest === null) return {};
    return {
      containerId: st.subject.containerId,
      tunnelPorts: [...st.subject.expectations.tunnelPorts],
      sandboxScopeDigest: v.sandboxScopeDigest,
    };
  }

  /** Start a READY case with its subject confined in a container. */
  async start(caseRunId: string, input: { principalId: string | null; job: ContainedJob }): Promise<Row> {
    const d = this.#d;
    if (this.#cases.has(caseRunId)) throw new RouteSpecError('RS_PHASE_INVALID', 'Case already started.');
    const runtime = await this.runtime();
    if (runtime.status !== 'AVAILABLE') {
      throw new RouteSpecError(
        'RS_CONTAINMENT_UNAVAILABLE',
        'No container runtime can confine the subject.',
        {
          details: { reason: runtime.reason, detail: runtime.detail.slice(0, 64) },
        },
      );
    }
    const config = d.config as ContainmentConfig;
    const c = d.store.getCaseRun(caseRunId) as Row;
    const g = d.store.getGateRun(s(c, 'gate_run_id')) as Row;
    const build = d.control.getBuild(s(g, 'build_revision_id')) as Row;
    const entry = this.#artifact(build);
    if (input.principalId !== null) {
      const p = d.control.getPrincipal(input.principalId);
      if (!p || p.projectId !== s(g, 'project_id'))
        throw new RouteSpecError('RS_NOT_FOUND', 'Attester principal not found.');
    }
    const mode = (d.control.gateRunMode(s(g, 'gate_run_id')) ?? 'SIMULATE') as 'SIMULATE' | 'REPLAY';
    const proxyOrigin = await d.service.openProxy(mode);
    const proxyPort = Number(new URL(proxyOrigin).port);
    const { handoff } = d.service.startExternalCase(caseRunId, mode);
    const creds = handoff.credentials;
    let subject: ContainedSubject;
    let st: CaseState | null = null;
    try {
      subject = await ContainedSubject.launch({
        cli: config.cli,
        imageId: runtime.imageId,
        root: config.subjectRoot,
        entry,
        tunnels: [
          { containerPort: proxyPort, hostPort: proxyPort, purpose: 'routespec-proxy' },
          { containerPort: SINK_CONTAINER_PORT, hostPort: null, purpose: 'effect-sink' },
        ],
        resolveTunnel: (port) =>
          port === SINK_CONTAINER_PORT && st !== null ? this.#launchInterceptor(st) : Promise.resolve(null),
      });
    } catch (error) {
      d.service.abortExternalCase(caseRunId, 'CONTAINMENT_LAUNCH_FAILED');
      throw new RouteSpecError('RS_CONTAINMENT_UNAVAILABLE', 'The subject container did not start.', {
        details: { reason: 'CONTAINER_START_FAILED', detail: String((error as Error).message).slice(0, 64) },
      });
    }
    const manifestHooks = d.store.journal.read(
      (db) =>
        db
          .prepare(
            `SELECT h.sink_class, h.effect_type FROM effect_manifest_hooks h JOIN effect_manifests m USING (manifest_id)
              WHERE m.manifest_digest = ?`,
          )
          .all(s(g, 'effect_manifest_digest')) as Row[],
    );
    st = {
      caseRunId,
      gateRunId: s(g, 'gate_run_id'),
      projectId: s(g, 'project_id'),
      principalId: input.principalId,
      subject,
      runtime,
      startedAtMs: Date.now(),
      sinkClasses: Object.fromEntries(manifestHooks.map((h) => [s(h, 'sink_class'), s(h, 'effect_type')])),
      interceptor: null,
      interceptorLaunch: null,
      caseLaunchAttestationId: null,
      interceptorAttestationId: null,
      attestations: {},
      job: 'STARTING',
      outcome: null,
      error: null,
      credentialPurposes: [creds.purpose],
      release: { decided: false, authorizationId: null, withheld: false, error: null },
      frames: { attempted: 0, blocked: 0, released: 0, refused: 0 },
      teardown: null,
    };
    this.#cases.set(caseRunId, st);
    const state = st;
    try {
      if (g['build_attestation_id'] !== null && input.principalId !== null) {
        const after = d.store.getCaseRun(caseRunId) as Row;
        const outcome = await this.#attest(state, 'CASE_LAUNCH', {
          ...this.#caseBase(caseRunId),
          artifactDigest: s(g, 'artifact_digest'),
          clientInstanceDigest: s(after, 'client_instance_digest'),
          buildAttestationId: s(g, 'build_attestation_id'),
          repositoryLocator: s(build, 'repository_locator'),
          ...this.#sandboxBinding(state),
        });
        state.caseLaunchAttestationId = outcome?.attestationId ?? null;
      }
      await subject.waitFor('loaded', 180_000);
      await subject.request({
        type: 'attach',
        origin: proxyOrigin,
        credentials: { ...creds, adapterRevision: ADAPTER_REVISION },
      });
    } catch (error) {
      state.job = 'FAILED';
      state.error = error instanceof RouteSpecError ? error.code : 'SUBJECT_START_FAILED';
      return this.view(caseRunId);
    }
    state.job = 'RUNNING';
    const sinkClass = Object.keys(state.sinkClasses)[0] ?? null;
    subject
      .request(
        {
          type: 'run',
          request: {
            ...input.job,
            effectSink:
              sinkClass === null ? null : { origin: `http://127.0.0.1:${SINK_CONTAINER_PORT}`, sinkClass },
          },
        },
        300_000,
      )
      .then(
        (r) => {
          state.outcome = (r['outcome'] as Record<string, unknown>) ?? {};
          state.job = 'DONE';
        },
        (e: Error) => {
          state.error = e.message.slice(0, 120);
          state.job = 'FAILED';
        },
      );
    return this.view(caseRunId);
  }

  /** Launch the interceptor at the case's current fencing epoch; returns its sink port. */
  #launchInterceptor(st: CaseState): Promise<number | null> {
    st.interceptorLaunch ??= (async () => {
      const d = this.#d;
      const g = d.store.getGateRun(st.gateRunId) as Row;
      const profileDigest = g['interceptor_profile_digest'];
      if (typeof profileDigest !== 'string') return null;
      const profile = d.control.getInterceptorProfile(st.projectId, profileDigest);
      if (!profile) return null;
      await st.subject.verify();
      const supported = JSON.parse(s(profile, 'supported_sinks_json')) as string[];
      const outcome = await this.#attest(st, 'EFFECT_INTERCEPTOR_LAUNCH', {
        ...this.#caseBase(st.caseRunId),
        interceptorProfileDigest: s(profile, 'profile_digest'),
        interceptorArtifactDigest: s(profile, 'interceptor_artifact_digest'),
        processTreeScope: s(profile, 'process_tree_scope'),
        ...this.#sandboxBinding(st),
      });
      st.interceptorAttestationId = outcome?.attestationId ?? null;
      const v = st.subject.verdict;
      const host = await InterceptorHost.launch({
        store: d.store,
        fence: d.service.fenceForExternalCase(st.caseRunId),
        profile: {
          profileId: CANARY_INTERCEPTOR_PROFILE.profileId,
          artifactPath: CANARY_INTERCEPTOR_PROFILE.artifactPath,
          artifactDigest: s(profile, 'interceptor_artifact_digest') as `sha256:${string}`,
          sinkEffects: Object.fromEntries(supported.map((k) => [k, st.sinkClasses[k] ?? 'PROTECTED_EFFECT'])),
        },
        registeredProfileDigest: s(profile, 'profile_digest') as `sha256:${string}`,
        containment: {
          containment:
            profile['containment'] === 'PROCESS_TREE_ENFORCED' ? v.containment : 'DECLARED_HOOKS_ONLY',
          reason: v.findings.length === 0 ? 'CONTAINER_ENGINE_VERIFIED' : v.findings.join(',').slice(0, 200),
          sandboxScopeDigest: v.sandboxScopeDigest,
        },
        attestationId: st.interceptorAttestationId,
        onFrame: (frame, ack) => this.#onFrame(st, frame, ack),
      });
      st.interceptor = host;
      return host.sinkPort;
    })();
    return st.interceptorLaunch;
  }

  #onFrame(st: CaseState, frame: InterceptorFrame, ack: InterceptorFrameAck): void {
    if (!ack.ok) {
      st.frames.refused++;
      return;
    }
    if (frame.action === 'ATTEMPTED') st.frames.attempted++;
    else if (frame.action === 'BLOCKED') st.frames.blocked++;
    else st.frames.released++;
    if (frame.action !== 'ATTEMPTED' || st.release.decided || st.interceptor === null) return;
    st.release.decided = true;
    try {
      const r = this.#d.service.authorizeEffectRelease(st.caseRunId, st.interceptor.interceptorInstanceId);
      if (r === null) st.release.withheld = true;
      else {
        st.release.authorizationId = r.authorizationId;
        void st.interceptor.release().catch(() => undefined);
      }
    } catch (error) {
      st.release.error = error instanceof RouteSpecError ? error.code : 'RELEASE_DECISION_FAILED';
    }
  }

  /** Deliver re-issued credentials to the contained subject (never to an HTTP caller). */
  deliverCredentials(caseRunId: string, credentials: LaunchCredentials): boolean {
    const st = this.#cases.get(caseRunId);
    if (!st || !st.subject.running) return false;
    st.credentialPurposes.push(credentials.purpose);
    void st.subject
      .request({ type: 'credentials', credentials: { ...credentials, adapterRevision: ADAPTER_REVISION } })
      .catch(() => undefined);
    return true;
  }

  /** Wait for the subject's job, stop the tree, tear down the interceptor, journal the record. */
  async finish(caseRunId: string, waitMs = 120_000): Promise<void> {
    const st = this.#cases.get(caseRunId);
    if (!st) return;
    const deadline = Date.now() + waitMs;
    while ((st.job === 'RUNNING' || st.job === 'STARTING') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.#teardown(st);
  }

  async #teardown(st: CaseState): Promise<void> {
    if (st.teardown !== null) return;
    if (st.subject.running) await st.subject.request({ type: 'detach' }, 5_000).catch(() => undefined);
    const t = await st.subject.stop();
    st.teardown = t;
    if (st.interceptorLaunch) await st.interceptorLaunch.catch(() => null);
    if (st.interceptor && (!t.removed || t.survivors.length > 0)) {
      try {
        st.interceptor.reportFinding('PROCESS_TREE_ESCAPE', null, {
          removed: t.removed,
          survivors: t.survivors.length,
        });
      } catch {
        // A finding that cannot be journaled leaves the interceptor without orderly teardown below.
      }
    }
    await st.interceptor?.teardown().catch(() => undefined);
    const v = st.subject.verdict;
    try {
      this.#d.store.recordSubjectContainment({
        caseRunId: st.caseRunId,
        interceptorInstanceId: st.interceptor?.interceptorInstanceId ?? null,
        engine: 'docker',
        engineVersion: st.runtime.serverVersion,
        imageId: st.runtime.imageId,
        containerId: st.subject.containerId,
        containment: v.containment,
        findings: v.findings,
        sandboxScopeDigest: v.sandboxScopeDigest,
        scope: v.scope,
        selfObservation: st.subject.self,
        caseLaunchAttestationId: st.caseLaunchAttestationId,
        interceptorAttestationId: st.interceptorAttestationId,
        containerRemoved: t.removed,
        teardown: {
          removed: t.removed,
          engineExitCode: t.engineExitCode,
          survivors: t.survivors.length,
          tunnels: t.tunnels,
          frames: st.frames,
          release: st.release,
          credentialPurposes: st.credentialPurposes,
          job: st.job,
        },
        startedAtMs: st.startedAtMs,
      });
    } finally {
      this.#cases.delete(st.caseRunId);
    }
  }

  /** Abort: stop everything for a contained case before the runner aborts it. */
  async abort(caseRunId: string): Promise<void> {
    const st = this.#cases.get(caseRunId);
    if (st) await this.#teardown(st).catch(() => undefined);
  }

  /** Live view of a contained case plus its persisted containment records. */
  view(caseRunId: string): Row {
    const st = this.#cases.get(caseRunId);
    const records = this.#d.store.listSubjectContainments(caseRunId).map((r) => ({
      containmentId: s(r, 'containment_id'),
      engine: s(r, 'engine'),
      engineVersion: s(r, 'engine_version'),
      imageId: s(r, 'image_id'),
      containment: s(r, 'containment'),
      findings: JSON.parse(s(r, 'findings_json')) as string[],
      sandboxScopeDigest: (r['sandbox_scope_digest'] as string | null) ?? null,
      interceptorInstanceId: (r['interceptor_instance_id'] as string | null) ?? null,
      caseLaunchAttestationId: (r['case_launch_attestation_id'] as string | null) ?? null,
      interceptorAttestationId: (r['interceptor_attestation_id'] as string | null) ?? null,
      containerRemoved: r['container_removed'] === 1,
      teardown: JSON.parse(s(r, 'teardown_json')) as unknown,
      recordDigest: s(r, 'record_digest'),
    }));
    return {
      caseRunId,
      live:
        st === undefined
          ? null
          : {
              job: st.job,
              error: st.error,
              subjectOutcome: st.outcome,
              subjectOutcomeClass: 'SUBJECT_REPORTED',
              containment: st.subject.verdict.containment,
              findings: st.subject.verdict.findings,
              sandboxScopeDigest: st.subject.verdict.sandboxScopeDigest,
              selfObservation: st.subject.self,
              attestations: st.attestations,
              caseLaunchAttestationId: st.caseLaunchAttestationId,
              interceptorAttestationId: st.interceptorAttestationId,
              interceptorInstanceId: st.interceptor?.interceptorInstanceId ?? null,
              frames: st.frames,
              release: st.release,
              credentialPurposes: st.credentialPurposes,
              tokenDelivery: 'CONTAINED_SUBJECT',
            },
      records,
      recordDigests: records.map((r) => r.recordDigest),
      digest: digestValue(
        'routespec.containment-view/1',
        records.map((r) => r.recordDigest),
      ),
    };
  }

  async closeAll(): Promise<void> {
    for (const st of [...this.#cases.values()]) await this.#teardown(st).catch(() => undefined);
  }
}
