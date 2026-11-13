/**
 * Parent-side launcher for the live-dry adapter process.
 *
 * The child gets a minimal environment: operating-system essentials only, never NODE_OPTIONS,
 * proxy variables, TLS overrides or extra CA paths. The provider JWT variable is passed through
 * only when the caller asks for it (`passProviderJwt`), and only from the launcher's own
 * environment, where the user placed it; the launcher never parses, logs or returns it. Nothing
 * secret goes on argv.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ProviderTokenState } from '@routespec/contracts';
import { PROVIDER_JWT_ENV, type CredentialPolicy } from './credential.ts';
import type { EgressLimits } from './egress.ts';
import type { PreflightReport } from './process.ts';
import type { AdapterReport } from './server.ts';

const ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'WINDIR',
  'ComSpec',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'TZ',
] as const;

export function sanitizedAdapterEnv(
  parent: NodeJS.ProcessEnv,
  options: { passProviderJwt: boolean },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    if (parent[key] !== undefined) env[key] = parent[key];
  }
  if (options.passProviderJwt && parent[PROVIDER_JWT_ENV] !== undefined) {
    env[PROVIDER_JWT_ENV] = parent[PROVIDER_JWT_ENV];
  }
  return env;
}

export interface LaunchedAdapter {
  readonly child: ChildProcess;
  readonly port: number;
  readonly baseUrl: string;
  readonly probeToken: string;
  readonly tokenState: ProviderTokenState;
  readonly preflight: PreflightReport;
  report<T = AdapterReport>(): Promise<T>;
  release(): Promise<ProviderTokenState>;
  close<T = AdapterReport>(): Promise<T>;
}

export class AdapterRefused extends Error {
  readonly code: string;
  readonly reason: string;
  constructor(code: string, reason: string) {
    super(`live-dry adapter refused to start: ${code} ${reason}`);
    this.code = code;
    this.reason = reason;
  }
}

function next(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`live-dry adapter exited ${code}`));
    };
    const onMessage = (m: unknown) => {
      const msg = m as Record<string, unknown>;
      if (msg['type'] === 'refused') {
        cleanup();
        reject(new AdapterRefused(String(msg['code']), String(msg['reason'])));
      } else if (msg['type'] === 'error') {
        cleanup();
        reject(new Error(`live-dry adapter error ${String(msg['code'])}`));
      } else if (msg['type'] === type) {
        cleanup();
        resolve(msg);
      }
    };
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

export async function launchLiveDryAdapter(input: {
  readonly credentialPolicy: CredentialPolicy;
  readonly passProviderJwt?: boolean;
  readonly maxProbes?: number;
  /** Token-list reads for the fidelity matrix; default 0 keeps the route denied. */
  readonly maxTokenListFetches?: number;
  readonly ledgerPath?: string | null;
  readonly limits?: Partial<EgressLimits>;
  /** Entry script; defaults to the production entry (main.ts). */
  readonly entry?: string;
  /** Child environment; defaults to `sanitizedAdapterEnv(process.env)`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Forwarded to a test entry only. */
  readonly test?: unknown;
}): Promise<LaunchedAdapter> {
  const entry = input.entry ?? fileURLToPath(new URL('./main.ts', import.meta.url));
  const env =
    input.env ?? sanitizedAdapterEnv(process.env, { passProviderJwt: input.passProviderJwt === true });
  const child = fork(entry, [], {
    execArgv: ['--no-warnings'],
    env,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  child.stderr?.resume();
  const ready = next(child, 'ready');
  child.send({
    type: 'start',
    credentialPolicy: input.credentialPolicy,
    maxProbes: input.maxProbes ?? 1,
    maxTokenListFetches: input.maxTokenListFetches ?? 0,
    ledgerPath: input.ledgerPath ?? null,
    limits: input.limits ?? {},
    test: input.test,
  });
  let msg: Record<string, unknown>;
  try {
    msg = await ready;
  } catch (error) {
    if (child.exitCode === null) child.kill();
    throw error;
  }
  const port = msg['port'] as number;
  return {
    child,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    probeToken: msg['probeToken'] as string,
    tokenState: msg['tokenState'] as ProviderTokenState,
    preflight: msg['preflight'] as PreflightReport,
    async report<T>() {
      const p = next(child, 'report');
      child.send({ type: 'report' });
      return (await p)['report'] as T;
    },
    async release() {
      const p = next(child, 'released');
      child.send({ type: 'release' });
      return (await p)['tokenState'] as ProviderTokenState;
    },
    async close<T>() {
      const p = next(child, 'closed');
      child.send({ type: 'close' });
      const out = (await p)['report'] as T;
      await new Promise<void>((resolve) =>
        child.exitCode !== null ? resolve() : child.once('exit', () => resolve()),
      );
      return out;
    },
  };
}
