/**
 * Redacted evidence bundles (M06 deliverable 6; FR-17, FR-18; API-SPEC section 7; SECURITY.md).
 *
 * plan   -> builds the bundle content from one persisted gate evaluation and the immutable
 *           journal, runs the privacy scan (credentials, authorization, cookies, private keys,
 *           signed payloads, sensitive addresses, author-machine paths), and records an
 *           immutable plan. A blocked plan stores only safe finding metadata (category, path,
 *           count) and no content. Nothing is written to disk.
 * write  -> requires the plan digest as explicit local confirmation, an explicitly chosen
 *           local path, and a distinct overwrite confirmation for an existing file. The bundle
 *           is rebuilt from the journal and must reproduce the planned digest; it is written
 *           atomically and re-read before `artifactReady` is recorded. The gate decision is
 *           never read back from, or changed by, this step.
 * verify -> extracts a bundle into a disposable directory and checks the manifest, checksums,
 *           identity/decision parity across report formats, a fresh secret scan, declared
 *           exclusions, and the absence of author-machine paths, using only the bundle itself.
 *
 * Checksums identify content; they are not signatures. No signature is claimed (no signing
 * ADR exists).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { RouteSpecError, digestValue } from '@routespec/contracts';
import { isWithin, resolveExtractionDir, resolveInputFile, resolveOutputFile } from '@routespec/hardening';
import { scanForExport, type ExportFindingCategory } from '@routespec/regressions';
import {
  GateJournal,
  type ExportFindingRecord,
  type GateEvaluationView,
  type RouteSpecStore,
} from '@routespec/store';
import { buildGateReport, renderJUnit, renderJson, renderSarif, type GateReport } from './reports.ts';
import { MAX_BUNDLE_BYTES, isSafeEntryName, readTar, writeTar, type TarEntry } from './tar.ts';

export const BUNDLE_FORMAT = 'routespec.bundle/1' as const;
export const BUNDLE_SCANNER_REVISION = 'routespec-bundle-scan@1.0.0' as const;
export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 256 * 1024;

export const DECLARED_EXCLUSIONS: readonly string[] = Object.freeze([
  'RUN_ENVELOPES: host name, platform paths, data and working directories, wall-clock times',
  'RAW_AUTHORIZATION: provider Authorization headers and any provider credential',
  'CASE_TOKENS: one-time execution and reconciliation tokens (only digests exist in the journal)',
  'UNREVIEWED_TRACE_PAYLOADS: quarantined or unreviewed imports',
  'BROWSER_LOCAL_STATE: console storage and session state',
  'FULL_SIGNED_TRANSACTION_MATERIAL: only digests of signed material are journaled',
  'REQUEST_AND_RESPONSE_BODIES: exchanges are represented by digests',
]);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface ExportAttachment {
  readonly name: string;
  readonly content: string;
}

export interface PlanExportOptions {
  readonly idempotencyKey: string;
  readonly attachments?: readonly ExportAttachment[];
  readonly includeAddresses?: boolean;
  readonly acknowledgeAddresses?: boolean;
  /** Configured secret values (memory only for this call). */
  readonly configuredSecrets?: readonly string[];
  /** Extra author-machine path markers (for example the data directory). */
  readonly localPathMarkers?: readonly string[];
}

export interface BundleFinding extends ExportFindingRecord {
  readonly category: ExportFindingCategory | 'LOCAL_PATH';
}

export interface ExportPlanResult {
  readonly exportId: string;
  readonly created: boolean;
  readonly blocked: boolean;
  readonly planDigest: string;
  readonly bundleDigest: string | null;
  readonly bundleBytes: number | null;
  readonly findings: readonly BundleFinding[];
  readonly entries: ReadonlyArray<{ path: string; digest: string; bytes: number; kind: string }>;
  readonly exclusions: readonly string[];
  readonly privacyScanResult: string;
  readonly revision: number;
}

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function json(value: unknown): Buffer {
  return Buffer.from(renderJson(value), 'utf8');
}

function addressDigest(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0
    ? digestValue('routespec.export-address/1', value)
    : null;
}

const ADDRESS_FIELDS = ['recipient', 'refundTo', 'depositAddress', 'sender', 'senderAddress'];

/** Default export masks addresses as digests (different key, so they are not raw addresses). */
function maskQuoteRequest(request: Record<string, unknown>, include: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(request)) {
    if (ADDRESS_FIELDS.includes(k) && !include) out[`${k}Digest`] = addressDigest(v);
    else out[k] = v;
  }
  return out;
}

function pathMarkers(extra: readonly string[]): string[] {
  const markers = new Set<string>();
  const add = (v: string | undefined) => {
    if (!v || v.length < 4) return;
    markers.add(v);
    markers.add(v.replace(/\\/g, '/'));
    markers.add(v.replace(/\\/g, '\\\\'));
  };
  add(homedir());
  add(tmpdir());
  add(process.cwd());
  add(hostname());
  try {
    add(userInfo().username.length >= 4 ? userInfo().username : undefined);
  } catch {
    // no user name available
  }
  for (const e of extra) add(e);
  return [...markers].filter((m) => m.length >= 4);
}

const GENERIC_LOCAL_PATH = [
  /\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings|Windows|ProgramData)[\\/]/,
  /(?:^|[\s"'=(])\/(?:home|Users|root|private\/var|tmp|var\/folders)\/[^\s"']+/,
  /\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9$._-]+/,
];

function scanLocalPaths(text: string, path: string, markers: readonly string[], out: BundleFinding[]): void {
  const lower = text.toLowerCase();
  if (markers.some((m) => lower.includes(m.toLowerCase())) || GENERIC_LOCAL_PATH.some((r) => r.test(text))) {
    out.push({ category: 'LOCAL_PATH', path, count: 1, blocking: true });
  }
}

interface BuiltEntry {
  readonly path: string;
  readonly kind: string;
  readonly content: Buffer;
  /** Parsed JSON for scanning; null for text entries. */
  readonly value: Json | null;
}

function scanEntries(
  entries: readonly BuiltEntry[],
  options: {
    configuredSecrets: readonly string[];
    acknowledgeAddresses: boolean;
    markers: readonly string[];
  },
): BundleFinding[] {
  const findings: BundleFinding[] = [];
  for (const e of entries) {
    const text = e.content.toString('utf8');
    const target = e.value ?? { text };
    const scan = scanForExport(target, {
      configuredSecrets: options.configuredSecrets,
      acknowledgeAddresses: true,
    });
    for (const f of scan.findings) {
      const blocking = f.category !== 'SENSITIVE_ADDRESS' || !options.acknowledgeAddresses;
      findings.push({ category: f.category, path: `${e.path}#${f.path}`, count: f.count, blocking });
    }
    scanLocalPaths(text, e.path, options.markers, findings);
  }
  return findings.sort((a, b) =>
    a.category < b.category
      ? -1
      : a.category > b.category
        ? 1
        : a.path < b.path
          ? -1
          : a.path > b.path
            ? 1
            : 0,
  );
}

function bundleReport(view: GateEvaluationView): GateReport {
  // Artifact readiness is recorded outside the bundle: the bundle cannot depend on itself.
  return { ...buildGateReport(view), artifact: { ready: false, exportIds: [] } };
}

function caseDir(ordinal: number): string {
  return `cases/${String(ordinal).padStart(3, '0')}`;
}

function sanitizeAttachmentName(name: string, index: number): string {
  const base = name
    .replace(/^.*[\\/]/, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '');
  const trimmed = (base || 'attachment').slice(0, 48);
  return `attachments/${String(index + 1).padStart(2, '0')}-${trimmed}`;
}

function validateAttachments(attachments: readonly ExportAttachment[]): ExportAttachment[] {
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'Too many export attachments.', {
      details: { max: MAX_ATTACHMENTS },
    });
  }
  return attachments.map((a, i) => {
    if (typeof a.content !== 'string' || Buffer.byteLength(a.content, 'utf8') > MAX_ATTACHMENT_BYTES) {
      throw new RouteSpecError('RS_SCHEMA_INVALID', 'Export attachment exceeds the size limit.', {
        details: { index: i, maxBytes: MAX_ATTACHMENT_BYTES },
      });
    }
    return { name: sanitizeAttachmentName(a.name, i), content: a.content };
  });
}

/** Build the bundle content entries (everything except manifest and checksums). */
function buildContent(
  store: RouteSpecStore,
  view: GateEvaluationView,
  options: { includeAddresses: boolean; attachments: readonly ExportAttachment[] },
): BuiltEntry[] {
  const entries: BuiltEntry[] = [];
  const add = (path: string, kind: string, value: Json | null, content?: Buffer) => {
    entries.push({ path, kind, value, content: content ?? json(value) });
  };
  const report = bundleReport(view);
  add('reports/gate-report.json', 'GATE_REPORT_JSON', report as unknown as Json);
  add('reports/junit.xml', 'GATE_REPORT_JUNIT', null, Buffer.from(renderJUnit(report), 'utf8'));
  add('reports/sarif.json', 'GATE_REPORT_SARIF', JSON.parse(renderSarif(report)) as Json);
  for (const c of view.cases) {
    if (c.caseRunId === null) continue;
    const result = store.getCaseResult(c.caseRunId);
    const dir = caseDir(c.ordinal);
    if (result) {
      add(
        `${dir}/canonical-result.json`,
        'CANONICAL_CASE_RESULT',
        JSON.parse(String(result['canonical_json'])) as Json,
      );
    }
    const caseRun = store.getCaseRun(c.caseRunId);
    if (!caseRun || caseRun['session_id'] === null) continue;
    const snap = store.readEvaluationSnapshot(c.caseRunId);
    add(
      `${dir}/invariant-results.json`,
      'INVARIANT_RESULTS',
      store.listInvariantResults(c.caseRunId).map((r) => ({
        invariantId: r['invariant_id'] as string,
        verdict: r['verdict'] as string,
        runOperationId: (r['run_operation_id'] as string | null) ?? null,
        evaluatorRevision: r['evaluator_revision'] as string,
        evidenceIds: JSON.parse(String(r['evidence_ids_json'])) as Json,
        missingPredicates: JSON.parse(String(r['missing_predicates_json'])) as Json,
        reasons: JSON.parse(String(r['reasons_json'])) as Json,
        fencingEpoch: r['fencing_epoch'] as number,
        resultDigest: r['result_digest'] as string,
      })) as Json,
    );
    add(
      `${dir}/events.json`,
      'NORMALIZED_EVENTS',
      snap.events.map((e) => ({
        sequence: e['sequence'] as number,
        eventKind: e['event_kind'] as string,
        runOperationId: (e['run_operation_id'] as string | null) ?? null,
        fencingEpoch: e['fencing_epoch'] as number,
        rawStatus: (e['raw_status'] as string | null) ?? null,
        normalizedFact: (e['normalized_fact'] as string | null) ?? null,
        sourceKind: e['source_kind'] as string,
        payloadDigest: (e['payload_digest'] as string | null) ?? null,
        scenarioStepId: (e['scenario_step_id'] as string | null) ?? null,
        virtualMs: (e['virtual_ms'] as number | null) ?? null,
      })) as Json,
    );
    add(
      `${dir}/evidence.json`,
      'EVIDENCE_MANIFEST',
      snap.evidence.map((e) => ({
        evidenceId: e['evidence_id'] as string,
        sequence: e['sequence'] as number,
        runOperationId: (e['run_operation_id'] as string | null) ?? null,
        evidenceClass: e['evidence_class'] as string,
        evidenceScope: e['evidence_scope'] as string,
        reasons: JSON.parse(String(e['reasons_json'])) as Json,
        subject: e['subject'] as string,
        sourceKind: e['source_kind'] as string,
        assetId: (e['asset_id'] as string | null) ?? null,
        amount: (e['amount'] as string | null) ?? null,
        payloadDigest: e['payload_digest'] as string,
        fencingEpoch: e['fencing_epoch'] as number,
      })) as Json,
    );
    add(
      `${dir}/operations.json`,
      'RUN_OPERATIONS',
      snap.runOperations.map((o) => {
        const fin = snap.quoteFinalizations.find((q) => q['run_operation_id'] === o['run_operation_id']);
        const deposit = fin ? ((fin['deposit_address'] as string | null) ?? null) : null;
        return {
          runOperationId: o['run_operation_id'] as string,
          logicalJobId: o['logical_job_id'] as string,
          currentPhase: o['current_phase'] as string,
          normalizedOutcome: (o['normalized_outcome'] as string | null) ?? null,
          acceptedTerminalStatus: (o['accepted_terminal_status'] as string | null) ?? null,
          quoteRequestDigest: o['quote_request_digest'] as string,
          quoteFinalizationDigest: (o['quote_finalization_digest'] as string | null) ?? null,
          commitBindingDigest: (o['commit_binding_digest'] as string | null) ?? null,
          quoteRequest: maskQuoteRequest(
            JSON.parse(String(o['quote_request_json'])) as Record<string, unknown>,
            options.includeAddresses,
          ),
          ...(options.includeAddresses
            ? { depositAddress: deposit }
            : { depositAddressDigest: addressDigest(deposit) }),
          fencingEpoch: o['fencing_epoch'] as number,
        };
      }) as unknown as Json,
    );
  }
  for (const a of options.attachments) {
    let value: Json | null = null;
    if (a.name.endsWith('.json')) {
      try {
        value = JSON.parse(a.content) as Json;
      } catch {
        value = null;
      }
    }
    add(a.name, 'OPERATOR_ATTACHMENT', value, Buffer.from(a.content, 'utf8'));
  }
  return entries;
}

function finalizeBundle(
  view: GateEvaluationView,
  content: readonly BuiltEntry[],
  options: { includeAddresses: boolean; acknowledgeAddresses: boolean },
  journalSchemaVersion: number,
): { tar: Buffer; entries: Array<{ path: string; digest: string; bytes: number; kind: string }> } {
  const entries = content.map((e) => ({
    path: e.path,
    digest: sha256(e.content),
    bytes: e.content.length,
    kind: e.kind,
  }));
  const manifest = {
    format: BUNDLE_FORMAT,
    schemaVersions: {
      bundle: '1',
      gateReport: 'routespec.gate-report/1',
      canonicalCaseResult: '1.0',
      journal: journalSchemaVersion,
    },
    gateEvaluationId: view.gateEvaluationId,
    gateRunId: view.gateRunId,
    decision: view.decision,
    decisionDigest: view.decisionDigest,
    identityDigest: view.identityDigest,
    identity: view.identity,
    aggregatorRevision: view.aggregatorRevision,
    evaluatorRevision: view.runtime['evaluatorRevision'] ?? null,
    proxyRevision: view.runtime['proxyRevision'] ?? null,
    enforcement: {
      mode: view.enforcementMode,
      digest: view.enforcementDigest,
      verified: false,
      blocking: false,
    },
    artifactReadiness: 'RECORDED_OUTSIDE_BUNDLE',
    provenance: [
      'Networkless SIMULATE/REPLAY scenario evidence: proven within scenario only.',
      'No official-endpoint, live, or fund-moving behavior is represented.',
    ],
    addresses: options.includeAddresses
      ? { included: true, acknowledged: options.acknowledgeAddresses }
      : { included: false, masking: 'routespec.export-address/1 digests' },
    toolchain: { runtime: `node ${process.versions.node}`, bundleScanner: BUNDLE_SCANNER_REVISION },
    exclusions: DECLARED_EXCLUSIONS,
    entries,
    signature: null,
    signatureNote: 'Checksums identify content; no signature is claimed until a signing ADR is accepted.',
  };
  const manifestBytes = json(manifest);
  const all: TarEntry[] = [
    ...content.map((e) => ({ path: e.path, content: e.content })),
    { path: 'manifest.json', content: manifestBytes },
  ];
  const checksums = [...all]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((e) => `${createHash('sha256').update(e.content).digest('hex')}  ${e.path}`)
    .join('\n');
  all.push({ path: 'checksums.sha256', content: Buffer.from(`${checksums}\n`, 'utf8') });
  const tar = writeTar(all);
  if (tar.length > MAX_BUNDLE_BYTES)
    throw new RouteSpecError('RS_EXPORT_BLOCKED', 'Bundle exceeds the size limit.');
  return { tar, entries };
}

function planView(gates: GateJournal, exportId: string, created: boolean): ExportPlanResult {
  const p = gates.getExportPlan(exportId);
  return {
    exportId,
    created,
    blocked: p.blocked,
    planDigest: p.planDigest,
    bundleDigest: p.bundleDigest,
    bundleBytes: p.bundleBytes,
    findings: p.findings as BundleFinding[],
    entries: p.entries,
    exclusions: p.exclusions,
    privacyScanResult: p.privacyScanResult,
    revision: p.revision,
  };
}

export function planExport(
  store: RouteSpecStore,
  gateEvaluationId: string,
  options: PlanExportOptions,
): ExportPlanResult {
  const gates = new GateJournal(store);
  const view = gates.getGateEvaluation(gateEvaluationId);
  const includeAddresses = options.includeAddresses === true;
  const acknowledgeAddresses = options.acknowledgeAddresses === true;
  const attachments = validateAttachments(options.attachments ?? []);
  const content = buildContent(store, view, { includeAddresses, attachments });
  const findings = scanEntries(content, {
    configuredSecrets: options.configuredSecrets ?? [],
    acknowledgeAddresses,
    markers: pathMarkers(options.localPathMarkers ?? []),
  });
  const blocked = findings.some((f) => f.blocking);
  const built = blocked
    ? null
    : finalizeBundle(view, content, { includeAddresses, acknowledgeAddresses }, store.schemaVersion);
  const bundleDigest = built ? sha256(built.tar) : null;
  const opts = {
    includeAddresses,
    acknowledgeAddresses,
    attachments: attachments.map((a) => ({ name: a.name, digest: sha256(a.content) })),
    scanner: BUNDLE_SCANNER_REVISION,
  };
  const planDigest = digestValue('routespec.export-plan/1', {
    gateEvaluationId,
    decisionDigest: view.decisionDigest,
    options: opts,
    bundleDigest,
    findings,
  });
  const privacyScanResult = blocked
    ? 'BLOCKED'
    : findings.some((f) => f.category === 'SENSITIVE_ADDRESS')
      ? 'ADDRESSES_ACKNOWLEDGED'
      : 'CLEAN';
  const { exportId, created } = gates.createExportPlan({
    gateEvaluationId,
    idempotencyKey: options.idempotencyKey,
    planDigest,
    bundleDigest,
    bundleBytes: built ? built.tar.length : null,
    options: opts,
    findings,
    entries: built ? built.entries : [],
    exclusions: DECLARED_EXCLUSIONS,
    attachments: blocked ? null : attachments,
    blocked,
    privacyScanResult,
  });
  return planView(gates, exportId, created);
}

function rebuild(
  store: RouteSpecStore,
  gates: GateJournal,
  exportId: string,
): { tar: Buffer; planDigest: string } {
  const plan = gates.getExportPlan(exportId);
  if (plan.blocked || plan.bundleDigest === null) {
    throw new RouteSpecError(
      'RS_EXPORT_BLOCKED',
      'Export privacy scan blocked this plan; nothing is written.',
      {
        details: { findings: plan.findings.slice(0, 32).map((f) => `${f.category}@${f.path}`) },
      },
    );
  }
  const view = gates.getGateEvaluation(plan.gateEvaluationId);
  const includeAddresses = plan.options['includeAddresses'] === true;
  const acknowledgeAddresses = plan.options['acknowledgeAddresses'] === true;
  const content = buildContent(store, view, { includeAddresses, attachments: plan.attachments ?? [] });
  const built = finalizeBundle(
    view,
    content,
    { includeAddresses, acknowledgeAddresses },
    store.schemaVersion,
  );
  if (sha256(built.tar) !== plan.bundleDigest) {
    throw new RouteSpecError(
      'RS_BUNDLE_VERIFY_FAILED',
      'The journal no longer reproduces the planned bundle.',
      {
        details: { exportId },
      },
    );
  }
  return { tar: built.tar, planDigest: plan.planDigest };
}

/**
 * Resolve an explicit local output file (M11 path policy, T-040): plain local path syntax only
 * (no UNC or device namespace, drive-relative path, alternate data stream, reserved device
 * name, or trailing dot/space), an existing parent directory, and a final component that is
 * absent or a regular file (never a link or junction, dangling links included).
 */
export function resolveOutputPath(outPath: string): string {
  return resolveOutputFile(outPath, 'RS_EXPORT_PATH_INVALID').path;
}

export interface WriteExportOptions {
  readonly outPath: string;
  /** Explicit local confirmation: the plan digest shown by `export plan`. */
  readonly confirm: string;
  /** Distinct confirmation required to replace an existing file. */
  readonly overwrite?: boolean;
  readonly retainPath?: boolean;
  readonly idempotencyKey: string;
}

export interface WriteExportResult {
  readonly exportId: string;
  readonly outputDigest: string;
  readonly bytes: number;
  readonly artifactReady: boolean;
  readonly revision: number;
  readonly overwrote: boolean;
}

export function writeExport(
  store: RouteSpecStore,
  exportId: string,
  options: WriteExportOptions,
): WriteExportResult {
  const gates = new GateJournal(store);
  const plan = gates.getExportPlan(exportId);
  if (plan.blocked) {
    throw new RouteSpecError(
      'RS_EXPORT_BLOCKED',
      'Export privacy scan blocked this plan; nothing is written.',
      {
        details: { findings: plan.findings.slice(0, 32).map((f) => `${f.category}@${f.path}`) },
      },
    );
  }
  if (options.confirm !== plan.planDigest) {
    throw new RouteSpecError(
      'RS_EXPORT_CONFIRMATION_REQUIRED',
      'Writing requires the exact plan digest as confirmation.',
    );
  }
  const target = resolveOutputFile(options.outPath, 'RS_EXPORT_PATH_INVALID');
  const full = target.path;
  const exists = target.exists;
  if (exists && options.overwrite !== true) {
    throw new RouteSpecError(
      'RS_EXPORT_OVERWRITE_DENIED',
      'The output file exists; overwriting needs a distinct confirmation.',
    );
  }
  const { tar } = rebuild(store, gates, exportId);
  const tmp = join(dirname(full), `.routespec-export-${randomBytes(8).toString('hex')}.tmp`);
  const outputDigest = sha256(tar);
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, tar);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (exists) {
      // Confirmed overwrite of the regular file checked above. A link planted since the check
      // is itself replaced: rename never follows its destination.
      renameSync(tmp, full);
    } else {
      // No overwrite confirmation: publish with an exclusive hard link, which fails if any entry
      // (file, link, or junction) appeared at the target after the check.
      try {
        linkSync(tmp, full);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new RouteSpecError(
            'RS_EXPORT_OVERWRITE_DENIED',
            'The output file exists; overwriting needs a distinct confirmation.',
          );
        }
        throw error;
      }
      rmSync(tmp, { force: true });
    }
    if (sha256(readFileSync(full)) !== outputDigest) {
      throw new RouteSpecError('RS_EXPORT_WRITE_FAILED', 'Written bundle does not match its digest.');
    }
  } catch (error) {
    rmSync(tmp, { force: true });
    const code = error instanceof RouteSpecError ? error.code : 'RS_EXPORT_WRITE_FAILED';
    gates.recordExportWrite({
      exportId,
      expectedRevision: plan.revision,
      idempotencyKey: `${options.idempotencyKey}.failed`,
      outcome: 'FAILED',
      outputDigest: null,
      failureCode: code,
      overwrite: exists,
      retainedPath: null,
    });
    throw new RouteSpecError(
      'RS_EXPORT_WRITE_FAILED',
      'The bundle could not be written; artifact readiness stays false.',
      {
        details: { cause: code },
      },
    );
  }
  const recorded = gates.recordExportWrite({
    exportId,
    expectedRevision: plan.revision,
    idempotencyKey: options.idempotencyKey,
    outcome: 'WRITTEN',
    outputDigest,
    failureCode: null,
    overwrite: exists,
    retainedPath: options.retainPath === true ? full : null,
  });
  return {
    exportId,
    outputDigest,
    bytes: tar.length,
    artifactReady: recorded.artifactReady,
    revision: recorded.revision,
    overwrote: exists,
  };
}

/** Record a failed write attempt without touching the file system (for example a refused path). */
export function recordExportFailure(
  store: RouteSpecStore,
  exportId: string,
  code: string,
  idempotencyKey: string,
): void {
  const gates = new GateJournal(store);
  const plan = gates.getExportPlan(exportId);
  if (plan.blocked) return;
  gates.recordExportWrite({
    exportId,
    expectedRevision: plan.revision,
    idempotencyKey,
    outcome: 'FAILED',
    outputDigest: null,
    failureCode: code,
    overwrite: false,
    retainedPath: null,
  });
}

// ---------------------------------------------------------------------------------------------
// Verification after clean extraction.

export interface BundleCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string | null;
}

export interface BundleVerification {
  readonly verified: boolean;
  readonly bundleDigest: string;
  readonly gateEvaluationId: string | null;
  readonly decision: string | null;
  readonly entryCount: number;
  readonly checks: readonly BundleCheck[];
  readonly findings: readonly BundleFinding[];
}

const ENVELOPE_KEYS = [
  'wallClockStartedAt',
  'wallClockEndedAt',
  'hostName',
  'dataDirectory',
  'workingDirectory',
  'artifactPaths',
];

function hasKey(value: unknown, keys: readonly string[]): boolean {
  if (Array.isArray(value)) return value.some((v) => hasKey(v, keys));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => keys.includes(k) || hasKey(v, keys));
  }
  return false;
}

function junitProperty(xmlText: string, name: string): string | null {
  const m = new RegExp(`<property name="${name.replace(/\./g, '\\.')}" value="([^"]*)"/>`).exec(xmlText);
  return m ? (m[1] as string) : null;
}

export function verifyBundle(
  bundlePath: string,
  extractDir: string,
  options: { configuredSecrets?: readonly string[]; localPathMarkers?: readonly string[] } = {},
): BundleVerification {
  // Reading never writes, but a network or device path is refused here too: opening a UNC path
  // can send the operator's credentials to a remote host.
  const source = resolveInputFile(bundlePath, 'RS_EXPORT_PATH_INVALID', { followLinks: true });
  if (statSync(source).size > MAX_BUNDLE_BYTES)
    throw new RouteSpecError('RS_BUNDLE_VERIFY_FAILED', 'Bundle archive exceeds the size limit.');
  const bytes = readFileSync(source);
  const bundleDigest = sha256(bytes);
  const entries = readTar(bytes);
  const dir = resolveExtractionDir(extractDir, 'RS_EXPORT_PATH_INVALID');
  if (dir.exists) {
    if (readdirSync(dir.path).length > 0) {
      throw new RouteSpecError('RS_EXPORT_PATH_INVALID', 'The extraction directory must be new or empty.');
    }
  } else {
    mkdirSync(dir.path, { recursive: true, mode: 0o700 });
  }
  // Every entry is checked against the canonical real path of the chosen directory, so neither
  // a hostile name nor a link inside the tree can redirect a write elsewhere.
  const root = realpathSync.native(dir.path);
  for (const e of entries) {
    if (!isSafeEntryName(e.path)) throw new RouteSpecError('RS_BUNDLE_VERIFY_FAILED', 'Unsafe entry name.');
    const target = resolve(root, ...e.path.split('/'));
    if (target === root || !isWithin(root, target))
      throw new RouteSpecError('RS_BUNDLE_VERIFY_FAILED', 'Entry escapes the extraction directory.');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (!isWithin(root, realpathSync.native(dirname(target))))
      throw new RouteSpecError('RS_BUNDLE_VERIFY_FAILED', 'Entry escapes the extraction directory.');
    const fd = openSync(target, 'wx', 0o600);
    try {
      writeSync(fd, e.content);
    } finally {
      closeSync(fd);
    }
  }
  // Everything below reads the extracted copy only.
  const files = new Map<string, Buffer>();
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full, rel);
      else if (st.isFile()) files.set(rel, readFileSync(full));
      else files.set(rel, Buffer.alloc(0));
    }
  };
  walk(root, '');
  const checks: BundleCheck[] = [];
  const check = (name: string, ok: boolean, detail: string | null = null) =>
    checks.push({ name, ok, detail });
  const read = (p: string): unknown => {
    const b = files.get(p);
    if (!b) return null;
    try {
      return JSON.parse(b.toString('utf8')) as unknown;
    } catch {
      return null;
    }
  };
  const manifest = read('manifest.json') as Record<string, unknown> | null;
  check('manifest-present', manifest !== null && manifest['format'] === BUNDLE_FORMAT);
  const listed = Array.isArray(manifest?.['entries'])
    ? (manifest['entries'] as Array<{ path: string; digest: string; bytes: number }>)
    : [];
  const digestsOk = listed.every((e) => {
    const b = files.get(e.path);
    return b !== undefined && sha256(b) === e.digest && b.length === e.bytes;
  });
  check('entry-digests', listed.length > 0 && digestsOk);
  const expectedFiles = new Set([...listed.map((e) => e.path), 'manifest.json', 'checksums.sha256']);
  const unexpected = [...files.keys()].filter((p) => !expectedFiles.has(p));
  check(
    'no-undeclared-files',
    unexpected.length === 0 && files.size === expectedFiles.size,
    unexpected.join(',') || null,
  );
  const sums = (files.get('checksums.sha256')?.toString('utf8') ?? '').trim().split('\n').filter(Boolean);
  const sumsOk =
    sums.length === files.size - 1 &&
    sums.every((line) => {
      const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      const b = m ? files.get(m[2] as string) : undefined;
      return m !== null && b !== undefined && createHash('sha256').update(b).digest('hex') === m[1];
    });
  check('checksums', sumsOk);
  const report = read('reports/gate-report.json') as Record<string, unknown> | null;
  const sarif = read('reports/sarif.json') as {
    runs?: Array<{ properties?: Record<string, unknown>; results?: unknown[] }>;
  } | null;
  const junit = files.get('reports/junit.xml')?.toString('utf8') ?? '';
  const run0 = sarif?.runs?.[0];
  const counts = (report?.['counts'] ?? {}) as Record<string, number>;
  const cases = Array.isArray(report?.['cases']) ? (report['cases'] as unknown[]) : [];
  check(
    'identity-parity',
    manifest !== null &&
      report !== null &&
      manifest['identityDigest'] === report['identityDigest'] &&
      manifest['gateEvaluationId'] === report['gateEvaluationId'] &&
      junitProperty(junit, 'routespec.identityDigest') === report['identityDigest'] &&
      run0?.properties?.['routespec.identityDigest'] === report['identityDigest'],
  );
  check(
    'decision-parity',
    manifest !== null &&
      report !== null &&
      manifest['decision'] === report['decision'] &&
      manifest['decisionDigest'] === report['decisionDigest'] &&
      junitProperty(junit, 'routespec.decision') === report['decision'] &&
      run0?.properties?.['routespec.decision'] === report['decision'],
  );
  const junitTests = /<testsuite [^>]*tests="(\d+)" failures="(\d+)" errors="(\d+)" skipped="(\d+)"/.exec(
    junit,
  );
  check(
    'count-parity',
    junitTests !== null &&
      Number(junitTests[1]) === cases.length &&
      Number(junitTests[2]) === counts['fail'] &&
      Number(junitTests[3]) === (counts['review'] ?? 0) + (counts['unsupported'] ?? 0) &&
      Number(junitTests[4]) === counts['notRun'],
  );
  check(
    'sarif-locations-real',
    Array.isArray(run0?.results) &&
      (
        run0.results as Array<{
          locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: string } } }>;
        }>
      ).every(
        (r) =>
          r.locations?.every((l) => typeof l.physicalLocation?.artifactLocation?.uri === 'string') ?? false,
      ),
  );
  const addresses = (manifest?.['addresses'] ?? {}) as Record<string, unknown>;
  const scanned: BuiltEntry[] = [...files].map(([path, content]) => {
    let value: Json | null = null;
    if (path.endsWith('.json')) {
      try {
        value = JSON.parse(content.toString('utf8')) as Json;
      } catch {
        value = null;
      }
    }
    return { path, kind: 'EXTRACTED', content, value };
  });
  const findings = scanEntries(scanned, {
    configuredSecrets: options.configuredSecrets ?? [],
    acknowledgeAddresses: addresses['included'] === true && addresses['acknowledged'] === true,
    markers: pathMarkers(options.localPathMarkers ?? []),
  });
  check(
    'secret-rescan',
    !findings.some((f) => f.blocking),
    findings
      .filter((f) => f.blocking)
      .map((f) => f.category)
      .join(',') || null,
  );
  const exclusions = Array.isArray(manifest?.['exclusions']) ? (manifest['exclusions'] as string[]) : [];
  check(
    'exclusions-declared',
    DECLARED_EXCLUSIONS.every((x) => exclusions.includes(x)),
  );
  check(
    'no-run-envelopes',
    ![...files.keys()].some((p) => p.endsWith('.json') && hasKey(read(p), ENVELOPE_KEYS)),
  );
  check('no-signature-claim', manifest !== null && manifest['signature'] === null);
  check('extraction-contained', isAbsolute(root) && [...files.keys()].every((p) => isSafeEntryName(p)));
  return {
    verified: checks.every((c) => c.ok),
    bundleDigest,
    gateEvaluationId:
      typeof manifest?.['gateEvaluationId'] === 'string' ? manifest['gateEvaluationId'] : null,
    decision: typeof manifest?.['decision'] === 'string' ? manifest['decision'] : null,
    entryCount: files.size,
    checks,
    findings,
  };
}
