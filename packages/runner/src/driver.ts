/**
 * Case drivers: how a started case is handed to the actual client (API-SPEC section 6, TDD
 * section 5 step 6).
 *
 * RouteSpec never launches integrator commands, package scripts, or project binaries. The
 * runner only hands each case's proxy configuration and one-time credentials to a reviewed
 * launcher channel, and waits for the launcher to report that client input for the case is
 * closed. The user's CI (or the launcher adapter) starts the client separately.
 *
 * `IpcCaseDriver` uses the inherited IPC pipe of a process started by the reviewed launcher
 * (`@routespec/cli` `runWithLauncher`): credentials travel only over that pipe, never argv,
 * environment, stdout, a file, or the journal.
 */
import type { LaunchCredentials } from '@routespec/proxy';

export const LAUNCHER_PROTOCOL = 'routespec.launcher/1' as const;

export interface CaseHandoff {
  readonly protocol: typeof LAUNCHER_PROTOCOL;
  readonly gateRunId: string;
  readonly caseRunId: string;
  readonly ordinal: number;
  readonly scenarioRevisionId: string;
  readonly scenarioStableId: string;
  readonly mode: 'SIMULATE' | 'REPLAY';
  readonly proxyOrigin: string;
  readonly credentials: LaunchCredentials;
  readonly tokenTtlMs: number;
  readonly buildAttestationClass: string;
  /** True for the first case handed to this launcher (attach); later cases reset the client. */
  readonly firstCase: boolean;
}

export type CaseDriverOutcome =
  | { readonly kind: 'INPUT_CLOSED' }
  | { readonly kind: 'CANCELLED'; readonly reason: string }
  | { readonly kind: 'CLIENT_FAILED'; readonly code: string };

export interface CaseDriver {
  runCase(handoff: CaseHandoff): Promise<CaseDriverOutcome>;
  /** A newly issued credential (reconciliation-only after an unknown outcome). */
  pushCredentials(caseRunId: string, credentials: LaunchCredentials): void;
  /** Ask the launcher to stop a case; `runCase` then resolves CANCELLED. */
  cancel(caseRunId: string, reason: string): void;
}

type Msg = Record<string, unknown>;

/** Driver over the inherited IPC channel of the current process. */
export class IpcCaseDriver implements CaseDriver {
  readonly #pending = new Map<string, (outcome: CaseDriverOutcome) => void>();
  readonly #onMessage: (raw: unknown) => void;
  readonly #onDisconnect: () => void;
  #closed = false;
  #first = true;

  constructor() {
    if (typeof process.send !== 'function' || !process.connected) {
      throw new Error('IpcCaseDriver requires an inherited IPC channel.');
    }
    this.#onMessage = (raw: unknown) => {
      const msg = raw as Msg;
      if (msg === null || typeof msg !== 'object' || msg['protocol'] !== LAUNCHER_PROTOCOL) return;
      const caseRunId = typeof msg['caseRunId'] === 'string' ? msg['caseRunId'] : null;
      if (caseRunId === null) return;
      const resolve = this.#pending.get(caseRunId);
      if (!resolve) return;
      if (msg['type'] === 'case-input-closed') resolve({ kind: 'INPUT_CLOSED' });
      else if (msg['type'] === 'case-cancelled') {
        resolve({
          kind: 'CANCELLED',
          reason: typeof msg['reason'] === 'string' ? msg['reason'] : 'LAUNCHER_CANCELLED',
        });
      } else if (msg['type'] === 'case-client-failed') {
        resolve({
          kind: 'CLIENT_FAILED',
          code: typeof msg['code'] === 'string' ? msg['code'] : 'CLIENT_FAILED',
        });
      }
    };
    this.#onDisconnect = () => {
      this.#closed = true;
      for (const resolve of this.#pending.values())
        resolve({ kind: 'CANCELLED', reason: 'LAUNCHER_DISCONNECTED' });
    };
    process.on('message', this.#onMessage);
    process.on('disconnect', this.#onDisconnect);
  }

  get firstCase(): boolean {
    return this.#first;
  }

  private send(msg: Msg): void {
    if (this.#closed || typeof process.send !== 'function' || !process.connected) return;
    // A launcher that is going away fails the send asynchronously; its 'disconnect' settles the
    // pending cases, so the error itself is not a crash of the gate run.
    process.send({ protocol: LAUNCHER_PROTOCOL, ...msg }, undefined, undefined, () => undefined);
  }

  runCase(handoff: CaseHandoff): Promise<CaseDriverOutcome> {
    this.#first = false;
    if (this.#closed) return Promise.resolve({ kind: 'CANCELLED', reason: 'LAUNCHER_DISCONNECTED' });
    return new Promise((resolve) => {
      this.#pending.set(handoff.caseRunId, (outcome) => {
        this.#pending.delete(handoff.caseRunId);
        resolve(outcome);
      });
      this.send({ type: 'case-handoff', handoff });
    });
  }

  pushCredentials(caseRunId: string, credentials: LaunchCredentials): void {
    this.send({ type: 'case-credentials', caseRunId, credentials });
  }

  cancel(caseRunId: string, reason: string): void {
    this.send({ type: 'case-cancel', caseRunId, reason });
    this.#pending.get(caseRunId)?.({ kind: 'CANCELLED', reason });
  }

  progress(event: Record<string, string | number | boolean | null>): void {
    this.send({ type: 'progress', event });
  }

  close(): void {
    process.off('message', this.#onMessage);
    process.off('disconnect', this.#onDisconnect);
  }
}
