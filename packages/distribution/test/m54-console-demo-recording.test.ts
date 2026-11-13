/**
 * M54: the committed console demo recording is the record of a real contained run, and it can be
 * checked without trusting the recorder:
 *
 * - snapshot and bundle match the digests in `provenance.json`;
 * - the bundle verifies offline with the product's own verifier, PASS, and it is the bundle the
 *   snapshot names;
 * - the snapshot's corrected gate run is the bundle's gate run, contained and PASS, and the
 *   recorded records say so (trusted launcher attestation, independent boundary coverage);
 * - the snapshot carries no control token and no path of the machine that recorded it.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { verifyBundle } from '@routespec/runner';
import { checkRecording } from '../src/console-demo/build.ts';
import { DEMO_DIR } from '../src/console-demo/record.ts';
import { ROOT } from '../src/npm-package.ts';

type J = Record<string, unknown>;
const text = readFileSync(join(DEMO_DIR, 'snapshot.json'), 'utf8');
const snapshot = JSON.parse(text) as {
  schema: string;
  source: J;
  responses: Record<string, { status: number; body: J }>;
};
const provenance = JSON.parse(readFileSync(join(DEMO_DIR, 'provenance.json'), 'utf8')) as J;
const extract = mkdtempSync(join(tmpdir(), 'routespec-m54-demo-verify-'));
afterAll(() => rmSync(extract, { recursive: true, force: true }));

describe('M54 console demo recording', () => {
  it('matches its provenance record', () => {
    expect(() => checkRecording()).not.toThrow();
    expect(snapshot.schema).toBe('routespec.console-demo/1');
    expect(snapshot.source['bundleDigest']).toBe((provenance['bundle'] as J)['digest']);
    expect((provenance['run'] as J)['commit']).toBe(snapshot.source['commit']);
    expect(((provenance['run'] as J)['containment'] as J)['mode']).toBe('CONTAINED');
    expect(snapshot.source['containment']).toBe('CONTAINED');
  });

  it('carries a bundle that verifies offline as PASS for the recorded corrected gate run', () => {
    const v = verifyBundle(join(DEMO_DIR, 'evidence-bundle.tar'), join(extract, 'bundle'));
    expect(v.verified).toBe(true);
    expect(v.decision).toBe('PASS');
    expect(v.bundleDigest).toBe(snapshot.source['bundleDigest']);
    const manifest = JSON.parse(readFileSync(join(extract, 'bundle', 'manifest.json'), 'utf8')) as J;
    expect(JSON.stringify(manifest)).toContain(snapshot.source['correctedGateRunId'] as string);
  });

  it('records the corrected gate run as contained, attested and PASS', () => {
    const id = snapshot.source['correctedGateRunId'] as string;
    expect(snapshot.source['correctedDecision']).toBe('PASS');
    const run = snapshot.responses[`GET /gate-runs/${id}`];
    expect(run?.status).toBe(200);
    const body = JSON.stringify(run?.body);
    expect(body).toContain('PASS');
    const matrix = Object.entries(snapshot.responses).find(([k]) => k.endsWith('/matrix'))?.[1];
    const m = JSON.stringify(matrix?.body);
    expect(m).toContain('TRUSTED_LAUNCHER');
    expect(m).toContain('INDEPENDENT_BOUNDARY_INTERCEPT');
    // The recording also holds the judge-visible FAIL case (hedging build, INV-03).
    expect(m).toContain('FAIL');
  });

  it('holds only GET responses and no machine-specific value', () => {
    expect(Object.keys(snapshot.responses).every((k) => k.startsWith('GET /'))).toBe(true);
    for (const needle of [ROOT, ROOT.replace(/\\/g, '/'), homedir(), homedir().replace(/\\/g, '/')]) {
      expect(text.includes(needle)).toBe(false);
    }
    expect(text).not.toMatch(/#token=|[A-Za-z]:\\\\Users\\\\|\/home\/[a-z]/);
    expect(createHash('sha256').update(text).digest('hex')).toBe(
      (provenance['snapshotDigest'] as string).slice('sha256:'.length),
    );
  });
});
