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
 * Deleting a variable from `process.env` does not remove it from the process's initial
 * environment block, which Linux keeps serving through `/proc/<pid>/environ` to the process
 * itself and to any same-user process (a subject included). The composite action therefore
 * removes these variables in the step shell before it starts Node (`withheldNames`, then
 * `export -n` and `exec`), and hands the values to the entry point over a pipe only, so they never
 * appear in any environment block of the action process (`parseLauncherWithheld`). In-process
 * withholding cannot protect against hostile code loaded into the same process: the values stay
 * in this process's memory for the leak scan.
 *
 * A provider secret present in an untrusted job is a workflow misconfiguration (GitHub does not
 * hand repository secrets to fork pull requests; `pull_request_target` would). It is withheld
 * like any other and reported as a finding; the gate still runs and reports its own decision.
 */
import { RouteSpecError } from '@routespec/contracts';
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
 * `env` is normally `process.env`. `launcherWithheld` holds the credentials the step shell already
 * removed before starting this process (see `parseLauncherWithheld`); they are recorded the same
 * way so findings and the leak scan do not depend on where a credential was removed.
 */
export function withholdSecrets(
  env: Record<string, string | undefined>,
  launcherWithheld: Readonly<Record<string, string>> = {},
): WithheldSecrets {
  const names = new Set<string>();
  const values: string[] = [];
  let provider = false;
  const record = (name: string, v: string | undefined): void => {
    if (typeof v === 'string' && v.length >= 8 && !values.includes(v)) values.push(v);
    names.add(name);
    if (PROVIDER_SECRET.test(name) && v !== undefined && v !== '') provider = true;
  };
  for (const [name, v] of Object.entries(launcherWithheld)) {
    if (isWithheldName(name)) record(name, v);
  }
  for (const name of Object.keys(env)) {
    if (!isWithheldName(name)) continue;
    record(name, env[name]);
    delete env[name];
  }
  return { names: [...names].sort(), providerSecretPresent: provider, values };
}

/** Names in `env` the step shell must remove before it starts the entry point. */
export function withheldNames(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(env)
    .filter((name) => isWithheldName(name) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .sort();
}

/**
 * Parse what the step shell handed over on the withheld-credentials pipe: `NAME=VALUE` entries,
 * each terminated by a NUL byte. Only withheld names are accepted; anything else fails closed.
 */
export function parseLauncherWithheld(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = Buffer.from(bytes).toString('utf8');
  if (text === '') return out;
  if (!text.endsWith('\0')) {
    throw new RouteSpecError('RS_INTERNAL', 'The withheld-credentials handoff is malformed.');
  }
  for (const entry of text.slice(0, -1).split('\0')) {
    const eq = entry.indexOf('=');
    const name = eq > 0 ? entry.slice(0, eq) : '';
    if (!isWithheldName(name) || name in out) {
      throw new RouteSpecError('RS_INTERNAL', 'The withheld-credentials handoff is malformed.');
    }
    out[name] = entry.slice(eq + 1);
  }
  return out;
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
