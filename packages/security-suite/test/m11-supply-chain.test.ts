/**
 * M11 supply-chain review (deliverable 5, NFR-11). Supplementary module test; it claims no
 * canonical test ID. It reads the committed lockfile and the installed manifests only; no
 * registry is contacted and no package script is run.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { auditSupplyChain, licenseAccepted } from '@routespec/hardening';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('M11 — supply-chain review of the locked dependency graph', () => {
  const report = auditSupplyChain(ROOT);

  it('the toolchain is pinned exactly and every locked package for this platform is installed', () => {
    expect(report.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(report.nodeEngine).toBe('>=22.18.0');
    expect(report.lockedPackages).toBeGreaterThan(100);
    expect(report.missingManifests).toEqual([]);
    expect(report.inspectedPackages + report.otherPlatformPackages).toBe(report.lockedPackages);
  });

  it('every declared license is on the reviewed allowlist or a recorded exception', () => {
    expect(report.licenseFindings).toEqual([]);
    expect(licenseAccepted('(MIT OR GPL-3.0)')).toBe(true);
    expect(licenseAccepted('GPL-3.0')).toBe(false);
    expect(licenseAccepted(null)).toBe(false);
  });

  it('no install-time script is allowed to run; declared ones are listed for review', () => {
    expect(report.allowedBuilds).toEqual([]);
    expect(report.installScripts.filter((s) => s.allowedToRun)).toEqual([]);
    // pnpm recorded that it did not run them.
    const modules = readFileSync(`${ROOT}node_modules/.modules.yaml`, 'utf8');
    for (const s of report.installScripts) expect(modules).toContain(s.pkg);
  });
});
