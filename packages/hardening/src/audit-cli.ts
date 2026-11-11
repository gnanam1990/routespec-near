/**
 * `pnpm run audit:supply-chain`: offline license and install-script review of the locked
 * dependency graph. Prints one JSON report on stdout. Exit 0 = no unreviewed finding, 1 =
 * unreviewed license or an install script pnpm is allowed to run, 2 = audit error.
 */
import { auditSupplyChain } from './supply-chain.ts';

try {
  const report = auditSupplyChain(process.cwd());
  const runnable = report.installScripts.filter((s) => s.allowedToRun);
  const failed =
    report.licenseFindings.length > 0 || runnable.length > 0 || report.missingManifests.length > 0;
  process.stdout.write(`${JSON.stringify({ ...report, verdict: failed ? 'FINDINGS' : 'CLEAN' }, null, 2)}\n`);
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  process.stderr.write(`audit:supply-chain: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
