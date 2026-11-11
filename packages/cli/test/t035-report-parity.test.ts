/**
 * T-035 — JSON, JUnit, and SARIF agree with gate result. Covers FR-14, FR-18.
 *
 * One real gate evaluation with PASS, FAIL, cancelled (REVIEW), and advisory cases is produced
 * through the CLI and installed subjects. `routespec gate evaluate` writes all three formats
 * from that one persisted evaluation; the test parses each independently and asserts identity,
 * decision, digest, and per-status count parity, and that the gate-run stdout report is the
 * same evaluation. SARIF contains only source-locatable findings: a gate evaluation has none,
 * so it has zero results and no invented locations; a renderer fed one real locatable finding
 * and one without a location emits exactly the real one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderSarif, type GateReport } from '@routespec/runner';
import {
  runCliProcess,
  runGateWithSubjects,
  setupJournal,
  tempDir,
  type Journal,
} from './support/product.ts';

let tmp: ReturnType<typeof tempDir>;
let j: Journal;
let runReport: GateReport;
let evaluated: {
  json: GateReport;
  junit: string;
  sarif: Record<string, unknown>;
  stdout: Record<string, unknown>;
};

function junitCases(xml: string): Array<{ id: string; kind: 'pass' | 'failure' | 'error' | 'skipped' }> {
  const out: Array<{ id: string; kind: 'pass' | 'failure' | 'error' | 'skipped' }> = [];
  const re = /<testcase [^>]*id="([^"]+)">([\s\S]*?)<\/testcase>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const body = m[2] as string;
    out.push({
      id: m[1] as string,
      kind: body.includes('<failure')
        ? 'failure'
        : body.includes('<error')
          ? 'error'
          : body.includes('<skipped')
            ? 'skipped'
            : 'pass',
    });
  }
  return out;
}

function prop(xml: string, name: string): string | null {
  return (
    new RegExp(`<property name="${name.replace(/\./g, '\\.')}" value="([^"]*)"/>`).exec(xml)?.[1] ?? null
  );
}

beforeAll(async () => {
  tmp = tempDir();
  j = setupJournal(tmp.dir, {
    scenarios: ['happy-path', 'refund-shortfall', 'happy-path'],
    advisoryScenarios: ['incomplete-deposit-refund'],
    build: 'reconciling-client',
    label: 't035',
  });
  const r = await runGateWithSubjects(j, { behaviour: { 2: 'cancel' } });
  expect(r.exitCode).toBe(2);
  runReport = r.json?.['report'] as GateReport;
  const paths = {
    json: join(tmp.dir, 'gate.json'),
    junit: join(tmp.dir, 'gate.junit.xml'),
    sarif: join(tmp.dir, 'gate.sarif'),
  };
  const e = await runCliProcess([
    'gate',
    'evaluate',
    '--data',
    tmp.dir,
    '--gate-run',
    runReport.gateRunId,
    '--json',
    paths.json,
    '--junit',
    paths.junit,
    '--sarif',
    paths.sarif,
  ]);
  expect(e.exitCode).toBe(2);
  evaluated = {
    json: JSON.parse(readFileSync(paths.json, 'utf8')) as GateReport,
    junit: readFileSync(paths.junit, 'utf8'),
    sarif: JSON.parse(readFileSync(paths.sarif, 'utf8')) as Record<string, unknown>,
    stdout: e.json as Record<string, unknown>,
  };
});

afterAll(() => tmp?.cleanup());

describe('T-035 — JSON, JUnit, and SARIF agree with gate result', () => {
  it('the gate-run output, stdout, and JSON file are the same persisted evaluation', () => {
    const { json, stdout } = evaluated;
    expect(stdout['created']).toBe(false);
    expect(json.gateEvaluationId).toBe(runReport.gateEvaluationId);
    expect(json.decisionDigest).toBe(runReport.decisionDigest);
    expect((stdout['report'] as GateReport).decisionDigest).toBe(json.decisionDigest);
    expect(json.decision).toBe('FAIL');
    expect(json.exitCode).toBe(2);
    expect(json.counts).toEqual({
      total: 4,
      required: 3,
      pass: 2,
      fail: 1,
      review: 1,
      notRun: 0,
      unsupported: 0,
    });
    expect(json.cases.map((c) => [c.required, c.contribution])).toEqual([
      [true, 'PASS'],
      [true, 'FAIL'],
      [true, 'REVIEW'],
      [false, 'PASS'],
    ]);
  });

  it('JUnit identity, decision, and counts match the JSON evaluation', () => {
    const { json, junit } = evaluated;
    expect(prop(junit, 'routespec.gateEvaluationId')).toBe(json.gateEvaluationId);
    expect(prop(junit, 'routespec.decision')).toBe(json.decision);
    expect(prop(junit, 'routespec.decisionDigest')).toBe(json.decisionDigest);
    expect(prop(junit, 'routespec.identityDigest')).toBe(json.identityDigest);
    expect(prop(junit, 'routespec.buildRevisionId')).toBe(j.buildRevisionId);
    expect(prop(junit, 'routespec.artifactDigest')).toBe(j.artifactDigest);
    expect(prop(junit, 'routespec.enforcementVerified')).toBe('false');
    const suite = /<testsuite [^>]*tests="(\d+)" failures="(\d+)" errors="(\d+)" skipped="(\d+)"/.exec(junit);
    expect(suite?.slice(1).map(Number)).toEqual([
      json.counts.total,
      json.counts.fail,
      json.counts.review + json.counts.unsupported,
      json.counts.notRun,
    ]);
    const cases = junitCases(junit);
    expect(cases.map((c) => c.id)).toEqual(json.cases.map((c) => c.caseRunId));
    const kind = {
      PASS: 'pass',
      FAIL: 'failure',
      REVIEW: 'error',
      UNSUPPORTED: 'error',
      NOT_RUN: 'skipped',
    } as const;
    expect(cases.map((c) => c.kind)).toEqual(json.cases.map((c) => kind[c.contribution]));
  });

  it('SARIF agrees on identity and decision and invents no locations', () => {
    const { json, sarif } = evaluated;
    expect(sarif['version']).toBe('2.1.0');
    const run = (sarif['runs'] as Array<{ properties: Record<string, unknown>; results: unknown[] }>)[0]!;
    expect(run.properties['routespec.gateEvaluationId']).toBe(json.gateEvaluationId);
    expect(run.properties['routespec.decision']).toBe(json.decision);
    expect(run.properties['routespec.decisionDigest']).toBe(json.decisionDigest);
    expect(run.properties['routespec.identityDigest']).toBe(json.identityDigest);
    expect(run.properties['routespec.counts']).toEqual(json.counts);
    expect(run.properties['routespec.sourceLocatableFindings']).toBe(0);
    expect(run.results).toEqual([]);
    expect(JSON.stringify(sarif)).not.toMatch(/"(physicalLocation|region|startLine)"/);
  });

  it('only real source-locatable findings become SARIF results', () => {
    const rendered = JSON.parse(
      renderSarif(evaluated.json, [
        {
          ruleId: 'RS_SCENARIO_INVALID',
          message: 'Unknown step type',
          uri: 'scenarios/bad.yaml',
          startLine: 7,
        },
        { ruleId: 'RS_NO_LOCATION', message: 'not locatable', uri: '' },
      ]),
    ) as {
      runs: Array<{
        results: Array<{
          ruleId: string;
          locations: Array<{
            physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number } };
          }>;
        }>;
      }>;
    };
    const results = rendered.runs[0]!.results;
    expect(results).toHaveLength(1);
    expect(results[0]?.ruleId).toBe('RS_SCENARIO_INVALID');
    expect(results[0]?.locations[0]?.physicalLocation).toEqual({
      artifactLocation: { uri: 'scenarios/bad.yaml' },
      region: { startLine: 7 },
    });
  });

  it('the run-time report and the later evaluate report carry identical identity, cases, and counts', () => {
    expect(runReport.identity).toEqual(evaluated.json.identity);
    expect(runReport.cases).toEqual(evaluated.json.cases);
    expect(runReport.counts).toEqual(evaluated.json.counts);
  });
});
