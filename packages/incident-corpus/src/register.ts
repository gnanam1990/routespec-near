/**
 * Register a verified corpus directory in a RouteSpec journal (M50), so a gate can run it.
 *
 * Each scenario goes through the same bounded compiler as any other scenario source and becomes
 * an immutable scenario revision; the corpus revision pins those exact revisions under the
 * manifest's label. Scenarios are registered as UNREVIEWED unless the caller states that a
 * person reviewed them: they are generated, and generation is not a review.
 */
import { RouteSpecError } from '@routespec/contracts';
import { compileScenario } from '@routespec/scenario';
import type { RouteSpecStore } from '@routespec/store';
import { verifyCorpusDir } from './corpus.ts';

export interface RegisterOptions {
  readonly requiredInvariants: readonly string[];
  readonly severity: string;
  readonly reviewed?: boolean;
  /**
   * Require every requested invariant for every case, including those a class cannot decide.
   * Stuck, failed and late-success cases then stay REVIEW for any client.
   */
  readonly requireAll?: boolean;
}

export interface RegisteredCorpus {
  readonly label: string;
  readonly manifestDigest: string;
  readonly corpusRevisionId: string;
  readonly corpusDigest: string;
  readonly cases: ReadonlyArray<{
    readonly scenarioId: string;
    readonly scenarioRevisionId: string;
    readonly revisionDigest: string;
    readonly gatePolicy: 'REQUIRED';
    readonly requiredInvariants: readonly string[];
    /** Requested invariants this case does not require, because its class cannot decide them. */
    readonly notRequired: readonly string[];
    readonly observedCount: number;
  }>;
}

export function registerObservedCorpus(
  store: RouteSpecStore,
  dir: string,
  options: RegisterOptions,
): RegisteredCorpus {
  if (
    options.requiredInvariants.length === 0 ||
    options.requiredInvariants.some((i) => !/^INV-(0[1-9]|1[0-2])$/.test(i))
  ) {
    throw new RouteSpecError('RS_CLI_USAGE', 'Invalid invariant identifier.');
  }
  if (!/^(LOW|MEDIUM|HIGH|CRITICAL)$/.test(options.severity)) {
    throw new RouteSpecError('RS_CLI_USAGE', 'Severity must be LOW, MEDIUM, HIGH or CRITICAL.');
  }
  const { manifest, scenarios } = verifyCorpusDir(dir);
  if (scenarios.length === 0) {
    throw new RouteSpecError(
      'RS_IMPORT_STATE_INVALID',
      'This corpus has no cases yet: its live import is pending. Run the import first.',
      { details: { corpusLabel: manifest.corpusLabel, importStatus: manifest.importStatus } },
    );
  }
  const cases = scenarios.map((s, i) => {
    const template = manifest.templates[i] as (typeof manifest.templates)[number];
    const compiled = compileScenario(s.source);
    const { scenarioRevisionId, revisionDigest } = store.createScenarioRevision({
      ...compiled.revisionInput,
      reviewStatus: options.reviewed === true ? 'REVIEWED' : 'UNREVIEWED',
    });
    const left = options.requireAll === true ? [] : template.undecidableInvariants;
    const requiredInvariants = options.requiredInvariants.filter((i) => !left.includes(i));
    if (requiredInvariants.length === 0) {
      throw new RouteSpecError('RS_CLI_USAGE', 'A case would have no required invariant.', {
        details: { scenarioId: s.scenarioId },
      });
    }
    return {
      scenarioId: s.scenarioId,
      scenarioRevisionId,
      revisionDigest,
      gatePolicy: 'REQUIRED' as const,
      requiredInvariants,
      notRequired: options.requiredInvariants.filter((i) => left.includes(i)),
      observedCount: template.count,
    };
  });
  const { corpusRevisionId, corpusDigest } = store.createCorpusRevision({
    label: manifest.corpusLabel,
    cases: cases.map((c) => ({
      scenarioRevisionId: c.scenarioRevisionId,
      requiredInvariants: [...c.requiredInvariants],
      severity: options.severity,
      gatePolicy: c.gatePolicy,
    })),
  });
  return {
    label: manifest.corpusLabel,
    manifestDigest: manifest.manifestDigest,
    corpusRevisionId,
    corpusDigest,
    cases,
  };
}
