/**
 * Fix advice (`routespec.fix-advice/1`, M53).
 *
 * On FAIL or REVIEW, each violated invariant result is linked to the fix patterns for its
 * explanation code. When the subject source is given, the SDK usage found in it is listed with
 * real lines, the code shapes that are evidence for a linked pattern are attached to it, and a
 * suggested diff is built against that source.
 *
 * Fix advice is advisory. It is rendered after a gate decision, from the invariant results the
 * kernel produced, and never feeds back into any verdict, result digest, or decision digest.
 */
import { createHash } from 'node:crypto';
import { digestValue } from '@routespec/contracts';
import { EXPLANATIONS, REMEDIATIONS } from '@routespec/kernel';
import {
  FIX_PATTERNS,
  FIX_PATTERNS_REVISION,
  patternsForCode,
  type FixPattern,
  type FixPatternId,
} from './catalogue.ts';
import { unifiedDiff } from './diff.ts';
import { rewriteForPatterns, type AppliedRewrite, type RewriteRule } from './rewrite.ts';
import {
  SHAPE_PATTERNS,
  SHAPE_TEXT,
  parseErrorCount,
  parseSource,
  scanSdkUsageParsed,
  type SdkCall,
  type ShapeFinding,
  type UsageShape,
} from './usage.ts';

export const FIX_ADVICE_SCHEMA = 'routespec.fix-advice/1' as const;
const FIX_ADVICE_DOMAIN = 'routespec.fix-advice/1';

export const FIX_ADVICE_NOTE =
  'Advisory. Fix patterns and the suggested diff are not applied, compiled, or run by RouteSpec and are not part of any verdict or decision digest. Rerun the gate on the changed build to get a verdict.';

export interface InvariantViolation {
  readonly ordinal: number;
  readonly caseRunId: string | null;
  readonly required: boolean;
  readonly invariantId: string;
  readonly verdict: string;
  readonly explanationCode: string;
  readonly remediationCode: string | null;
}

export interface SubjectSource {
  /** Display path, relative to the project (forward slashes). */
  readonly path: string;
  readonly text: string;
}

export interface FixAdviceInput {
  readonly gate: {
    readonly gateRunId: string;
    readonly gateEvaluationId: string;
    readonly decision: string;
    readonly artifactDigest: string | null;
  } | null;
  readonly violations: readonly InvariantViolation[];
  /** Cases whose invariant results could not be reproduced from the journal. */
  readonly unreproduced?: ReadonlyArray<{
    readonly ordinal: number;
    readonly caseRunId: string | null;
    readonly reason: string;
  }>;
  readonly source: SubjectSource | null;
}

export interface FixAdviceLink {
  readonly ordinal: number;
  readonly caseRunId: string | null;
  readonly required: boolean;
  readonly invariantId: string;
  readonly verdict: string;
  readonly explanationCode: string;
  readonly explanation: string;
  readonly remediation: string | null;
  readonly patternIds: readonly FixPatternId[];
}

export interface FixAdvicePattern extends FixPattern {
  readonly invariants: readonly string[];
  /** Code shapes in the source that are evidence for this pattern (empty without a source). */
  readonly foundIn: ReadonlyArray<ShapeFinding & { readonly description: string }>;
}

export interface FixAdvice {
  readonly schema: typeof FIX_ADVICE_SCHEMA;
  readonly revision: typeof FIX_PATTERNS_REVISION;
  readonly advisory: true;
  readonly note: string;
  readonly gate: FixAdviceInput['gate'];
  readonly links: readonly FixAdviceLink[];
  readonly patterns: readonly FixAdvicePattern[];
  readonly unreproduced: NonNullable<FixAdviceInput['unreproduced']>;
  readonly source: {
    readonly path: string;
    readonly sha256: string;
    /** True/false when the gated artifact digest is the SHA-256 of this file alone; null otherwise. */
    readonly matchesArtifactDigest: boolean;
    readonly parseErrors: number;
    readonly calls: readonly SdkCall[];
    readonly shapes: readonly ShapeFinding[];
  } | null;
  readonly diff: {
    readonly path: string;
    readonly unified: string;
    readonly rewrites: readonly AppliedRewrite[];
    readonly skipped: ReadonlyArray<{
      readonly rule: RewriteRule;
      readonly line: number;
      readonly reason: string;
    }>;
    /** Syntax errors in the patched text (0 means it parses; it is not type-checked or run). */
    readonly patchedParseErrors: number;
    readonly patchedSha256: string;
  } | null;
  readonly digest: string;
}

/** Which rewrite rules each shape enables. */
const SHAPE_RULES: Readonly<Record<UsageShape, readonly RewriteRule[]>> = Object.freeze({
  COMMIT_RETRIED_IN_LOOP: ['RECONCILE_ON_UNKNOWN_COMMIT'],
  STATUS_NOT_READ_AFTER_COMMIT_ERROR: ['RECONCILE_ON_UNKNOWN_COMMIT'],
  NO_STATUS_READ: ['RECONCILE_ON_UNKNOWN_COMMIT'],
  REPEATED_COMMIT_CALL: ['SINGLE_ORDER'],
  REPEATED_QUOTE_CALL: ['SINGLE_ORDER'],
  ORDER_KEY_CHANGED: ['SINGLE_ORDER'],
  STATUS_POLL_BOUNDED: ['UNBOUNDED_STATUS_POLL'],
});

/** Shapes each explanation code makes relevant (a shape is shown only when its code fired). */
const CODE_SHAPES: Readonly<Record<string, readonly UsageShape[]>> = Object.freeze({
  INV03_SECOND_MUTATION_UNDER_UNCERTAINTY: [
    'REPEATED_QUOTE_CALL',
    'REPEATED_COMMIT_CALL',
    'ORDER_KEY_CHANGED',
    'COMMIT_RETRIED_IN_LOOP',
    'NO_STATUS_READ',
    'STATUS_NOT_READ_AFTER_COMMIT_ERROR',
  ],
  INV03_RECONCILIATION_INCOMPLETE: [
    'COMMIT_RETRIED_IN_LOOP',
    'NO_STATUS_READ',
    'STATUS_NOT_READ_AFTER_COMMIT_ERROR',
  ],
  INV03_RETRY_JOINED_BEFORE_FENCE: ['COMMIT_RETRIED_IN_LOOP', 'REPEATED_COMMIT_CALL'],
  INV05_OUTCOME_UNDETERMINED: ['NO_STATUS_READ', 'STATUS_NOT_READ_AFTER_COMMIT_ERROR', 'STATUS_POLL_BOUNDED'],
  INV06_TERMINAL_NOT_REACHED: ['NO_STATUS_READ', 'STATUS_POLL_BOUNDED'],
  INV07_EVIDENCE_REUSED: ['REPEATED_COMMIT_CALL', 'COMMIT_RETRIED_IN_LOOP'],
  INV02_BINDING_INCONSISTENT: ['REPEATED_COMMIT_CALL', 'ORDER_KEY_CHANGED'],
});

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function templateOf(code: string): string {
  return (
    (EXPLANATIONS as Record<string, { template: string } | undefined>)[code]?.template ??
    'Unknown explanation code.'
  );
}

function remediationOf(code: string | null): string | null {
  if (code === null) return null;
  return (REMEDIATIONS as Record<string, string | undefined>)[code] ?? null;
}

export function buildFixAdvice(input: FixAdviceInput): FixAdvice {
  const violations = [...input.violations]
    .filter((v) => v.verdict === 'FAIL' || v.verdict === 'REVIEW')
    .sort(
      (a, b) =>
        a.ordinal - b.ordinal ||
        (a.invariantId < b.invariantId ? -1 : a.invariantId > b.invariantId ? 1 : 0) ||
        (a.explanationCode < b.explanationCode ? -1 : a.explanationCode > b.explanationCode ? 1 : 0),
    );
  const seenLink = new Set<string>();
  const links: FixAdviceLink[] = [];
  for (const v of violations) {
    const key = `${v.ordinal}:${v.invariantId}:${v.explanationCode}`;
    if (seenLink.has(key)) continue;
    seenLink.add(key);
    links.push({
      ordinal: v.ordinal,
      caseRunId: v.caseRunId,
      required: v.required,
      invariantId: v.invariantId,
      verdict: v.verdict,
      explanationCode: v.explanationCode,
      explanation: templateOf(v.explanationCode),
      remediation: remediationOf(v.remediationCode),
      patternIds: patternsForCode(v.explanationCode).map((p) => p.id),
    });
  }

  // Patterns in first-link order; the shapes relevant to the codes that fired.
  const patternOrder: FixPatternId[] = [];
  const patternInvariants = new Map<FixPatternId, Set<string>>();
  const relevantShapes = new Set<UsageShape>();
  for (const l of links) {
    for (const id of l.patternIds) {
      if (!patternOrder.includes(id)) patternOrder.push(id);
      patternInvariants.set(id, (patternInvariants.get(id) ?? new Set()).add(l.invariantId));
    }
    for (const s of CODE_SHAPES[l.explanationCode] ?? []) relevantShapes.add(s);
  }

  let source: FixAdvice['source'] = null;
  let diff: FixAdvice['diff'] = null;
  let shapes: readonly ShapeFinding[] = [];
  if (input.source !== null) {
    const parsed = scanSdkUsageParsed(input.source.path, input.source.text);
    const digest = sha256(input.source.text);
    shapes = parsed.shapes;
    source = {
      path: input.source.path,
      sha256: digest,
      matchesArtifactDigest: input.gate?.artifactDigest === digest,
      parseErrors: parsed.parseErrors,
      calls: parsed.calls,
      shapes: parsed.shapes,
    };
    const patterns = new Set(patternOrder);
    const rules = new Set<RewriteRule>();
    for (const s of parsed.shapes) {
      if (!relevantShapes.has(s.shape)) continue;
      if (!SHAPE_PATTERNS[s.shape].some((p) => patterns.has(p))) continue;
      for (const r of SHAPE_RULES[s.shape]) rules.add(r);
    }
    if (rules.size > 0 && parsed.parseErrors === 0) {
      const rewritten = rewriteForPatterns(parsed, patterns, rules);
      const unified = unifiedDiff(input.source.path, input.source.text, rewritten.edits);
      if (unified.length > 0 || rewritten.skipped.length > 0) {
        diff = {
          path: input.source.path,
          unified,
          rewrites: rewritten.applied,
          skipped: rewritten.skipped,
          patchedParseErrors: parseErrorCount(parseSource(input.source.path, rewritten.patched)),
          patchedSha256: sha256(rewritten.patched),
        };
      }
    }
  }

  const patterns: FixAdvicePattern[] = patternOrder.map((id) => ({
    ...FIX_PATTERNS[id],
    invariants: [...(patternInvariants.get(id) ?? [])].sort(),
    foundIn: shapes
      .filter((s) => relevantShapes.has(s.shape) && SHAPE_PATTERNS[s.shape].includes(id))
      .map((s) => ({ ...s, description: SHAPE_TEXT[s.shape] })),
  }));

  const body = {
    schema: FIX_ADVICE_SCHEMA,
    revision: FIX_PATTERNS_REVISION,
    advisory: true as const,
    note: FIX_ADVICE_NOTE,
    gate: input.gate,
    links,
    patterns,
    unreproduced: [...(input.unreproduced ?? [])],
    source,
    diff,
  };
  return { ...body, digest: digestValue(FIX_ADVICE_DOMAIN, body) };
}

/** Source-locatable findings for SARIF: only shapes in the given source, never invented. */
export function fixAdviceSarifFindings(
  advice: FixAdvice,
): Array<{ ruleId: string; message: string; uri: string; startLine: number }> {
  if (advice.source === null) return [];
  const uri = advice.source.path;
  const out: Array<{ ruleId: string; message: string; uri: string; startLine: number }> = [];
  const seen = new Set<string>();
  for (const p of advice.patterns) {
    for (const f of p.foundIn) {
      const key = `${f.shape}:${f.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ruleId: `routespec.fix/${f.shape}`,
        message: `${f.description} Fix pattern: ${p.title} (${p.invariants.join(', ')}).`,
        uri,
        startLine: f.line,
      });
    }
  }
  return out.sort((a, b) => a.startLine - b.startLine || (a.ruleId < b.ruleId ? -1 : 1));
}

/** An inline Markdown code span that stays one span when the text holds backticks. */
function code(text: string): string {
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

/** Plain Markdown rendering of fix advice. */
export function renderFixAdviceMarkdown(advice: FixAdvice): string {
  const out: string[] = ['# RouteSpec fix patterns', ''];
  if (advice.gate) {
    out.push(`Gate run \`${advice.gate.gateRunId}\`, decision **${advice.gate.decision}**.`, '');
  }
  out.push(`> ${advice.note}`, '');
  if (advice.links.length === 0) {
    out.push('No violated invariant result: nothing to fix.', '');
  } else {
    out.push('## Violated invariants', '');
    for (const l of advice.links) {
      const patterns = l.patternIds.map((id) => FIX_PATTERNS[id].title).join('; ');
      out.push(
        `- Case ${l.ordinal}: **${l.invariantId} ${l.verdict}**${l.required ? '' : ' (not required)'} \`${l.explanationCode}\`. ${l.explanation}`,
        `  - Fix pattern: ${patterns.length > 0 ? patterns : 'none in client code'}${l.remediation ? `. Remediation: ${l.remediation}` : ''}`,
      );
    }
    out.push('');
  }
  for (const u of advice.unreproduced) {
    out.push(
      `- Case ${u.ordinal}: invariant results not reproduced from the journal (${u.reason}); no pattern linked.`,
    );
  }
  if (advice.unreproduced.length > 0) out.push('');
  for (const p of advice.patterns) {
    out.push(`## ${p.title}`, '', `Violated: ${p.invariants.join(', ')}.`, '', p.rule, '', p.why, '');
    for (const s of p.steps) out.push(`1. ${s}`);
    out.push('');
    if (p.foundIn.length > 0) {
      out.push(`Found in \`${advice.source?.path ?? ''}\`:`, '');
      for (const f of p.foundIn) out.push(`- line ${f.line}: ${f.description} ${code(f.text)}`);
      out.push('');
    }
    out.push('```ts', p.example, '```', '');
  }
  if (advice.source) {
    out.push('## SDK usage found', '', `\`${advice.source.path}\` (${advice.source.sha256})`, '');
    for (const c of advice.source.calls) out.push(`- line ${c.line}: \`${c.method}\` on \`${c.receiver}\``);
    out.push('');
  }
  if (advice.diff) {
    out.push('## Suggested diff', '');
    for (const r of advice.diff.rewrites) out.push(`- lines ${r.startLine}-${r.endLine}: ${r.note}`);
    for (const s of advice.diff.skipped) out.push(`- line ${s.line}: ${s.rule} not applied (${s.reason})`);
    out.push(
      '',
      `Patched text parse errors: ${advice.diff.patchedParseErrors} (syntax only; not type-checked or run).`,
      '',
    );
    if (advice.diff.unified.length > 0) out.push('```diff', advice.diff.unified.trimEnd(), '```', '');
  }
  return `${out.join('\n')}\n`;
}
