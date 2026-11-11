/**
 * Corpus identity and visible diff (FR-12, INV-12; DATA-MODEL.md `corpus_revisions`).
 *
 * A corpus revision is an immutable, ordered list of exact scenario revision IDs with per-case
 * required invariants, severity, and gate policy. Its identity is a digest of exactly that list
 * and its label, so reordering, removing, adding, or changing any case or policy produces a new
 * identity. `diffCorpora` makes every such difference visible; a gate never follows "latest".
 */
import type { CorpusCaseInput, ImportJournal } from '@routespec/store';

export type CorpusChange =
  | { readonly kind: 'LABEL_CHANGED'; readonly from: string; readonly to: string }
  | { readonly kind: 'CASE_REMOVED'; readonly ordinal: number; readonly scenarioRevisionId: string }
  | { readonly kind: 'CASE_ADDED'; readonly ordinal: number; readonly scenarioRevisionId: string }
  | {
      readonly kind: 'CASE_REORDERED';
      readonly scenarioRevisionId: string;
      readonly fromOrdinal: number;
      readonly toOrdinal: number;
    }
  | {
      readonly kind: 'SCENARIO_REVISION_CHANGED';
      readonly scenarioStableId: string;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly kind: 'POLICY_CHANGED';
      readonly scenarioRevisionId: string;
      readonly field: 'requiredInvariants' | 'severity' | 'gatePolicy';
    };

export interface CorpusDiff {
  readonly fromCorpusRevisionId: string;
  readonly toCorpusRevisionId: string;
  readonly fromDigest: string;
  readonly toDigest: string;
  readonly identical: boolean;
  readonly changes: readonly CorpusChange[];
}

export function diffCorpora(journal: ImportJournal, fromId: string, toId: string): CorpusDiff {
  const a = journal.getCorpus(fromId);
  const b = journal.getCorpus(toId);
  const stable = (scenarioRevisionId: string): string =>
    String(
      journal.store.getScenarioRevision(scenarioRevisionId)?.['scenario_stable_id'] ?? scenarioRevisionId,
    );
  const changes: CorpusChange[] = [];
  if (a.label !== b.label) changes.push({ kind: 'LABEL_CHANGED', from: a.label, to: b.label });
  const indexIn = (cases: readonly CorpusCaseInput[]) =>
    new Map(cases.map((c, i) => [c.scenarioRevisionId, i]));
  const ai = indexIn(a.cases);
  const bi = indexIn(b.cases);
  // A case whose exact revision left the corpus while another revision of the same stable
  // scenario arrived is a revision change, not an unrelated removal plus addition.
  const revised = new Set<string>();
  const arrivals = b.cases.filter((c) => !ai.has(c.scenarioRevisionId));
  for (const c of a.cases) {
    if (bi.has(c.scenarioRevisionId)) continue;
    const sid = stable(c.scenarioRevisionId);
    const to = arrivals.find(
      (x) => !revised.has(x.scenarioRevisionId) && stable(x.scenarioRevisionId) === sid,
    );
    if (to) {
      changes.push({
        kind: 'SCENARIO_REVISION_CHANGED',
        scenarioStableId: sid,
        from: c.scenarioRevisionId,
        to: to.scenarioRevisionId,
      });
      revised.add(c.scenarioRevisionId).add(to.scenarioRevisionId);
    }
  }
  a.cases.forEach((c, i) => {
    if (!bi.has(c.scenarioRevisionId) && !revised.has(c.scenarioRevisionId)) {
      changes.push({ kind: 'CASE_REMOVED', ordinal: i, scenarioRevisionId: c.scenarioRevisionId });
    }
  });
  b.cases.forEach((c, i) => {
    if (!ai.has(c.scenarioRevisionId) && !revised.has(c.scenarioRevisionId)) {
      changes.push({ kind: 'CASE_ADDED', ordinal: i, scenarioRevisionId: c.scenarioRevisionId });
    }
  });
  const common = a.cases.filter((c) => bi.has(c.scenarioRevisionId)).map((c) => c.scenarioRevisionId);
  const commonInB = b.cases.filter((c) => ai.has(c.scenarioRevisionId)).map((c) => c.scenarioRevisionId);
  common.forEach((id, i) => {
    if (commonInB[i] !== id) {
      changes.push({
        kind: 'CASE_REORDERED',
        scenarioRevisionId: id,
        fromOrdinal: ai.get(id) as number,
        toOrdinal: bi.get(id) as number,
      });
    }
  });
  for (const ca of a.cases) {
    const j = bi.get(ca.scenarioRevisionId);
    if (j === undefined) continue;
    const cb = b.cases[j] as CorpusCaseInput;
    if (JSON.stringify([...ca.requiredInvariants]) !== JSON.stringify([...cb.requiredInvariants])) {
      changes.push({
        kind: 'POLICY_CHANGED',
        scenarioRevisionId: ca.scenarioRevisionId,
        field: 'requiredInvariants',
      });
    }
    if (ca.severity !== cb.severity) {
      changes.push({ kind: 'POLICY_CHANGED', scenarioRevisionId: ca.scenarioRevisionId, field: 'severity' });
    }
    if (ca.gatePolicy !== cb.gatePolicy) {
      changes.push({
        kind: 'POLICY_CHANGED',
        scenarioRevisionId: ca.scenarioRevisionId,
        field: 'gatePolicy',
      });
    }
  }
  return {
    fromCorpusRevisionId: fromId,
    toCorpusRevisionId: toId,
    fromDigest: a.corpusDigest,
    toDigest: b.corpusDigest,
    identical: a.corpusDigest === b.corpusDigest,
    changes,
  };
}
