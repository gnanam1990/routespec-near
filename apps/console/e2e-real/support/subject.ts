/**
 * A separately launched installed subject: the pinned official 1Click SDK with the RouteSpec
 * client adapter (the M02 subject harness in packages/proxy/test/support/subject-client.ts).
 * Credentials reach it only over the inherited IPC channel. Only `node:` built-ins are used here so
 * the same file runs in the seeding service and inside Playwright workers.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SUBJECT_SCRIPT = fileURLToPath(
  new URL('../../../../packages/proxy/test/support/subject-client.ts', import.meta.url),
);

/** Artifact digest of the installed subject entry (same algorithm as the control API's fileDigest). */
export function subjectArtifactDigest(): string {
  return `sha256:${createHash('sha256').update(readFileSync(SUBJECT_SCRIPT)).digest('hex')}`;
}

export interface CaseCredentials {
  readonly purpose: 'EXECUTION' | 'RECONCILIATION_ONLY';
  readonly token: string;
  readonly sessionId: string;
  readonly caseRunId: string;
  readonly fencingEpoch: number;
  readonly clientInstanceId: string;
}

export type SubjectOp = 'getQuote' | 'submitDepositTx' | 'getExecutionStatus';

export class Subject {
  readonly child: ChildProcess;
  private constructor(child: ChildProcess) {
    this.child = child;
  }

  static async launch(): Promise<Subject> {
    const child = fork(SUBJECT_SCRIPT, [], {
      execArgv: ['--no-warnings'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
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

  send(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const p = this.wait(`${String(msg['type'])}-done`);
    this.child.send(msg);
    return p;
  }

  attach(origin: string, credentials: CaseCredentials): Promise<Record<string, unknown>> {
    return this.send({
      type: 'attach',
      origin,
      credentials: { ...credentials, adapterRevision: 'routespec-adapter@1.0.0' },
    });
  }

  logicalJob(key: string): Promise<Record<string, unknown>> {
    return this.send({ type: 'logicalJob', key });
  }

  call(op: SubjectOp, ...args: unknown[]): Promise<Record<string, unknown>> {
    return this.send({ type: 'call', op, args });
  }

  /** A crash: the process is killed without detaching or finishing its case input. */
  kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.kill('SIGKILL');
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

function depositOf(quote: Record<string, unknown>): string {
  const v = quote['value'] as Record<string, unknown> | undefined;
  return String(((v?.['quote'] ?? {}) as Record<string, unknown>)['depositAddress']);
}

export type Behaviour = 'RECONCILING' | 'NAIVE_RESUBMIT';

/**
 * Drives one logical job the way an installed client would. RECONCILING: one quote, one
 * submission, then status polls until a terminal status. NAIVE_RESUBMIT: when the submission
 * gets no usable answer it submits again without reconciling (the issue-383 defect class).
 */
export async function driveJob(
  subject: Subject,
  key: string,
  behaviour: Behaviour,
  polls = 4,
  stopAtTerminal = true,
): Promise<{ calls: number; failures: number }> {
  let calls = 0;
  let failures = 0;
  const attempt = async (op: SubjectOp, ...args: unknown[]) => {
    calls++;
    try {
      const r = await subject.call(op, ...args);
      if (r['ok'] === false) failures++;
      return r;
    } catch {
      failures++;
      return null;
    }
  };
  await subject.logicalJob(key);
  const q = await attempt('getQuote', quoteBody());
  if (q === null || q['ok'] === false) return { calls, failures };
  const depositAddress = depositOf(q);
  const first = await attempt('submitDepositTx', { txHash: `sim-tx-${key}`, depositAddress });
  const firstOk = first !== null && first['ok'] !== false;
  if (!firstOk && behaviour === 'NAIVE_RESUBMIT') {
    await attempt('submitDepositTx', { txHash: `sim-tx-${key}-again`, depositAddress });
  }
  for (let i = 0; i < polls; i++) {
    const s = await attempt('getExecutionStatus', depositAddress);
    const status = String(((s?.['value'] ?? {}) as Record<string, unknown>)['status'] ?? '');
    if (stopAtTerminal && ['SUCCESS', 'REFUNDED', 'FAILED'].includes(status) && i >= 1) break;
  }
  return { calls, failures };
}
