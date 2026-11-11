/**
 * Operator command for the real RP-07 official dry probe. It contacts the official endpoint, so
 * it only runs on an explicit user action:
 *
 *   ROUTESPEC_PROVIDER_JWT=<your token>   (optional; set in your own shell, never on argv)
 *   pnpm --filter @routespec/live-dry-adapter probe:official -- \
 *     --confirm-official-endpoint --request <dry-quote.json> [--ledger <compat.sqlite>]
 *
 * The request file must be a quote request with `"dry": true`; the adapter denies anything else
 * before the credential, DNS or a socket. The adapter process reads the token from its own
 * environment after preflight; this command removes the variable from its own environment as
 * soon as the adapter has started. Output is the redacted compatibility record only (label,
 * reason, shape digest, HTTP status, timing, token state); no response value is printed.
 * No retry is made and no settlement is exercised.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROVIDER_JWT_ENV } from './credential.ts';
import { launchLiveDryAdapter } from './launch.ts';
import { PROBE_TOKEN_HEADER, type AdapterReport } from './server.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<number> {
  if (!process.argv.includes('--confirm-official-endpoint')) {
    process.stderr.write(
      'Refusing: this contacts the official 1Click endpoint. Re-run with --confirm-official-endpoint.\n',
    );
    return 2;
  }
  const requestPath = arg('--request');
  if (!requestPath) {
    process.stderr.write('Missing --request <dry-quote.json>.\n');
    return 2;
  }
  const request = JSON.parse(readFileSync(resolve(requestPath), 'utf8')) as Record<string, unknown>;
  const ledgerPath = arg('--ledger') ?? null;
  const adapter = await launchLiveDryAdapter({
    credentialPolicy: 'OPTIONAL',
    passProviderJwt: true,
    maxProbes: 1,
    ledgerPath: ledgerPath === null ? null : resolve(ledgerPath),
  });
  delete process.env[PROVIDER_JWT_ENV];
  try {
    const sdk = await import('@defuse-protocol/one-click-sdk-typescript');
    sdk.OpenAPI.BASE = adapter.baseUrl;
    sdk.OpenAPI.TOKEN = undefined;
    sdk.OpenAPI.HEADERS = { [PROBE_TOKEN_HEADER]: adapter.probeToken };
    let clientOutcome = 'RESOLVED';
    try {
      await sdk.OneClickService.getQuote(request as never);
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      clientOutcome = `REJECTED_HTTP_${typeof status === 'number' ? status : 'UNKNOWN'}`;
    }
    const report = await adapter.report<AdapterReport>();
    const result = report.lastResult;
    const summary = {
      clientOutcome,
      tokenStateAtStart: adapter.tokenState,
      transportKind: report.transportKind,
      policyDenials: report.inMemoryDenials.map((d) => `${d.code}:${d.reason}`),
      compatibility: result?.compatibility ?? 'DOCUMENTED_ONLY',
      reasonCode: result?.reasonCode ?? 'NO_REQUEST_FORWARDED',
      shapeResult: result?.shapeResult ?? 'NOT_JUDGED',
      httpStatus: result?.httpStatus ?? null,
      responseShapeDigest: result?.responseShapeDigest ?? null,
      responseAssignedAddress: result?.responseAssignedAddress ?? 'NOT_OBSERVED',
      timing: report.probes.at(-1)?.timing ?? null,
      settlementExercised: false,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return result?.compatibility === 'OFFICIAL_ENDPOINT_COMPATIBLE' ? 0 : 1;
  } finally {
    await adapter.close();
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    process.stderr.write('Probe failed before a result was recorded.\n');
    process.exit(1);
  },
);
