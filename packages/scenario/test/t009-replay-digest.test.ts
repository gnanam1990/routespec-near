/**
 * T-009 — Canonical replay digest is deterministic.
 *
 * Covers FR-06, NFR-01, INV-09. The same exact identity, compiled scenario revision, seed, and
 * canonical client interaction produce the same digest on repeated runs and in a separately
 * spawned Node.js process; the digest matches a committed golden vector. Changing any mandatory
 * identity field (one at a time) changes the digest; a mismatched scenario revision or seed,
 * or a missing identity field, is rejected. Run-envelope (host/time) data cannot enter it.
 *
 * Scope: win32/x64 only in this stage. The cross-OS half of T-009 (Linux, macOS) is NOT_RUN.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { digestValue } from '@routespec/contracts';
import { ScenarioRuntime, canonicalReplayDigest } from '../src/index.ts';
import { REPLAY_COMPILED, replayExchanges, replayIdentity } from './support/replay-fixture.ts';

const golden = JSON.parse(readFileSync(new URL('./vectors/t009-golden.json', import.meta.url), 'utf8')) as {
  replayDigest: string;
  eventLogDigest: string;
};

function depositAddress(): string {
  const probe = new ScenarioRuntime(REPLAY_COMPILED.plan);
  const d = probe.commit(probe.planRequest(replayExchanges('unused')[0]!.request));
  return String(d.quoteResponse?.quote['depositAddress']);
}

function digestFor(identity: unknown): string {
  return canonicalReplayDigest(identity, REPLAY_COMPILED, replayExchanges(depositAddress())).digest;
}

describe('T-009 — Canonical replay digest is deterministic', () => {
  it('is identical across repeated runs in one process and equals the golden vector', () => {
    const digests = Array.from({ length: 10 }, () => digestFor(replayIdentity()));
    expect(new Set(digests).size).toBe(1);
    expect(digests[0]).toBe(golden.replayDigest);
    const result = canonicalReplayDigest(
      replayIdentity(),
      REPLAY_COMPILED,
      replayExchanges(depositAddress()),
    );
    expect(result.summary.eventLogDigest).toBe(golden.eventLogDigest);
  });

  it('is identical when recomputed in a separately spawned Node.js process', () => {
    const child = fileURLToPath(new URL('./support/replay-child.ts', import.meta.url));
    for (let i = 0; i < 2; i++) {
      const out = spawnSync(process.execPath, ['--no-warnings', child], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(out.status).toBe(0);
      const parsed = JSON.parse(out.stdout.trim()) as { digest: string; events: string };
      expect(parsed.digest).toBe(golden.replayDigest);
      expect(parsed.events).toBe(golden.eventLogDigest);
    }
  });

  it('changes when any mandatory identity field changes', () => {
    const base = replayIdentity();
    const baseline = digestFor(base);
    const alt = (label: string) => digestValue('routespec.test.digest/1', `changed-${label}`);
    const changes: Record<string, unknown> = {
      projectRevisionId: 'integration-revision-2',
      buildRevisionId: 'build-revision-2',
      artifactDigest: alt('artifact'),
      buildAttestationClass: 'CI_ATTESTED',
      buildAttestationId: 'attestation-1',
      gateRunId: 'gate-run-2',
      caseRunId: 'case-run-2',
      runOperationLineage: [{ relation: 'REPLAY_OF', runOperationId: 'op-0' }],
      adapterRevision: 'routespec-adapter@1.0.1',
      protocolProfileId: 'oneclick-v0@1.0.1',
      evaluatorRevision: 'routespec-kernel@1.0.1',
      effectCoveragePolicyDigest: alt('policy'),
      effectManifestDigest: alt('manifest'),
      callsiteInventoryDigest: alt('inventory'),
      interceptorProfileDigest: alt('interceptor'),
      configurationDigest: alt('configuration'),
      fencingEpoch: 2,
    };
    const seen = new Set([baseline]);
    for (const [field, value] of Object.entries(changes)) {
      const d = digestFor({ ...base, [field]: value });
      expect(d, field).not.toBe(baseline);
      seen.add(d);
    }
    expect(seen.size).toBe(Object.keys(changes).length + 1);
  });

  it('changes when the canonical client interaction changes', () => {
    const dep = depositAddress();
    const baseline = canonicalReplayDigest(replayIdentity(), REPLAY_COMPILED, replayExchanges(dep)).digest;
    const fewer = canonicalReplayDigest(
      replayIdentity(),
      REPLAY_COMPILED,
      replayExchanges(dep).slice(0, 4),
    ).digest;
    const denied = replayExchanges(dep);
    denied[2] = { ...denied[2]!, deniedWith: 'RS_TOKEN_REVOKED' };
    expect(fewer).not.toBe(baseline);
    expect(canonicalReplayDigest(replayIdentity(), REPLAY_COMPILED, denied).digest).not.toBe(baseline);
  });

  it('rejects reuse with a different scenario revision, seed, missing field, or envelope data', () => {
    const base = replayIdentity();
    const code = (identity: unknown) => {
      try {
        digestFor(identity);
        return 'NO_ERROR';
      } catch (error) {
        return (error as { code: string }).code;
      }
    };
    expect(code({ ...base, scenarioRevisionDigest: digestValue('routespec.test.digest/1', 'other') })).toBe(
      'RS_IDENTITY_MISMATCH',
    );
    expect(code({ ...base, seed: 'another-seed' })).toBe('RS_IDENTITY_MISMATCH');
    const { fencingEpoch: _omitted, ...missing } = base;
    expect(code(missing)).toBe('RS_SCHEMA_INVALID');
    expect(code({ ...base, hostName: 'build-agent-7', wallClockStartedAt: '2026-11-11T00:00:00Z' })).toBe(
      'RS_SCHEMA_INVALID',
    );
  });
});
