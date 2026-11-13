/**
 * Finish the built verify page for publishing (M49): write `config.json` from the environment
 * and the badge JSON of every configured network next to the page.
 *
 *   node --no-warnings apps/verify/scripts/site.ts --dist apps/verify/dist [--no-badges]
 *
 * Environment (all optional; empty means "keep the shipped value"):
 *   ROUTESPEC_REGISTRY_ACCOUNT          testnet registry account
 *   ROUTESPEC_MAINNET_REGISTRY_ACCOUNT  mainnet registry account
 *   ROUTESPEC_BADGE_PROJECT             project key of the badge and of the page default
 *   ROUTESPEC_BADGE_ATTESTERS           pinned attester keys, separated by spaces or commas
 *   ROUTESPEC_REGISTRY_CODE_HASHES      extra known registry code hashes, separated likewise
 *
 * Each badge is `badge/<network>.json`, written by `routespec certificate badge` for the
 * project's newest certificate with `--write-on-error`: an unreachable or missing registry gives
 * an "unverified" badge, never a stale or invented one. Nothing here holds or reads a secret.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type VerifyPageConfig } from '../src/config.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, '../../../packages/cli/bin/routespec.mjs');
const CHAIN_NETWORKS = new Set(['testnet', 'mainnet']);

function list(text: string | undefined): string[] {
  return (text ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function nonEmpty(text: string | undefined): string | null {
  return text === undefined || text.trim() === '' ? null : text.trim();
}

/** The shipped configuration with the environment applied, validated. */
export function configFromEnv(
  shipped: VerifyPageConfig,
  env: Readonly<Record<string, string | undefined>>,
): VerifyPageConfig {
  const networks: Record<string, VerifyPageConfig['networks'][string]> = { ...shipped.networks };
  const testnet = nonEmpty(env['ROUTESPEC_REGISTRY_ACCOUNT']);
  const mainnet = nonEmpty(env['ROUTESPEC_MAINNET_REGISTRY_ACCOUNT']);
  if (testnet !== null && networks['testnet'] !== undefined)
    networks['testnet'] = { ...networks['testnet'], registry: testnet };
  if (mainnet !== null && networks['mainnet'] !== undefined)
    networks['mainnet'] = { ...networks['mainnet'], registry: mainnet };
  const attesters = list(env['ROUTESPEC_BADGE_ATTESTERS']);
  return parseConfig({
    ...shipped,
    project: nonEmpty(env['ROUTESPEC_BADGE_PROJECT']) ?? shipped.project,
    networks,
    trustedAttesters: attesters.length > 0 ? [...new Set(attesters)] : shipped.trustedAttesters,
    knownCodeHashes: [
      ...new Set([...shipped.knownCodeHashes, ...list(env['ROUTESPEC_REGISTRY_CODE_HASHES'])]),
    ],
  });
}

/** The `certificate badge` arguments for one network, or null when the network has no registry. */
export function badgeArgs(config: VerifyPageConfig, network: string, out: string): string[] | null {
  const net = config.networks[network];
  if (net === undefined || net.registry === null || config.project === null) return null;
  return [
    'certificate',
    'badge',
    '--project-key',
    config.project,
    '--registry',
    net.registry,
    ...(CHAIN_NETWORKS.has(network) ? ['--network', network] : []),
    '--rpc',
    net.rpcUrl,
    ...config.knownCodeHashes.flatMap((h) => ['--known-code-hash', h]),
    ...config.trustedAttesters.flatMap((k) => ['--attester', k]),
    '--label',
    network === 'mainnet' ? 'RouteSpec' : `RouteSpec ${network}`,
    '--write-on-error',
    '--out',
    out,
  ];
}

function main(argv: readonly string[]): number {
  const at = argv.indexOf('--dist');
  if (at === -1 || argv[at + 1] === undefined) {
    process.stderr.write('usage: site.ts --dist <built page directory> [--no-badges]\n');
    return 4;
  }
  const dist = resolve(argv[at + 1] as string);
  const shipped = parseConfig(JSON.parse(readFileSync(join(dist, 'config.json'), 'utf8')));
  const config = configFromEnv(shipped, process.env);
  writeFileSync(join(dist, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const summary: Record<string, unknown> = { config: 'written' };
  if (!argv.includes('--no-badges')) {
    const badges = join(dist, 'badge');
    rmSync(badges, { recursive: true, force: true });
    mkdirSync(badges, { recursive: true });
    for (const network of Object.keys(config.networks)) {
      const out = join(badges, `${network}.json`);
      const args = badgeArgs(config, network, out);
      if (args === null) {
        summary[network] = 'no registry configured: no badge';
        continue;
      }
      const run = spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { encoding: 'utf8' });
      let status = 'unknown';
      try {
        status = String((JSON.parse(run.stdout) as { status?: unknown }).status);
      } catch {
        status = 'no result';
      }
      if (run.status !== 0) {
        process.stderr.write(
          `badge for ${network} failed (exit ${String(run.status)}): ${run.stdout.slice(0, 400)}\n`,
        );
        return run.status ?? 5;
      }
      summary[network] = status;
    }
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
