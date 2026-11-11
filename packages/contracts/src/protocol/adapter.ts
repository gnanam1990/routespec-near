/**
 * Versioned actual-client adapter contract (FR-03, API-SPEC.md section 5, TB-01).
 *
 * The adapter wraps the exact pinned official SDK transport. It injects the stable correlation
 * headers from `ROUTESPEC_HEADERS` plus a client-instance header that binds one subject client
 * process to its case token, so a copied token from a different client fails closed. Every
 * header here starts with `x-routespec-` and is therefore stripped by `stripForUpstream` before
 * any live boundary. Header names are lowercase; comparison is case-insensitive.
 */
import { ROUTESPEC_HEADERS } from './headers.ts';
import { ONECLICK_SDK_PIN } from './sdk-pin.ts';

export const ADAPTER_REVISION = 'routespec-adapter@1.0.0' as const;

export const ADAPTER_HEADERS = Object.freeze({
  ...ROUTESPEC_HEADERS,
  clientInstance: 'x-routespec-client-instance',
} as const);

export const ADAPTER_CONTRACT = Object.freeze({
  revision: ADAPTER_REVISION,
  sdkPackage: ONECLICK_SDK_PIN.packageName,
  sdkVersion: ONECLICK_SDK_PIN.version,
  sdkGitHead: ONECLICK_SDK_PIN.gitHead,
  headers: ADAPTER_HEADERS,
  /** Response header carrying the proxy-assigned run-operation identity after quote creation. */
  runOperationResponseHeader: ROUTESPEC_HEADERS.runOperation,
  transportRequestIdPattern: '^[A-Za-z0-9._:-]{1,128}$',
  clientInstancePattern: '^[A-Za-z0-9._:-]{16,128}$',
});

/** Digest domain binding a client-instance header value to a case lease. */
export const CLIENT_INSTANCE_DIGEST_DOMAIN = 'routespec.client-instance/1' as const;
