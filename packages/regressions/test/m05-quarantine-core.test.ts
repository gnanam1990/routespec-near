/**
 * M05 quarantine core properties (supplementary to the owned tests): bounded streaming and
 * strict JSON limits (NFR-06), filename normalization, secret detection, the export privacy
 * scan (deliverable 7, no bundle written), incident scenario encoding (deliverable 6), the
 * database-level import state machine, and a static audit that the M05 sources import no
 * network capability.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, isRouteSpecError } from '@routespec/contracts';
import { ImportJournal, RouteSpecStore } from '@routespec/store';
import {
  DEFAULT_IMPORT_LIMITS,
  INCIDENT_SCENARIO_SOURCES,
  assertExportAllowed,
  compileIncident,
  ingestStream,
  parseBoundedJson,
  resolveImportLimits,
  sanitizeFilename,
  scanForExport,
  scanSecrets,
} from '../src/index.ts';
import { tempDir } from './support/product.ts';
import { simpleUserTrace } from './support/traces.ts';

const limits = resolveImportLimits({ maxDepth: 8, maxStringLength: 64, maxKeysPerObject: 8, maxNodes: 200 });

describe('M05 bounded ingest and strict JSON', () => {
  it('stops streaming past the byte limit and labels the digest as partial', async () => {
    const big = [Buffer.alloc(600, 0x61), Buffer.alloc(600, 0x62)];
    const r = await ingestStream(big, 1000);
    expect(r.complete).toBe(false);
    expect(r.bytes).toBeNull();
    expect(r.byteCount).toBe(1001);
    const full = await ingestStream([Buffer.alloc(600, 0x61), Buffer.alloc(400, 0x62)], 1000);
    expect(full.complete).toBe(true);
    expect(full.digest).not.toBe(r.digest);
  });

  it('enforces depth, string, keys, nodes, duplicate and prototype keys without evaluating anything', () => {
    const cases: Array<[string, string]> = [
      ['[[[[[[[[[[1]]]]]]]]]]', 'RESOURCE_DEPTH'],
      [JSON.stringify({ a: 'x'.repeat(65) }), 'RESOURCE_STRING'],
      [
        JSON.stringify(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i]))),
        'RESOURCE_KEYS',
      ],
      [JSON.stringify(Array.from({ length: 250 }, () => 1)), 'RESOURCE_NODES'],
      ['{"a":1,"a":2}', 'SCHEMA_DUPLICATE_KEY'],
      ['{"__proto__":{"polluted":true}}', 'SCHEMA_FORBIDDEN_KEY'],
      ['{"a":1,}', 'SCHEMA_INVALID'],
      ['{"a":NaN}', 'SCHEMA_INVALID'],
    ];
    for (const [text, category] of cases) {
      const r = parseBoundedJson(text, limits);
      expect(r.ok, text).toBe(false);
      if (!r.ok) expect(r.category, text).toBe(category);
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    const ok = parseBoundedJson('{"a":[1,2,{"b":"c\\u0041"}],"n":-1.5e2}', limits);
    expect(ok).toEqual({ ok: true, value: { a: [1, 2, { b: 'cA' }], n: -150 } });
  });

  it('limits are explicit, configurable downward, and never exceed hard caps', () => {
    expect(DEFAULT_IMPORT_LIMITS.maxEvents).toBe(10_000);
    expect(() => resolveImportLimits({ maxBytes: 64 * 1024 * 1024 })).toThrow(
      expect.objectContaining({ code: 'RS_IMPORT_LIMIT_EXCEEDED' }),
    );
  });

  it('normalizes untrusted filenames to a safe basename and reports traversal or device names', () => {
    expect(sanitizeFilename('trace.json')).toEqual({ name: 'trace.json', unsafe: false });
    for (const raw of [
      '../../etc/passwd',
      'C:\\Windows\\win.ini',
      '\\\\host\\share\\t.json',
      '/abs/t.json',
      'CON.json',
      'a\u202Egnp.json',
    ]) {
      const r = sanitizeFilename(raw);
      expect(r.unsafe, raw).toBe(true);
      expect(r.name).not.toMatch(/[\\/:]/);
      expect(r.name).not.toMatch(/^(con|prn|aux|nul)(\.|$)/i);
    }
  });

  it('detects credential patterns, configured values, and credential-bearing keys without returning values', () => {
    const jwt = [
      'eyJ',
      'hbGciOiJIUzI1NiJ9',
      '.eyJ',
      'zdWIiOiIxMjM0NTY3ODkwIn0',
      '.',
      'c2lnbmF0dXJlLXZhbHVl',
    ].join('');
    const pem = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    const findings = scanSecrets(
      { a: jwt, b: { authorization: 'x' }, c: [pem], d: 'my-configured-value-1', e: { Cookie: 'sid=1' } },
      { configuredSecrets: ['my-configured-value-1'] },
    ).list();
    expect(findings.map((f) => f.category).sort()).toEqual([
      'SECRET_AUTHORIZATION_HEADER',
      'SECRET_CONFIGURED_VALUE',
      'SECRET_COOKIE',
      'SECRET_JWT',
      'SECRET_PRIVATE_KEY',
    ]);
    expect(JSON.stringify(findings)).not.toContain(jwt);
    expect(JSON.stringify(findings)).not.toContain('my-configured-value-1');
  });
});

describe('M05 export privacy scan (no bundle is written)', () => {
  it('blocks credentials, cookies, private keys, signed payloads, and unacknowledged addresses', () => {
    const bearer = ['Bea', 'rer ', 'Z'.repeat(20)].join('');
    const scan = scanForExport({
      headers: { authorization: bearer },
      cookie: 'sid=abcdef12',
      key: ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
      commit: { txHash: 'sim-tx-1', depositAddress: 'sim-deposit-1' },
      signature: 'f'.repeat(130),
    });
    expect(scan.exportAllowed).toBe(false);
    expect(new Set(scan.findings.map((f) => f.category))).toEqual(
      new Set([
        'AUTHORIZATION_HEADER',
        'CREDENTIAL',
        'COOKIE',
        'PRIVATE_KEY',
        'SIGNED_PAYLOAD',
        'SENSITIVE_ADDRESS',
      ]),
    );
    expect(JSON.stringify(scan)).not.toContain(bearer);
    expect(() => assertExportAllowed(scan)).toThrow(expect.objectContaining({ code: 'RS_EXPORT_BLOCKED' }));
    // Addresses alone block until their inclusion is explicitly acknowledged.
    const addressOnly = scanForExport({ recipient: 'recipient.sim' });
    expect(addressOnly.exportAllowed).toBe(false);
    expect(scanForExport({ recipient: 'recipient.sim' }, { acknowledgeAddresses: true }).exportAllowed).toBe(
      true,
    );
    expect(scanForExport({ title: 'clean reviewed content' }).exportAllowed).toBe(true);
  });
});

describe('M05 encoded incident scenarios', () => {
  it('issue-383 is source-derived, never settles; issue-384 is a disputed ambiguity case expecting REVIEW', () => {
    const i383 = compileIncident('issue-383-lost-commit-refund');
    expect(i383.plan.sourceProvenance.class).toBe('ISSUE_DERIVED_NOT_REPRODUCED');
    expect(i383.plan.groundTruthEvents.some((e) => e.fact === 'DESTINATION_CREDIT')).toBe(false);
    expect(i383.plan.expectedOutcomes.terminalStatus).toBe('REFUNDED');
    expect(i383.plan.forbiddenBehaviors).toEqual([
      'EFFECT_RELEASE_BEFORE_COMPLETION',
      'SECOND_COMMIT_UNDER_UNCERTAINTY',
    ]);
    const i384 = compileIncident('issue-384-disputed-private-credit');
    expect(i384.plan.sourceProvenance.class).toBe('DISPUTED_AMBIGUITY_CASE');
    expect(i384.plan.groundTruthEvents.find((e) => e.fact === 'DESTINATION_CREDIT')?.visibility).toBe(
      'PRIVATE',
    );
    expect(Object.values(i384.plan.expectedOutcomes.invariants)).toEqual(['REVIEW', 'REVIEW']);
    expect(Object.keys(INCIDENT_SCENARIO_SOURCES)).toHaveLength(2);
  });
});

describe('M05 import state machine in the journal', () => {
  let tmp: ReturnType<typeof tempDir>;
  let store: RouteSpecStore;
  beforeAll(() => {
    tmp = tempDir();
    store = RouteSpecStore.open({ path: join(tmp.dir, 'journal.db') });
  });
  afterAll(() => {
    store.close();
    tmp.cleanup();
  });

  it('refuses skipped, backward, and post-terminal transitions and deletion', () => {
    const journal = new ImportJournal(store);
    const { projectId } = store.createProject({ name: 'sm', idempotencyKey: 'project-sm-key' });
    const out = journal.recordQuarantine({
      projectId,
      origin: 'USER_FILE',
      sourceSessionId: null,
      sourceFilename: 'a.json',
      rawByteCount: 10,
      rawSourceDigest: `sha256:${'a'.repeat(64)}`,
      disposition: 'SANITIZE',
      sanitized: JSON.parse(canonicalJson(simpleUserTrace('sm'))) as unknown,
      schemaState: 'VALID',
      findings: [],
      scannerRevision: 'test',
      captureBinding: null,
      idempotencyKey: 'sm-quarantine',
    });
    const set = (state: string) => {
      try {
        store.journal.transact('tamper', (db) =>
          db
            .prepare('UPDATE imports SET state = ?, revision = revision + 1 WHERE import_id = ?')
            .run(state, out.importId),
        );
        return null;
      } catch (error) {
        return isRouteSpecError(error) ? error.code : 'UNTYPED';
      }
    };
    expect(set('REVIEWED')).toBe('RS_IMPORT_STATE_INVALID');
    expect(set('PROMOTED')).toBe('RS_IMPORT_STATE_INVALID');
    expect(set('QUARANTINED')).toBe('RS_IMPORT_STATE_INVALID');
    expect(set('REJECTED')).toBeNull();
    expect(set('SANITIZED')).toBe('RS_IMPORT_STATE_INVALID');
    expect(set('PURGED')).toBeNull();
    expect(set('REJECTED')).toBe('RS_TERMINAL_IMMUTABLE');
    expect(() =>
      store.journal.transact('tamper', (db) =>
        db.prepare('DELETE FROM imports WHERE import_id = ?').run(out.importId),
      ),
    ).toThrow(expect.objectContaining({ code: 'RS_IMMUTABLE_RECORD' }));
    // A user file can never carry an installed capture binding.
    expect(() =>
      journal.recordQuarantine({
        projectId,
        origin: 'USER_FILE',
        sourceSessionId: null,
        sourceFilename: 'b.json',
        rawByteCount: 1,
        rawSourceDigest: `sha256:${'b'.repeat(64)}`,
        disposition: 'REJECT',
        sanitized: null,
        schemaState: 'NOT_PARSED',
        findings: [],
        scannerRevision: 'test',
        captureBinding: {
          caseRunId: 'x',
          gateRunId: 'x',
          sessionId: 'x',
          buildRevisionId: 'x',
          artifactDigest: 'x',
          scenarioRevisionId: 'x',
          effectManifestDigest: 'x',
          effectCoveragePolicyDigest: 'x',
          callsiteInventoryDigest: null,
          interceptorProfileDigest: null,
          adapterRevision: 'x',
          fencingEpoch: 0,
          identityDigest: 'x',
          captureDigest: 'x',
        },
        idempotencyKey: 'sm-forged-binding',
      }),
    ).toThrow(expect.objectContaining({ code: 'RS_IMPORT_CAPTURE_MISMATCH' }));
  });
});

describe('M05 static audit', () => {
  it('regressions sources import no network, DNS, HTTP, TLS, provider SDK, or model client', () => {
    const dir = fileURLToPath(new URL('../src/', import.meta.url));
    const forbidden =
      /from\s+'(?:node:)?(?:net|dns|dns\/promises|http|https|http2|tls|dgram|undici)'|@defuse-protocol|axios|openai|@[\w-]+-ai\b|fetch\(/;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(forbidden.test(text), file).toBe(false);
      if (file !== 'replay.ts') expect(/node:child_process/.test(text), file).toBe(false);
    }
  });
});
