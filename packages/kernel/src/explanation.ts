/**
 * Deterministic explanations and the optional, non-authoritative model boundary (TB-04, T-043).
 *
 * - `renderExplanation` renders only closed templates from a completed evaluation.
 * - `explainWithOptionalModel` hands an optional model a redacted, frozen copy of a completed
 *   evaluation (codes, verdicts, counts, shortened identifiers; no evidence payloads, digests of
 *   inputs, or fact lists). Whatever the model returns is reduced to bounded plain text in a
 *   separate annotation labelled non-authoritative. The authoritative evaluation object is
 *   returned unchanged, is deep-frozen, and its digest is re-verified after the model ran.
 */
import { RouteSpecError } from '@routespec/contracts';
import {
  CASE_EXPLANATIONS,
  EXPLANATIONS,
  REMEDIATIONS,
  type ExplanationCode,
  type RemediationCode,
} from './codes.ts';
import { digestEvaluation, type CaseEvaluation } from './evaluate.ts';
import { deepFreeze } from './result.ts';

export const NON_AUTHORITATIVE_LABEL =
  'Explanation (non-authoritative; the deterministic result above is authoritative)';
const MAX_MODEL_TEXT = 2_000;

function short(id: string | null): string {
  return id === null ? 'case' : id.slice(0, 8);
}

export function renderExplanation(e: CaseEvaluation): string {
  const lines = [`${e.verdict}: ${CASE_EXPLANATIONS[e.explanationCode].template}`];
  for (const r of e.invariantResults) {
    const template =
      EXPLANATIONS[r.explanationCode as ExplanationCode]?.template ?? 'Unknown explanation code.';
    const remediation =
      r.remediationCode === null
        ? ''
        : ` Remediation: ${REMEDIATIONS[r.remediationCode as RemediationCode] ?? ''}`;
    const missing = r.missingPredicates.length > 0 ? ` Missing: ${r.missingPredicates.length}.` : '';
    lines.push(
      `${r.invariantId} [${short(r.runOperationId)}] ${r.verdict}: ${template}${missing}${remediation}`,
    );
  }
  return lines.join('\n');
}

export interface RedactedEvaluation {
  readonly verdict: string;
  readonly explanationCode: string;
  readonly invariants: ReadonlyArray<{
    readonly invariantId: string;
    readonly runOperation: string;
    readonly verdict: string;
    readonly explanationCode: string;
    readonly remediationCode: string | null;
    readonly missingCount: number;
  }>;
}

export function redactForModel(e: CaseEvaluation): RedactedEvaluation {
  return deepFreeze({
    verdict: e.verdict,
    explanationCode: e.explanationCode,
    invariants: e.invariantResults.map((r) => ({
      invariantId: r.invariantId,
      runOperation: short(r.runOperationId),
      verdict: r.verdict,
      explanationCode: r.explanationCode,
      remediationCode: r.remediationCode,
      missingCount: r.missingPredicates.length,
    })),
  });
}

export interface ExplainedEvaluation {
  /** The authoritative evaluation, identical (same frozen object) to the input. */
  readonly authoritative: CaseEvaluation;
  readonly explanation: {
    readonly authoritative: false;
    readonly label: string;
    readonly deterministic: string;
    readonly modelText: string | null;
  };
}

/** Bounded plain text from untrusted model output: strings only, control characters removed. */
function sanitize(output: unknown): string | null {
  let text: unknown = output;
  if (text !== null && typeof text === 'object') {
    const t = (text as { text?: unknown }).text;
    text = typeof t === 'string' ? t : null;
  }
  if (typeof text !== 'string') return null;
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, MAX_MODEL_TEXT);
  return clean.length > 0 ? clean : null;
}

export function explainWithOptionalModel(
  evaluation: CaseEvaluation,
  model?: (redacted: RedactedEvaluation) => unknown,
): ExplainedEvaluation {
  if (!Object.isFrozen(evaluation)) {
    throw new RouteSpecError(
      'RS_KERNEL_INPUT_INVALID',
      'Only a completed, frozen evaluation can be explained.',
    );
  }
  let modelText: string | null = null;
  if (model) {
    try {
      modelText = sanitize(model(redactForModel(evaluation)));
    } catch {
      modelText = null;
    }
  }
  const { resultDigest, ...body } = evaluation;
  if (digestEvaluation(body) !== resultDigest) {
    throw new RouteSpecError('RS_INTERNAL', 'Authoritative evaluation changed during explanation.');
  }
  return deepFreeze({
    authoritative: evaluation,
    explanation: {
      authoritative: false as const,
      label: NON_AUTHORITATIVE_LABEL,
      deterministic: renderExplanation(evaluation),
      modelText,
    },
  });
}
