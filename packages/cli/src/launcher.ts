/**
 * Reviewed launcher adapter for `routespec gate run` (API-SPEC section 6).
 *
 * The launcher starts the RouteSpec CLI as a child with an inherited IPC pipe and relays each
 * case handoff to the caller's `onCase`, which connects the user's separately started client
 * (for example a CI step or a test harness) to the printed proxy origin with the delivered
 * credentials. RouteSpec itself never executes a shell string or a project command; the
 * launcher only starts the RouteSpec CLI entry point. Credentials cross only this pipe.
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { CaseHandoff } from '@routespec/runner';
import type { LaunchCredentials } from '@routespec/proxy';

export const CLI_ENTRY = fileURLToPath(new URL('./main.ts', import.meta.url));
const PROTOCOL = 'routespec.launcher/1';

export type LauncherCaseResult =
  | 'INPUT_CLOSED'
  | { readonly cancelled: string }
  | { readonly failed: string };

export interface LauncherCaseControl {
  /** Subscribe to credentials re-issued for this case (reconciliation-only after an unknown outcome). */
  onCredentials(listener: (credentials: LaunchCredentials) => void): void;
  /** Aborted when RouteSpec cancels the case. */
  readonly signal: AbortSignal;
}

export interface LauncherOptions {
  readonly args: readonly string[];
  readonly onCase: (handoff: CaseHandoff, control: LauncherCaseControl) => Promise<LauncherCaseResult>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cliEntry?: string;
  readonly onProgress?: (event: Record<string, unknown>) => void;
}

export interface LauncherResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly json: Record<string, unknown> | null;
  readonly handoffs: number;
}

const STRIPPED_ENV =
  /^(?:ROUTESPEC_PROVIDER_JWT|HTTPS?_PROXY|https?_proxy|ALL_PROXY|all_proxy|NODE_OPTIONS)$/;

export function runWithLauncher(options: LauncherOptions): Promise<LauncherResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.env ?? process.env)) {
    if (v !== undefined && !STRIPPED_ENV.test(k)) env[k] = v;
  }
  const child = fork(options.cliEntry ?? CLI_ENTRY, [...options.args], {
    cwd: options.cwd ?? process.cwd(),
    env,
    execArgv: ['--no-warnings'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let stderr = '';
  let handoffs = 0;
  child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
  const cases = new Map<
    string,
    { listeners: Array<(c: LaunchCredentials) => void>; abort: AbortController }
  >();
  const reply = (msg: Record<string, unknown>) => {
    if (child.connected) child.send({ protocol: PROTOCOL, ...msg });
  };
  child.on('message', (raw: unknown) => {
    const msg = raw as Record<string, unknown>;
    if (msg === null || typeof msg !== 'object' || msg['protocol'] !== PROTOCOL) return;
    if (msg['type'] === 'case-handoff') {
      const handoff = msg['handoff'] as CaseHandoff;
      handoffs++;
      const state = { listeners: [] as Array<(c: LaunchCredentials) => void>, abort: new AbortController() };
      cases.set(handoff.caseRunId, state);
      void options
        .onCase(handoff, {
          onCredentials: (l) => state.listeners.push(l),
          signal: state.abort.signal,
        })
        .then(
          (result) => {
            if (result === 'INPUT_CLOSED') reply({ type: 'case-input-closed', caseRunId: handoff.caseRunId });
            else if ('cancelled' in result) {
              reply({ type: 'case-cancelled', caseRunId: handoff.caseRunId, reason: result.cancelled });
            } else reply({ type: 'case-client-failed', caseRunId: handoff.caseRunId, code: result.failed });
          },
          () =>
            reply({ type: 'case-client-failed', caseRunId: handoff.caseRunId, code: 'LAUNCHER_CASE_ERROR' }),
        )
        .finally(() => cases.delete(handoff.caseRunId));
    } else if (msg['type'] === 'case-credentials') {
      const state = cases.get(String(msg['caseRunId']));
      for (const l of state?.listeners ?? []) l(msg['credentials'] as LaunchCredentials);
    } else if (msg['type'] === 'case-cancel') {
      cases.get(String(msg['caseRunId']))?.abort.abort();
    } else if (msg['type'] === 'progress') {
      options.onProgress?.(msg['event'] as Record<string, unknown>);
    }
  });
  return new Promise((resolve) => {
    child.on('close', (code) => {
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        json = null;
      }
      resolve({ exitCode: code, stdout, stderr, json, handoffs });
    });
  });
}
