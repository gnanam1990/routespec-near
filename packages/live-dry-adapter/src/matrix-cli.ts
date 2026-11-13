/**
 * Operator command for the 1Click fidelity matrix (M51, ADR-0027). It contacts the official
 * endpoint, so it only runs on an explicit action:
 *
 *   ROUTESPEC_PROVIDER_JWT=<your token>   (optional; set in your own shell, never on argv)
 *   pnpm --filter @routespec/live-dry-adapter fidelity:matrix -- \
 *     --confirm-official-endpoint [--routes <1..39>] [--out-dir <dir>] [--baseline <file>] \
 *     [--pause-ms <0..5000>]
 *
 * One run reads the official token list once and sends one `dry: true` quote per selected route
 * (24 by default), never more than 40 upstream requests in total and never a retry. The adapter
 * process holds the token; this command removes the variable from its own environment as soon as
 * the adapter has started. Output is the redacted matrix only: routes, HTTP status, compatibility
 * label, reason and response shape digest. No quote value is printed or written.
 *
 * `--out-dir` receives `fidelity-matrix.md`, `fidelity-matrix.json` and `fidelity-badge.json`.
 * Exit code: 0 no drift (or a profile-compatible shape outside the baseline), 1 drift,
 * 2 usage error, 3 inconclusive.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_JWT_ENV } from './credential.ts';
import { launchLiveDryAdapter } from './launch.ts';
import { exitCodeFor, parseBaseline, renderBadge, renderMatrixMarkdown } from './matrix-report.ts';
import { adapterMatrixClient, clampRouteCount, runFidelityMatrix } from './matrix-run.ts';

const DEFAULT_BASELINE = fileURLToPath(new URL('../fidelity-baseline.json', import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function intArg(name: string, min: number, max: number): number | undefined | null {
  const raw = arg(name);
  if (raw === undefined) return process.argv.includes(name) ? null : undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

async function main(): Promise<number> {
  if (!process.argv.includes('--confirm-official-endpoint')) {
    process.stderr.write(
      'Refusing: this contacts the official 1Click endpoint. Re-run with --confirm-official-endpoint.\n',
    );
    return 2;
  }
  const routesArg = intArg('--routes', 1, 39);
  const pauseArg = intArg('--pause-ms', 0, 5000);
  if (routesArg === null || pauseArg === null) {
    process.stderr.write('Usage: --routes takes 1..39 and --pause-ms takes 0..5000.\n');
    return 2;
  }
  let baseline;
  try {
    baseline = parseBaseline(
      JSON.parse(readFileSync(resolve(arg('--baseline') ?? DEFAULT_BASELINE), 'utf8')),
    );
  } catch {
    process.stderr.write('The fidelity baseline file is missing or malformed.\n');
    return 2;
  }
  const routes = clampRouteCount(routesArg);
  const adapter = await launchLiveDryAdapter({
    credentialPolicy: 'OPTIONAL',
    passProviderJwt: true,
    maxProbes: routes,
    maxTokenListFetches: 1,
    ledgerPath: null,
  });
  delete process.env[PROVIDER_JWT_ENV];
  try {
    const sdk = await import('@defuse-protocol/one-click-sdk-typescript');
    const matrix = await runFidelityMatrix({
      client: adapterMatrixClient(adapter, sdk as never),
      baseline,
      routes,
      pauseMs: pauseArg ?? 250,
    });
    const markdown = renderMatrixMarkdown(matrix);
    const outDir = arg('--out-dir');
    if (outDir !== undefined) {
      const dir = resolve(outDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'fidelity-matrix.md'), markdown);
      writeFileSync(join(dir, 'fidelity-matrix.json'), `${JSON.stringify(matrix, null, 2)}\n`);
      writeFileSync(join(dir, 'fidelity-badge.json'), `${JSON.stringify(renderBadge(matrix))}\n`);
    }
    process.stdout.write(markdown);
    return exitCodeFor(matrix.verdict);
  } finally {
    await adapter.close();
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    process.stderr.write('The fidelity matrix run failed before a matrix was produced.\n');
    process.exit(3);
  },
);
