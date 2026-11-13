/**
 * M50: import from the documented-shape recording, the corpus manifest with provenance and
 * counts, corpus directory verification, and registration in a real journal.
 *
 * The recording is hand-authored from the public API document (not mainnet data), so the corpus
 * built from it is labelled as a shape fixture and can never carry the `mainnet-observed` label.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { RouteSpecError } from '@routespec/contracts';
import { ImportJournal, RouteSpecStore } from '@routespec/store';
import {
  EXPLORER_API_SPEC,
  MAINNET_CORPUS_LABEL,
  RecordingSource,
  buildCorpus,
  pendingManifest,
  registerObservedCorpus,
  runImport,
  verifyCorpusDir,
  writeCorpusDir,
  type TransactionSource,
} from '../src/index.ts';
import { WINDOW, fixtureDoc } from './support/fixture.ts';

const dirs: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'routespec-m50-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof RouteSpecError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
}

async function fixtureCorpus(recheckAfterSec = 3600) {
  const summary = await runImport(new RecordingSource(fixtureDoc()), {
    window: WINDOW,
    stuckAfterSec: 900,
    recheckAfterSec,
  });
  return { summary, corpus: buildCorpus(summary, { label: 'explorer-shape-fixture' }) };
}

describe('M50 import and corpus', () => {
  it('imports the recording with a second look: exact classes, counts and templates', async () => {
    const { summary, corpus } = await fixtureCorpus();
    expect(summary.sourceKind).toBe('DOCUMENTED_SHAPE_FIXTURE');
    expect(summary.counts).toMatchObject({
      recordsRead: 12,
      rejectedShape: 0,
      documentedShapeDeviations: 0,
      duplicates: 0,
      notIncident: { ordinarySuccess: 0, inFlightYoung: 1, unusedQuote: 0 },
      incidents: 11,
      byClass: { STUCK: 2, REFUNDED: 6, FAILED: 2, LATE_SUCCESS: 1 },
      rechecked: 4,
      recheckNotFound: 0,
      truncated: false,
    });
    expect(summary.counts.byRefundReason).toEqual({
      AMOUNT_LESS_THAN_MIN_AMOUNT_OUT: 2,
      INTENT_SUBMIT_FAILED: 1,
      NONE_REPORTED: 1,
      NO_LIQUIDITY: 1,
      PARTIAL_DEPOSIT: 1,
    });
    expect(summary.counts.byDepositType).toEqual({ INTENTS: 1, ORIGIN_CHAIN: 10 });
    const m = corpus.manifest;
    expect(m.corpusLabel).toBe('explorer-shape-fixture');
    expect(m.importStatus).toBe('PENDING_LIVE_IMPORT');
    expect(m.source).toEqual({
      kind: 'DOCUMENTED_SHAPE_FIXTURE',
      network: 'none',
      endpoint: 'GET https://explorer.near-intents.org/api/v0/transactions',
      apiSpecDigest: EXPLORER_API_SPEC.sha256,
    });
    expect(m.scenarioProvenanceClass).toBe('OFFICIAL_SPEC_DERIVED');
    expect(m.window).toEqual(WINDOW);
    expect(m.observedAtHour).toBe('2026-11-13T12:00:00.000Z');
    expect(m.recheckedAtHour).toBe('2026-11-13T13:00:00.000Z');
    expect(m.statusesQueried).toEqual(['FAILED', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'REFUNDED']);
    expect(m.templates.map((t) => [t.scenarioId, t.count, t.undecidableInvariants.join(',')])).toEqual([
      ['shape-failed-deposit-seen', 1, 'INV-05'],
      ['shape-failed-no-deposit-seen', 1, 'INV-05'],
      ['shape-late-success-proc-ge-30m', 1, 'INV-05,INV-08'],
      ['shape-refund-amount-less-than-min-amount-out', 2, ''],
      ['shape-refund-intent-submit-failed-proc-ge-15m', 1, ''],
      ['shape-refund-no-liquidity', 1, ''],
      ['shape-refund-none-reported', 1, ''],
      ['shape-refund-partial-deposit', 1, ''],
      ['shape-stuck-incd-ge-3h', 1, 'INV-05,INV-06'],
      ['shape-stuck-proc-ge-3h', 1, 'INV-05,INV-06'],
    ]);
    expect(m.templates.find((t) => t.scenarioId === 'shape-late-success-proc-ge-30m')).toMatchObject({
      observedStatuses: ['PROCESSING', 'SUCCESS'],
      scriptedStatuses: ['PROCESSING', 'SUCCESS'],
    });
    expect(Object.keys(corpus.files).sort()).toEqual(m.templates.map((t) => t.file).sort());
    expect(m.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('without a second look a held swap is only ever stuck, never a late success', async () => {
    const { summary, corpus } = await fixtureCorpus(0);
    expect(summary.counts.byClass).toEqual({ STUCK: 4, REFUNDED: 5, FAILED: 2, LATE_SUCCESS: 0 });
    expect(summary.counts.rechecked).toBe(0);
    expect(corpus.manifest.recheckedAtHour).toBeNull();
    expect(corpus.manifest.templates.map((t) => t.scenarioId).filter((id) => id.includes('stuck'))).toEqual([
      'shape-stuck-incd-ge-3h',
      'shape-stuck-proc-ge-15m',
      'shape-stuck-proc-ge-1h',
      'shape-stuck-proc-ge-30m',
    ]);
  });

  it('is deterministic: the same recording gives the same manifest digest', async () => {
    const a = await fixtureCorpus();
    const b = await fixtureCorpus();
    expect(a.corpus.manifest.manifestDigest).toBe(b.corpus.manifest.manifestDigest);
    expect(a.corpus.files).toEqual(b.corpus.files);
  });

  it('counts malformed records and repeated records instead of dropping them silently', async () => {
    const doc = fixtureDoc();
    const first = doc.observations[0]!;
    const txs = first.transactions as Array<Record<string, unknown>>;
    const repeated = { ...txs[1] };
    const noStatus = { ...txs[2], depositAddress: 'another-address', status: 'SETTLED' };
    const notObject = 'not-a-record';
    const missingDocumentedField: Record<string, unknown> = { ...txs[3], depositAddress: 'third-address' };
    delete missingDocumentedField['recipient'];
    const summary = await runImport(
      new RecordingSource({
        ...doc,
        observations: [
          { ...first, transactions: [...txs, repeated, noStatus, notObject, missingDocumentedField] },
        ],
      }),
      { window: WINDOW, stuckAfterSec: 900, recheckAfterSec: 0 },
    );
    expect(summary.counts.recordsRead).toBe(16);
    expect(summary.counts.duplicates).toBe(1);
    expect(summary.counts.rejectedShape).toBe(2);
    expect(summary.counts.documentedShapeDeviations).toBe(1);
    expect(summary.counts.incidents).toBe(12);
  });

  it('stops instead of looping when the cursor does not advance', async () => {
    const inner = new RecordingSource(fixtureDoc());
    const notes: string[] = [];
    // A source that ignores the cursor and answers the first page again and again.
    const stuckCursor: TransactionSource = {
      kind: inner.kind,
      nowMs: () => inner.nowMs(),
      wait: () => inner.wait(),
      lookup: (a, m) => inner.lookup(a, m),
      rateLimitedCount: () => 0,
      listPage: (q) => inner.listPage({ ...q, cursor: null }),
    };
    const summary = await runImport(stuckCursor, {
      window: WINDOW,
      stuckAfterSec: 900,
      recheckAfterSec: 0,
      pageSize: 5,
      maxPages: 50,
      onProgress: (note) => notes.push(note),
    });
    expect(summary.counts.pagesRead).toBe(2);
    expect(summary.counts.truncated).toBe(true);
    expect(summary.counts.recordsRead).toBe(10);
    expect(summary.counts.duplicates).toBe(5);
    expect(notes).toEqual(['page 1: 5 records, 0 held so far', 'page 2: 5 records, 0 held so far']);
  });

  it('never lets fixture data carry the mainnet label, or mainnet data any other', async () => {
    const { summary } = await fixtureCorpus();
    expect(MAINNET_CORPUS_LABEL).toBe('mainnet-observed-2026-11');
    expect(code(() => buildCorpus(summary, { label: MAINNET_CORPUS_LABEL }))).toBe('RS_MODE_POLICY_DENIED');
    expect(code(() => buildCorpus(summary, { label: 'mainnet-anything' }))).toBe('RS_MODE_POLICY_DENIED');
    const live = { ...summary, sourceKind: 'INTENTS_EXPLORER_API' as const };
    expect(code(() => buildCorpus(live, { label: 'explorer-shape-fixture' }))).toBe('RS_MODE_POLICY_DENIED');
    const corpus = buildCorpus(live, { label: MAINNET_CORPUS_LABEL });
    expect(corpus.manifest.importStatus).toBe('IMPORTED');
    expect(corpus.manifest.source.network).toBe('mainnet');
    expect(corpus.manifest.scenarioProvenanceClass).toBe('ISSUE_DERIVED_NOT_REPRODUCED');
    expect(corpus.manifest.templates.every((t) => t.scenarioId.startsWith('obs-'))).toBe(true);
  });

  it('writes a corpus directory that verifies, and detects every kind of tampering', async () => {
    const { corpus } = await fixtureCorpus();
    const dir = join(temp(), 'corpus');
    writeCorpusDir(dir, corpus);
    const verified = verifyCorpusDir(dir);
    expect(verified.manifest.manifestDigest).toBe(corpus.manifest.manifestDigest);
    expect(verified.scenarios).toHaveLength(10);
    expect(readdirSync(join(dir, 'scenarios')).sort()).toEqual(
      corpus.manifest.templates.map((t) => t.file.slice(10)).sort(),
    );
    // A second write refuses to overwrite an imported corpus unless asked to.
    expect(code(() => writeCorpusDir(dir, corpus))).toBe('RS_EXPORT_OVERWRITE_DENIED');
    writeCorpusDir(dir, corpus, { replace: true });

    const manifestPath = join(dir, 'manifest.json');
    const original = readFileSync(manifestPath, 'utf8');
    const scenarioPath = join(dir, corpus.manifest.templates[0]!.file);
    const scenario = readFileSync(scenarioPath, 'utf8');

    // 1. A scenario edited by hand (for example to smuggle a real account in).
    writeFileSync(scenarioPath, scenario.replace('recipient.sim', 'somebody.near'));
    expect(code(() => verifyCorpusDir(dir))).toBe('RS_IDENTITY_MISMATCH');
    writeFileSync(scenarioPath, scenario);
    // 2. A count changed without the digest.
    writeFileSync(manifestPath, original.replace('"recordsRead": 12', '"recordsRead": 13'));
    expect(code(() => verifyCorpusDir(dir))).toBe('RS_IDENTITY_MISMATCH');
    // 3. An unknown field (a place to keep an address) is refused by the closed schema.
    const withExtra = JSON.parse(original) as Record<string, unknown>;
    (withExtra['templates'] as Array<Record<string, unknown>>)[0]!['depositAddress'] = 'x';
    writeFileSync(manifestPath, JSON.stringify(withExtra));
    expect(code(() => verifyCorpusDir(dir))).toBe('RS_SCHEMA_INVALID');
    writeFileSync(manifestPath, original);
    // 4. A stray file next to the scenarios.
    writeFileSync(join(dir, 'scenarios', 'extra.yaml'), scenario);
    expect(code(() => verifyCorpusDir(dir))).toBe('RS_IDENTITY_MISMATCH');
    rmSync(join(dir, 'scenarios', 'extra.yaml'));
    expect(verifyCorpusDir(dir).scenarios).toHaveLength(10);
  });

  it('registers the corpus in a real journal as pinned scenario revisions', async () => {
    const { corpus } = await fixtureCorpus();
    const root = temp();
    const dir = join(root, 'corpus');
    writeCorpusDir(dir, corpus);
    const store = RouteSpecStore.open({ path: join(root, 'journal.db') });
    try {
      const out = registerObservedCorpus(store, dir, {
        requiredInvariants: ['INV-03', 'INV-05'],
        severity: 'HIGH',
      });
      expect(out.label).toBe('explorer-shape-fixture');
      expect(out.cases).toHaveLength(10);
      const view = new ImportJournal(store).getCorpus(out.corpusRevisionId);
      expect(view.label).toBe('explorer-shape-fixture');
      expect(view.cases.every((c) => c.gatePolicy === 'REQUIRED')).toBe(true);
      // An invariant a class cannot decide is not required for its cases, and that is reported.
      const required = Object.fromEntries(
        view.cases.map((c, i) => [out.cases[i]!.scenarioId, c.requiredInvariants]),
      );
      expect(required['shape-refund-no-liquidity']).toEqual(['INV-03', 'INV-05']);
      expect(required['shape-stuck-proc-ge-3h']).toEqual(['INV-03']);
      expect(required['shape-failed-deposit-seen']).toEqual(['INV-03']);
      expect(out.cases.find((c) => c.scenarioId === 'shape-stuck-proc-ge-3h')?.notRequired).toEqual([
        'INV-05',
      ]);
      // Asking for everything keeps every requested invariant required for every case.
      const all = registerObservedCorpus(store, dir, {
        requiredInvariants: ['INV-03', 'INV-05'],
        severity: 'HIGH',
        requireAll: true,
      });
      expect(all.corpusRevisionId).not.toBe(out.corpusRevisionId);
      expect(all.cases.every((c) => c.requiredInvariants.join(',') === 'INV-03,INV-05')).toBe(true);
      // A case must keep at least one required invariant.
      expect(
        code(() => registerObservedCorpus(store, dir, { requiredInvariants: ['INV-05'], severity: 'HIGH' })),
      ).toBe('RS_CLI_USAGE');
      for (const [i, c] of out.cases.entries()) {
        const row = store.getScenarioRevision(c.scenarioRevisionId);
        expect(row?.['scenario_stable_id']).toBe(corpus.manifest.templates[i]!.scenarioId);
        expect(row?.['provenance_class']).toBe('OFFICIAL_SPEC_DERIVED');
        expect(row?.['review_status']).toBe('UNREVIEWED');
        expect(row?.['revision_digest']).toBe(corpus.manifest.templates[i]!.revisionDigest);
      }
      // Registration is idempotent: the same corpus content is the same corpus revision.
      const again = registerObservedCorpus(store, dir, {
        requiredInvariants: ['INV-03', 'INV-05'],
        severity: 'HIGH',
      });
      expect(again.corpusRevisionId).toBe(out.corpusRevisionId);
    } finally {
      store.close();
    }
  });

  it('a pending manifest has no cases and cannot be registered', () => {
    const root = temp();
    const dir = join(root, 'pending');
    const pending = pendingManifest(MAINNET_CORPUS_LABEL);
    expect(pending.importStatus).toBe('PENDING_LIVE_IMPORT');
    expect(pending.templates).toEqual([]);
    expect(pending.counts.recordsRead).toBe(0);
    expect(pending.source.kind).toBe('INTENTS_EXPLORER_API');
    writeCorpusDir(dir, { manifest: pending, files: {} });
    expect(verifyCorpusDir(dir).manifest.importStatus).toBe('PENDING_LIVE_IMPORT');
    const store = RouteSpecStore.open({ path: join(root, 'journal.db') });
    try {
      expect(
        code(() => registerObservedCorpus(store, dir, { requiredInvariants: ['INV-03'], severity: 'HIGH' })),
      ).toBe('RS_IMPORT_STATE_INVALID');
    } finally {
      store.close();
    }
  });

  it('the committed mainnet corpus directory is valid: pending with zero cases, or a verified import', () => {
    const dir = fileURLToPath(new URL(`../corpora/${MAINNET_CORPUS_LABEL}`, import.meta.url));
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
    const { manifest, scenarios } = verifyCorpusDir(dir);
    expect(manifest.corpusLabel).toBe(MAINNET_CORPUS_LABEL);
    expect(manifest.source.kind).toBe('INTENTS_EXPLORER_API');
    if (manifest.importStatus === 'PENDING_LIVE_IMPORT') {
      expect(scenarios).toEqual([]);
      expect(manifest.counts.recordsRead).toBe(0);
      expect(manifest.observedAtHour).toBeNull();
    } else {
      expect(manifest.scenarioProvenanceClass).toBe('ISSUE_DERIVED_NOT_REPRODUCED');
      expect(manifest.templates.reduce((n, t) => n + t.count, 0)).toBe(manifest.counts.incidents);
    }
  });
});
