/**
 * Process body of the separately launched live-dry adapter (main.ts is the production entry).
 *
 * Launch preflight runs before the provider credential is read:
 * - refuses to start when TLS validation is disabled (`NODE_TLS_REJECT_UNAUTHORIZED=0`) or extra
 *   trust roots are configured (`NODE_EXTRA_CA_CERTS`), because both silently widen who the
 *   adapter would trust;
 * - removes and reports proxy environment variables (the egress never uses an agent, so they
 *   could not apply anyway; removing them keeps that true for any later code);
 * - checks the compiled protocol profile digest and the installed official SDK version against
 *   the pins, and compiles the pinned origin.
 * Only then is `ROUTESPEC_PROVIDER_JWT` read into the vault and deleted from the environment.
 *
 * IPC (JSON over the inherited channel only; nothing secret on argv):
 *   parent -> {type:'start', credentialPolicy, maxProbes, maxTokenListFetches?, ledgerPath, limits?,
 *              test?}
 *   child  -> {type:'ready', port, probeToken, tokenState, preflight} | {type:'refused', code, reason}
 *   parent -> {type:'report'} | {type:'release'} | {type:'close'}
 *   child  -> {type:'report', report} | {type:'released', tokenState} | {type:'closed', report}
 * When the parent disconnects the credential is released and the process exits.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ONECLICK_PROFILE, ONECLICK_SDK_PIN, RouteSpecError, isRouteSpecError } from '@routespec/contracts';
import { compileUpstreamOrigin } from './address-policy.ts';
import { ProviderCredentialVault, type CredentialPolicy } from './credential.ts';
import { DEFAULT_EGRESS_LIMITS, type EgressLimits, type EgressTransport } from './egress.ts';
import { CompatibilityLedger } from './ledger.ts';
import { LIVE_DRY_HARD_REQUEST_CAP, LiveDryAdapter } from './server.ts';

/** Profile integrity digest reviewed for this adapter revision; a profile change needs a re-pin. */
export const PINNED_PROFILE_INTEGRITY_DIGEST =
  'sha256:71e0c45dc0c4dbb775ff4271c78ddc17bfa56c1402654fd4c685deb52f4e3d05' as const;

export const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'GLOBAL_AGENT_HTTP_PROXY',
  'GLOBAL_AGENT_HTTPS_PROXY',
] as const;

export interface StartMessage {
  readonly type: 'start';
  readonly credentialPolicy: CredentialPolicy;
  readonly maxProbes?: number;
  readonly maxTokenListFetches?: number;
  readonly ledgerPath?: string | null;
  readonly limits?: Partial<EgressLimits>;
  /** Only read by test entries that inject a transport; the production entry ignores it. */
  readonly test?: unknown;
}

export interface PreflightReport {
  readonly ignoredProxyEnv: readonly string[];
  readonly profileIntegrityDigest: string;
  readonly sdkVersion: string;
  readonly origin: string;
}

function installedSdkVersion(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve(ONECLICK_SDK_PIN.packageName);
  const pkg = JSON.parse(readFileSync(join(dirname(dirname(entry)), 'package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

export function preflight(env: NodeJS.ProcessEnv): PreflightReport {
  if (env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0') {
    throw new RouteSpecError('RS_MODE_POLICY_DENIED', 'TLS validation is disabled for this process.', {
      details: { reason: 'TLS_VALIDATION_DISABLED' },
    });
  }
  if (env['NODE_EXTRA_CA_CERTS'] !== undefined) {
    throw new RouteSpecError('RS_MODE_POLICY_DENIED', 'Extra trust roots are configured for this process.', {
      details: { reason: 'EXTRA_TRUST_ROOTS_CONFIGURED' },
    });
  }
  const ignoredProxyEnv: string[] = [];
  for (const key of PROXY_ENV_KEYS) {
    if (env[key] !== undefined) {
      ignoredProxyEnv.push(key);
      delete env[key];
    }
  }
  if (ONECLICK_PROFILE.integrityDigest !== PINNED_PROFILE_INTEGRITY_DIGEST) {
    throw new RouteSpecError('RS_ADAPTER_MISMATCH', 'Protocol profile differs from the reviewed pin.', {
      details: { reason: 'PROFILE_DIGEST_MISMATCH' },
    });
  }
  const sdkVersion = installedSdkVersion();
  if (sdkVersion !== ONECLICK_SDK_PIN.version) {
    throw new RouteSpecError('RS_ADAPTER_MISMATCH', 'Installed official SDK differs from the pin.', {
      details: { reason: 'SDK_VERSION_MISMATCH' },
    });
  }
  const origin = compileUpstreamOrigin(ONECLICK_SDK_PIN.defaultBaseUrl).origin;
  return Object.freeze({
    ignoredProxyEnv,
    profileIntegrityDigest: ONECLICK_PROFILE.integrityDigest,
    sdkVersion,
    origin,
  });
}

type Send = (message: Record<string, unknown>) => void;

export interface RunOptions {
  /** Chooses the egress transport. The production entry always returns the system transport. */
  readonly transportFor: (start: StartMessage) => EgressTransport;
  /** Extra data a test entry adds to reports (for example its own network tripwire). */
  readonly extraReport?: () => Record<string, unknown>;
  readonly env?: NodeJS.ProcessEnv;
}

export function runAdapterProcess(options: RunOptions): void {
  const env = options.env ?? process.env;
  const send: Send = (message) => {
    if (process.connected) process.send?.(message);
  };
  let adapter: LiveDryAdapter | null = null;
  let vault: ProviderCredentialVault | null = null;
  let ledger: CompatibilityLedger | null = null;

  const report = () => ({
    ...(adapter ? adapter.report() : {}),
    tokenState: vault?.state() ?? 'NOT_REQUIRED',
    ...(options.extraReport ? options.extraReport() : {}),
  });

  const shutdown = async () => {
    vault?.release();
    await adapter?.close();
    ledger?.close();
  };

  process.on('disconnect', () => {
    void shutdown().finally(() => process.exit(0));
  });

  process.on('message', (raw: unknown) => {
    const msg = raw as Record<string, unknown>;
    void (async () => {
      try {
        if (msg['type'] === 'start' && adapter === null) {
          const start = msg as unknown as StartMessage;
          const policy: CredentialPolicy = start.credentialPolicy === 'OPTIONAL' ? 'OPTIONAL' : 'NONE';
          let pre: PreflightReport;
          try {
            pre = preflight(env);
          } catch (error) {
            delete env['ROUTESPEC_PROVIDER_JWT'];
            const safe = isRouteSpecError(error)
              ? error
              : new RouteSpecError('RS_INTERNAL', 'preflight failed');
            send({ type: 'refused', code: safe.code, reason: String(safe.details['reason'] ?? safe.code) });
            return;
          }
          vault = new ProviderCredentialVault(policy);
          try {
            vault.loadFromProtectedEnv(env);
          } catch (error) {
            const safe = isRouteSpecError(error) ? error : new RouteSpecError('RS_TOKEN_INVALID', 'invalid');
            send({ type: 'refused', code: safe.code, reason: 'PROVIDER_CREDENTIAL_INVALID' });
            return;
          }
          const maxProbes = typeof start.maxProbes === 'number' ? start.maxProbes : 1;
          const maxTokenListFetches =
            typeof start.maxTokenListFetches === 'number' ? start.maxTokenListFetches : 0;
          if (
            ![maxProbes, maxTokenListFetches].every((n) => Number.isInteger(n) && n >= 0) ||
            maxProbes + maxTokenListFetches > LIVE_DRY_HARD_REQUEST_CAP
          ) {
            vault.release();
            send({ type: 'refused', code: 'RS_MODE_POLICY_DENIED', reason: 'REQUEST_CAP_EXCEEDED' });
            return;
          }
          ledger = typeof start.ledgerPath === 'string' ? new CompatibilityLedger(start.ledgerPath) : null;
          adapter = new LiveDryAdapter({
            vault,
            transport: options.transportFor(start),
            ledger,
            maxProbes,
            maxTokenListFetches,
            limits: { ...DEFAULT_EGRESS_LIMITS, ...(start.limits ?? {}) },
          });
          const address = await adapter.listen();
          send({
            type: 'ready',
            port: address.port,
            address: { address: address.address, family: address.family },
            probeToken: adapter.probeToken,
            tokenState: vault.state(),
            preflight: pre,
          });
        } else if (msg['type'] === 'report') {
          send({ type: 'report', report: report() });
        } else if (msg['type'] === 'release') {
          vault?.release();
          send({ type: 'released', tokenState: vault?.state() ?? 'NOT_REQUIRED' });
        } else if (msg['type'] === 'close') {
          const final = report();
          await shutdown();
          send({ type: 'closed', report: final });
          process.disconnect?.();
          setTimeout(() => process.exit(0), 50).unref();
        }
      } catch {
        send({ type: 'error', code: 'RS_INTERNAL' });
      }
    })();
  });
}
