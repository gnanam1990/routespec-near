/**
 * M16 — release-evidence refusal on every surface the spec names (RP-08: promotion, corpus,
 * gate aggregation, bundle export) and the CLI side of the profile review workflow (RP-02,
 * RP-06), through the real journal, the real installed subject, and the real CLI process.
 *
 * - A user-file trace is never release evidence: the default promotion is refused with
 *   RS_CAPTURE_NOT_RELEASE_EVIDENCE and its reasons, by the API function and by
 *   `regression promote`; `--diagnostic-only` adds it only as an ADVISORY case.
 * - A corpus can never make such a case REQUIRED (create and revise are both refused).
 * - Gate aggregation never lets a required non-release-evidence case contribute PASS.
 * - `export plan` refuses a release-evidence bundle for a gate that uses it; the explicit
 *   diagnostic bundle verifies, and tampering with its declared use fails verification.
 * - `profile review-sign` signs only with the key the statement names; `profile review-status`
 *   reports REVIEWED only after the signed review is recorded.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROFILE_REVIEW_CHECKLIST, isRouteSpecError } from '@routespec/contracts';
import { compileMapping } from '@routespec/regressions';
import { GateService, aggregateGate, readTar, writeTar } from '@routespec/runner';
import { CORE_SCENARIO_SOURCES, compileScenario } from '@routespec/scenario';
import {
  ControlJournal,
  ProfileReviewJournal,
  RouteSpecStore,
  reviewerEnrollmentPlanDigest,
} from '@routespec/store';
import { LIVE_INVARIANTS, Product, Subject } from '../../regressions/test/support/product.ts';
import { promoteUserTrace, simpleUserTrace } from '../../regressions/test/support/traces.ts';
import { gateInput } from './support/gate-fixture.ts';
import { runCliProcess, tempDir } from './support/product.ts';

let tmp: ReturnType<typeof tempDir>;
let data: string;
let gateEvaluationId = '';
let refusedImportId = '';
let refusedReviewId = '';
let diagnosticCorpus = '';
let projectId = '';
let profileDigest = '';
let challengeFile = '';
let challengeId = '';
const reviewer = generateKeyPairSync('ed25519');
const stranger = generateKeyPairSync('ed25519');

function codeOf(fn: () => unknown): { code: string | null; reasons: unknown } {
  try {
    fn();
    return { code: null, reasons: null };
  } catch (error) {
    return isRouteSpecError(error)
      ? { code: error.code, reasons: error.details['reasons'] ?? null }
      : { code: `UNTYPED:${String(error)}`, reasons: null };
  }
}

const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const cli = (args: string[]) => runCliProcess([...args, '--data', data]);
const happy = compileScenario(CORE_SCENARIO_SOURCES['happy-path'] as string);
const dropProcessing = (m: Parameters<typeof compileMapping>[0]) => ({
  ...m,
  scenario: { ...m.scenario, steps: m.scenario.steps.filter((s) => s.id !== 'processing') },
});

beforeAll(async () => {
  tmp = tempDir('routespec-m16-cli-');
  data = tmp.dir;
  const p = await Product.open(data, 'm16');
  try {
    projectId = p.projectId;
    const s1 = p.store.createScenarioRevision({ ...happy.revisionInput, reviewStatus: 'REVIEWED' });
    const c1 = p.store.createCorpusRevision({
      label: 'release',
      cases: [
        {
          scenarioRevisionId: s1.scenarioRevisionId,
          requiredInvariants: LIVE_INVARIANTS,
          severity: 'HIGH',
          gatePolicy: 'REQUIRED',
        },
      ],
    });
    // 1. The default (release-evidence) promotion of a user file is refused.
    let refused: { code: string | null; reasons: unknown } = { code: null, reasons: null };
    try {
      await promoteUserTrace(p, {
        trace: simpleUserTrace('m16-refused'),
        tag: 'm16-refused',
        sourcePlan: happy.plan,
        baseCorpusRevisionId: c1.corpusRevisionId,
        corpusLabel: 'release + user trace',
        requiredInvariants: LIVE_INVARIANTS,
        edit: dropProcessing,
        evidenceUse: 'RELEASE_EVIDENCE',
        gatePolicy: 'REQUIRED',
      });
    } catch (error) {
      refused = isRouteSpecError(error)
        ? { code: error.code, reasons: error.details['reasons'] ?? null }
        : { code: 'UNTYPED', reasons: null };
    }
    expect(refused).toEqual({
      code: 'RS_CAPTURE_NOT_RELEASE_EVIDENCE',
      reasons: ['DECLARED_HOOKS_ONLY', 'NOT_INSTALLED_CAPTURE'],
    });
    refusedImportId = String(
      p.store.journal.read(
        (db) =>
          db.prepare("SELECT import_id FROM imports WHERE state = 'REVIEWED'").get() as Record<
            string,
            unknown
          >,
      )['import_id'],
    );
    refusedReviewId = String(
      p.store.journal.read(
        (db) =>
          db
            .prepare('SELECT review_id FROM import_reviews WHERE import_id = ?')
            .get(refusedImportId) as Record<string, unknown>,
      )['review_id'],
    );
    // 2. The explicit diagnostic-only promotion of another trace is an ADVISORY case.
    const { importId, mapping, promotion } = await promoteUserTrace(p, {
      trace: simpleUserTrace('m16-diagnostic'),
      tag: 'm16-diagnostic',
      sourcePlan: happy.plan,
      baseCorpusRevisionId: c1.corpusRevisionId,
      corpusLabel: 'release + diagnostic user trace',
      requiredInvariants: LIVE_INVARIANTS,
      edit: dropProcessing,
    });
    expect(promotion).toMatchObject({ evidenceUse: 'DIAGNOSTIC_ONLY' });
    diagnosticCorpus = promotion.corpusRevisionId;
    const corpus = p.journal.getCorpus(diagnosticCorpus);
    expect(corpus.cases.map((c) => c.gatePolicy)).toEqual(['REQUIRED', 'ADVISORY']);

    // 3. The real corrected client runs both cases; the gate is evaluated from the journal.
    const corrected = p.registerBuild('corrected-client');
    const promotedPlan = compileMapping(mapping, importId);
    const gate = p.createGateRun(
      corrected,
      diagnosticCorpus,
      corpus.cases.map((c, i) => ({
        compiled: i === 0 ? happy : promotedPlan,
        scenarioRevisionId: c.scenarioRevisionId,
        lineageRole: i === 0 ? ('CORRECTED' as const) : ('PROMOTED_REGRESSION' as const),
        requiredInvariants: c.requiredInvariants,
      })),
    );
    const subject = await Subject.launch('corrected-client');
    try {
      for (let i = 0; i < gate.caseRunIds.length; i++) {
        const caseRunId = gate.caseRunIds[i] as string;
        await p.runCase(
          subject,
          caseRunId,
          i === 0 ? happy : promotedPlan,
          { logicalJob: `m16-order-${i}`, txHash: `sim-tx-m16-${i}` },
          i === 0 ? 'attach' : 'reset',
        );
        p.evaluate(caseRunId);
      }
    } finally {
      await subject.close();
    }
    const evaluated = new GateService(p.store).evaluateGate(gate.gateRunId);
    gateEvaluationId = evaluated.evaluation.gateEvaluationId;

    // 4. A local test reviewer and one review challenge for a registered profile.
    const control = new ControlJournal(p.store);
    const reviews = new ProfileReviewJournal(control);
    profileDigest = control.registerInterceptorProfile({
      projectId,
      interceptorArtifactDigest: `sha256:${sha256Hex('m16-canary')}`,
      containment: 'PROCESS_TREE_ENFORCED',
      processTreeScope: 'linux-container:network-none',
      supportedSinks: ['fulfilment-webhook'],
      denialMechanism: 'CANARY_REDIRECT',
    }).profileDigest;
    const x = String(reviewer.publicKey.export({ format: 'jwk' }).x);
    const plan = {
      projectId,
      label: 'local test reviewer',
      publicKeyX: x,
      validFromMs: Date.now() - 60_000,
      validUntilMs: Date.now() + 3_600_000,
    };
    const planDigest = reviewerEnrollmentPlanDigest(plan);
    const conf = control.issueConfirmation({
      actionCode: 'PROFILE_REVIEWER_ENROLL',
      planDigest,
      ttlMs: 60_000,
    });
    const { reviewerId } = reviews.enrollReviewer({
      projectId,
      label: plan.label,
      publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x },
      validFromMs: plan.validFromMs,
      validUntilMs: plan.validUntilMs,
      confirmation: { confirmationId: conf.confirmationId, code: conf.code, planDigest },
    });
    const challenge = reviews.createReviewChallenge({
      projectId,
      profileDigest,
      reviewerId,
      decision: 'APPROVED',
      checklist: Object.fromEntries(PROFILE_REVIEW_CHECKLIST.map((c) => [c, true])),
      ttlMs: 10 * 60_000,
    });
    challengeId = challenge.challengeId;
    challengeFile = join(tmp.dir, 'challenge.json');
    writeFileSync(challengeFile, JSON.stringify({ challengeId, statement: challenge.statement }));
    writeFileSync(
      join(tmp.dir, 'reviewer.pem'),
      reviewer.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    );
    writeFileSync(
      join(tmp.dir, 'stranger.pem'),
      stranger.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    );

    // 5. Corpora can never make the diagnostic case REQUIRED.
    const required = corpus.cases.map((c) => ({ ...c, gatePolicy: 'REQUIRED' }));
    expect(codeOf(() => p.store.createCorpusRevision({ label: 'forced', cases: required })).code).toBe(
      'RS_CAPTURE_NOT_RELEASE_EVIDENCE',
    );
    expect(
      codeOf(() =>
        p.journal.reviseCorpus({
          baseCorpusRevisionId: diagnosticCorpus,
          label: 'forced revision',
          cases: required,
          idempotencyKey: 'm16-forced-revision',
        }),
      ).code,
    ).toBe('RS_CAPTURE_NOT_RELEASE_EVIDENCE');
  } finally {
    await p.close();
  }
}, 180_000);

afterAll(() => tmp?.cleanup());

describe('M16 — release-evidence refusal and profile review on the CLI and the journal', () => {
  it('gate aggregation never lets a required non-release-evidence case pass; FAIL still dominates', () => {
    const base = gateInput(['PASS', 'PASS']);
    expect(aggregateGate(base).decision).toBe('PASS');
    for (const cls of ['DIAGNOSTIC_ONLY', 'UNCLASSIFIED'] as const) {
      const input = {
        ...base,
        cases: base.cases.map((c, i) =>
          i === 1 && c.corpusCase ? { ...c, corpusCase: { ...c.corpusCase, evidenceClass: cls } } : c,
        ),
      };
      const d = aggregateGate(input);
      expect(d.decision).toBe('REVIEW');
      expect(d.cases[1]?.findings).toContain(`CAPTURE_NOT_RELEASE_EVIDENCE:${cls}`);
      // An ADVISORY diagnostic case is not required and does not change the decision.
      const advisory = {
        ...input,
        cases: input.cases.map((c, i) =>
          i === 1 && c.corpusCase ? { ...c, corpusCase: { ...c.corpusCase, gatePolicy: 'ADVISORY' } } : c,
        ),
      };
      expect(aggregateGate(advisory).decision).toBe('PASS');
    }
    const failing = gateInput(['FAIL', 'PASS']);
    const failingDiagnostic = {
      ...failing,
      cases: failing.cases.map((c, i) =>
        i === 1 && c.corpusCase
          ? { ...c, corpusCase: { ...c.corpusCase, evidenceClass: 'DIAGNOSTIC_ONLY' as const } }
          : c,
      ),
    };
    expect(aggregateGate(failingDiagnostic).decision).toBe('FAIL');
  });

  it('regression evidence and regression promote refuse a user file; --diagnostic-only adds an ADVISORY case', async () => {
    const ev = await cli(['regression', 'evidence', '--import', refusedImportId]);
    expect(ev.exitCode).toBe(3);
    expect(ev.json).toMatchObject({
      releaseEvidence: false,
      refusalReasons: ['DECLARED_HOOKS_ONLY', 'NOT_INSTALLED_CAPTURE'],
    });
    const args = [
      'regression',
      'promote',
      '--import',
      refusedImportId,
      '--review',
      refusedReviewId,
      '--label',
      'cli',
    ];
    const refused = await cli(args);
    expect(refused.exitCode).toBe(6);
    expect(refused.json?.['error']).toMatchObject({
      code: 'RS_CAPTURE_NOT_RELEASE_EVIDENCE',
      details: { reasons: ['DECLARED_HOOKS_ONLY', 'NOT_INSTALLED_CAPTURE'] },
    });
    expect(refused.stderr).toContain('RS_CAPTURE_NOT_RELEASE_EVIDENCE');
    const required = await cli([...args, '--diagnostic-only', '--gate-policy', 'required']);
    expect(required.exitCode).toBe(6);
    const ok = await cli([...args, '--diagnostic-only']);
    expect(ok.exitCode, ok.stderr).toBe(0);
    expect(ok.json).toMatchObject({
      evidenceUse: 'DIAGNOSTIC_ONLY',
      refusalReasons: ['DECLARED_HOOKS_ONLY', 'NOT_INSTALLED_CAPTURE'],
    });
    expect(ok.stderr).toContain('DIAGNOSTIC_ONLY');
  });

  it('export plan refuses a release-evidence bundle for a gate with a diagnostic capture; the diagnostic bundle verifies', async () => {
    const refused = await cli(['export', 'plan', '--gate-evaluation', gateEvaluationId]);
    expect(refused.exitCode).toBe(6);
    expect(refused.json?.['error']).toMatchObject({
      code: 'RS_CAPTURE_NOT_RELEASE_EVIDENCE',
      details: { reasons: ['CAPTURE_NOT_RELEASE_EVIDENCE:DIAGNOSTIC_ONLY'] },
    });
    const plan = await cli([
      'export',
      'plan',
      '--gate-evaluation',
      gateEvaluationId,
      '--evidence-use',
      'diagnostic-only',
    ]);
    expect(plan.exitCode, plan.stderr).toBe(0);
    const bundle = join(tmp.dir, 'diagnostic.tar');
    const w = await cli([
      'export',
      'write',
      '--export',
      String(plan.json?.['exportId']),
      '--out',
      bundle,
      '--confirm',
      String(plan.json?.['confirm']),
    ]);
    expect(w.exitCode, w.stderr).toBe(0);
    const v = await runCliProcess([
      'export',
      'verify',
      '--bundle',
      bundle,
      '--extract-to',
      join(tmp.dir, 'x1'),
    ]);
    expect(v.exitCode, v.stdout).toBe(0);
    const entries = readTar(readFileSync(bundle));
    const manifest = JSON.parse(String(entries.find((e) => e.path === 'manifest.json')?.content)) as Record<
      string,
      unknown
    >;
    expect(manifest['evidenceUse']).toBe('DIAGNOSTIC_ONLY');
    expect(manifest['releaseEvidence']).toMatchObject({
      refusals: ['CAPTURE_NOT_RELEASE_EVIDENCE:DIAGNOSTIC_ONLY'],
    });

    // Mutation checks: relabel the bundle as release evidence with consistent checksums.
    const rewrite = (name: string, mutate: (files: Map<string, Buffer>) => void) => {
      const files = new Map(entries.map((e) => [e.path, Buffer.from(e.content)]));
      mutate(files);
      const m = JSON.parse(String(files.get('manifest.json'))) as {
        entries: Array<{ path: string; digest: string; bytes: number }>;
      };
      for (const e of m.entries) {
        const b = files.get(e.path) as Buffer;
        e.digest = `sha256:${sha256Hex(b)}`;
        e.bytes = b.length;
      }
      files.set('manifest.json', Buffer.from(JSON.stringify(m)));
      const sums = [...files.keys()]
        .filter((k) => k !== 'checksums.sha256')
        .sort()
        .map((k) => `${sha256Hex(files.get(k) as Buffer)}  ${k}`)
        .join('\n');
      files.set('checksums.sha256', Buffer.from(`${sums}\n`));
      const out = join(tmp.dir, `${name}.tar`);
      writeFileSync(out, writeTar([...files].map(([path, content]) => ({ path, content }))));
      return out;
    };
    const asRelease = (files: Map<string, Buffer>, alsoEvidence: boolean) => {
      const m = JSON.parse(String(files.get('manifest.json'))) as Record<string, unknown>;
      m['evidenceUse'] = 'RELEASE_EVIDENCE';
      m['releaseEvidence'] = { ...(m['releaseEvidence'] as object), refusals: [] };
      files.set('manifest.json', Buffer.from(JSON.stringify(m)));
      if (alsoEvidence) {
        const e = JSON.parse(String(files.get('evidence/release-evidence.json'))) as Record<string, unknown>;
        e['evidenceUse'] = 'RELEASE_EVIDENCE';
        e['refusals'] = [];
        files.set('evidence/release-evidence.json', Buffer.from(JSON.stringify(e)));
      }
    };
    for (const [name, also, failing] of [
      ['manifest-only', false, 'evidence-use-declared'],
      ['manifest-and-classification', true, 'evidence-use-declared'],
    ] as const) {
      const tampered = rewrite(name, (f) => asRelease(f, also));
      const r = await runCliProcess([
        'export',
        'verify',
        '--bundle',
        tampered,
        '--extract-to',
        join(tmp.dir, `x-${name}`),
      ]);
      expect(r.exitCode, name).toBe(5);
      const checks = r.json?.['checks'] as Array<{ name: string; ok: boolean }>;
      expect(checks.find((c) => c.name === failing)?.ok, name).toBe(false);
    }
  });

  it('profile review-sign signs only with the named reviewer key; review-status turns REVIEWED only after recording', async () => {
    const wrong = await runCliProcess([
      'profile',
      'review-sign',
      '--challenge',
      challengeFile,
      '--key',
      join(tmp.dir, 'stranger.pem'),
    ]);
    expect(wrong.exitCode).toBe(4);
    expect(wrong.json?.['error']).toMatchObject({ code: 'RS_IDENTITY_MISMATCH' });
    expect(wrong.json?.['signature']).toBeUndefined();
    const before = await cli([
      'profile',
      'review-status',
      '--project',
      projectId,
      '--profile',
      profileDigest,
    ]);
    expect(before.exitCode).toBe(0);
    expect(before.json).toMatchObject({
      declaredState: 'DECLARED_UNREVIEWED',
      reviewState: 'DECLARED_UNREVIEWED',
    });
    const signed = await runCliProcess([
      'profile',
      'review-sign',
      '--challenge',
      challengeFile,
      '--key',
      join(tmp.dir, 'reviewer.pem'),
    ]);
    expect(signed.exitCode, signed.stderr).toBe(0);
    expect(signed.stdout).not.toContain('PRIVATE KEY');
    const store = RouteSpecStore.open({ path: join(data, 'journal.db') });
    try {
      const reviews = new ProfileReviewJournal(new ControlJournal(store));
      reviews.recordReview({ challengeId, signature: String(signed.json?.['signature']) });
    } finally {
      store.close();
    }
    const after = await cli(['profile', 'review-status', '--project', projectId, '--profile', profileDigest]);
    expect(after.json).toMatchObject({
      declaredState: 'DECLARED_UNREVIEWED',
      reviewState: 'REVIEWED',
      independentHumanReview: 'NOT_ESTABLISHED_BY_RECORDS',
    });
    expect((after.json?.['reviews'] as unknown[]).length).toBe(1);
  });
});
