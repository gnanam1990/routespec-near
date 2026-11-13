/**
 * `list_findings`: what a gate run found, per case, in the kernel's own words, with the fix
 * patterns that answer each remediation code. Only invariants the MCP gate requires are listed
 * as findings; INV-04 (needs a contained run) is counted separately so it is never mistaken for
 * a defect of the client.
 */
import { REQUIRED_INVARIANTS, type GateRunRecord } from './gate.ts';
import { explanationText, INVARIANTS, PATTERNS_FOR_REMEDIATION, remediationText } from './knowledge.ts';

export interface Finding {
  readonly invariantId: string;
  readonly title: string;
  readonly verdict: string;
  readonly explanationCode: string | null;
  readonly explanation: string | null;
  readonly remediationCode: string | null;
  readonly remediation: string | null;
  readonly missingPredicates: readonly string[];
  readonly occurrences: number;
  readonly fixPatterns: readonly string[];
}

export interface CaseFindings {
  readonly ordinal: number;
  readonly scenario: string;
  readonly contribution: string;
  readonly caseFindings: readonly string[];
  readonly invariants: readonly Finding[];
  readonly clientOutcome: Record<string, unknown> | null;
  readonly clientError: string | null;
}

export interface FindingsReport {
  readonly runId: string;
  readonly client: string;
  readonly artifactDigest: string;
  readonly decision: string;
  readonly gateFindings: readonly string[];
  readonly cases: readonly CaseFindings[];
  /** Fix patterns to apply first, most severe finding first. */
  readonly nextFixPatterns: readonly string[];
  readonly notRequired: { readonly invariants: readonly string[]; readonly note: string };
  readonly evidenceUse: string;
}

const SEVERITY: Record<string, number> = { FAIL: 0, REVIEW: 1, UNSUPPORTED: 2, NOT_RUN: 3, PASS: 4 };

export function buildFindings(
  run: GateRunRecord,
  options: { includePassing?: boolean } = {},
): FindingsReport {
  const required = new Set<string>(REQUIRED_INVARIANTS);
  const cases: CaseFindings[] = [];
  const ranked: Array<{ severity: number; patterns: readonly string[] }> = [];
  for (const c of run.cases) {
    if (c.contribution === 'PASS' && options.includePassing !== true) continue;
    const grouped = new Map<string, Finding>();
    for (const inv of c.invariants) {
      if (!required.has(inv.invariantId) || inv.verdict === 'PASS') continue;
      const key = `${inv.invariantId}|${inv.verdict}|${inv.explanationCode ?? ''}`;
      const prior = grouped.get(key);
      if (prior !== undefined) {
        grouped.set(key, {
          ...prior,
          occurrences: prior.occurrences + 1,
          missingPredicates: [...new Set([...prior.missingPredicates, ...inv.missingPredicates])],
        });
        continue;
      }
      const fixPatterns =
        (inv.remediationCode !== null ? PATTERNS_FOR_REMEDIATION[inv.remediationCode] : undefined) ??
        INVARIANTS[inv.invariantId]?.fixPatterns ??
        [];
      grouped.set(key, {
        invariantId: inv.invariantId,
        title: INVARIANTS[inv.invariantId]?.title ?? inv.invariantId,
        verdict: inv.verdict,
        explanationCode: inv.explanationCode,
        explanation: explanationText(inv.explanationCode),
        remediationCode: inv.remediationCode,
        remediation: remediationText(inv.remediationCode),
        missingPredicates: inv.missingPredicates,
        occurrences: 1,
        fixPatterns,
      });
    }
    const invariants = [...grouped.values()].sort(
      (a, b) =>
        (SEVERITY[a.verdict] ?? 9) - (SEVERITY[b.verdict] ?? 9) || a.invariantId.localeCompare(b.invariantId),
    );
    for (const f of invariants) ranked.push({ severity: SEVERITY[f.verdict] ?? 9, patterns: f.fixPatterns });
    cases.push({
      ordinal: c.ordinal,
      scenario: c.scenario,
      contribution: c.contribution,
      caseFindings: c.findings,
      invariants,
      clientOutcome: c.clientOutcome,
      clientError: c.clientError,
    });
  }
  ranked.sort((a, b) => a.severity - b.severity);
  const nextFixPatterns = [...new Set(ranked.flatMap((r) => r.patterns))];
  return {
    runId: run.runId,
    client: run.client,
    artifactDigest: run.artifactDigest,
    decision: run.decision,
    gateFindings: run.findings,
    cases,
    nextFixPatterns,
    notRequired: {
      invariants: ['INV-04', 'INV-09'],
      note: 'INV-04 is judged only in a contained run with an independent effect interceptor; INV-09 is replay identity. Neither is required by this uncontained gate.',
    },
    evidenceUse: run.evidenceUse,
  };
}
