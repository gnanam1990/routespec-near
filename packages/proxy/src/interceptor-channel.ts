/**
 * Independent effect-interceptor transport and containment (M02 deliverable 9; INV-04 support).
 *
 * M02 supplies only the transport: launching a separately reviewed interceptor artifact, a
 * private peer-bound channel, exact identity binding, honest containment labelling, canary
 * denial/release, and the immutable journal handoff. Coverage semantics (what a set of
 * boundary observations proves) belong to the kernel (M04).
 *
 * - Reviewed artifact: the interceptor script's LF-normalized text digest must equal the
 *   profile's pinned artifact digest before anything is spawned. A modified artifact is refused.
 * - Private channel: the interceptor is forked with an inherited IPC pipe (no network port, no
 *   argv/env secret). A random channel key is generated here and sent over that pipe only; the
 *   journal stores its digest. Frames are accepted only from this child's own pipe and only
 *   with that key, so no case token, control token, or subject path can write observations.
 * - Binding: the instance is registered under the case's current execution fence; every frame
 *   must carry the exact build/gate/case/session/epoch/policy/manifest/profile binding and a
 *   supported sink class, or the store rejects it (fail closed; the subject is denied).
 * - Containment: without an OS sandbox that confines the subject's process tree, this host
 *   reports `DECLARED_HOOKS_ONLY` and never claims complete boundary coverage. A caller that
 *   launched the subject inside a verified container (M14, `@routespec/containment`) passes the
 *   engine-verified containment evidence; only that evidence can register
 *   `PROCESS_TREE_ENFORCED`, with its sandbox-scope digest.
 * - Teardown: an orderly `TEARDOWN` record, or `CHANNEL_LOST` when the interceptor exits or the
 *   pipe closes first. A torn-down instance cannot journal again.
 */
import { randomBytes } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RouteSpecError, digestValue, type Digest } from '@routespec/contracts';
import type { ExecutionFence, RouteSpecStore } from '@routespec/store';

export type Containment = 'PROCESS_TREE_ENFORCED' | 'DECLARED_HOOKS_ONLY';

export interface InterceptorProfile {
  readonly profileId: string;
  readonly artifactPath: string;
  /** Pinned digest of the reviewed artifact text (LF-normalized). */
  readonly artifactDigest: Digest;
  /** sink class -> declared effect type */
  readonly sinkEffects: Readonly<Record<string, string>>;
}

export const INTERCEPTOR_ARTIFACT_DOMAIN = 'routespec.interceptor-artifact/1' as const;
export const INTERCEPTOR_CHANNEL_KEY_DOMAIN = 'routespec.interceptor-channel-key/1' as const;

/** Pinned digest of `interceptor/canary-interceptor.ts` as reviewed (update only on review). */
export const CANARY_INTERCEPTOR_ARTIFACT_DIGEST: Digest =
  'sha256:5e36e58c3145519ef6d45f3f88b7993dc7b2f0bd873ac8fe10212960a5ddf5ab';

export const CANARY_INTERCEPTOR_PROFILE: InterceptorProfile = Object.freeze({
  profileId: 'routespec-canary-interceptor@1.0.0',
  artifactPath: fileURLToPath(new URL('./interceptor/canary-interceptor.ts', import.meta.url)),
  artifactDigest: CANARY_INTERCEPTOR_ARTIFACT_DIGEST,
  sinkEffects: Object.freeze({ 'fulfilment-webhook': 'DELIVER_GOODS' }),
});

export function artifactDigestOf(path: string): Digest {
  return digestValue(INTERCEPTOR_ARTIFACT_DOMAIN, readFileSync(path, 'utf8').replace(/\r\n/g, '\n'));
}

export function interceptorProfileDigest(profile: InterceptorProfile): Digest {
  return digestValue('routespec.interceptor-profile/1', {
    profileId: profile.profileId,
    artifactDigest: profile.artifactDigest,
    sinkEffects: Object.fromEntries(
      Object.entries(profile.sinkEffects).sort(([a], [b]) => a.localeCompare(b)),
    ),
  });
}

/**
 * Honest containment for this host. No OS/container sandbox that confines the subject process
 * tree and forces its effect sinks through the interceptor is integrated, on any platform, so
 * the answer is always `DECLARED_HOOKS_ONLY` with the reason recorded.
 */
export function detectContainment(): { containment: Containment; reason: string; platform: string } {
  return {
    containment: 'DECLARED_HOOKS_ONLY',
    reason: 'NO_PROCESS_TREE_SANDBOX',
    platform: `${process.platform}-${process.arch}`,
  };
}

export interface InterceptorFrameAck {
  readonly sequence: number;
  readonly ok: boolean;
  readonly code: string | null;
  readonly observationId: string | null;
}

export interface VerifiedContainment {
  readonly containment: Containment;
  readonly reason: string;
  readonly sandboxScopeDigest: Digest | null;
}

export type InterceptorFrame = Frame;

interface Frame {
  sequence: number;
  buildRevisionId: string;
  gateRunId: string;
  caseRunId: string;
  sessionId: string;
  fencingEpoch: number;
  policyDigest: string;
  manifestDigest: string;
  interceptorProfileDigest: string;
  runOperationId: string | null;
  sinkClass: string;
  effectId: string;
  effectType: string;
  action: 'ATTEMPTED' | 'BLOCKED' | 'RELEASED';
  virtualMs: number | null;
}

function waitFor(child: ChildProcess, type: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new RouteSpecError('RS_CHANNEL_AUTH_FAILED', 'Interceptor did not answer on its channel.'));
    }, timeoutMs);
    const onMessage = (m: unknown) => {
      const msg = m as Record<string, unknown>;
      if (msg !== null && typeof msg === 'object' && msg['type'] === type) {
        cleanup();
        resolve(msg);
      }
    };
    const onExit = () => {
      cleanup();
      reject(new RouteSpecError('RS_INTERCEPTOR_TORN_DOWN', 'Interceptor exited before answering.'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

export class InterceptorHost {
  readonly interceptorInstanceId: string;
  readonly sinkPort: number;
  readonly peerPid: number;
  readonly containment: Containment;
  readonly profileDigest: Digest;
  readonly acks: InterceptorFrameAck[] = [];
  private readonly store: RouteSpecStore;
  private readonly child: ChildProcess;
  readonly #channelKey: string;
  #closed = false;
  #onFrame: ((frame: InterceptorFrame, ack: InterceptorFrameAck) => void) | null = null;
  readonly #fencingEpoch: number;

  private constructor(args: {
    store: RouteSpecStore;
    child: ChildProcess;
    channelKey: string;
    interceptorInstanceId: string;
    sinkPort: number;
    containment: Containment;
    profileDigest: Digest;
    fencingEpoch: number;
  }) {
    this.store = args.store;
    this.#fencingEpoch = args.fencingEpoch;
    this.child = args.child;
    this.#channelKey = args.channelKey;
    this.interceptorInstanceId = args.interceptorInstanceId;
    this.sinkPort = args.sinkPort;
    this.peerPid = args.child.pid as number;
    this.containment = args.containment;
    this.profileDigest = args.profileDigest;
    this.child.on('message', (m: unknown) => this.onMessage(m));
    const lost = () => this.onLost();
    this.child.once('exit', lost);
    this.child.once('disconnect', lost);
  }

  /**
   * Launch the reviewed interceptor for one running case. Refuses a modified artifact before
   * spawning; registers the instance under the case's current fence; binds it over its pipe.
   */
  static async launch(input: {
    store: RouteSpecStore;
    fence: ExecutionFence;
    profile?: InterceptorProfile;
    /** Digest of the interceptor profile as registered in the control journal (M14). */
    registeredProfileDigest?: Digest;
    /** Engine-verified containment of the subject (M14); absent means declared hooks only. */
    containment?: VerifiedContainment;
    /** EFFECT_INTERCEPTOR_LAUNCH attestation completed for this launch (M14). */
    attestationId?: string | null;
    /** Called after each frame is journaled (or refused). */
    onFrame?: (frame: InterceptorFrame, ack: InterceptorFrameAck) => void;
  }): Promise<InterceptorHost> {
    const profile = input.profile ?? CANARY_INTERCEPTOR_PROFILE;
    const actual = artifactDigestOf(profile.artifactPath);
    if (actual !== profile.artifactDigest) {
      throw new RouteSpecError(
        'RS_IDENTITY_MISMATCH',
        'Interceptor artifact differs from the reviewed profile.',
        {
          details: { profileId: profile.profileId },
        },
      );
    }
    const caseRun = input.store.getCaseRun(input.fence.caseRunId);
    const sessionId = caseRun?.['session_id'];
    if (!caseRun || typeof sessionId !== 'string') {
      throw new RouteSpecError('RS_PHASE_INVALID', 'Interceptor requires a started case.');
    }
    const session = input.store.getSession(sessionId) as Record<string, unknown>;
    const detected = detectContainment();
    const verified = input.containment;
    const containment: Containment =
      verified !== undefined && verified.containment === 'PROCESS_TREE_ENFORCED'
        ? 'PROCESS_TREE_ENFORCED'
        : 'DECLARED_HOOKS_ONLY';
    const reason = verified === undefined ? detected.reason : verified.reason;
    const platform = detected.platform;
    const profileDigest = input.registeredProfileDigest ?? interceptorProfileDigest(profile);
    const channelKey = randomBytes(32).toString('base64url');
    // Minimal environment: nothing secret is inherited; the key travels only over the pipe.
    const env: Record<string, string> = {};
    for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP']) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    const child = fork(profile.artifactPath, [], {
      execArgv: ['--no-warnings'],
      env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
    });
    try {
      const hello = await waitFor(child, 'hello');
      if (hello['pid'] !== child.pid) {
        throw new RouteSpecError(
          'RS_CHANNEL_AUTH_FAILED',
          'Interceptor peer identity does not match its process.',
        );
      }
      const { interceptorInstanceId } = input.store.registerInterceptorInstance(input.fence, {
        interceptorProfileDigest: profileDigest,
        interceptorArtifactDigest: profile.artifactDigest,
        sandboxScopeDigest:
          verified !== undefined && verified.sandboxScopeDigest !== null
            ? verified.sandboxScopeDigest
            : digestValue('routespec.sandbox-scope/1', { containment, reason, platform }),
        supportedSinks: Object.keys(profile.sinkEffects),
        containment,
        channelKeyDigest: digestValue(INTERCEPTOR_CHANNEL_KEY_DOMAIN, channelKey),
        peerPid: child.pid as number,
        attestationId: input.attestationId ?? null,
      });
      const ready = waitFor(child, 'ready');
      child.send({
        type: 'bind',
        channelKey,
        binding: {
          interceptorInstanceId,
          buildRevisionId: String(session['build_revision_id']),
          gateRunId: String(session['gate_run_id']),
          caseRunId: input.fence.caseRunId,
          sessionId,
          fencingEpoch: input.fence.fencingEpoch,
          policyDigest: String(session['effect_coverage_policy_digest']),
          manifestDigest: String(session['effect_manifest_digest']),
          interceptorProfileDigest: profileDigest,
          sinkEffects: profile.sinkEffects,
        },
      });
      const sinkPort = Number((await ready)['sinkPort']);
      const host = new InterceptorHost({
        store: input.store,
        child,
        channelKey,
        interceptorInstanceId,
        sinkPort,
        containment,
        profileDigest,
        fencingEpoch: input.fence.fencingEpoch,
      });
      if (input.onFrame) host.#onFrame = input.onFrame;
      return host;
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  get sinkOrigin(): string {
    return `http://127.0.0.1:${this.sinkPort}`;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Declared completion was accepted elsewhere: later attempts go to the no-effect canary. */
  async release(): Promise<void> {
    const done = waitFor(this.child, 'released');
    this.child.send({ type: 'release' });
    await done;
  }

  /** Orderly teardown: the interceptor closes its sink and the instance is closed in the journal. */
  async teardown(): Promise<void> {
    if (this.#closed) return;
    const bye = waitFor(this.child, 'bye').catch(() => null);
    this.child.send({ type: 'teardown' });
    await bye;
    this.close('TEARDOWN');
    if (this.child.exitCode === null)
      await new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
  }

  /**
   * Journal a coverage defect this host observed about the boundary (for example a subject
   * container that survived teardown) over the instance's own private channel.
   */
  reportFinding(
    kind: 'PROCESS_TREE_ESCAPE' | 'SINK_BYPASS',
    sinkClass: string | null,
    detail: unknown,
  ): void {
    if (this.#closed) return;
    this.store.recordCoverageFinding(
      { interceptorInstanceId: this.interceptorInstanceId, channelKey: this.#channelKey },
      {
        kind,
        sinkClass,
        fencingEpoch: this.#fencingEpoch,
        detailDigest: digestValue('routespec.coverage-finding-detail/1', detail),
      },
    );
  }

  private close(reason: 'TEARDOWN' | 'CHANNEL_LOST'): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.store.teardownInterceptor(
        { interceptorInstanceId: this.interceptorInstanceId, channelKey: this.#channelKey },
        reason,
      );
    } catch {
      // Already closed by a case-terminal transition; the journal keeps the first teardown.
    }
  }

  private onLost(): void {
    this.close('CHANNEL_LOST');
  }

  private onMessage(raw: unknown): void {
    const msg = raw as { type?: unknown; channelKey?: unknown; frame?: Frame };
    if (msg?.type !== 'frame' || !msg.frame || typeof msg.frame.sequence !== 'number') return;
    const frame = msg.frame;
    let ack: InterceptorFrameAck;
    try {
      const result = this.store.recordBoundaryObservation(
        { interceptorInstanceId: this.interceptorInstanceId, channelKey: String(msg.channelKey ?? '') },
        { ...frame, frameDigest: digestValue('routespec.boundary-frame/1', frame) },
      );
      ack = { sequence: frame.sequence, ok: true, code: null, observationId: result.observationId };
    } catch (error) {
      const code = error instanceof RouteSpecError ? error.code : 'RS_INTERNAL';
      ack = { sequence: frame.sequence, ok: false, code, observationId: null };
    }
    this.acks.push(ack);
    try {
      this.#onFrame?.(frame, ack);
    } catch {
      // A listener never decides whether the frame was journaled.
    }
    if (this.child.connected)
      this.child.send({ type: 'ack', sequence: ack.sequence, ok: ack.ok, code: ack.code });
  }
}
