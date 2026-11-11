/**
 * Journal rows to kernel input (pure mapping, no I/O).
 *
 * The journal (M01/M02) reads every relevant row for one case in one consistent pass and hands
 * over plain objects. This module validates their shape and maps them into the immutable
 * `KernelInput`. Any unexpected shape fails closed with RS_KERNEL_INPUT_INVALID rather than
 * being guessed. Display-only material (USD values, formatted amounts, response extensions) is
 * deliberately not mapped.
 */
import {
  ATTEMPT_OUTCOMES,
  EFFECT_ACTIONS,
  EFFECT_COVERAGE_BASES,
  EVIDENCE_CLASSES,
  EVIDENCE_REASONS,
  EVIDENCE_SCOPES,
  EXECUTION_LIFECYCLES,
  LINEAGE_RELATIONS,
  NORMALIZED_FACTS,
  OPERATION_PHASES,
  RouteSpecError,
  SUBJECT_ATTESTATION_CLASSES,
  TOKEN_PURPOSES,
  isMember,
} from '@routespec/contracts';
import { recipientDigest } from './invariants/inv05.ts';
import { deepFreeze } from './result.ts';
import type { KernelInput, RequiredEvidence } from './types.ts';

type Row = Readonly<Record<string, unknown>>;

/** Structural shape of the journal's consistent evaluation read (see the store). */
export interface JournalSnapshotRows {
  readonly caseRun: Row;
  readonly session: Row;
  readonly gateRun: Row;
  readonly scenario: Row;
  readonly policy: Row | null;
  readonly manifest: Row | null;
  readonly manifestHooks: readonly Row[];
  readonly inventory: Row | null;
  readonly attestations: readonly Row[];
  readonly interceptors: readonly Row[];
  readonly boundaryObservations: readonly Row[];
  readonly coverageFindings: readonly Row[];
  readonly releaseAuthorizations: readonly Row[];
  readonly subjectReports: readonly Row[];
  readonly runOperations: readonly Row[];
  readonly lineage: readonly Row[];
  readonly quoteFinalizations: readonly Row[];
  readonly commitBindings: readonly Row[];
  readonly attempts: readonly Row[];
  readonly exchanges: readonly Row[];
  readonly events: readonly Row[];
  readonly conflicts: readonly Row[];
  readonly tokens: readonly Row[];
  readonly evidence: readonly Row[];
  readonly consumptions: readonly Row[];
  readonly allocations: readonly Row[];
}

function bad(field: string): never {
  throw new RouteSpecError('RS_KERNEL_INPUT_INVALID', 'Journal snapshot row has an unexpected shape.', {
    details: { field },
  });
}

function s(row: Row, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v : bad(key);
}
function sn(row: Row, key: string): string | null {
  const v = row[key];
  return v === null || v === undefined ? null : typeof v === 'string' ? v : bad(key);
}
function n(row: Row, key: string): number {
  const v = row[key];
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : bad(key);
}
function nn(row: Row, key: string): number | null {
  const v = row[key];
  return v === null || v === undefined
    ? null
    : typeof v === 'number' && Number.isSafeInteger(v)
      ? v
      : bad(key);
}
function member<T extends readonly string[]>(values: T, row: Row, key: string): T[number] {
  const v = row[key];
  return isMember(values, v) ? v : bad(key);
}
function parse(row: Row, key: string): unknown {
  try {
    return JSON.parse(s(row, key)) as unknown;
  } catch {
    return bad(key);
  }
}
function stringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) bad(key);
  return [...(value as string[])];
}
function record(value: unknown, key: string): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : bad(key);
}

function requiredEvidenceOf(compiled: unknown): RequiredEvidence[] {
  const plan = record(compiled, 'scenario.compiled_json');
  const list = plan['requiredEvidence'];
  if (list === undefined) return [];
  if (!Array.isArray(list)) bad('scenario.requiredEvidence');
  return (list as unknown[]).map((raw) => {
    const r = record(raw, 'scenario.requiredEvidence[]');
    const predicate = typeof r['predicate'] === 'string' ? r['predicate'] : bad('requiredEvidence.predicate');
    const classes = stringArray(r['classes'] ?? ['PROVEN'], 'requiredEvidence.classes');
    const scopes = stringArray(
      r['scopes'] ?? ['SIMULATED_GROUND_TRUTH', 'PUBLIC_CHAIN_OBSERVATION'],
      'requiredEvidence.scopes',
    );
    if (!classes.every((c) => isMember(EVIDENCE_CLASSES, c))) bad('requiredEvidence.classes');
    if (!scopes.every((c) => isMember(EVIDENCE_SCOPES, c))) bad('requiredEvidence.scopes');
    return {
      predicate,
      classes: classes as RequiredEvidence['classes'][number][],
      scopes: scopes as RequiredEvidence['scopes'][number][],
    };
  });
}

function observedDigests(row: Row): string[] {
  const v = parse(row, 'observed_digests_json');
  if (Array.isArray(v)) return stringArray(v, 'observed_digests_json');
  return Object.values(record(v, 'observed_digests_json')).filter((x): x is string => typeof x === 'string');
}

export function snapshotFromJournal(rows: JournalSnapshotRows): KernelInput {
  const { caseRun, session, gateRun, scenario } = rows;
  const finalizationByOp = new Map(rows.quoteFinalizations.map((f) => [s(f, 'run_operation_id'), f]));
  const requiredInvariants = stringArray(
    parse(caseRun, 'required_invariants_json'),
    'required_invariants_json',
  );
  const lineageSeen = new Set<string>();
  const input: KernelInput = {
    identity: {
      projectId: s(gateRun, 'project_id'),
      integrationRevisionId: s(session, 'integration_revision_id'),
      buildRevisionId: s(session, 'build_revision_id'),
      artifactDigest: s(session, 'artifact_digest'),
      buildAttestationClass: member(SUBJECT_ATTESTATION_CLASSES, gateRun, 'build_attestation_class'),
      buildAttestationId: sn(gateRun, 'build_attestation_id'),
      caseLaunchAttestationId: sn(session, 'case_launch_attestation_id'),
      gateRunId: s(session, 'gate_run_id'),
      caseRunId: s(caseRun, 'case_run_id'),
      sessionId: s(session, 'session_id'),
      corpusRevisionId: s(session, 'corpus_revision_id'),
      scenarioRevisionId: s(caseRun, 'scenario_revision_id'),
      scenarioRevisionDigest: s(scenario, 'revision_digest'),
      seed: s(session, 'seed'),
      protocolProfileId: s(gateRun, 'protocol_profile_id'),
      adapterRevision: s(session, 'adapter_revision'),
      evaluatorRevision: s(gateRun, 'evaluator_revision'),
      configurationDigest: s(gateRun, 'configuration_digest'),
      effectCoveragePolicyDigest: s(session, 'effect_coverage_policy_digest'),
      effectManifestDigest: s(session, 'effect_manifest_digest'),
      callsiteInventoryDigest:
        sn(session, 'callsite_inventory_digest') ?? sn(gateRun, 'callsite_inventory_digest'),
      interceptorProfileDigest: sn(gateRun, 'interceptor_profile_digest'),
      interceptorInstanceId: sn(session, 'interceptor_instance_id'),
      fencingEpoch: n(caseRun, 'fencing_epoch'),
    },
    caseState: {
      lifecycle: member(EXECUTION_LIFECYCLES, caseRun, 'execution_lifecycle'),
      inputClosed: nn(caseRun, 'teardown_recorded_at_ms') !== null,
      requiredInvariants: [...new Set(requiredInvariants)].sort(),
      asOfMs: nn(caseRun, 'teardown_recorded_at_ms'),
    },
    requiredEvidence: requiredEvidenceOf(parse(scenario, 'compiled_json')),
    runOperations: rows.runOperations.map((op) => {
      const q = record(parse(op, 'quote_request_json'), 'quote_request_json');
      const fin = finalizationByOp.get(s(op, 'run_operation_id'));
      const c = fin ? record(parse(fin, 'constraints_json'), 'constraints_json') : {};
      const str = (o: Record<string, unknown>, k: string): string | null =>
        typeof o[k] === 'string' ? (o[k] as string) : null;
      const recipient = str(q, 'recipient');
      const refundTo = str(q, 'refundTo');
      const outcome = sn(op, 'normalized_outcome');
      return {
        runOperationId: s(op, 'run_operation_id'),
        logicalJobId: s(op, 'logical_job_id'),
        integrationRevisionId: s(op, 'integration_revision_id'),
        buildRevisionId: s(op, 'build_revision_id'),
        gateRunId: s(op, 'gate_run_id'),
        caseRunId: s(op, 'case_run_id'),
        sessionId: s(op, 'session_id'),
        createdFencingEpoch: n(op, 'fencing_epoch'),
        currentPhase: member(OPERATION_PHASES, op, 'current_phase'),
        quoteRequestDigest: s(op, 'quote_request_digest'),
        quoteFinalizationDigest: sn(op, 'quote_finalization_digest'),
        commitBindingDigest: sn(op, 'commit_binding_digest'),
        acceptedTerminalStatus: sn(op, 'accepted_terminal_status'),
        normalizedOutcome:
          outcome === null ? null : isMember(NORMALIZED_FACTS, outcome) ? outcome : bad('normalized_outcome'),
        createdSequence: n(op, 'created_sequence'),
        committedSequence: nn(op, 'committed_sequence'),
        quote: {
          swapType: str(q, 'swapType') ?? bad('quote.swapType'),
          originAsset: str(q, 'originAsset') ?? bad('quote.originAsset'),
          destinationAsset: str(q, 'destinationAsset') ?? bad('quote.destinationAsset'),
          requestedAmount: str(q, 'amount') ?? bad('quote.amount'),
          recipientDigest: recipient === null ? null : recipientDigest(recipient),
          refundToDigest: refundTo === null ? null : recipientDigest(refundTo),
          amountIn: str(c, 'amountIn'),
          amountOut: str(c, 'amountOut'),
          minAmountOut: str(c, 'minAmountOut'),
        },
      };
    }),
    lineage: rows.lineage
      .map((l) => ({
        fromRunOperationId: s(l, 'from_run_operation_id'),
        toRunOperationId: s(l, 'to_run_operation_id'),
        relation: member(LINEAGE_RELATIONS, l, 'relation'),
      }))
      .filter((l) => {
        const key = `${l.relation}\u0000${l.fromRunOperationId}\u0000${l.toRunOperationId}`;
        if (lineageSeen.has(key)) return false;
        lineageSeen.add(key);
        return true;
      }),
    quoteFinalizations: rows.quoteFinalizations.map((f) => ({
      runOperationId: s(f, 'run_operation_id'),
      finalizationDigest: s(f, 'finalization_digest'),
      sequence: n(f, 'sequence'),
      fencingEpoch: n(f, 'fencing_epoch'),
    })),
    commitBindings: rows.commitBindings.map((c) => ({
      runOperationId: s(c, 'run_operation_id'),
      bindingDigest: s(c, 'binding_digest'),
      firstAttemptId: s(c, 'first_attempt_id'),
      sequence: n(c, 'sequence'),
      fencingEpoch: n(c, 'fencing_epoch'),
    })),
    attempts: rows.attempts.map((a) => ({
      attemptId: s(a, 'attempt_id'),
      runOperationId: s(a, 'run_operation_id'),
      fencingEpoch: n(a, 'fencing_epoch'),
      ordinal: n(a, 'attempt_ordinal'),
      transportRequestId: s(a, 'transport_request_id'),
      phase: member(OPERATION_PHASES, a, 'phase'),
      outcome: member(ATTEMPT_OUTCOMES, a, 'outcome'),
    })),
    exchanges: rows.exchanges.map((x) => ({
      exchangeId: s(x, 'exchange_id'),
      sequence: n(x, 'sequence'),
      runOperationId: sn(x, 'run_operation_id'),
      attemptId: sn(x, 'attempt_id'),
      fencingEpoch: n(x, 'fencing_epoch'),
      phase: member(OPERATION_PHASES, x, 'phase'),
      method: s(x, 'method'),
      routeTemplate: s(x, 'route_template'),
      transportRequestId: s(x, 'transport_request_id'),
      requestDigest: s(x, 'request_digest'),
      responseStatus: nn(x, 'response_status'),
      responseDigest: sn(x, 'response_digest'),
      errorCode: sn(x, 'error_code'),
    })),
    events: rows.events.map((e) => ({
      eventId: s(e, 'event_id'),
      sequence: n(e, 'sequence'),
      runOperationId: sn(e, 'run_operation_id'),
      exchangeId: sn(e, 'exchange_id'),
      fencingEpoch: n(e, 'fencing_epoch'),
      kind: s(e, 'event_kind'),
      rawStatus: sn(e, 'raw_status'),
      normalizedFact: sn(e, 'normalized_fact'),
      sourceKind: s(e, 'source_kind'),
      payloadDigest: sn(e, 'payload_digest'),
    })),
    conflicts: rows.conflicts.map((c) => ({
      runOperationId: sn(c, 'run_operation_id'),
      phase: member(OPERATION_PHASES, c, 'phase'),
      errorCode: s(c, 'error_code'),
      fencingEpoch: n(c, 'fencing_epoch'),
    })),
    tokens: rows.tokens.map((t) => ({
      purpose: member(TOKEN_PURPOSES, t, 'purpose'),
      fencingEpoch: n(t, 'fencing_epoch'),
      revoked: sn(t, 'revocation_reason') !== null,
      revocationReason: sn(t, 'revocation_reason'),
      revokedAtEpoch: nn(t, 'revoked_at_epoch'),
    })),
    evidence: rows.evidence.map((e) => {
      const reasons = stringArray(parse(e, 'reasons_json'), 'reasons_json');
      if (!reasons.every((r) => isMember(EVIDENCE_REASONS, r))) bad('reasons_json');
      return {
        evidenceId: s(e, 'evidence_id'),
        sequence: n(e, 'sequence'),
        integrationRevisionId: s(e, 'integration_revision_id'),
        buildRevisionId: s(e, 'build_revision_id'),
        artifactDigest: s(e, 'artifact_digest'),
        gateRunId: s(e, 'gate_run_id'),
        caseRunId: s(e, 'case_run_id'),
        sessionId: s(e, 'session_id'),
        scenarioRevisionId: s(e, 'scenario_revision_id'),
        effectCoveragePolicyDigest: s(e, 'effect_coverage_policy_digest'),
        effectManifestDigest: s(e, 'effect_manifest_digest'),
        fencingEpoch: n(e, 'fencing_epoch'),
        runOperationId: sn(e, 'run_operation_id'),
        evidenceClass: member(EVIDENCE_CLASSES, e, 'evidence_class'),
        evidenceScope: member(EVIDENCE_SCOPES, e, 'evidence_scope'),
        reasons: reasons as KernelInput['evidence'][number]['reasons'][number][],
        subject: s(e, 'subject'),
        sourceKind: s(e, 'source_kind'),
        assetId: sn(e, 'asset_id'),
        amount: sn(e, 'amount'),
        recipientDigest: sn(e, 'recipient_digest'),
        singleUse: n(e, 'single_use') === 1,
        payloadDigest: s(e, 'payload_digest'),
      };
    }),
    consumptions: rows.consumptions.map((c) => ({
      evidenceId: s(c, 'evidence_id'),
      runOperationId: s(c, 'run_operation_id'),
      predicate: s(c, 'predicate'),
      allocationId: sn(c, 'allocation_id'),
    })),
    allocations: [...new Set(rows.allocations.map((a) => s(a, 'allocation_id')))].map((allocationId) => {
      const parts = rows.allocations.filter((a) => a['allocation_id'] === allocationId);
      const first = parts[0] as Row;
      return {
        allocationId,
        evidenceId: s(first, 'evidence_id'),
        assetId: s(first, 'asset_id'),
        totalAmount: s(first, 'total_amount'),
        parts: parts.map((p) => ({
          runOperationId: s(p, 'part_run_operation_id'),
          amount: s(p, 'part_amount'),
        })),
      };
    }),
    effectPolicy: rows.policy
      ? {
          policyDigest: s(rows.policy, 'policy_digest'),
          buildRevisionId: s(rows.policy, 'build_revision_id'),
          artifactDigest: s(rows.policy, 'artifact_digest'),
          selectedAttestationId: sn(rows.policy, 'selected_attestation_id'),
          scenarioRevisionId: s(rows.policy, 'scenario_revision_id'),
          manifestDigest: s(rows.policy, 'manifest_digest'),
          requiredSinkClasses: [
            ...new Set(
              stringArray(parse(rows.policy, 'required_sink_classes_json'), 'required_sink_classes_json'),
            ),
          ].sort(),
          interceptorProfileDigest: sn(rows.policy, 'interceptor_profile_digest'),
          callsiteInventoryDigest: sn(rows.policy, 'callsite_inventory_digest'),
          basis: member(EFFECT_COVERAGE_BASES, rows.policy, 'basis'),
        }
      : null,
    effectManifest: rows.manifest
      ? {
          manifestDigest: s(rows.manifest, 'manifest_digest'),
          buildRevisionId: s(rows.manifest, 'build_revision_id'),
          artifactDigest: s(rows.manifest, 'artifact_digest'),
          adapterRevision: s(rows.manifest, 'adapter_revision'),
          hooks: rows.manifestHooks.map((h) => ({
            hookId: s(h, 'hook_id'),
            hookRevision: s(h, 'hook_revision'),
            effectType: s(h, 'effect_type'),
            sinkClass: s(h, 'sink_class'),
            mechanism: s(h, 'mechanism'),
            coverageExpectation: member(['REQUIRED', 'OPTIONAL'] as const, h, 'coverage_expectation'),
          })),
        }
      : null,
    callsiteInventory: rows.inventory
      ? {
          inventoryDigest: s(rows.inventory, 'inventory_digest'),
          buildRevisionId: s(rows.inventory, 'build_revision_id'),
          manifestDigest: s(rows.inventory, 'manifest_digest'),
          analyzerDigest: s(rows.inventory, 'analyzer_digest'),
          attestationId: sn(rows.inventory, 'attestation_id'),
          unsupportedFindings: n(rows.inventory, 'unsupported_findings'),
          callsites: (() => {
            const v = parse(rows.inventory, 'inventory_json');
            if (!Array.isArray(v)) bad('inventory_json');
            return (v as unknown[]).map((raw) => {
              const c = record(raw, 'inventory_json[]');
              return {
                callsiteId: typeof c['callsiteId'] === 'string' ? c['callsiteId'] : bad('callsiteId'),
                sinkClass: typeof c['sinkClass'] === 'string' ? c['sinkClass'] : bad('sinkClass'),
                hookId: typeof c['hookId'] === 'string' ? c['hookId'] : null,
                dynamic: c['dynamic'] === true,
              };
            });
          })(),
        }
      : null,
    interceptors: rows.interceptors.map((i) => ({
      interceptorInstanceId: s(i, 'interceptor_instance_id'),
      interceptorProfileDigest: s(i, 'interceptor_profile_digest'),
      artifactDigest: s(i, 'artifact_digest'),
      supportedSinks: stringArray(parse(i, 'supported_sinks_json'), 'supported_sinks_json').sort(),
      buildRevisionId: s(i, 'build_revision_id'),
      gateRunId: s(i, 'gate_run_id'),
      caseRunId: s(i, 'case_run_id'),
      sessionId: s(i, 'session_id'),
      policyDigest: s(i, 'policy_digest'),
      manifestDigest: s(i, 'manifest_digest'),
      fencingEpoch: n(i, 'fencing_epoch'),
      attestationId: sn(i, 'attestation_id'),
      containment: member(['PROCESS_TREE_ENFORCED', 'DECLARED_HOOKS_ONLY'] as const, i, 'containment'),
      teardownReason:
        i['teardown_reason'] === null || i['teardown_reason'] === undefined
          ? null
          : member(['TEARDOWN', 'CHANNEL_LOST', 'CASE_TERMINAL'] as const, i, 'teardown_reason'),
    })),
    boundaryObservations: rows.boundaryObservations.map((o) => ({
      observationId: s(o, 'observation_id'),
      interceptorInstanceId: s(o, 'interceptor_instance_id'),
      buildRevisionId: s(o, 'build_revision_id'),
      artifactDigest: s(o, 'artifact_digest'),
      gateRunId: s(o, 'gate_run_id'),
      caseRunId: s(o, 'case_run_id'),
      sessionId: s(o, 'session_id'),
      scenarioRevisionId: s(o, 'scenario_revision_id'),
      policyDigest: s(o, 'policy_digest'),
      manifestDigest: s(o, 'manifest_digest'),
      interceptorProfileDigest: s(o, 'interceptor_profile_digest'),
      runOperationId: sn(o, 'run_operation_id'),
      sinkClass: s(o, 'sink_class'),
      effectId: s(o, 'effect_id'),
      effectType: s(o, 'effect_type'),
      action: member(EFFECT_ACTIONS, o, 'action'),
      fencingEpoch: n(o, 'fencing_epoch'),
      frameSequence: n(o, 'sequence'),
      sessionSequence: nn(o, 'session_sequence'),
    })),
    subjectReports: rows.subjectReports.map((r) => ({
      observationId: s(r, 'observation_id'),
      buildRevisionId: s(r, 'build_revision_id'),
      gateRunId: s(r, 'gate_run_id'),
      caseRunId: s(r, 'case_run_id'),
      sessionId: s(r, 'session_id'),
      runOperationId: sn(r, 'run_operation_id'),
      policyDigest: s(r, 'policy_digest'),
      manifestDigest: s(r, 'manifest_digest'),
      hookId: s(r, 'hook_id'),
      hookRevision: s(r, 'hook_revision'),
      effectId: s(r, 'effect_id'),
      effectType: s(r, 'effect_type'),
      action: member(EFFECT_ACTIONS, r, 'action'),
      fencingEpoch: n(r, 'fencing_epoch'),
      sequence: n(r, 'sequence'),
      coverageClassification: member(['SUBJECT_REPORTED'] as const, r, 'coverage_classification'),
    })),
    coverageFindings: rows.coverageFindings.map((f) => ({
      interceptorInstanceId: s(f, 'interceptor_instance_id'),
      kind: member(['PROCESS_TREE_ESCAPE', 'UNSUPPORTED_DYNAMIC_CALL', 'SINK_BYPASS'] as const, f, 'kind'),
      sinkClass: sn(f, 'sink_class'),
      fencingEpoch: n(f, 'fencing_epoch'),
      sessionSequence: n(f, 'session_sequence'),
    })),
    releaseAuthorizations: rows.releaseAuthorizations.map((a) => ({
      authorizationId: s(a, 'authorization_id'),
      interceptorInstanceId: sn(a, 'interceptor_instance_id'),
      fencingEpoch: n(a, 'fencing_epoch'),
      sessionSequence: n(a, 'session_sequence'),
      completionEvidenceIds: stringArray(
        parse(a, 'completion_evidence_ids_json'),
        'completion_evidence_ids_json',
      ),
    })),
    attestations: rows.attestations.map((a) => ({
      attestationId: s(a, 'attestation_id'),
      attestationClass: member(['TRUSTED_LAUNCHER', 'CI_ATTESTED'] as const, a, 'attestation_class'),
      scope: s(a, 'scope'),
      buildRevisionId: sn(a, 'build_revision_id'),
      observedDigests: observedDigests(a).sort(),
      expiresAtMs: n(a, 'expires_at_ms'),
      principalEnabled: n(a, 'principal_enabled') === 1,
      principalRevocationEpochAtIssue: n(a, 'principal_revocation_epoch'),
      principalCurrentRevocationEpoch: n(a, 'principal_current_revocation_epoch'),
      principalPolicyDigestAtIssue: s(a, 'principal_policy_digest'),
      principalCurrentPolicyDigest: s(a, 'principal_current_policy_digest'),
    })),
    probeResults: [],
  };
  return deepFreeze(input);
}
