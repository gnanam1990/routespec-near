/**
 * Capture-to-regression lineage and corrected-client status (FR-11; API-SPEC section 9).
 *
 * Promotion alone never completes a regression: replay-only PASS is insufficient. The
 * regression is complete only after the corrected installed client — a different subject build
 * from the one the capture came from — runs the promoted scenario from the new corpus through
 * the normal adapter/proxy/journal/kernel path and that case reaches a complete PASS.
 */
import type { ImportJournal } from '@routespec/store';

export type RegressionStatus =
  | 'IN_QUARANTINE'
  | 'REJECTED'
  | 'PROMOTED_AWAITING_CORRECTED_RUN'
  | 'CORRECTED_RUN_NOT_PASSING'
  | 'CORRECTED_RUN_PASSED';

export interface RegressionLineage {
  readonly importId: string;
  readonly origin: string;
  readonly state: string;
  readonly source: {
    readonly caseRunId: string | null;
    readonly gateRunId: string | null;
    readonly buildRevisionId: string | null;
    readonly scenarioRevisionId: string | null;
  };
  readonly promotion: {
    readonly scenarioRevisionId: string;
    readonly corpusRevisionId: string;
    readonly baseCorpusRevisionId: string | null;
    /** M16: RELEASE_EVIDENCE, DIAGNOSTIC_ONLY, or UNCLASSIFIED (promoted before M16). */
    readonly evidenceUse: 'RELEASE_EVIDENCE' | 'DIAGNOSTIC_ONLY' | 'UNCLASSIFIED';
    readonly refusalReasons: readonly string[];
  } | null;
  readonly correctedRuns: ReadonlyArray<{
    readonly gateRunId: string;
    readonly caseRunId: string;
    readonly buildRevisionId: string;
    readonly lineageRole: string;
    readonly lifecycle: string;
    readonly verdict: string | null;
  }>;
  readonly status: RegressionStatus;
}

export function regressionLineage(journal: ImportJournal, importId: string): RegressionLineage {
  const view = journal.getImport(importId);
  const b = view.captureBinding;
  const source = {
    caseRunId: b ? String(b['case_run_id']) : null,
    gateRunId: b ? String(b['gate_run_id']) : null,
    buildRevisionId: b ? String(b['build_revision_id']) : null,
    scenarioRevisionId: b ? String(b['scenario_revision_id']) : null,
  };
  const p = journal.getPromotion(importId);
  const cls = p ? journal.getPromotionEvidenceClass(String(p['promotion_id'])) : undefined;
  const promotion = p
    ? {
        scenarioRevisionId: String(p['scenario_revision_id']),
        corpusRevisionId: String(p['corpus_revision_id']),
        baseCorpusRevisionId:
          typeof p['base_corpus_revision_id'] === 'string' ? p['base_corpus_revision_id'] : null,
        evidenceUse: (cls ? String(cls['evidence_use']) : 'UNCLASSIFIED') as
          | 'RELEASE_EVIDENCE'
          | 'DIAGNOSTIC_ONLY'
          | 'UNCLASSIFIED',
        refusalReasons: cls ? (JSON.parse(String(cls['refusal_reasons_json'])) as string[]) : [],
      }
    : null;
  const correctedRuns = promotion
    ? journal
        .listCaseRunsFor(promotion.corpusRevisionId, promotion.scenarioRevisionId)
        .filter((r) => source.buildRevisionId === null || r['build_revision_id'] !== source.buildRevisionId)
        .map((r) => ({
          gateRunId: String(r['gate_run_id']),
          caseRunId: String(r['case_run_id']),
          buildRevisionId: String(r['build_revision_id']),
          lineageRole: String(r['lineage_role']),
          lifecycle: String(r['execution_lifecycle']),
          verdict: typeof r['verdict'] === 'string' ? r['verdict'] : null,
        }))
    : [];
  let status: RegressionStatus;
  if (view.state === 'REJECTED' || view.state === 'PURGED') status = 'REJECTED';
  else if (!promotion) status = 'IN_QUARANTINE';
  else if (correctedRuns.length === 0) status = 'PROMOTED_AWAITING_CORRECTED_RUN';
  else if (
    correctedRuns.some(
      (r) => r.lineageRole === 'PROMOTED_REGRESSION' && r.lifecycle === 'COMPLETED' && r.verdict === 'PASS',
    )
  ) {
    status = 'CORRECTED_RUN_PASSED';
  } else status = 'CORRECTED_RUN_NOT_PASSING';
  return { importId, origin: view.origin, state: view.state, source, promotion, correctedRuns, status };
}
