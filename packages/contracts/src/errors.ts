/**
 * Typed, redaction-safe RouteSpec errors (API-SPEC.md section 3).
 *
 * Messages are human-safe; `details` must only contain non-secret scalar diagnostics.
 * Callers must never place authorization values, raw signed payloads, or configured
 * secrets in either field.
 */

export const ERROR_CODES = Object.freeze([
  // schema / contract
  'RS_SCHEMA_INVALID',
  'RS_SCHEMA_VERSION_UNSUPPORTED',
  'RS_UNKNOWN_CONTRACT_KIND',
  // canonical encoding
  'RS_CANONICAL_UNSUPPORTED_TYPE',
  'RS_CANONICAL_NON_INTEGER',
  'RS_CANONICAL_MALFORMED_STRING',
  'RS_CANONICAL_LIMIT_EXCEEDED',
  'RS_CANONICAL_DUPLICATE_SEQUENCE',
  // protocol profile / material
  'RS_UNKNOWN_MATERIAL_FIELD',
  'RS_DEPOSIT_ADDRESS_NOT_REQUEST_KNOWN',
  'RS_MATERIAL_INVALID',
  'RS_PARTIAL_FINALIZATION',
  'RS_FINALIZATION_CONFLICT',
  'RS_FINALIZATION_REQUEST_MISMATCH',
  'RS_COMMIT_WITHOUT_FINALIZATION',
  'RS_COMMIT_MATERIAL_MISMATCH',
  'RS_SECOND_COMMIT_REJECTED',
  'RS_MATERIAL_CHANGED',
  'RS_PHASE_INVALID',
  'RS_UNSUPPORTED_ROUTE',
  'RS_UNKNOWN_RAW_STATUS',
  'RS_MODE_POLICY_DENIED',
  // identity / authority
  'RS_IDENTITY_MISMATCH',
  'RS_TOKEN_INVALID',
  'RS_TOKEN_REVOKED',
  'RS_TOKEN_EXPIRED',
  'RS_TOKEN_PHASE_DENIED',
  'RS_STALE_FENCING_EPOCH',
  'RS_LEASE_HELD',
  'RS_LEASE_EXPIRED',
  'RS_CLIENT_CONFLICT',
  'RS_PARALLELISM_EXCEEDED',
  'RS_RECOVERY_NOT_REQUIRED',
  // lifecycle
  'RS_LIFECYCLE_TRANSITION_INVALID',
  'RS_TERMINAL_IMMUTABLE',
  // persistence
  'RS_NOT_FOUND',
  'RS_IMMUTABLE_RECORD',
  'RS_DUPLICATE',
  'RS_EVIDENCE_ALREADY_CONSUMED',
  'RS_ALLOCATION_INVALID',
  'RS_IDEMPOTENCY_KEY_REUSED',
  'RS_REVISION_CONFLICT',
  'RS_SECRET_FIELD_REJECTED',
  'RS_STORAGE_FULL',
  'RS_STORAGE_BUSY',
  'RS_STORAGE_UNAVAILABLE',
  'RS_STORAGE_CORRUPT',
  'RS_WRITER_LOCKED',
  'RS_READ_ONLY_RECOVERY',
  'RS_MIGRATION_CHECKSUM_MISMATCH',
  'RS_MIGRATION_FAILED',
  'RS_BACKUP_FAILED',
  'RS_CHECKPOINT_INCOMPLETE',
  // scenario compiler / runtime (M03)
  'RS_SCENARIO_INVALID',
  'RS_SCENARIO_UNSAFE_CONSTRUCT',
  'RS_SCENARIO_LIMIT_EXCEEDED',
  'RS_SCENARIO_UNEXPECTED_REQUEST',
  'RS_SCENARIO_ENDED',
  // local proxy / adapter / interceptor channel (M02)
  'RS_HOST_REJECTED',
  'RS_ORIGIN_REJECTED',
  'RS_BODY_TOO_LARGE',
  'RS_CONTENT_TYPE_UNSUPPORTED',
  'RS_HEADER_INVALID',
  'RS_ADAPTER_MISMATCH',
  'RS_CHANNEL_AUTH_FAILED',
  'RS_CHANNEL_BINDING_MISMATCH',
  'RS_INTERCEPTOR_TORN_DOWN',
  'RS_SINK_UNSUPPORTED',
  // protected-effect observation and kernel input (M04)
  'RS_EFFECT_HOOK_UNDECLARED',
  'RS_KERNEL_INPUT_INVALID',
  // trace quarantine, capture-to-regression, corpus, export scan (M05)
  'RS_IMPORT_LIMIT_EXCEEDED',
  'RS_IMPORT_STATE_INVALID',
  'RS_IMPORT_BLOCKED',
  'RS_IMPORT_CAPTURE_MISMATCH',
  'RS_IMPORT_MAPPING_INVALID',
  'RS_IMPORT_REVIEW_INVALID',
  'RS_EXPORT_BLOCKED',
  // runner, CLI, release gates, reports, export bundles (M06)
  'RS_CLI_USAGE',
  'RS_LAUNCHER_UNAVAILABLE',
  'RS_GATE_VALIDATION_FAILED',
  'RS_ENFORCEMENT_CLAIM_REJECTED',
  'RS_EXPORT_CONFIRMATION_REQUIRED',
  'RS_EXPORT_OVERWRITE_DENIED',
  'RS_EXPORT_PATH_INVALID',
  'RS_EXPORT_WRITE_FAILED',
  'RS_BUNDLE_VERIFY_FAILED',
  // local control API, attestation, pagination (M08)
  'RS_CONTROL_AUTH_REQUIRED',
  'RS_CONTROL_AUTH_INVALID',
  'RS_METHOD_NOT_ALLOWED',
  'RS_IDEMPOTENCY_KEY_REQUIRED',
  'RS_IDEMPOTENCY_IN_PROGRESS',
  'RS_PRECONDITION_REQUIRED',
  'RS_CURSOR_INVALID',
  'RS_RATE_LIMITED',
  'RS_LOCAL_CONFIRMATION_REQUIRED',
  'RS_LOCAL_CONFIRMATION_INVALID',
  'RS_ATTESTER_UNAVAILABLE',
  'RS_CHALLENGE_UNAVAILABLE',
  'RS_ATTESTATION_REJECTED',
  'RS_PEER_BINDING_UNAVAILABLE',
  'RS_PROBE_NOT_AUTHORIZED',
  'RS_DELETION_PLAN_MISMATCH',
  // container containment launcher (M14)
  'RS_CONTAINMENT_UNAVAILABLE',
  'RS_INTERNAL',
] as const);
export type ErrorCode = (typeof ERROR_CODES)[number];

export type SafeDetailValue = string | number | boolean | null;
export type SafeDetails = Readonly<Record<string, SafeDetailValue | readonly SafeDetailValue[]>>;

export class RouteSpecError extends Error {
  readonly code: ErrorCode;
  readonly recoverable: boolean;
  readonly details: SafeDetails;

  constructor(code: ErrorCode, message: string, options?: { recoverable?: boolean; details?: SafeDetails }) {
    super(message);
    this.name = 'RouteSpecError';
    this.code = code;
    this.recoverable = options?.recoverable ?? false;
    this.details = Object.freeze({ ...(options?.details ?? {}) });
  }

  /** Error envelope shape from API-SPEC.md section 3. */
  toEnvelope(requestId: string): {
    error: {
      code: ErrorCode;
      message: string;
      requestId: string;
      recoverable: boolean;
      details: SafeDetails;
    };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
        recoverable: this.recoverable,
        details: this.details,
      },
    };
  }
}

export function isRouteSpecError(value: unknown, code?: ErrorCode): value is RouteSpecError {
  return value instanceof RouteSpecError && (code === undefined || value.code === code);
}

export function fail(code: ErrorCode, message: string, details?: SafeDetails): never {
  throw new RouteSpecError(code, message, details === undefined ? undefined : { details });
}
