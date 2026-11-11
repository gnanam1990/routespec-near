/**
 * Typed failure classes for control-API calls. Each kind maps to one authentic UI state
 * (UI-SPEC section 9). The console never converts a failure into a verdict.
 */
export const API_ERROR_KINDS = [
  'NETWORK',
  'TIMEOUT',
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'TOKEN_REVOKED',
  'TOKEN_REUSED',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'UNSUPPORTED_ENDPOINT',
  'CONFLICT',
  'CONCURRENT_CLIENT',
  'VALIDATION',
  'POLICY_DENIED',
  'RECOVERY_MUTATION_DENIED',
  'PRIVACY_BLOCKED',
  'RESOURCE_LIMIT',
  'UNSUPPORTED_SCHEMA',
  'SERVER',
] as const;
export type ApiErrorKind = (typeof API_ERROR_KINDS)[number];

export interface FieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface ApiErrorInit {
  readonly kind: ApiErrorKind;
  readonly message: string;
  readonly status: number | null;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly recoverable: boolean;
  readonly fieldErrors: readonly FieldError[];
  readonly method: string;
  readonly path: string;
  readonly attempts: number;
  /** True when a mutation was sent but no authoritative response arrived. */
  readonly outcomeUnknown: boolean;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly recoverable: boolean;
  readonly fieldErrors: readonly FieldError[];
  readonly method: string;
  readonly path: string;
  readonly attempts: number;
  readonly outcomeUnknown: boolean;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.recoverable = init.recoverable;
    this.fieldErrors = init.fieldErrors;
    this.method = init.method;
    this.path = init.path;
    this.attempts = init.attempts;
    this.outcomeUnknown = init.outcomeUnknown;
  }
}

/** Stable RouteSpec error codes the console distinguishes (API-SPEC section 3). */
const CODE_KINDS: Readonly<Record<string, ApiErrorKind>> = {
  RS_CONTROL_TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  RS_TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  RS_TOKEN_REVOKED: 'TOKEN_REVOKED',
  RS_TOKEN_REUSED: 'TOKEN_REUSED',
  RS_CONCURRENT_CLIENT: 'CONCURRENT_CLIENT',
  RS_MODE_POLICY_DENIED: 'POLICY_DENIED',
  RS_RECOVERY_MUTATION_DENIED: 'RECOVERY_MUTATION_DENIED',
  RS_SECRET_DETECTED: 'PRIVACY_BLOCKED',
  RS_PRIVACY_SCAN_BLOCKED: 'PRIVACY_BLOCKED',
  RS_RESOURCE_LIMIT: 'RESOURCE_LIMIT',
  RS_RATE_LIMITED: 'RESOURCE_LIMIT',
  RS_VALIDATION_FAILED: 'VALIDATION',
  RS_REVISION_CONFLICT: 'CONFLICT',
  RS_IDEMPOTENCY_CONFLICT: 'CONFLICT',
  RS_UNSUPPORTED_PROFILE: 'UNSUPPORTED_SCHEMA',
};

export function classifyStatus(status: number, code: string | null, hasEnvelope: boolean): ApiErrorKind {
  if (code !== null && CODE_KINDS[code] !== undefined) return CODE_KINDS[code];
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'PERMISSION_DENIED';
  // A 404/405/501 without a RouteSpec envelope means this API revision has no such route.
  if ((status === 404 || status === 405 || status === 501) && !hasEnvelope) return 'UNSUPPORTED_ENDPOINT';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409 || status === 412) return 'CONFLICT';
  if (status === 400 || status === 422) return 'VALIDATION';
  if (status === 413 || status === 429 || status === 507) return 'RESOURCE_LIMIT';
  return 'SERVER';
}
