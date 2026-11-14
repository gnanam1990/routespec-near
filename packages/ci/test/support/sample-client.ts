/**
 * Sample client launch module for the RouteSpec gate action (the integrator-owned part of a CI
 * job). For every case handoff it starts a fresh subject process from the first configured
 * artifact file (an installed client running the pinned official SDK with the RouteSpec
 * adapter), attaches it to the printed proxy origin with the delivered credentials over IPC,
 * runs one job, and detaches.
 *
 * Test hooks, all opt-in through non-secret environment variables:
 * - `ROUTESPEC_CI_TEST_ENV_REPORT`: append the names (never values) of credential-shaped
 *   variables visible to this module and to the subject process.
 * - `ROUTESPEC_CI_TEST_SWAP_FILE`: append bytes to this artifact file during the first case
 *   (an artifact swapped while the gate runs).
 * - `ROUTESPEC_CI_TEST_PROC_ENVIRON` (Linux): a comma-separated list of variable names; append
 *   which of them (names only) appear in the initial environment block of this process (the
 *   subject's parent) and of its parent, as `/proc/<pid>/environ` serves it.
 */
import { fork } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import type { LauncherCaseControl, LauncherCaseResult } from '@routespec/cli';
import type { CaseHandoff } from '@routespec/runner';

const CREDENTIAL_NAME =
  /(?:TOKEN|JWT|SECRET|PASSWORD|ROUTESPEC_PROVIDER_|ACTIONS_ID_TOKEN|ACTIONS_RUNTIME|NODE_OPTIONS)/i;

function credentialNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((k) => CREDENTIAL_NAME.test(k) && k !== 'ROUTESPEC_CI_TEST_ENV_REPORT')
    .sort();
}

/** Which of `watched` appear in the initial environment block of `pid` (names only). */
function initialEnvironNames(pid: string, watched: readonly string[]): string[] {
  const block = readFileSync(`/proc/${pid}/environ`, 'latin1');
  const present = new Set(block.split('\0').map((entry) => entry.slice(0, entry.indexOf('='))));
  return watched.filter((name) => present.has(name)).sort();
}

function quoteBody(): Record<string, unknown> {
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

export async function onCase(
  handoff: CaseHandoff,
  control: LauncherCaseControl,
  context: { readonly workspace: string; readonly artifactFiles: readonly string[] },
): Promise<LauncherCaseResult> {
  const report = process.env['ROUTESPEC_CI_TEST_ENV_REPORT'];
  if (report)
    appendFileSync(
      report,
      `${JSON.stringify({ where: 'client-module', names: credentialNames(process.env) })}\n`,
    );
  const watched = process.env['ROUTESPEC_CI_TEST_PROC_ENVIRON'];
  if (report && watched && handoff.ordinal === 0) {
    const names = watched.split(',').filter((n) => n !== '');
    for (const [where, pid] of [
      ['client-module-initial-environ', 'self'],
      ['action-parent-initial-environ', String(process.ppid)],
    ] as const) {
      appendFileSync(report, `${JSON.stringify({ where, names: initialEnvironNames(pid, names) })}\n`);
    }
  }
  const swap = process.env['ROUTESPEC_CI_TEST_SWAP_FILE'];
  if (swap && handoff.ordinal === 0) appendFileSync(swap, 'swapped during the gate run\n');

  const child = fork(context.artifactFiles[0] as string, [], {
    execArgv: ['--no-warnings'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const wait = (type: string): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const onExit = (code: number | null) => reject(new Error(`subject exited ${code}`));
      const onMessage = (m: unknown) => {
        const msg = m as Record<string, unknown>;
        if (msg['type'] !== 'error' && msg['type'] !== type) return;
        child.off('message', onMessage);
        child.off('exit', onExit);
        if (msg['type'] === 'error') reject(new Error(`subject error ${String(msg['code'])}`));
        else resolve(msg);
      };
      child.on('message', onMessage);
      child.once('exit', onExit);
    });
  const send = (msg: Record<string, unknown>) => {
    const p = wait(`${String(msg['type'])}-done`);
    child.send(msg, () => undefined);
    return p;
  };
  try {
    await wait('loaded');
    if (report) {
      // The subject inherits this process's environment; record what it would see.
      appendFileSync(
        report,
        `${JSON.stringify({ where: 'subject', names: credentialNames(process.env) })}\n`,
      );
    }
    control.onCredentials((credentials) => {
      if (child.connected) child.send({ type: 'credentials', credentials }, () => undefined);
    });
    if (control.signal.aborted) return { cancelled: 'LAUNCHER_ABORTED' };
    await send({ type: 'attach', origin: handoff.proxyOrigin, credentials: handoff.credentials });
    await send({
      type: 'run',
      request: {
        logicalJob: `order-${handoff.ordinal + 1}`,
        quote: quoteBody(),
        txHash: `sim-tx-${handoff.ordinal + 1}`,
      },
    });
    await send({ type: 'detach' });
  } catch {
    return { failed: 'CLIENT_CRASHED' };
  } finally {
    if (child.exitCode === null) {
      await new Promise<void>((r) => {
        child.once('exit', () => r());
        setTimeout(() => {
          child.kill();
          r();
        }, 5000).unref();
      });
    }
  }
  return 'INPUT_CLOSED';
}
