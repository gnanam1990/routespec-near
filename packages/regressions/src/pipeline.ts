/**
 * Capture and import entry points (API-SPEC `POST /imports`, `POST /case-runs/{id}/captures`).
 *
 * Both paths stream bytes through the same bounded ingest and the same no-network quarantine
 * analysis. Only the origin differs, and RouteSpec — never the document — decides it:
 * - `captureInstalledCase` takes only a case run ID, derives the capture from the journal, binds
 *   its exact identity, and records `INSTALLED_ARTIFACT_CAPTURE`;
 * - `importUserFile` records `USER_FILE` whatever the file claims.
 */
import { createHash } from 'node:crypto';
import { RouteSpecError, digestValue, type Digest } from '@routespec/contracts';
import { ImportJournal, type StoredFinding } from '@routespec/store';
import { deriveInstalledCapture, resolveClaimedIdentity } from './capture.ts';
import { safePath, FindingSet, SCANNER_REVISION, type Finding } from './findings.ts';
import { ingestStream, type ByteSource } from './ingest.ts';
import { resolveImportLimits, type ImportLimits } from './limits.ts';
import { analyzeTrace, type QuarantineAnalysis } from './quarantine.ts';
import { canonicalTraceBytes } from './serialize.ts';

export interface ImportOutcome {
  readonly importId: string;
  readonly state: 'SANITIZED' | 'REJECTED';
  readonly revision: number;
  readonly rawSourceDigest: Digest;
  readonly findings: readonly Finding[];
}

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

/** Reduce an untrusted filename to a safe display basename; report anything that was unsafe. */
export function sanitizeFilename(name: string): { name: string; unsafe: boolean } {
  const parts = name.split(/[\\/]+/).filter((p) => p.length > 0);
  let base = parts.at(-1) ?? '';
  const unsafe =
    parts.length !== 1 ||
    /^[A-Za-z]:/.test(name) ||
    name.startsWith('\\\\') ||
    name.startsWith('/') ||
    parts.some((p) => p === '..' || p === '.') ||
    /[\u0000-\u001f\u007f<>:"|?*\u202a-\u202e\u2066-\u2069]/.test(base) ||
    WINDOWS_RESERVED.test(base) ||
    /[. ]$/.test(base) ||
    base.length > 128;
  base = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 128)
    // Windows strips a trailing dot or space, so such a name would alias another one.
    .replace(/[. ]+$/, '');
  if (WINDOWS_RESERVED.test(base)) base = `_${base}`;
  return { name: base.length > 0 ? base : 'trace.json', unsafe };
}

function stored(findings: readonly Finding[]): StoredFinding[] {
  return findings.map((f) => ({ category: f.category, path: f.path, count: f.count, blocking: f.blocking }));
}

function record(
  journal: ImportJournal,
  analysis: QuarantineAnalysis,
  extra: Finding[],
  input: {
    projectId: string;
    origin: 'INSTALLED_ARTIFACT_CAPTURE' | 'USER_FILE';
    sourceSessionId: string | null;
    sourceFilename: string | null;
    rawByteCount: number;
    rawSourceDigest: Digest;
    captureBinding: Parameters<ImportJournal['recordQuarantine']>[0]['captureBinding'];
    idempotencyKey: string;
  },
): ImportOutcome {
  const findings = [...analysis.findings, ...extra].sort((a, b) =>
    a.category < b.category ? -1 : a.category > b.category ? 1 : a.path < b.path ? -1 : 1,
  );
  const result = journal.recordQuarantine({
    ...input,
    disposition: analysis.disposition,
    sanitized: analysis.sanitized,
    schemaState: analysis.schemaState,
    findings: stored(findings),
    scannerRevision: SCANNER_REVISION,
  });
  return {
    importId: result.importId,
    state: result.state as ImportOutcome['state'],
    revision: result.revision,
    rawSourceDigest: input.rawSourceDigest,
    findings,
  };
}

export async function importUserFile(
  journal: ImportJournal,
  input: {
    projectId: string;
    filename: string;
    source: ByteSource;
    configuredSecrets?: readonly string[];
    limits?: Partial<ImportLimits>;
    idempotencyKey: string;
  },
): Promise<ImportOutcome> {
  const limits = resolveImportLimits(input.limits);
  const ingest = await ingestStream(input.source, limits.maxBytes);
  const store = journal.store;
  const analysis = analyzeTrace(ingest, {
    origin: 'USER_FILE',
    limits,
    configuredSecrets: input.configuredSecrets ?? [],
    resolveIdentity: (identity) => resolveClaimedIdentity(store, identity),
  });
  const file = sanitizeFilename(input.filename);
  const extra = new FindingSet();
  if (file.unsafe) extra.add('PATH_UNSAFE', safePath(['sourceFilename']));
  return record(journal, analysis, extra.list(), {
    projectId: input.projectId,
    origin: 'USER_FILE',
    sourceSessionId: null,
    sourceFilename: file.name,
    rawByteCount: ingest.byteCount,
    rawSourceDigest: ingest.digest,
    captureBinding: null,
    idempotencyKey: input.idempotencyKey,
  });
}

/** Capture the installed client's closed case run (no caller-supplied events are accepted). */
export async function captureInstalledCase(
  journal: ImportJournal,
  input: {
    caseRunId: string;
    configuredSecrets?: readonly string[];
    limits?: Partial<ImportLimits>;
    idempotencyKey: string;
  },
): Promise<ImportOutcome> {
  const limits = resolveImportLimits(input.limits);
  const store = journal.store;
  const capture = deriveInstalledCapture(store, input.caseRunId);
  const bytes = canonicalTraceBytes(capture.trace);
  // The capture goes through exactly the bounded streaming path a user file takes.
  const ingest = await ingestStream(chunked(bytes, 16_384), limits.maxBytes);
  const analysis = analyzeTrace(ingest, {
    origin: 'INSTALLED_ARTIFACT_CAPTURE',
    limits,
    configuredSecrets: input.configuredSecrets ?? [],
    resolveIdentity: (identity) => resolveClaimedIdentity(store, identity),
  });
  const id = capture.trace.identity;
  if (id === null) throw new Error('unreachable: installed capture always has identity');
  return record(journal, analysis, [], {
    projectId: id.projectId,
    origin: 'INSTALLED_ARTIFACT_CAPTURE',
    sourceSessionId: capture.sessionId,
    sourceFilename: null,
    rawByteCount: ingest.byteCount,
    rawSourceDigest: ingest.digest,
    captureBinding: {
      caseRunId: id.caseRunId,
      gateRunId: id.gateRunId,
      sessionId: id.sessionId,
      buildRevisionId: id.buildRevisionId,
      artifactDigest: id.artifactDigest,
      scenarioRevisionId: id.scenarioRevisionId,
      effectManifestDigest: id.effectManifestDigest,
      effectCoveragePolicyDigest: id.effectCoveragePolicyDigest,
      callsiteInventoryDigest: id.callsiteInventoryDigest,
      interceptorProfileDigest: id.interceptorProfileDigest,
      adapterRevision: id.adapterRevision,
      fencingEpoch: id.fencingEpoch,
      identityDigest: capture.identityDigest,
      captureDigest: capture.captureDigest,
    },
    idempotencyKey: input.idempotencyKey,
  });
}

function* chunked(bytes: Buffer, size: number): Generator<Buffer> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

/**
 * Re-derive an installed capture from the journal and compare it with what was recorded and
 * persisted. Any difference means the capture was replaced or the journal changed: refuse.
 */
export function verifyInstalledCapture(journal: ImportJournal, importId: string): void {
  const view = journal.getImport(importId);
  if (view.origin !== 'INSTALLED_ARTIFACT_CAPTURE') return;
  const binding = view.captureBinding;
  if (binding === null) {
    throw new CaptureMismatch('Installed capture has no identity binding.');
  }
  const capture = deriveInstalledCapture(journal.store, String(binding['case_run_id']));
  const limits = resolveImportLimits();
  const bytes = canonicalTraceBytes(capture.trace);
  const rawDigest = `sha256:${createHashHex(bytes)}`;
  const analysis = analyzeTrace(
    { bytes, byteCount: bytes.length, digest: rawDigest as Digest, complete: true },
    { origin: 'INSTALLED_ARTIFACT_CAPTURE', limits },
  );
  const sanitizedDigest =
    analysis.sanitized === null ? null : digestValue('routespec.import-sanitized/1', analysis.sanitized);
  if (
    capture.captureDigest !== binding['capture_digest'] ||
    capture.identityDigest !== binding['identity_digest'] ||
    rawDigest !== view.rawSourceDigest ||
    sanitizedDigest === null ||
    sanitizedDigest !== view.sanitizedDigest
  ) {
    throw new CaptureMismatch('Installed capture no longer matches its journal source.');
  }
}

function createHashHex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

class CaptureMismatch extends RouteSpecError {
  constructor(message: string) {
    super('RS_IMPORT_CAPTURE_MISMATCH', message);
  }
}
