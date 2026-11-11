/**
 * T-053 — Redacted bundle verifies after clean extraction. Covers FR-18.
 *
 * A real gate evaluation is exported through `export plan` and `export write` (explicit plan
 * digest confirmation and output path). A separate CLI process with a different working
 * directory, a different home directory, and no access to the journal extracts the bundle into
 * a disposable directory and verifies manifest, checksums, identity and decision parity across
 * formats, a fresh secret scan, declared exclusions, the absence of run envelopes and
 * author-machine paths, and that no signature is claimed. A tampered or unsafe archive fails.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DECLARED_EXCLUSIONS, readTar, writeTar } from '@routespec/runner';
import {
  runCliProcess,
  runGateWithSubjects,
  setupJournal,
  tempDir,
  type Journal,
} from './support/product.ts';

let tmp: ReturnType<typeof tempDir>;
let elsewhere: ReturnType<typeof tempDir>;
let j: Journal;
let bundle = '';
let gateEvaluationId = '';
let outputDigest = '';

beforeAll(async () => {
  tmp = tempDir();
  elsewhere = tempDir('routespec-m06-clean-');
  j = setupJournal(tmp.dir, {
    scenarios: ['happy-path', 'refund-shortfall'],
    build: 'reconciling-client',
    label: 't053',
  });
  const r = await runGateWithSubjects(j);
  expect(r.exitCode).toBe(2);
  gateEvaluationId = (r.json?.['report'] as { gateEvaluationId: string }).gateEvaluationId;
  const plan = await runCliProcess([
    'export',
    'plan',
    '--data',
    tmp.dir,
    '--gate-evaluation',
    gateEvaluationId,
  ]);
  expect(plan.exitCode, plan.stderr).toBe(0);
  bundle = join(tmp.dir, 'evidence.tar');
  const w = await runCliProcess([
    'export',
    'write',
    '--data',
    tmp.dir,
    '--export',
    String(plan.json?.['exportId']),
    '--out',
    bundle,
    '--confirm',
    String(plan.json?.['confirm']),
  ]);
  expect(w.exitCode, w.stderr).toBe(0);
  outputDigest = String(w.json?.['outputDigest']);
});

afterAll(() => {
  tmp?.cleanup();
  elsewhere?.cleanup();
});

function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env['ROUTESPEC_DATA_DIR'];
  env['HOME'] = elsewhere.dir;
  env['USERPROFILE'] = elsewhere.dir;
  return env;
}

describe('T-053 — Redacted bundle verifies after clean extraction', () => {
  it('a clean process without the journal extracts and verifies the bundle', async () => {
    // Copy the bundle bytes away from the author's data directory first.
    const copy = join(elsewhere.dir, 'received.tar');
    writeFileSync(copy, readFileSync(bundle));
    const extract = join(elsewhere.dir, 'extracted');
    const r = await runCliProcess(['export', 'verify', '--bundle', copy, '--extract-to', extract], {
      cwd: elsewhere.dir,
      env: cleanEnv(),
    });
    expect(r.exitCode, r.stdout).toBe(0);
    const v = r.json as {
      verified: boolean;
      bundleDigest: string;
      gateEvaluationId: string;
      decision: string;
      checks: Array<{ name: string; ok: boolean }>;
    };
    expect(v.verified).toBe(true);
    expect(v.bundleDigest).toBe(outputDigest);
    expect(v.gateEvaluationId).toBe(gateEvaluationId);
    expect(v.decision).toBe('FAIL');
    expect(v.checks.map((c) => c.name).sort()).toEqual(
      [
        'checksums',
        'count-parity',
        'decision-parity',
        'entry-digests',
        'exclusions-declared',
        'extraction-contained',
        'identity-parity',
        'manifest-present',
        'no-run-envelopes',
        'no-signature-claim',
        'no-undeclared-files',
        'sarif-locations-real',
        'secret-rescan',
      ].sort(),
    );
    expect(v.checks.every((c) => c.ok)).toBe(true);

    // Inspect the extracted copy directly.
    const manifest = JSON.parse(readFileSync(join(extract, 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest['identity']).toMatchObject({
      buildRevisionId: j.buildRevisionId,
      artifactDigest: j.artifactDigest,
      corpusRevisionId: j.corpusRevisionId,
    });
    expect(manifest['exclusions']).toEqual(DECLARED_EXCLUSIONS);
    expect(manifest['signature']).toBeNull();
    expect(manifest['artifactReadiness']).toBe('RECORDED_OUTSIDE_BUNDLE');
    expect(manifest['enforcement']).toMatchObject({ verified: false, blocking: false });
    const all: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir, { withFileTypes: true })) {
        if (n.isDirectory()) walk(join(dir, n.name));
        else all.push(readFileSync(join(dir, n.name), 'utf8'));
      }
    };
    walk(extract);
    const text = all.join('\n');
    for (const marker of [
      tmp.dir,
      tmp.dir.replace(/\\/g, '/'),
      tmp.dir.replace(/\\/g, '\\\\'),
      homedir(),
      tmpdir(),
      hostname(),
    ]) {
      expect(text.toLowerCase().includes(marker.toLowerCase()), marker).toBe(false);
    }
    expect(text).not.toMatch(/wallClockStartedAt|workingDirectory|dataDirectory|hostName/);
    expect(text).not.toMatch(/rsct_[A-Za-z0-9_-]{20,}/);
    // Addresses are masked by default.
    expect(text).not.toContain('recipient.sim');
    expect(text).toContain('recipientDigest');
  });

  it('a tampered byte fails verification (exit 5)', async () => {
    const bytes = readFileSync(bundle);
    const entries = readTar(bytes);
    const tampered = entries.map((e) =>
      e.path === 'reports/gate-report.json'
        ? { path: e.path, content: Buffer.from(e.content.toString('utf8').replace('"FAIL"', '"PASS"')) }
        : e,
    );
    const file = join(elsewhere.dir, 'tampered.tar');
    writeFileSync(file, writeTar(tampered));
    const r = await runCliProcess(
      ['export', 'verify', '--bundle', file, '--extract-to', join(elsewhere.dir, 'x1')],
      { env: cleanEnv() },
    );
    expect(r.exitCode).toBe(5);
    const v = r.json as { verified: boolean; checks: Array<{ name: string; ok: boolean }> };
    expect(v.verified).toBe(false);
    expect(v.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(
      expect.arrayContaining(['entry-digests', 'checksums', 'decision-parity']),
    );
  });

  it('unsafe archive entries and a non-empty extraction target are refused', async () => {
    const good = readFileSync(bundle);
    const traversal = Buffer.from(good);
    // Rename the first entry header to a parent-directory path (checksum then also fails closed).
    traversal.write('../escape.json\0', 0, 'ascii');
    const file = join(elsewhere.dir, 'traversal.tar');
    writeFileSync(file, traversal);
    const r = await runCliProcess(
      ['export', 'verify', '--bundle', file, '--extract-to', join(elsewhere.dir, 'x2')],
      { env: cleanEnv() },
    );
    expect(r.exitCode).toBe(5);
    expect((r.json?.['error'] as { code: string }).code).toBe('RS_BUNDLE_VERIFY_FAILED');
    expect(readdirSync(elsewhere.dir)).not.toContain('escape.json');
    expect(() => writeTar([{ path: '../escape.json', content: Buffer.from('{}') }])).toThrow();
    expect(() => writeTar([{ path: 'C:/abs.json', content: Buffer.from('{}') }])).toThrow();
    const busy = join(elsewhere.dir, 'busy');
    mkdirSync(busy);
    writeFileSync(join(busy, 'keep.txt'), 'x');
    const b = await runCliProcess(['export', 'verify', '--bundle', bundle, '--extract-to', busy], {
      env: cleanEnv(),
    });
    expect(b.exitCode).toBe(4);
    expect((b.json?.['error'] as { code: string }).code).toBe('RS_EXPORT_PATH_INVALID');
  });
});
