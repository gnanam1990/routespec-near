/**
 * Compatibility ledger: the separate, append-only compatibility axis (FR-16, INV-08).
 *
 * It is a SQLite file of its own, written only by the live-dry adapter process (one writer). It is
 * deliberately not part of the gate journal: its schema has no gate-run, case-run, verdict or
 * evidence-scope column, so a compatibility record cannot be joined into, or upgrade, a local
 * GateRun. It stores only redacted shape evidence, reason codes, profile identity and provider
 * timing: never request or response bodies, never the provider credential, never header values.
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  CompatibilityProbeRecord,
  digestValue,
  type ProviderTokenState,
  type Digest,
} from '@routespec/contracts';
import type { CompatibilityResult } from './compatibility.ts';
import { profileIdentity } from './compatibility.ts';
import type { EgressTiming } from './egress.ts';
import type { PolicyDenial } from './policy.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS compatibility_probes (
  probe_id TEXT PRIMARY KEY,
  protocol_profile_id TEXT NOT NULL,
  profile_integrity_digest TEXT NOT NULL,
  sdk_version TEXT NOT NULL,
  sdk_git_head TEXT NOT NULL,
  origin TEXT NOT NULL,
  transport_kind TEXT NOT NULL CHECK (transport_kind IN ('SYSTEM','INJECTED','NONE')),
  compatibility TEXT NOT NULL CHECK (compatibility IN
    ('DOCUMENTED_ONLY','OFFICIAL_ENDPOINT_COMPATIBLE','INCOMPATIBLE','UNKNOWN')),
  shape_result TEXT NOT NULL CHECK (shape_result IN ('SHAPE_COMPATIBLE','SHAPE_INCOMPATIBLE','NOT_JUDGED')),
  reason_code TEXT NOT NULL,
  http_status INTEGER,
  quote_request_digest TEXT,
  response_shape_json TEXT,
  response_shape_digest TEXT,
  response_bytes INTEGER NOT NULL,
  response_assigned_address TEXT NOT NULL CHECK (response_assigned_address IN ('PRESENT','ABSENT','NOT_OBSERVED')),
  credential_attached INTEGER NOT NULL CHECK (credential_attached IN (0,1)),
  token_state TEXT NOT NULL CHECK (token_state IN ('NOT_REQUIRED','OPTIONAL_ABSENT','PRESENT_IN_MEMORY','EXPIRED')),
  timing_json TEXT NOT NULL,
  settlement_exercised INTEGER NOT NULL CHECK (settlement_exercised = 0),
  observed_at_ms INTEGER NOT NULL,
  record_digest TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS policy_denials (
  denial_id TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  code TEXT NOT NULL,
  reason TEXT NOT NULL,
  credential_attached INTEGER NOT NULL CHECK (credential_attached = 0),
  dns_attempted INTEGER NOT NULL CHECK (dns_attempted = 0),
  socket_attempted INTEGER NOT NULL CHECK (socket_attempted = 0),
  upstream_attempted INTEGER NOT NULL CHECK (upstream_attempted = 0),
  observed_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS compatibility_probes_no_update BEFORE UPDATE ON compatibility_probes
  BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER IF NOT EXISTS compatibility_probes_no_delete BEFORE DELETE ON compatibility_probes
  BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER IF NOT EXISTS policy_denials_no_update BEFORE UPDATE ON policy_denials
  BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER IF NOT EXISTS policy_denials_no_delete BEFORE DELETE ON policy_denials
  BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
`;

export interface ProbeEntry {
  readonly probeId: string;
  readonly compatibility: CompatibilityResult['compatibility'];
  readonly shapeResult: CompatibilityResult['shapeResult'];
  readonly reasonCode: string;
  readonly httpStatus: number | null;
  readonly transportKind: 'SYSTEM' | 'INJECTED' | 'NONE';
  readonly quoteRequestDigest: Digest | null;
  readonly responseShape: CompatibilityResult['responseShape'];
  readonly responseShapeDigest: Digest | null;
  readonly responseBytes: number;
  readonly responseAssignedAddress: CompatibilityResult['responseAssignedAddress'];
  readonly credentialAttached: boolean;
  readonly tokenState: ProviderTokenState;
  readonly timing: EgressTiming | null;
  readonly settlementExercised: false;
  readonly observedAtMs: number;
  readonly recordDigest: Digest;
}

export interface DenialEntry {
  readonly denialId: string;
  readonly method: string;
  readonly route: string;
  readonly code: string;
  readonly reason: string;
  readonly observedAtMs: number;
}

export class CompatibilityLedger {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
    this.#now = now;
  }

  recordProbe(input: {
    readonly result: CompatibilityResult;
    readonly transportKind: 'SYSTEM' | 'INJECTED' | 'NONE';
    readonly quoteRequestDigest: Digest | null;
    readonly credentialAttached: boolean;
    readonly tokenState: ProviderTokenState;
    readonly timing: EgressTiming | null;
  }): ProbeEntry {
    const id = profileIdentity();
    const probeId = randomUUID();
    const observedAtMs = this.#now();
    const body = {
      probeId,
      ...id,
      transportKind: input.transportKind,
      compatibility: input.result.compatibility,
      shapeResult: input.result.shapeResult,
      reasonCode: input.result.reasonCode,
      httpStatus: input.result.httpStatus,
      quoteRequestDigest: input.quoteRequestDigest,
      responseShapeDigest: input.result.responseShapeDigest,
      responseBytes: input.result.responseBytes,
      responseAssignedAddress: input.result.responseAssignedAddress,
      credentialAttached: input.credentialAttached,
      tokenState: input.tokenState,
      timing: input.timing,
      settlementExercised: false,
      observedAtMs,
    };
    const recordDigest = digestValue('routespec.live-dry.compatibility-probe/1', body);
    this.#db
      .prepare(
        `INSERT INTO compatibility_probes (probe_id, protocol_profile_id, profile_integrity_digest, sdk_version,
           sdk_git_head, origin, transport_kind, compatibility, shape_result, reason_code, http_status,
           quote_request_digest, response_shape_json, response_shape_digest, response_bytes,
           response_assigned_address, credential_attached, token_state, timing_json, settlement_exercised,
           observed_at_ms, record_digest)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
      )
      .run(
        probeId,
        id.protocolProfileId,
        id.profileIntegrityDigest,
        id.sdkVersion,
        id.sdkGitHead,
        id.origin,
        input.transportKind,
        input.result.compatibility,
        input.result.shapeResult,
        input.result.reasonCode,
        input.result.httpStatus,
        input.quoteRequestDigest,
        input.result.responseShape ? JSON.stringify(input.result.responseShape) : null,
        input.result.responseShapeDigest,
        input.result.responseBytes,
        input.result.responseAssignedAddress,
        input.credentialAttached ? 1 : 0,
        input.tokenState,
        JSON.stringify(input.timing),
        observedAtMs,
        recordDigest,
      );
    return this.probes().find((p) => p.probeId === probeId)!;
  }

  recordDenial(denial: PolicyDenial): DenialEntry {
    const denialId = randomUUID();
    const observedAtMs = this.#now();
    this.#db
      .prepare(
        `INSERT INTO policy_denials (denial_id, method, route, code, reason, credential_attached, dns_attempted,
           socket_attempted, upstream_attempted, observed_at_ms) VALUES (?,?,?,?,?,0,0,0,0,?)`,
      )
      .run(denialId, denial.method.slice(0, 16), denial.route, denial.code, denial.reason, observedAtMs);
    return {
      denialId,
      method: denial.method,
      route: denial.route,
      code: denial.code,
      reason: denial.reason,
      observedAtMs,
    };
  }

  probes(): ProbeEntry[] {
    const rows = this.#db.prepare('SELECT * FROM compatibility_probes ORDER BY observed_at_ms, rowid').all();
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return Object.freeze({
        probeId: String(row['probe_id']),
        compatibility: row['compatibility'] as ProbeEntry['compatibility'],
        shapeResult: row['shape_result'] as ProbeEntry['shapeResult'],
        reasonCode: String(row['reason_code']),
        httpStatus: row['http_status'] === null ? null : Number(row['http_status']),
        transportKind: row['transport_kind'] as ProbeEntry['transportKind'],
        quoteRequestDigest: (row['quote_request_digest'] as Digest | null) ?? null,
        responseShape:
          row['response_shape_json'] === null
            ? null
            : (JSON.parse(String(row['response_shape_json'])) as ProbeEntry['responseShape']),
        responseShapeDigest: (row['response_shape_digest'] as Digest | null) ?? null,
        responseBytes: Number(row['response_bytes']),
        responseAssignedAddress: row['response_assigned_address'] as ProbeEntry['responseAssignedAddress'],
        credentialAttached: row['credential_attached'] === 1,
        tokenState: row['token_state'] as ProviderTokenState,
        timing: JSON.parse(String(row['timing_json'])) as EgressTiming | null,
        settlementExercised: false as const,
        observedAtMs: Number(row['observed_at_ms']),
        recordDigest: String(row['record_digest']) as Digest,
      });
    });
  }

  denials(): DenialEntry[] {
    return this.#db
      .prepare('SELECT * FROM policy_denials ORDER BY observed_at_ms, rowid')
      .all()
      .map((r) => {
        const row = r as Record<string, unknown>;
        return {
          denialId: String(row['denial_id']),
          method: String(row['method']),
          route: String(row['route']),
          code: String(row['code']),
          reason: String(row['reason']),
          observedAtMs: Number(row['observed_at_ms']),
        };
      });
  }

  /** The contract-level view of one probe (the shared `compatibility-probe` record kind). */
  static toContractRecord(entry: ProbeEntry): CompatibilityProbeRecord {
    return CompatibilityProbeRecord.parse({
      schemaVersion: '1.0',
      probeId: entry.probeId,
      protocolProfileId: profileIdentity().protocolProfileId,
      compatibility: entry.compatibility,
      responseShapeDigest: entry.responseShapeDigest,
      observedAtMs: entry.observedAtMs,
    });
  }

  close(): void {
    this.#db.close();
  }
}
