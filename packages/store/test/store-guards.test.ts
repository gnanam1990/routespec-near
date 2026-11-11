/**
 * M01 supplementary tests: repository-boundary secret guards, token-digest-only storage,
 * database-enforced lifecycle state machine, and mandatory identity foreign keys.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertNoSecrets, type RouteSpecStore } from '../src/index.ts';
import {
  ManualClock,
  codeOf,
  createGate,
  openStore,
  quoteAndFinalize,
  quoteRequest,
  startCase,
  tempDir,
} from './support/fixture.ts';

let tmp: ReturnType<typeof tempDir>;
let store: RouteSpecStore;
beforeEach(() => {
  tmp = tempDir();
  store = openStore(tmp.dir, { clock: new ManualClock(Date.now()) });
});
afterEach(() => {
  store.close();
  tmp.cleanup();
});

describe('repository-boundary secret guards', () => {
  it('rejects secret-bearing field names and secret-shaped values without echoing them', () => {
    const canaryJwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJjYW5hcnkifQ', 'c2lnbmF0dXJlLWNhbmFyeQ'].join('.');
    for (const value of [
      { authorization: 'x' },
      { nested: { providerJwt: 'x' } },
      { apiKey: 'x' },
      { list: [{ password: 'x' }] },
      { note: canaryJwt },
      { note: 'Bearer abcdefghijklmnop' },
      { note: ['-----BEGIN', 'PRIVATE KEY-----'].join(' ') }, // assembled so the repo scan stays clean
    ]) {
      let message = '';
      expect(() => {
        try {
          assertNoSecrets(value);
        } catch (error) {
          message = JSON.stringify({
            m: (error as Error).message,
            d: (error as { details?: unknown }).details,
          });
          throw error;
        }
      }).toThrow();
      expect(message).not.toContain(canaryJwt);
      expect(message).not.toContain('abcdefghijklmnop');
    }
    expect(() => assertNoSecrets({ tokenDigest: 'sha256:abc', seed: 'seed-1', amount: '10' })).not.toThrow();
  });

  it('refuses secret-shaped material at the proxy journal boundary', () => {
    const gate = createGate(store, { label: 'guard' });
    const { auth } = startCase(store, gate.caseRunIds[0]!);
    const canary = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJjYW5hcnkifQ', 'c2lnbmF0dXJlLWNhbmFyeQ'].join('.');
    expect(
      codeOf(() =>
        store.recordQuoteRequest(auth, {
          transportRequestId: 't',
          logicalJobKey: 'j',
          material: quoteRequest({ customRecipientMsg: canary }),
        }),
      ),
    ).toBe('RS_SECRET_FIELD_REJECTED');
    expect(store.countRows('run_operations')).toBe(0);
  });

  it('persists only token digests: no plaintext case token appears in the database or WAL files', () => {
    const gate = createGate(store, { label: 'tokens' });
    const { auth } = startCase(store, gate.caseRunIds[0]!);
    quoteAndFinalize(store, auth);
    store.journal.read((db) => db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get());
    const files = readdirSync(tmp.dir).filter((f) => f.startsWith('journal.db'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const bytes = readFileSync(join(tmp.dir, f));
      expect(bytes.includes(Buffer.from(auth.token, 'utf8')), f).toBe(false);
    }
  });
});

describe('database-enforced lifecycle and identity', () => {
  it('rejects illegal lifecycle transitions and terminal rewrites even from a raw connection', () => {
    const gate = createGate(store, { label: 'raw' });
    store.close();
    const raw = new DatabaseSync(join(tmp.dir, 'journal.db'));
    try {
      raw.exec('PRAGMA foreign_keys = ON');
      expect(() =>
        raw.exec(
          `UPDATE case_runs SET execution_lifecycle = 'COMPLETED' WHERE case_run_id = '${gate.caseRunIds[0]}'`,
        ),
      ).toThrow(/RS_LIFECYCLE_TRANSITION_INVALID/);
      raw.exec(
        `UPDATE case_runs SET execution_lifecycle = 'ABORTED' WHERE case_run_id = '${gate.caseRunIds[0]}'`,
      );
      expect(() =>
        raw.exec(
          `UPDATE case_runs SET execution_lifecycle = 'READY' WHERE case_run_id = '${gate.caseRunIds[0]}'`,
        ),
      ).toThrow(/RS_TERMINAL_IMMUTABLE/);
      expect(() => raw.exec(`UPDATE gate_runs SET artifact_digest = 'sha256:swapped'`)).toThrow(
        /RS_IMMUTABLE_RECORD/,
      );
      expect(() => raw.exec(`UPDATE build_revisions SET registration_claim = 'CI_ATTESTED'`)).toThrow(
        /RS_IMMUTABLE_RECORD/,
      );
      expect(() => raw.exec(`DELETE FROM case_runs`)).toThrow(/RS_IMMUTABLE_RECORD/);
    } finally {
      raw.close();
      store = openStore(tmp.dir, { clock: new ManualClock(Date.now()) });
    }
  });

  it('gate runs require a consistent build/artifact identity', () => {
    const gate = createGate(store, { label: 'fk' });
    const row = store.getGateRun(gate.gateRunId)!;
    expect(
      codeOf(() =>
        store.createGateRun({
          projectId: String(row['project_id']),
          integrationRevisionId: String(row['integration_revision_id']),
          buildRevisionId: String(row['build_revision_id']),
          artifactDigest: `sha256:${'f'.repeat(64)}`,
          buildAttestation: { attestationClass: 'USER_ASSERTED_LOCAL', attestationId: null },
          corpusRevisionId: String(row['corpus_revision_id']),
          protocolProfileId: String(row['protocol_profile_id']),
          adapterRevision: 'sdk-adapter@1.0.0',
          evaluatorRevision: 'kernel@0.0.0',
          proxyRevision: 'proxy@0.0.0',
          configurationDigest: String(row['configuration_digest']),
          effectManifestDigest: String(row['effect_manifest_digest']),
          effectCoveragePolicyDigest: String(row['effect_coverage_policy_digest']),
          callsiteInventoryDigest: null,
          interceptorProfileDigest: null,
          maxParallelCases: 1,
          cases: [],
        }),
      ),
    ).toBe('RS_IDENTITY_MISMATCH');
    expect(
      codeOf(() =>
        store.startCase({
          caseRunId: gate.caseRunIds[0]!,
          leaseOwnerDigest: 'x',
          clientInstanceDigest: 'y',
          mode: 'LIVE_DRY_PROBE',
          seed: 's',
          leaseTtlMs: 1,
          tokenTtlMs: 1,
        }),
      ),
    ).toBe('RS_MODE_POLICY_DENIED');
  });
});
