/**
 * Separately launched installed subjects for the delivery journey.
 *
 * The client builds are the reviewed integrator builds kept with the M05 regression suite:
 * `baseline-client.ts` (resubmits an unanswered deposit submission and never reconciles) and
 * `corrected-client.ts` (never resubmits an unknown commit; reads status read-only after
 * reconciliation authority arrives). A third build, `hedging-client.ts`, places a second order
 * (fresh quote, second deposit submission) while its first submission is still unanswered. All
 * three run the exact pinned official SDK with the RouteSpec
 * adapter on the SDK's own axios instance. The artifact digest of a build is the SHA-256 of its
 * own source bytes, so the fix is a different artifact.
 *
 * The probe is the M02 subject harness (the same official SDK and adapter) used to issue single
 * SDK calls with a chosen credential: the stale execution token, then the reconciliation token.
 *
 * Credentials cross only the inherited IPC pipe, never argv or the environment.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileDigest, type Sha256 } from './identity.ts';
import type { J } from './control.ts';

export type Build = 'baseline-client' | 'corrected-client' | 'hedging-client';

export function buildScript(root: string, build: Build): string {
  return join(root, 'packages', 'regressions', 'test', 'support', 'subject', `${build}.ts`);
}

export function probeScript(root: string): string {
  return join(root, 'packages', 'proxy', 'test', 'support', 'subject-client.ts');
}

export function buildArtifactDigest(root: string, build: Build): Sha256 {
  return fileDigest(buildScript(root, build));
}

export interface CaseCredentials {
  readonly purpose: 'EXECUTION' | 'RECONCILIATION_ONLY';
  readonly token: string;
  readonly sessionId: string;
  readonly caseRunId: string;
  readonly fencingEpoch: number;
  readonly clientInstanceId: string;
}

export function credentialsOf(r: J): CaseCredentials {
  const t = r['token'] as { value: string; purpose: 'EXECUTION' | 'RECONCILIATION_ONLY' };
  return {
    purpose: t.purpose,
    token: t.value,
    sessionId: String(r['sessionId']),
    caseRunId: String(r['caseRunId']),
    fencingEpoch: Number(r['fencingEpoch']),
    clientInstanceId: String(r['clientInstanceId']),
  };
}

export class SubjectProcess {
  readonly child: ChildProcess;
  readonly script: string;
  private constructor(child: ChildProcess, script: string) {
    this.child = child;
    this.script = script;
  }

  static async launch(script: string, env: Record<string, string>): Promise<SubjectProcess> {
    const child = fork(script, [], {
      execArgv: ['--no-warnings'],
      env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const s = new SubjectProcess(child, script);
    await s.wait('loaded');
    return s;
  }

  private wait(type: string): Promise<J> {
    return new Promise((resolve, reject) => {
      const onExit = (code: number | null) => reject(new Error(`subject exited ${String(code)}`));
      const onMessage = (m: unknown) => {
        const msg = m as J;
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

  send(msg: J): Promise<J> {
    const p = this.wait(`${String(msg['type'])}-done`);
    // A subject that is exiting fails the send asynchronously; `wait` then rejects on its exit.
    this.child.send(msg, () => undefined);
    return p;
  }

  attach(origin: string, c: CaseCredentials): Promise<J> {
    return this.send({
      type: 'attach',
      origin,
      credentials: { ...c, adapterRevision: 'routespec-adapter@1.0.0' },
    });
  }

  credentials(c: CaseCredentials): Promise<J> {
    return this.send({
      type: 'credentials',
      credentials: { ...c, adapterRevision: 'routespec-adapter@1.0.0' },
    });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await this.send({ type: 'detach' }).catch(() => undefined);
    await new Promise<void>((r) =>
      this.child.exitCode !== null || this.child.signalCode !== null
        ? r()
        : this.child.once('exit', () => r()),
    );
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
