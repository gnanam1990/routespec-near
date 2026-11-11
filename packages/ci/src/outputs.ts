/**
 * Step outputs and job summary. Only fixed, single-line, non-secret values are written:
 * identifiers, digests, closed enum values, counts, and booleans. Enforcement is always reported
 * with `enforcement-verified=false` and `blocking=false`.
 */
import { appendFileSync } from 'node:fs';
import type { ActionResult } from './action.ts';

const SAFE_VALUE = /^[A-Za-z0-9_.:/@+-]{0,200}$/;

export function outputLines(result: ActionResult): string[] {
  const pairs: Array<[string, string]> = [
    ['conclusion', result.conclusion],
    ['exit-code', String(result.exitCode)],
    ['decision', result.decision ?? 'NONE'],
    ['trust', result.context.trust],
    ['enforcement-mode', result.enforcement?.mode ?? 'NONE'],
    ['enforcement-verified', 'false'],
    ['blocking', 'false'],
    ['artifact-ready', String(result.artifactReady)],
    ['build-attestation', 'USER_ASSERTED_LOCAL'],
    ['gate-run-id', result.gateRunId ?? ''],
    ['gate-evaluation-id', result.gateEvaluationId ?? ''],
    ['upload-directory', result.uploadDirectory ?? ''],
    ['retention-days', String(result.uploads?.retentionDays ?? 0)],
    ['live-dry', result.liveDry],
  ];
  return pairs.map(([k, v]) => {
    // Paths can carry spaces on some runners; anything else unexpected is dropped, not escaped.
    const value =
      k === 'upload-directory' ? v.replace(/[\r\n]/g, '') : SAFE_VALUE.test(v) ? v : 'UNPRINTABLE';
    return `${k}=${value}`;
  });
}

export function summaryMarkdown(result: ActionResult): string {
  const rows: Array<[string, string]> = [
    ['Gate decision', result.decision ?? 'none (no gate evaluation)'],
    ['CI conclusion', result.conclusion],
    ['Job trust', result.context.trust],
    ['Enforcement', `${result.enforcement?.mode ?? 'none'} (unverified; never blocking)`],
    ['Build attestation', 'USER_ASSERTED_LOCAL (no CI attestation; see ADR-0015)'],
    ['Artifact readiness', result.artifactReady ? 'ready' : 'not ready'],
    ['Live dry probe', result.liveDry],
    ['Staged uploads', String(result.uploads?.staged.length ?? 0)],
    ['Refused uploads', String(result.uploads?.refused.length ?? 0)],
  ];
  const lines = [
    '## RouteSpec gate',
    '',
    '| Axis | Value |',
    '| --- | --- |',
    ...rows.map(([a, b]) => `| ${a} | ${b.replace(/\|/g, '/')} |`),
    '',
    'Simulated evidence is proven within scenario only. RouteSpec does not verify repository settings and this check does not block a release by itself.',
  ];
  if (result.findings.length > 0)
    lines.push('', `Findings: ${result.findings.map((f) => `\`${f}\``).join(', ')}`);
  if (result.error) lines.push('', `Error: \`${result.error.code}\``);
  return `${lines.join('\n')}\n`;
}

export function writeGithubFiles(
  result: ActionResult,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const out = env['GITHUB_OUTPUT'];
  if (out) appendFileSync(out, `${outputLines(result).join('\n')}\n`, 'utf8');
  const summary = env['GITHUB_STEP_SUMMARY'];
  if (summary) appendFileSync(summary, summaryMarkdown(result), 'utf8');
}
