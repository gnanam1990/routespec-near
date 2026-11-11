/**
 * T-028 — Database migration preserves immutable historical results. Covers NFR-05, NFR-08
 * (owned by M01).
 *
 * A journal is created at schema version 1 through the real repository API (project → gate →
 * case → quote/finalize/commit → status → evidence). Historical invariant results and a gate
 * evaluation are then written as a v1 *fixture* with raw SQL (they represent rows written by an
 * older build; the v1 build had no case_results table). The journal is migrated through every
 * later version; every v1 row, digest, and status value must be byte-identical afterwards.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalJson, digestValue } from '@routespec/contracts';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, RouteSpecStore, migrationChecksum } from '../src/index.ts';
import { ManualClock, codeOf, createGate, quoteAndFinalize, startCase, tempDir } from './support/fixture.ts';

let tmp: ReturnType<typeof tempDir>;
let dbPath: string;
beforeEach(() => {
  tmp = tempDir();
  dbPath = join(tmp.dir, 'journal.db');
});
afterEach(() => tmp.cleanup());

const V1_TABLES = [
  'projects',
  'integration_revisions',
  'build_revisions',
  'gate_runs',
  'case_runs',
  'sessions',
  'case_tokens',
  'logical_jobs',
  'run_operations',
  'quote_finalizations',
  'commit_bindings',
  'attempts',
  'proxy_exchanges',
  'lifecycle_events',
  'evidence_items',
  'invariant_results',
  'gate_evaluations',
  'protocol_profiles',
  'scenario_revisions',
  'corpus_revisions',
  'corpus_cases',
];

function dumpTables(path: string): Record<string, unknown[]> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(
      V1_TABLES.map((t) => [
        t,
        db
          .prepare(`SELECT * FROM ${t} ORDER BY rowid`)
          .all()
          .map((r) => canonicalJson(JSON.parse(JSON.stringify(r)))),
      ]),
    );
  } finally {
    db.close();
  }
}

function buildV1Journal(): { caseRunId: string; resultDigests: string[]; decisionDigest: string } {
  const store = RouteSpecStore.open({
    path: dbPath,
    clock: new ManualClock(Date.now()),
    migrations: MIGRATIONS.slice(0, 1),
  });
  expect(store.schemaVersion).toBe(1);
  const gate = createGate(store, { label: 'v1' });
  const caseRunId = gate.caseRunIds[0]!;
  const { auth, fence } = startCase(store, caseRunId);
  const runOperationId = quoteAndFinalize(store, auth);
  store.commitMutation(auth, {
    transportRequestId: 'c1',
    runOperationId,
    body: { txHash: '0xaa', depositAddress: 'deposit.sim' },
  });
  store.recordStatusObservation(auth, {
    transportRequestId: 's1',
    runOperationId,
    query: { depositAddress: 'deposit.sim' },
    rawStatus: 'SUCCESS',
  });
  const { evidenceId } = store.recordEvidence(fence, {
    runOperationId,
    evidenceClass: 'REPORTED',
    evidenceScope: 'PROVIDER_REPORTED',
    reasons: ['NOT_VISIBLE'],
    subject: 'destination_credit',
    sourceKind: 'PROVIDER_STATUS',
    assetId: null,
    amount: null,
    singleUse: false,
    payload: { rawStatus: 'SUCCESS' },
  });
  store.close();

  // v1 historical result fixture (older-build rows): REVIEW and FAIL verdicts with digests.
  const raw = new DatabaseSync(dbPath);
  const session = raw.prepare('SELECT * FROM sessions WHERE case_run_id = ?').get(caseRunId) as Record<
    string,
    string | number
  >;
  const insert =
    raw.prepare(`INSERT INTO invariant_results(result_id, integration_revision_id, build_revision_id, artifact_digest,
    gate_run_id, case_run_id, session_id, scenario_revision_id, effect_coverage_policy_digest, effect_manifest_digest, run_operation_id,
    invariant_id, verdict, evaluator_revision, evidence_ids_json, missing_predicates_json, reasons_json, fencing_epoch, result_digest,
    created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const resultDigests: string[] = [];
  for (const [invariantId, verdict, reasons] of [
    ['INV-05', 'REVIEW', ['NOT_VISIBLE']],
    ['INV-06', 'PASS', []],
    ['INV-02', 'FAIL', []],
  ] as const) {
    const body = {
      invariantId,
      verdict,
      runOperationId,
      evidenceIds: [evidenceId],
      reasons: [...reasons],
      evaluatorRevision: 'kernel@0.9.0',
    };
    const resultDigest = digestValue('routespec.invariant-result/1', body);
    resultDigests.push(resultDigest);
    insert.run(
      randomUUID(),
      session['integration_revision_id']!,
      session['build_revision_id']!,
      session['artifact_digest']!,
      session['gate_run_id']!,
      caseRunId,
      session['session_id']!,
      session['scenario_revision_id']!,
      session['effect_coverage_policy_digest']!,
      session['effect_manifest_digest']!,
      runOperationId,
      invariantId,
      verdict,
      'kernel@0.9.0',
      JSON.stringify([evidenceId]),
      '[]',
      JSON.stringify(reasons),
      Number(session['lease_fencing_epoch']),
      resultDigest,
      1,
    );
  }
  const decision = { gateRunId: session['gate_run_id'], decision: 'FAIL', caseResultDigests: resultDigests };
  const decisionDigest = digestValue('routespec.gate-decision/1', decision);
  raw
    .prepare(
      `INSERT INTO gate_evaluations(gate_evaluation_id, gate_run_id, identity_json, case_result_digests_json, decision, findings_json,
    decision_digest, enforcement_mode, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      randomUUID(),
      session['gate_run_id']!,
      '{}',
      JSON.stringify(resultDigests),
      'FAIL',
      '[]',
      decisionDigest,
      'REQUIRED_CHECK_UNVERIFIED',
      1,
    );
  raw.close();
  return { caseRunId, resultDigests, decisionDigest };
}

describe('T-028 — Database migration preserves immutable historical results', () => {
  it('migrates a v1 journal through every version with all historical rows and digests unchanged', () => {
    const { caseRunId, resultDigests, decisionDigest } = buildV1Journal();
    const before = dumpTables(dbPath);

    const store = RouteSpecStore.open({ path: dbPath, clock: new ManualClock(Date.now()) });
    try {
      expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
      const migrations = store.journal.read((db) =>
        db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all(),
      );
      expect(migrations).toEqual(
        MIGRATIONS.map((m) => ({ version: m.version, name: m.name, checksum: migrationChecksum(m) })),
      );
      const results = store.listInvariantResults(caseRunId);
      const byInvariant = Object.fromEntries(results.map((r) => [r['invariant_id'], r['result_digest']]));
      expect(byInvariant).toEqual({
        'INV-05': resultDigests[0],
        'INV-06': resultDigests[1],
        'INV-02': resultDigests[2],
      });
      expect(results.map((r) => `${r['invariant_id']}:${r['verdict']}`)).toEqual([
        'INV-02:FAIL',
        'INV-05:REVIEW',
        'INV-06:PASS',
      ]);
      // Status semantics stay readable: digests recompute from the stored fields.
      for (const r of results) {
        const recomputed = digestValue('routespec.invariant-result/1', {
          invariantId: r['invariant_id'],
          verdict: r['verdict'],
          runOperationId: r['run_operation_id'],
          evidenceIds: JSON.parse(String(r['evidence_ids_json'])),
          reasons: JSON.parse(String(r['reasons_json'])),
          evaluatorRevision: r['evaluator_revision'],
        });
        expect(recomputed).toBe(r['result_digest']);
      }
      const evaluation = store.journal.read((db) =>
        db.prepare('SELECT decision, decision_digest, enforcement_mode FROM gate_evaluations').get(),
      );
      expect(evaluation).toEqual({
        decision: 'FAIL',
        decision_digest: decisionDigest,
        enforcement_mode: 'REQUIRED_CHECK_UNVERIFIED',
      });
      // The new version's tables exist and v1 history cannot be rewritten by anyone.
      expect(store.countRows('case_results')).toBe(0);
      expect(() =>
        store.journal.transact('tamper', (db) => db.exec(`UPDATE invariant_results SET verdict = 'PASS'`)),
      ).toThrow();
    } finally {
      store.close();
    }
    expect(dumpTables(dbPath)).toEqual(before);
  });

  it('a failing migration rolls back completely and leaves the prior version intact', () => {
    buildV1Journal();
    const before = dumpTables(dbPath);
    const broken = [
      ...MIGRATIONS,
      {
        version: LATEST_SCHEMA_VERSION + 1,
        name: 'broken',
        sql: 'CREATE TABLE half_applied (x TEXT) STRICT; INSERT INTO no_such_table VALUES (1);',
      },
    ];
    expect(codeOf(() => RouteSpecStore.open({ path: dbPath, migrations: broken }))).toBe(
      'RS_MIGRATION_FAILED',
    );
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(
        LATEST_SCHEMA_VERSION,
      );
      expect(db.prepare(`SELECT name FROM sqlite_schema WHERE name = 'half_applied'`).get()).toBeUndefined();
    } finally {
      db.close();
    }
    expect(dumpTables(dbPath)).toEqual(before);
  });

  it('fails closed on a tampered migration checksum', () => {
    buildV1Journal();
    const raw = new DatabaseSync(dbPath);
    raw.exec(`UPDATE schema_migrations SET checksum = 'sha256:${'0'.repeat(64)}' WHERE version = 1`);
    raw.close();
    expect(codeOf(() => RouteSpecStore.open({ path: dbPath }))).toBe('RS_MIGRATION_CHECKSUM_MISMATCH');
  });

  it('opens an unknown newer schema only in read-only recovery mode', () => {
    buildV1Journal();
    RouteSpecStore.open({ path: dbPath }).close(); // migrate to latest
    const raw = new DatabaseSync(dbPath);
    raw
      .prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at_ms) VALUES (?,?,?,?)')
      .run(LATEST_SCHEMA_VERSION + 1, 'future', 'sha256:future', 1);
    raw.close();
    const store = RouteSpecStore.open({ path: dbPath });
    try {
      expect(store.mode).toBe('READ_ONLY_RECOVERY');
      expect(store.countRows('invariant_results')).toBe(3);
      expect(codeOf(() => store.createProject({ name: 'x', idempotencyKey: 'should-not-write' }))).toBe(
        'RS_READ_ONLY_RECOVERY',
      );
    } finally {
      store.close();
    }
  });

  it('refuses to adopt a foreign SQLite file', () => {
    const foreign = new DatabaseSync(dbPath);
    foreign.exec('CREATE TABLE app_data (x TEXT)');
    foreign.close();
    expect(codeOf(() => RouteSpecStore.open({ path: dbPath }))).toBe('RS_STORAGE_CORRUPT');
    writeFileSync(join(tmp.dir, 'garbage.db'), 'not a database at all, just text bytes '.repeat(200));
    expect(codeOf(() => RouteSpecStore.open({ path: join(tmp.dir, 'garbage.db') }))).toBe(
      'RS_STORAGE_CORRUPT',
    );
  });
});
