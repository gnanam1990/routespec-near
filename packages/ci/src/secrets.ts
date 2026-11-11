/**
 * Secret withholding for CI jobs (FR-17, NFR-03, INV-11; T-058).
 *
 * The gate action never forwards provider credentials or CI runtime credentials to anything it
 * starts or loads: the RouteSpec CLI child, the configured client module, or the subject
 * processes that module launches. At startup the action removes them from its own process
 * environment (so a client module cannot read them either) and keeps the values only in memory
 * for one purpose: scanning upload candidates for exact leaks. The values are never printed,
 * written, or passed as arguments.
 *
 * A provider secret present in an untrusted job is a workflow misconfiguration (GitHub does not
 * hand repository secrets to fork pull requests; `pull_request_target` would). It is withheld
 * like any other and reported as a finding; the gate still runs and reports its own decision.
 */
import type { CiContext } from './context.ts';
import { isTrusted } from './context.ts';

/** Provider credentials: only the separately launched live-dry adapter may ever use these. */
const PROVIDER_SECRET =
  /^(?:ROUTESPEC_PROVIDER_[A-Z0-9_]+|ONECLICK_[A-Z0-9_]*(?:JWT|TOKEN|KEY|SECRET)[A-Z0-9_]*)$/;

/** CI runtime credentials the gate never needs. */
const CI_CREDENTIAL =
  /^(?:GITHUB_TOKEN|GH_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN|ACTIONS_ID_TOKEN_REQUEST_URL|ACTIONS_RESULTS_URL|ACTIONS_RUNTIME_URL|ACTIONS_CACHE_URL|NPM_TOKEN|NODE_AUTH_TOKEN|INPUT_[A-Z0-9_]*(?:TOKEN|SECRET|JWT|PASSWORD|KEY))$/;

/** Variables that would let a child process change how it loads code or reaches the network. */
const PROCESS_STEERING = /^(?:NODE_OPTIONS|HTTPS?_PROXY|https?_proxy|ALL_PROXY|all_proxy|NO_PROXY|no_proxy)$/;

export interface WithheldSecrets {
  /** Names only, sorted. */
  readonly names: readonly string[];
  readonly providerSecretPresent: boolean;
  /** In-memory values for leak scanning. Never logged or persisted. */
  readonly values: readonly string[];
}

/**
 * Remove provider and CI credentials from `env` in place and return what was withheld.
 * `env` is normally `process.env`.
 */
export function withholdSecrets(env: Record<string, string | undefined>): WithheldSecrets {
  const names: string[] = [];
  const values: string[] = [];
  let provider = false;
  for (const name of Object.keys(env)) {
    const isProvider = PROVIDER_SECRET.test(name);
    if (!isProvider && !CI_CREDENTIAL.test(name)) continue;
    const v = env[name];
    if (typeof v === 'string' && v.length >= 8) values.push(v);
    delete env[name];
    names.push(name);
    if (isProvider && v !== undefined && v !== '') provider = true;
  }
  return { names: names.sort(), providerSecretPresent: provider, values };
}

/** The finding for a withheld provider secret, by job trust. */
export function secretFindings(withheld: WithheldSecrets, ctx: CiContext): string[] {
  if (!withheld.providerSecretPresent) return [];
  return [isTrusted(ctx) ? 'PROVIDER_SECRET_WITHHELD' : 'PROVIDER_SECRET_PRESENT_IN_UNTRUSTED_JOB'];
}

/** Environment for a child the action starts: no credentials, no loader or proxy steering. */
export function childEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (PROVIDER_SECRET.test(k) || CI_CREDENTIAL.test(k) || PROCESS_STEERING.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export function isWithheldName(name: string): boolean {
  return PROVIDER_SECRET.test(name) || CI_CREDENTIAL.test(name);
}
