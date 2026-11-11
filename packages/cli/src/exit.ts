/**
 * Stable CLI exit codes (API-SPEC section 6, FR-14). Every RouteSpec error code maps to exactly
 * one exit class; anything that is not a typed RouteSpec error is an internal error (5).
 *
 * | 0 | decision PASS (artifact readiness stays separate; never a blocking claim) |
 * | 2 | decision FAIL |
 * | 3 | REVIEW, incomplete, unknown, not visible, unsupported required case, or NOT_RUN |
 * | 4 | user / configuration / schema error |
 * | 5 | internal error or corrupted state |
 * | 6 | safety policy denied an attempted action |
 */
import { ERROR_CODES, RouteSpecError, type ErrorCode } from '@routespec/contracts';

export const EXIT = Object.freeze({
  PASS: 0,
  FAIL: 2,
  REVIEW: 3,
  CONFIG: 4,
  INTERNAL: 5,
  POLICY_DENIED: 6,
});

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

const POLICY_DENIED: readonly ErrorCode[] = [
  'RS_MODE_POLICY_DENIED',
  'RS_UNSUPPORTED_ROUTE',
  'RS_SECRET_FIELD_REJECTED',
  'RS_IMPORT_BLOCKED',
  'RS_EXPORT_BLOCKED',
  'RS_EXPORT_CONFIRMATION_REQUIRED',
  'RS_EXPORT_OVERWRITE_DENIED',
  'RS_ENFORCEMENT_CLAIM_REJECTED',
  'RS_TOKEN_INVALID',
  'RS_TOKEN_REVOKED',
  'RS_TOKEN_EXPIRED',
  'RS_TOKEN_PHASE_DENIED',
  'RS_STALE_FENCING_EPOCH',
  'RS_LEASE_HELD',
  'RS_LEASE_EXPIRED',
  'RS_CLIENT_CONFLICT',
  'RS_SECOND_COMMIT_REJECTED',
  'RS_HOST_REJECTED',
  'RS_ORIGIN_REJECTED',
  'RS_CHANNEL_AUTH_FAILED',
  'RS_CHANNEL_BINDING_MISMATCH',
  'RS_CONTROL_AUTH_REQUIRED',
  'RS_CONTROL_AUTH_INVALID',
  'RS_LOCAL_CONFIRMATION_REQUIRED',
  'RS_LOCAL_CONFIRMATION_INVALID',
  'RS_ATTESTER_UNAVAILABLE',
  'RS_ATTESTATION_REJECTED',
  'RS_PEER_BINDING_UNAVAILABLE',
  'RS_PROBE_NOT_AUTHORIZED',
];

const INTERNAL: readonly ErrorCode[] = [
  'RS_INTERNAL',
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
  'RS_KERNEL_INPUT_INVALID',
  'RS_CANONICAL_UNSUPPORTED_TYPE',
  'RS_CANONICAL_NON_INTEGER',
  'RS_CANONICAL_MALFORMED_STRING',
  'RS_CANONICAL_LIMIT_EXCEEDED',
  'RS_CANONICAL_DUPLICATE_SEQUENCE',
  'RS_EXPORT_WRITE_FAILED',
  'RS_BUNDLE_VERIFY_FAILED',
  'RS_INTERCEPTOR_TORN_DOWN',
];

/** The exit class of every error code (configuration error unless listed otherwise). */
export const ERROR_EXIT_CODES: Readonly<Record<ErrorCode, ExitCode>> = Object.freeze(
  Object.fromEntries(
    ERROR_CODES.map((code) => [
      code,
      POLICY_DENIED.includes(code)
        ? EXIT.POLICY_DENIED
        : INTERNAL.includes(code)
          ? EXIT.INTERNAL
          : EXIT.CONFIG,
    ]),
  ) as Record<ErrorCode, ExitCode>,
);

export function exitCodeForError(error: unknown): ExitCode {
  if (error instanceof RouteSpecError && error.code in ERROR_EXIT_CODES) return ERROR_EXIT_CODES[error.code];
  return EXIT.INTERNAL;
}
