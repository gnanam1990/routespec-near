/**
 * T-029 — Installed capture remains quarantined until safe review. Covers FR-11.
 *
 * The failure is produced by the installed baseline subject (a separately launched process
 * running the pinned official SDK with the RouteSpec adapter) through the normal adapter ->
 * networkless proxy -> journal path, and evaluated by the kernel. The capture is derived by
 * RouteSpec from the journal under the exact build/gate/case/session/scenario/manifest/policy
 * identity. It cannot enter a corpus before no-network quarantine, schema validation, secret
 * scan, material resolution, sanitization, deterministic replay, and immutable review.
 * Secret-bearing, nondeterministic, unresolved, unreviewed, caller-replaced, and identity-
 * mismatched traces are each shown to be rejected or blocked.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, isRouteSpecError } from '@routespec/contracts';
import {
  MappingRejected,
  REVIEW_CONFIRMATION,
  REVIEW_DECISIONS,
  captureInstalledCase,
  deriveInstalledCapture,
  importUserFile,
  promoteImport,
  proposeMapping,
  reviewImport,
  saveImportMapping,
  verifyReplay,
  type TraceDocument,
} from '../src/index.ts';
import { runBaselineIncident, type BaselineRun } from './support/flows.ts';
import { LIVE_INVARIANTS, Product, tempDir } from './support/product.ts';

const approve = Object.fromEntries(REVIEW_DECISIONS.map((d) => [d, true])) as Record<
  (typeof REVIEW_DECISIONS)[number],
  boolean
>;

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return isRouteSpecError(error) ? error.code : `UNTYPED:${String(error)}`;
  }
}

async function codeAsync(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return isRouteSpecError(error) ? error.code : `UNTYPED:${String(error)}`;
  }
}

/** Every text cell of every table: used to prove a value never reached persistence. */
function allPersistedText(dbPath: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>;
    return tables.map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).join('\n');
  } finally {
    db.close();
  }
}

let tmp: ReturnType<typeof tempDir>;
let p: Product;
let baseline: BaselineRun;
let captureId = '';
let capturedTrace: TraceDocument;

beforeAll(async () => {
  tmp = tempDir();
  p = await Product.open(tmp.dir, 't029');
  baseline = await runBaselineIncident(p, { cases: 2 });
});

afterAll(async () => {
  await p?.close();
  tmp?.cleanup();
});

describe('T-029 — Installed capture remains quarantined until safe review', () => {
  it('the installed baseline client fails the issue-383-derived case through the normal product path', () => {
    for (const outcome of baseline.outcomes) {
      expect(outcome['result']).toBe('GAVE_UP');
      // The naive resubmission was refused by the fenced journal, never accepted.
      expect((outcome['attempts'] as Array<{ code: string | null }>).every((a) => a.code !== null)).toBe(
        true,
      );
    }
    for (const evaluation of baseline.evaluations) {
      expect(evaluation.verdict).toBe('REVIEW');
      const inv03 = evaluation.invariantResults.find((r) => r.invariantId === 'INV-03');
      expect(inv03?.explanationCode).toBe('INV03_RECONCILIATION_INCOMPLETE');
    }
    expect(p.store.getCaseRun(baseline.caseRunIds[0] as string)).toMatchObject({
      execution_lifecycle: 'COMPLETED',
      verdict: 'REVIEW',
    });
  });

  it('capture accepts only a case run id, binds exact identity, and lands in quarantine as SANITIZED', async () => {
    const caseRunId = baseline.caseRunIds[0] as string;
    const out = await captureInstalledCase(p.journal, { caseRunId, idempotencyKey: 't029-capture-1' });
    captureId = out.importId;
    expect(out.state).toBe('SANITIZED');
    const view = p.journal.getImport(captureId);
    expect(view.origin).toBe('INSTALLED_ARTIFACT_CAPTURE');
    expect(view.blockingCount).toBe(0);
    const caseRow = p.store.getCaseRun(caseRunId) as Record<string, unknown>;
    const session = p.store.getSession(String(caseRow['session_id'])) as Record<string, unknown>;
    expect(view.captureBinding).toMatchObject({
      case_run_id: caseRunId,
      gate_run_id: baseline.gateRunId,
      session_id: caseRow['session_id'],
      build_revision_id: baseline.build.buildRevisionId,
      artifact_digest: baseline.build.artifactDigest,
      scenario_revision_id: baseline.scenarioRevisionId,
      effect_manifest_digest: session['effect_manifest_digest'],
      effect_coverage_policy_digest: session['effect_coverage_policy_digest'],
      adapter_revision: caseRow['adapter_revision'],
      fencing_epoch: caseRow['fencing_epoch'],
    });
    // The state machine ran CAPTURED_UNTRUSTED -> QUARANTINED -> SANITIZED, recorded as audit facts.
    const transitions = p.journal
      .listImportAudit(captureId)
      .filter((a) => a['action_code'] === 'IMPORT_STATE_CHANGED')
      .map((a) => JSON.parse(String(a['details_json'])) as { from: string; to: string });
    expect(transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      'CAPTURED_UNTRUSTED->QUARANTINED',
      'QUARANTINED->SANITIZED',
    ]);
    capturedTrace = view.sanitized as TraceDocument;
    // Authoritative exchanges, separate subject reports and boundary observations, denials.
    expect(capturedTrace.exchanges.map((x) => `${x.route}:${x.outcome}`)).toEqual([
      'QUOTE:RESPONDED',
      'COMMIT:RESPONSE_LOST',
    ]);
    expect(capturedTrace.denials.filter((x) => x.route === 'COMMIT').length).toBeGreaterThan(0);
    expect(capturedTrace.subjectReports).toEqual([]);
    expect(capturedTrace.boundaryObservations).toEqual([]);
    expect(capturedTrace.identity?.caseVerdict).toBe('REVIEW');
    // Raw bytes are never persisted: the journal holds the raw digest and the sanitized form only.
    expect(view.rawSourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('capture of a case whose client input is still open is refused', async () => {
    const extra = p.createGateRun(baseline.build, baseline.corpusRevisionId, [
      {
        compiled: baseline.compiled,
        scenarioRevisionId: baseline.scenarioRevisionId,
        lineageRole: 'BASELINE',
        requiredInvariants: LIVE_INVARIANTS,
      },
    ]);
    const caseRunId = extra.caseRunIds[0] as string;
    p.supervisor.startCase({ caseRunId, compiled: baseline.compiled, mode: 'SIMULATE' });
    expect(
      await codeAsync(() => captureInstalledCase(p.journal, { caseRunId, idempotencyKey: 't029-open-case' })),
    ).toBe('RS_IMPORT_STATE_INVALID');
    p.supervisor.abort(caseRunId);
  });

  it('nothing can enter a corpus before mapping, deterministic replay, and immutable review', async () => {
    const corporaBefore = p.store.countRows('corpus_revisions');
    const scenariosBefore = p.store.countRows('scenario_revisions');
    const view = p.journal.getImport(captureId);
    // Direct repository promotion without a review is refused by state.
    expect(
      code(() =>
        p.journal.promote({
          importId: captureId,
          expectedRevision: view.revision,
          reviewId: 'no-review',
          idempotencyKey: 't029-premature-promote',
          scenario: {
            revisionInput: baseline.compiled.revisionInput,
            revisionDigest: baseline.compiled.revisionDigest,
            sourceLocator: 'x',
          },
          corpus: {
            label: 'premature',
            baseCorpusRevisionId: baseline.corpusRevisionId,
            newCase: { requiredInvariants: LIVE_INVARIANTS, severity: 'HIGH', gatePolicy: 'REQUIRED' },
          },
        }),
      ),
    ).toBe('RS_IMPORT_STATE_INVALID');
    expect(
      code(() =>
        promoteImport(p.journal, {
          importId: captureId,
          expectedRevision: view.revision,
          reviewId: 'no-review',
          baseCorpusRevisionId: baseline.corpusRevisionId,
          corpusLabel: 'premature',
          severity: 'HIGH',
          gatePolicy: 'REQUIRED',
          idempotencyKey: 't029-premature-promote-2',
        }),
      ),
    ).toBe('RS_IMPORT_REVIEW_INVALID');
    // Review before replay verification is refused.
    expect(
      code(() =>
        reviewImport(p.journal, {
          importId: captureId,
          expectedRevision: view.revision,
          reviewer: 'local-reviewer',
          decisions: approve,
          confirmation: REVIEW_CONFIRMATION,
          idempotencyKey: 't029-review-too-early',
        }),
      ),
    ).not.toBeNull();

    // Map -> replay-verify; review still requires every explicit decision and the confirmation.
    const mapping = proposeMapping({
      trace: capturedTrace,
      sourcePlan: baseline.compiled.plan,
      requiredInvariants: LIVE_INVARIANTS,
      requiredSinkClasses: ['fulfilment-webhook'],
    });
    // A mapping that rewrites the observed exchange sequence or the run-operation lineage is refused.
    const diverging = {
      ...mapping,
      scenario: {
        ...mapping.scenario,
        steps: mapping.scenario.steps.map((s) =>
          s.type === 'drop_response' ? { ...s, type: 'respond' as const } : s,
        ),
      },
    };
    const relinked = {
      ...mapping,
      operations: mapping.operations.map((o) => ({ ...o, phases: { ...o.phases, commitMutation: null } })),
    };
    for (const [bad, expected] of [
      [diverging, 'STEPS_DIVERGE_FROM_TRACE'],
      [relinked, 'OPERATION_LINEAGE_MISMATCH'],
    ] as const) {
      let issues: string[] = [];
      try {
        saveImportMapping(p.journal, {
          importId: captureId,
          expectedRevision: view.revision,
          mapping: bad,
          idempotencyKey: `t029-bad-${expected}`,
        });
      } catch (error) {
        issues = error instanceof MappingRejected ? error.issues.map((i) => i.code) : ['UNTYPED'];
      }
      expect(issues).toEqual([expected]);
    }
    const saved = saveImportMapping(p.journal, {
      importId: captureId,
      expectedRevision: view.revision,
      mapping,
      idempotencyKey: 't029-map-1',
    });
    const replay = await verifyReplay(p.journal, {
      importId: captureId,
      expectedRevision: saved.revision,
      idempotencyKey: 't029-replay-1',
      crossProcess: false,
    });
    expect(replay.verified).toBe(true);
    expect(
      code(() =>
        reviewImport(p.journal, {
          importId: captureId,
          expectedRevision: replay.revision,
          reviewer: 'local-reviewer',
          decisions: { ...approve, PROVENANCE_APPROVED: false },
          confirmation: REVIEW_CONFIRMATION,
          idempotencyKey: 't029-review-partial',
        }),
      ),
    ).toBe('RS_IMPORT_REVIEW_INVALID');
    expect(
      code(() =>
        reviewImport(p.journal, {
          importId: captureId,
          expectedRevision: replay.revision,
          reviewer: 'local-reviewer',
          decisions: approve,
          confirmation: 'yes',
          idempotencyKey: 't029-review-noconfirm',
        }),
      ),
    ).toBe('RS_IMPORT_REVIEW_INVALID');
    expect(p.journal.getImport(captureId).state).toBe('REPLAY_VERIFIED');
    expect(p.store.countRows('corpus_revisions')).toBe(corporaBefore);
    expect(p.store.countRows('scenario_revisions')).toBe(scenariosBefore);
  });

  it('a secret-bearing source is rejected and persists only its digest and safe finding metadata', async () => {
    const configured = `cfg-${'k'.repeat(6)}-${Math.random().toString(36).slice(2, 12)}`;
    const bearer = ['Bea', 'rer ', 'A'.repeat(8), 'b'.repeat(16)].join('');
    const doc = structuredClone(capturedTrace) as TraceDocument;
    doc.annotations.notes = [`support said use ${bearer}`, `configured ${configured}`];
    const bytes = Buffer.from(canonicalJson(doc), 'utf8');
    const out = await importUserFile(p.journal, {
      projectId: p.projectId,
      filename: 'incident.json',
      source: [bytes],
      configuredSecrets: [configured],
      idempotencyKey: 't029-secret-file',
    });
    expect(out.state).toBe('REJECTED');
    const view = p.journal.getImport(out.importId);
    expect(view.sanitized).toBeNull();
    expect(view.findings.map((f) => f.category).sort()).toEqual(['SECRET_BEARER', 'SECRET_CONFIGURED_VALUE']);
    expect(view.findings.every((f) => f.path.startsWith('$.annotations.notes'))).toBe(true);
    const persisted = allPersistedText(`${tmp.dir}/journal.db`);
    expect(persisted.includes(configured)).toBe(false);
    expect(persisted.includes(bearer)).toBe(false);
    expect(
      code(() =>
        saveImportMapping(p.journal, {
          importId: out.importId,
          expectedRevision: view.revision,
          mapping: {},
          idempotencyKey: 't029-map-secret',
        }),
      ),
    ).toBe('RS_IMPORT_STATE_INVALID');
  });

  it('nondeterministic, unresolved, and identity-mismatched sources stay blocked in quarantine', async () => {
    const variants: Array<[string, (t: TraceDocument) => void, string]> = [
      [
        'nondeterministic',
        (t) => {
          const [a, b] = t.exchanges;
          if (a && b) [a.sequence, b.sequence] = [b.sequence, a.sequence];
        },
        'NONDETERMINISTIC_ORDER',
      ],
      [
        'unresolved',
        (t) => {
          const q = t.exchanges[0];
          if (q) q.material = { ...q.material, recipient: '[REDACTED]' };
        },
        'UNRESOLVED_MATERIAL',
      ],
      [
        'identity',
        (t) => {
          if (t.identity) t.identity = { ...t.identity, buildRevisionId: 'some-other-build' };
        },
        'IDENTITY_MISMATCH',
      ],
    ];
    for (const [label, mutate, category] of variants) {
      const doc = structuredClone(capturedTrace) as TraceDocument;
      mutate(doc);
      const out = await importUserFile(p.journal, {
        projectId: p.projectId,
        filename: `${label}.json`,
        source: [Buffer.from(canonicalJson(doc), 'utf8')],
        idempotencyKey: `t029-${label}-file`,
      });
      expect(out.state, label).toBe('SANITIZED');
      const view = p.journal.getImport(out.importId);
      expect(
        view.findings.some((f) => f.category === category && f.blocking),
        label,
      ).toBe(true);
      expect(
        code(() =>
          saveImportMapping(p.journal, {
            importId: out.importId,
            expectedRevision: view.revision,
            mapping: proposeMapping({
              trace: view.sanitized as TraceDocument,
              sourcePlan: null,
              requiredInvariants: LIVE_INVARIANTS,
            }),
            idempotencyKey: `t029-${label}-map`,
          }),
        ),
        label,
      ).toBe('RS_IMPORT_BLOCKED');
    }
  });

  it('a caller-supplied copy is never an installed capture, and a replaced capture cannot promote', async () => {
    // (a) A file claiming to be the installed capture is recorded as a user file.
    const forged = structuredClone(capturedTrace) as TraceDocument;
    const out = await importUserFile(p.journal, {
      projectId: p.projectId,
      filename: '..\\..\\capture.json',
      source: [Buffer.from(canonicalJson(forged), 'utf8')],
      idempotencyKey: 't029-forged-file',
    });
    const view = p.journal.getImport(out.importId);
    expect(view.origin).toBe('USER_FILE');
    expect(view.captureBinding).toBeNull();
    expect(view.sourceFilename).toBe('capture.json');
    expect(view.findings.map((f) => f.category)).toEqual(
      expect.arrayContaining(['ORIGIN_CLAIM_IGNORED', 'PATH_UNSAFE']),
    );
    expect((view.sanitized as TraceDocument).origin).toBe('USER_FILE');
    expect(view.blockingCount).toBe(0);
    // (b) Persisted sanitized content and identity columns cannot be rewritten through the journal.
    expect(
      code(() =>
        p.store.journal.transact('tamper', (db) =>
          db
            .prepare("UPDATE imports SET sanitized_json = '{}', revision = revision + 1 WHERE import_id = ?")
            .run(captureId),
        ),
      ),
    ).toBe('RS_IMMUTABLE_RECORD');
    expect(
      code(() =>
        p.store.journal.transact('tamper', (db) =>
          db
            .prepare("UPDATE imports SET origin = 'USER_FILE', revision = revision + 1 WHERE import_id = ?")
            .run(captureId),
        ),
      ),
    ).toBe('RS_IMMUTABLE_RECORD');
    // (c) When the journal source changes after capture, promotion's re-derivation refuses it.
    const second = await captureInstalledCase(p.journal, {
      caseRunId: baseline.caseRunIds[1] as string,
      idempotencyKey: 't029-capture-2',
    });
    const before = deriveInstalledCapture(p.store, baseline.caseRunIds[1] as string).captureDigest;
    let v = p.journal.getImport(second.importId);
    const mapping = proposeMapping({
      trace: v.sanitized as TraceDocument,
      sourcePlan: baseline.compiled.plan,
      requiredInvariants: LIVE_INVARIANTS,
      requiredSinkClasses: ['fulfilment-webhook'],
    });
    const saved = saveImportMapping(p.journal, {
      importId: second.importId,
      expectedRevision: v.revision,
      mapping,
      idempotencyKey: 't029-map-2',
    });
    const replay = await verifyReplay(p.journal, {
      importId: second.importId,
      expectedRevision: saved.revision,
      idempotencyKey: 't029-replay-2',
      crossProcess: false,
    });
    const review = reviewImport(p.journal, {
      importId: second.importId,
      expectedRevision: replay.revision,
      reviewer: 'local-reviewer',
      decisions: approve,
      confirmation: REVIEW_CONFIRMATION,
      idempotencyKey: 't029-review-2',
    });
    // A late proxy denial is journaled for the captured session after the capture was taken.
    v = p.journal.getImport(second.importId);
    p.store.recordProxyDenial({
      method: 'POST',
      path: '/v0/deposit/submit',
      code: 'RS_TOKEN_REVOKED',
      sessionId: v.sourceSessionId,
    });
    expect(deriveInstalledCapture(p.store, baseline.caseRunIds[1] as string).captureDigest).not.toBe(before);
    const corpora = p.store.countRows('corpus_revisions');
    expect(
      code(() =>
        promoteImport(p.journal, {
          importId: second.importId,
          expectedRevision: review.revision,
          reviewId: review.reviewId,
          baseCorpusRevisionId: baseline.corpusRevisionId,
          corpusLabel: 'release-corpus+replaced',
          severity: 'HIGH',
          gatePolicy: 'REQUIRED',
          idempotencyKey: 't029-promote-replaced',
        }),
      ),
    ).toBe('RS_IMPORT_CAPTURE_MISMATCH');
    expect(p.store.countRows('corpus_revisions')).toBe(corpora);
    expect(p.journal.getImport(second.importId).state).toBe('REVIEWED');
  });
});
