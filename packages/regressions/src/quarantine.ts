/**
 * No-network quarantine analysis (FR-11, NFR-03, NFR-06; TDD.md section 13 steps 2-3).
 *
 * A pure function over bounded in-memory bytes. Order matters and is fixed:
 *   1. resource bound (bytes) and strict UTF-8;
 *   2. bounded strict JSON (depth, strings, keys, nodes, duplicate and prototype keys);
 *   3. secret scan over every key and value — any hit rejects; nothing derived from the source
 *      except its digest and finding metadata is kept;
 *   4. active-content neutralization (flagged for review);
 *   5. signed-material digesting and origin-claim correction;
 *   6. strict trace schema and record-count bound;
 *   7. ordering/time determinism, reference and material resolution, identity checks.
 * Steps 1-3 and 6 reject; step 7 findings block mapping and promotion; step 4-5 are advisory.
 *
 * This module imports no network, filesystem, process, or database capability.
 */
import {
  digestValue,
  validateQuoteRequest,
  StatusQueryMaterial,
  DigestString,
  type ImportOrigin,
} from '@routespec/contracts';
import { FindingSet, safePath, type Finding } from './findings.ts';
import { decodeUtf8, parseBoundedJson, type IngestResult, type JsonValue } from './ingest.ts';
import type { ImportLimits } from './limits.ts';
import { neutralizeDocument, scanSecrets } from './scan.ts';
import { TraceDocument, traceRecordCount, type TraceIdentity } from './trace.ts';

export type IdentityResolution = 'MATCH' | 'MISMATCH' | 'UNKNOWN_SOURCE';

export interface AnalyzeContext {
  /** The origin RouteSpec itself established; a document can never upgrade it. */
  readonly origin: ImportOrigin;
  readonly limits: ImportLimits;
  readonly configuredSecrets?: readonly string[];
  /** Compares a claimed identity with the journal; `UNKNOWN_SOURCE` when it names nothing known. */
  readonly resolveIdentity?: (identity: TraceIdentity) => { result: IdentityResolution; fields: string[] };
}

export interface QuarantineAnalysis {
  readonly disposition: 'REJECT' | 'SANITIZE';
  readonly schemaState: 'VALID' | 'INVALID' | 'NOT_PARSED';
  readonly sanitized: TraceDocument | null;
  readonly findings: readonly Finding[];
}

const PLACEHOLDER =
  /^[[(\u2039<{]?\s*(?:redacted|unresolved|unknown|placeholder|todo|tbd|\?+|x{3,}|\*{3,})\s*[\])\u203a>}]?$/i;

function reject(findings: FindingSet, schemaState: QuarantineAnalysis['schemaState']): QuarantineAnalysis {
  return { disposition: 'REJECT', schemaState, sanitized: null, findings: findings.list() };
}

function hasPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return PLACEHOLDER.test(value.trim()) || value.trim().length === 0;
  if (Array.isArray(value)) return value.some(hasPlaceholder);
  if (value !== null && typeof value === 'object') return Object.values(value).some(hasPlaceholder);
  return false;
}

/** Replace a raw commit transaction hash by its profile digest (signed material never persists). */
function digestSignedMaterial(doc: JsonValue, findings: FindingSet): void {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return;
  const exchanges = doc['exchanges'];
  if (!Array.isArray(exchanges)) return;
  exchanges.forEach((ex, i) => {
    if (ex === null || typeof ex !== 'object' || Array.isArray(ex)) return;
    const material = ex['material'];
    if (material === null || typeof material !== 'object' || Array.isArray(material)) return;
    for (const key of ['txHash', 'signedPayload', 'signature', 'signedTransaction']) {
      const raw = material[key];
      if (typeof raw === 'string') {
        delete material[key];
        if (key === 'txHash')
          material['transactionDigest'] = digestValue('routespec.oneclick.tx-hash/1', raw);
        findings.add('SIGNED_MATERIAL_DIGESTED', safePath(['exchanges', i, 'material', key]));
      }
    }
  });
}

export function analyzeTrace(ingest: IngestResult, ctx: AnalyzeContext): QuarantineAnalysis {
  const findings = new FindingSet();
  if (!ingest.complete || ingest.bytes === null) {
    findings.add('RESOURCE_BYTES', '$');
    return reject(findings, 'NOT_PARSED');
  }
  const text = decodeUtf8(ingest.bytes);
  if (text === null) {
    findings.add('SCHEMA_ENCODING', '$');
    return reject(findings, 'NOT_PARSED');
  }
  const parsed = parseBoundedJson(text, ctx.limits);
  if (!parsed.ok) {
    findings.add(parsed.category, parsed.path);
    return reject(findings, 'INVALID');
  }
  const secrets = scanSecrets(parsed.value, { configuredSecrets: ctx.configuredSecrets ?? [] });
  if (secrets.rejecting) return reject(secrets, 'NOT_PARSED');

  const neutral = neutralizeDocument(parsed.value, findings);
  digestSignedMaterial(neutral, findings);
  if (neutral !== null && typeof neutral === 'object' && !Array.isArray(neutral)) {
    if (ctx.origin === 'USER_FILE' && neutral['origin'] === 'INSTALLED_ARTIFACT_CAPTURE') {
      neutral['origin'] = 'USER_FILE';
      findings.add('ORIGIN_CLAIM_IGNORED', '$.origin');
    }
  }
  const schema = TraceDocument.safeParse(neutral);
  if (!schema.success) {
    const issue = schema.error.issues[0];
    const parts = (issue?.path ?? []).map((p) => (typeof p === 'number' ? p : String(p)));
    findings.add(parts[0] === 'identity' ? 'IDENTITY_MALFORMED' : 'SCHEMA_INVALID', safePath(parts));
    return reject(findings, 'INVALID');
  }
  const doc = schema.data;
  if (doc.origin !== ctx.origin) {
    findings.add('IDENTITY_MISMATCH', '$.origin');
  }
  if (traceRecordCount(doc) > ctx.limits.maxEvents) {
    findings.add('RESOURCE_EVENTS', '$');
    return reject(findings, 'VALID');
  }

  // Ordering and time determinism. An exchange and the lifecycle event it caused share one
  // session sequence, so exchanges and events are each strictly ordered and unique.
  const claimer = () => {
    const seen = new Set<number>();
    return (seq: number, path: string) => {
      if (seen.has(seq)) findings.add('DUPLICATE_SEQUENCE', path);
      seen.add(seq);
    };
  };
  const claimExchange = claimer();
  const claimEvent = claimer();
  doc.exchanges.forEach((ex, i) => {
    claimExchange(ex.sequence, safePath(['exchanges', i, 'sequence']));
    const prev = doc.exchanges[i - 1];
    if (prev && ex.sequence <= prev.sequence) {
      findings.add('NONDETERMINISTIC_ORDER', safePath(['exchanges', i, 'sequence']));
    }
  });
  doc.events.forEach((ev, i) => {
    claimEvent(ev.sequence, safePath(['events', i, 'sequence']));
    const prev = doc.events[i - 1];
    if (prev && ev.sequence <= prev.sequence) {
      findings.add('NONDETERMINISTIC_ORDER', safePath(['events', i, 'sequence']));
    }
  });
  const timed = [
    ...doc.exchanges.map((x, i) => ({
      seq: x.sequence,
      ms: x.virtualMs,
      path: safePath(['exchanges', i, 'virtualMs']),
    })),
    ...doc.events.map((x, i) => ({
      seq: x.sequence,
      ms: x.virtualMs,
      path: safePath(['events', i, 'virtualMs']),
    })),
  ].sort((a, b) => a.seq - b.seq);
  const withTime = timed.filter((t) => t.ms !== null);
  if (withTime.length > 0 && withTime.length !== doc.exchanges.length + doc.events.length) {
    findings.add('NONDETERMINISTIC_TIME', '$');
  }
  for (let i = 1; i < withTime.length; i++) {
    if ((withTime[i]?.ms as number) < (withTime[i - 1]?.ms as number)) {
      findings.add('NONDETERMINISTIC_TIME', withTime[i]?.path ?? '$');
    }
  }

  // References and material resolution against the pinned protocol profile.
  const ops = new Map<string, (typeof doc.operations)[number]>();
  doc.operations.forEach((op, i) => {
    if (ops.has(op.ref)) findings.add('UNRESOLVED_REFERENCE', safePath(['operations', i, 'ref']));
    ops.set(op.ref, op);
  });
  const refOk = (ref: string | null, parts: Array<string | number>, required: boolean) => {
    if (ref === null) {
      if (required) findings.add('UNRESOLVED_REFERENCE', safePath(parts));
      return;
    }
    if (!ops.has(ref)) findings.add('UNRESOLVED_REFERENCE', safePath(parts));
  };
  doc.exchanges.forEach((ex, i) => {
    const at = (...rest: Array<string | number>) => safePath(['exchanges', i, ...rest]);
    refOk(ex.operationRef, ['exchanges', i, 'operationRef'], true);
    const op = ex.operationRef === null ? undefined : ops.get(ex.operationRef);
    if (hasPlaceholder(ex.material)) findings.add('UNRESOLVED_MATERIAL', at('material'));
    if (ex.route === 'QUOTE') {
      try {
        validateQuoteRequest(ex.material);
      } catch {
        findings.add('UNRESOLVED_MATERIAL', at('material'));
      }
    } else if (ex.route === 'COMMIT') {
      const m = ex.material;
      const allowed = new Set(['depositAddress', 'transactionDigest', 'nearSenderAccount', 'memo']);
      const unknown = Object.keys(m).some((k) => !allowed.has(k));
      if (
        unknown ||
        typeof m['depositAddress'] !== 'string' ||
        !DigestString.safeParse(m['transactionDigest']).success ||
        !op ||
        op.depositAddress === null ||
        op.depositAddress !== m['depositAddress']
      ) {
        findings.add('UNRESOLVED_MATERIAL', at('material'));
      }
    } else {
      const parsedStatus = StatusQueryMaterial.safeParse(ex.material);
      if (!parsedStatus.success || !op || op.depositAddress !== parsedStatus.data.depositAddress) {
        findings.add('UNRESOLVED_MATERIAL', at('material'));
      }
    }
  });
  doc.events.forEach((ev, i) => refOk(ev.operationRef, ['events', i, 'operationRef'], false));
  doc.evidence.forEach((ev, i) => refOk(ev.operationRef, ['evidence', i, 'operationRef'], false));
  doc.subjectReports.forEach((r, i) => refOk(r.operationRef, ['subjectReports', i, 'operationRef'], false));
  doc.boundaryObservations.forEach((r, i) =>
    refOk(r.operationRef, ['boundaryObservations', i, 'operationRef'], false),
  );

  // Identity: an installed capture must match its journal exactly; a user file's claim is checked.
  if (ctx.origin === 'INSTALLED_ARTIFACT_CAPTURE' && doc.identity === null) {
    findings.add('IDENTITY_MALFORMED', '$.identity');
  }
  if (doc.identity !== null && ctx.resolveIdentity) {
    const resolved = ctx.resolveIdentity(doc.identity);
    if (resolved.result === 'MISMATCH') {
      for (const f of resolved.fields.slice(0, 16))
        findings.add('IDENTITY_MISMATCH', safePath(['identity', f]));
    } else if (resolved.result === 'UNKNOWN_SOURCE' && ctx.origin === 'INSTALLED_ARTIFACT_CAPTURE') {
      findings.add('IDENTITY_MISMATCH', '$.identity');
    }
  }
  return { disposition: 'SANITIZE', schemaState: 'VALID', sanitized: doc, findings: findings.list() };
}
