/**
 * T-027 — Cross-platform canonical result ignores run envelope.
 * Covers NFR-01, NFR-10 (owned by M00).
 *
 * The canonical result digest must retain every mandatory build/gate/case/run/effect/epoch
 * identity while excluding only the declared run envelope (wall time, host, platform, local
 * paths, display labels), and must not depend on platform enumeration order.
 *
 * Cross-OS execution: this suite runs on whichever OS executes it and compares against the
 * committed golden digest in vectors/t027-golden.json. Equality on macOS/Linux/Windows is
 * established only when the suite is actually run on each OS (see BUILD-STATUS.md).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildCaseResultRecord,
  computeCanonicalResultDigest,
  isRouteSpecError,
  RouteSpecError,
} from '../src/index.ts';
import {
  canonicalResultFixture,
  darwinEnvelope,
  digestFor,
  linuxEnvelope,
  reverseKeyOrder,
  uuidFor,
  windowsEnvelope,
} from './fixtures.ts';

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('./vectors/t027-golden.json', import.meta.url)), 'utf8'),
) as { resultDigest: string };

/** Mandatory identity fields and a replacement value for each (one-at-a-time mutation). */
const MANDATORY_IDENTITY: Array<[string, unknown]> = [
  ['projectId', uuidFor('project-2')],
  ['integrationRevisionId', uuidFor('integration-revision-2')],
  ['buildRevisionId', uuidFor('build-2')],
  ['artifactDigest', digestFor('artifact-2')],
  ['buildAttestationClass', 'TRUSTED_LAUNCHER'],
  ['buildAttestationId', uuidFor('attestation')],
  ['caseLaunchAttestationId', uuidFor('case-launch')],
  ['gateRunId', uuidFor('gate-run-2')],
  ['caseRunId', uuidFor('case-run-2')],
  ['sessionId', uuidFor('session-2')],
  ['corpusRevisionId', uuidFor('corpus-2')],
  ['scenarioRevisionId', uuidFor('scenario-2')],
  ['seed', 'seed-0002'],
  ['protocolProfileId', 'oneclick-v0@1.0.1'],
  ['adapterRevision', 'sdk-adapter@1.0.1'],
  ['evaluatorRevision', 'kernel@1.0.1'],
  ['configurationDigest', digestFor('configuration-2')],
  ['effectCoveragePolicyDigest', digestFor('effect-policy-2')],
  ['effectManifestDigest', digestFor('effect-manifest-2')],
  ['callsiteInventoryDigest', digestFor('inventory')],
  ['interceptorInstanceId', uuidFor('interceptor-2')],
  ['fencingEpoch', 3],
  ['verdict', 'FAIL'],
];

describe('T-027 — Cross-platform canonical result ignores run envelope', () => {
  it('produces one canonical digest for Windows, Linux, and macOS envelopes', () => {
    const canonical = canonicalResultFixture();
    const win = buildCaseResultRecord(canonical, windowsEnvelope());
    const lin = buildCaseResultRecord(canonical, linuxEnvelope());
    const mac = buildCaseResultRecord(canonical, darwinEnvelope());
    expect(lin.resultDigest).toBe(win.resultDigest);
    expect(mac.resultDigest).toBe(win.resultDigest);
    // The envelope is still retained and separately digested: it differs, identity does not.
    expect(lin.envelopeDigest).not.toBe(win.envelopeDigest);
    expect(mac.envelopeDigest).not.toBe(lin.envelopeDigest);
    expect(win.envelope.hostName).toBe('WIN-BUILD-07');
  });

  it('matches the committed golden digest on this platform', () => {
    const record = buildCaseResultRecord(canonicalResultFixture(), windowsEnvelope());
    expect(record.resultDigest).toBe(golden.resultDigest);
    expect(computeCanonicalResultDigest(canonicalResultFixture())).toBe(golden.resultDigest);
  });

  it('is independent of object key order and platform enumeration order of collections', () => {
    const base = canonicalResultFixture();
    const reordered = reverseKeyOrder(base) as Record<string, unknown>;
    for (const key of ['exchanges', 'facts', 'invariantResults', 'runOperations']) {
      reordered[key] = [...(reordered[key] as unknown[])].reverse();
    }
    expect(computeCanonicalResultDigest(reordered)).toBe(computeCanonicalResultDigest(base));
  });

  it('ignores arbitrary envelope contents (property)', () => {
    const canonical = canonicalResultFixture();
    const expected = computeCanonicalResultDigest(canonical);
    const text = fc.string({ maxLength: 40 });
    fc.assert(
      fc.property(
        fc.record({
          schemaVersion: fc.constant('1.0' as const),
          wallClockStartedAt: text,
          wallClockEndedAt: fc.option(text, { nil: null }),
          hostName: text,
          platform: fc.constantFrom('win32', 'linux', 'darwin'),
          arch: fc.constantFrom('x64', 'arm64'),
          runtimeVersion: text,
          dataDirectory: text,
          workingDirectory: text,
          artifactPaths: fc.array(text, { maxLength: 4 }),
          displayLabels: fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), text, { maxKeys: 3 }),
        }),
        (envelope) => buildCaseResultRecord(canonical, envelope).resultDigest === expected,
      ),
      { numRuns: 200 },
    );
  });

  it('changes the digest when any single mandatory identity changes', () => {
    const base = computeCanonicalResultDigest(canonicalResultFixture());
    const seen = new Set([base]);
    for (const [field, replacement] of MANDATORY_IDENTITY) {
      const mutated = { ...canonicalResultFixture(), [field]: replacement };
      const digest = computeCanonicalResultDigest(mutated);
      expect(digest, `field ${field} must be part of canonical identity`).not.toBe(base);
      seen.add(digest);
    }
    expect(seen.size).toBe(MANDATORY_IDENTITY.length + 1);
  });

  it('changes the digest when run-operation lineage, exchanges, or facts change', () => {
    const base = computeCanonicalResultDigest(canonicalResultFixture());
    const lineage = canonicalResultFixture();
    (lineage['runOperations'] as Array<{ lineage: unknown[] }>)[1]!.lineage.pop();
    expect(computeCanonicalResultDigest(lineage)).not.toBe(base);
    const exchange = canonicalResultFixture();
    (exchange['exchanges'] as Array<{ requestDigest: string }>)[0]!.requestDigest = digestFor('changed');
    expect(computeCanonicalResultDigest(exchange)).not.toBe(base);
    const fact = canonicalResultFixture();
    (fact['facts'] as Array<{ evidenceClass: string }>)[0]!.evidenceClass = 'PROVEN';
    expect(computeCanonicalResultDigest(fact)).not.toBe(base);
  });

  it('rejects envelope fields smuggled into the canonical part', () => {
    for (const smuggled of [
      { hostName: 'WIN-BUILD-07' },
      { wallClockStartedAt: '2026-11-11T10:00:00.000Z' },
      { dataDirectory: 'C:\\Users\\dev' },
      { displayLabels: { project: 'x' } },
    ]) {
      let caught: unknown;
      try {
        computeCanonicalResultDigest({ ...canonicalResultFixture(), ...smuggled });
      } catch (error) {
        caught = error;
      }
      expect(isRouteSpecError(caught, 'RS_SCHEMA_INVALID')).toBe(true);
    }
  });

  it('rejects a canonical result missing a mandatory identity', () => {
    const { buildRevisionId: _omitted, ...missing } = canonicalResultFixture();
    expect(() => computeCanonicalResultDigest(missing)).toThrow(RouteSpecError);
  });

  it('rejects duplicate journal sequences instead of guessing an order', () => {
    const dup = canonicalResultFixture();
    const facts = dup['facts'] as Array<{ sequence: number }>;
    facts[1]!.sequence = facts[0]!.sequence;
    expect(() => computeCanonicalResultDigest(dup)).toThrow(/Duplicate sequence/);
  });
});
