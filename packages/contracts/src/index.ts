/**
 * @routespec/contracts — closed, versioned RouteSpec protocol/domain contracts (module M00).
 *
 * Dependency-light by design: imports only zod and node:crypto. It must never import Fastify,
 * SQLite, React, an upstream provider client, or an AI SDK.
 */
export * from './enums.ts';
export * from './errors.ts';
export * from './lifecycle.ts';
export * from './canonical/encoding.ts';
export * from './canonical/digest.ts';
export * from './schemas/common.ts';
export * from './schemas/records.ts';
export * from './schemas/result.ts';
export * from './schemas/registry.ts';
export * from './schemas/issues.ts';
export * from './protocol/headers.ts';
export * from './protocol/sdk-pin.ts';
export * from './protocol/status.ts';
export * from './protocol/oneclick-v0.ts';
export * from './protocol/adapter.ts';

export const CONTRACTS_REVISION = 'routespec-contracts@1.0.0' as const;
