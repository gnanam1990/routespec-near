/**
 * Machine-readable gate reports (FR-14, FR-18). Every format is rendered from one persisted
 * gate evaluation, so identity, decision, and counts agree by construction and are checked by
 * T-035.
 *
 * - JSON (`routespec.gate-report/1`): the authoritative machine output.
 * - JUnit: one testcase per case run. FAIL -> <failure>, REVIEW/UNSUPPORTED/incomplete ->
 *   <error type="REVIEW">, NOT_RUN -> <skipped>. Decision and identity are suite properties.
 * - SARIF 2.1.0: results only for findings that carry a real source location. RouteSpec v2
 *   findings are journal facts, not source positions, so a gate evaluation normally yields zero
 *   results; locations are never invented.
 *
 * Enforcement is capped at REQUIRED_CHECK_UNVERIFIED and is always reported as unverified and
 * non-blocking. Artifact readiness is a separate field.
 */
import type { EnforcementMode, Verdict } from '@routespec/contracts';
import type { GateEvaluationView } from '@routespec/store';
import { exitCodeForDecision } from './aggregate.ts';

export const GATE_REPORT_SCHEMA = 'routespec.gate-report/1' as const;
export const SARIF_SCHEMA_URI = 'https://json.schemastore.org/sarif-2.1.0.json';

export interface SourceLocatableFinding {
  readonly ruleId: string;
  readonly message: string;
  readonly uri: string;
  readonly startLine?: number;
}

export interface GateReport {
  readonly schema: typeof GATE_REPORT_SCHEMA;
  readonly gateEvaluationId: string;
  readonly gateRunId: string;
  readonly decision: Verdict;
  readonly decisionDigest: string;
  readonly identityDigest: string;
  readonly aggregatorRevision: string;
  readonly exitCode: 0 | 2 | 3;
  readonly identity: Record<string, unknown>;
  readonly enforcement: {
    readonly mode: EnforcementMode;
    readonly digest: string;
    readonly verified: false;
    readonly blocking: false;
    readonly note: string;
  };
  readonly artifact: { readonly ready: boolean; readonly exportIds: readonly string[] };
  readonly counts: {
    readonly total: number;
    readonly required: number;
    readonly pass: number;
    readonly fail: number;
    readonly review: number;
    readonly notRun: number;
    readonly unsupported: number;
  };
  readonly findings: readonly string[];
  readonly cases: ReadonlyArray<{
    readonly ordinal: number;
    readonly caseRunId: string | null;
    readonly required: boolean;
    readonly lifecycle: string | null;
    readonly caseVerdict: Verdict | null;
    readonly contribution: Verdict;
    readonly resultDigest: string | null;
    readonly fencingEpoch: number | null;
    readonly findings: readonly string[];
  }>;
  readonly labels: readonly string[];
  readonly createdAtMs: number;
}

export function buildGateReport(view: GateEvaluationView): GateReport {
  const count = (v: Verdict) => view.cases.filter((c) => c.contribution === v).length;
  const labels = [
    'SIMULATION_OR_REPLAY_ONLY: proven within scenario',
    'ENFORCEMENT_UNVERIFIED: no repository-settings verification; never blocking',
  ];
  if (view.identity['buildAttestationClass'] === 'USER_ASSERTED_LOCAL') {
    labels.push('BUILD_USER_ASSERTED_LOCAL: build identity is user-asserted, not attested');
  }
  return {
    schema: GATE_REPORT_SCHEMA,
    gateEvaluationId: view.gateEvaluationId,
    gateRunId: view.gateRunId,
    decision: view.decision,
    decisionDigest: view.decisionDigest,
    identityDigest: view.identityDigest,
    aggregatorRevision: view.aggregatorRevision,
    exitCode: exitCodeForDecision(view.decision),
    identity: view.identity,
    enforcement: {
      mode: view.enforcementMode,
      digest: view.enforcementDigest,
      verified: false,
      blocking: false,
      note: 'RouteSpec v2 has no repository-settings verification adapter; this state is advisory or unverified.',
    },
    artifact: { ready: view.artifactReady, exportIds: [...view.exportIds] },
    counts: {
      total: view.cases.length,
      required: view.cases.filter((c) => c.required).length,
      pass: count('PASS'),
      fail: count('FAIL'),
      review: count('REVIEW'),
      notRun: count('NOT_RUN'),
      unsupported: count('UNSUPPORTED'),
    },
    findings: [...view.findings],
    cases: view.cases.map((c) => ({
      ordinal: c.ordinal,
      caseRunId: c.caseRunId,
      required: c.required,
      lifecycle: c.lifecycle,
      caseVerdict: c.caseVerdict,
      contribution: c.contribution,
      resultDigest: c.resultDigest,
      fencingEpoch: c.fencingEpoch,
      findings: [...c.findings],
    })),
    labels,
    createdAtMs: view.createdAtMs,
  };
}

/** Stable JSON rendering (two-space indentation, trailing newline). */
export function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

export function renderJUnit(report: GateReport): string {
  const failures = report.cases.filter((c) => c.contribution === 'FAIL').length;
  const errors = report.cases.filter(
    (c) => c.contribution === 'REVIEW' || c.contribution === 'UNSUPPORTED',
  ).length;
  const skipped = report.cases.filter((c) => c.contribution === 'NOT_RUN').length;
  const props: Array<[string, string]> = [
    ['routespec.schema', report.schema],
    ['routespec.gateEvaluationId', report.gateEvaluationId],
    ['routespec.gateRunId', report.gateRunId],
    ['routespec.decision', report.decision],
    ['routespec.decisionDigest', report.decisionDigest],
    ['routespec.identityDigest', report.identityDigest],
    ['routespec.buildRevisionId', String(report.identity['buildRevisionId'])],
    ['routespec.artifactDigest', String(report.identity['artifactDigest'])],
    ['routespec.corpusRevisionId', String(report.identity['corpusRevisionId'])],
    ['routespec.enforcementMode', report.enforcement.mode],
    ['routespec.enforcementVerified', 'false'],
    ['routespec.artifactReady', String(report.artifact.ready)],
    ['routespec.gateFindings', report.findings.join(',')],
  ];
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="routespec" tests="${report.cases.length}" failures="${failures}" errors="${errors}" skipped="${skipped}">`,
    `  <testsuite name="routespec gate ${xml(report.gateRunId)}" tests="${report.cases.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" timestamp="${new Date(report.createdAtMs).toISOString()}">`,
    '    <properties>',
    ...props.map(([k, v]) => `      <property name="${xml(k)}" value="${xml(v)}"/>`),
    '    </properties>',
  ];
  for (const c of report.cases) {
    const name = `case ${c.ordinal}${c.required ? '' : ' (advisory)'}`;
    lines.push(
      `    <testcase classname="routespec.gate.${xml(report.gateRunId)}" name="${xml(name)}" id="${xml(c.caseRunId ?? `missing-${c.ordinal}`)}">`,
    );
    const detail = xml(c.findings.join(', ') || 'none');
    if (c.contribution === 'FAIL') lines.push(`      <failure type="FAIL" message="${detail}"/>`);
    else if (c.contribution === 'REVIEW' || c.contribution === 'UNSUPPORTED') {
      lines.push(`      <error type="${c.contribution}" message="${detail}"/>`);
    } else if (c.contribution === 'NOT_RUN') lines.push(`      <skipped message="NOT_RUN: ${detail}"/>`);
    lines.push(
      `      <system-out>${xml(`lifecycle=${c.lifecycle ?? 'MISSING'} caseVerdict=${c.caseVerdict ?? 'null'} contribution=${c.contribution} resultDigest=${c.resultDigest ?? 'null'}`)}</system-out>`,
    );
    lines.push('    </testcase>');
  }
  lines.push('  </testsuite>', '</testsuites>', '');
  return lines.join('\n');
}

/**
 * SARIF 2.1.0 with results only for source-locatable findings. A finding without a URI is not
 * source-locatable and is never given a fabricated location.
 */
export function renderSarif(report: GateReport, locatable: readonly SourceLocatableFinding[] = []): string {
  const real = locatable.filter((f) => typeof f.uri === 'string' && f.uri.length > 0);
  const rules = [...new Set(real.map((f) => f.ruleId))].sort().map((id) => ({ id }));
  const sarif = {
    $schema: SARIF_SCHEMA_URI,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'RouteSpec',
            semanticVersion: '2.0.0',
            rules,
          },
        },
        properties: {
          'routespec.schema': report.schema,
          'routespec.gateEvaluationId': report.gateEvaluationId,
          'routespec.gateRunId': report.gateRunId,
          'routespec.decision': report.decision,
          'routespec.decisionDigest': report.decisionDigest,
          'routespec.identityDigest': report.identityDigest,
          'routespec.counts': report.counts,
          'routespec.sourceLocatableFindings': real.length,
          'routespec.enforcementVerified': false,
        },
        results: real.map((f) => ({
          ruleId: f.ruleId,
          level: report.decision === 'FAIL' ? 'error' : 'warning',
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.uri },
                ...(f.startLine !== undefined ? { region: { startLine: f.startLine } } : {}),
              },
            },
          ],
        })),
      },
    ],
  };
  return renderJson(sarif);
}
