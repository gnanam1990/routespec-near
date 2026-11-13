/**
 * @routespec/registry — release certificates and the on-chain attester registry (M47).
 *
 * Imports only `@routespec/contracts`, zod, `node:crypto` and the built-in `fetch`. The
 * near-sandbox test harness is a separate entry (`@routespec/registry/sandbox`), and so is the
 * browser verification core of the verify page (`@routespec/registry/browser`, M49).
 */
export * from './keys.ts';
export * from './certificate.ts';
export * from './near.ts';
export * from './release.ts';
export * from './registry-client.ts';
export * from './badge.ts';
export { latestCertificate, MAX_CERTIFICATES_PER_BUNDLE, MAX_PAGE } from './views.ts';

export const REGISTRY_CLIENT_REVISION = 'routespec-registry-client@1.0.0' as const;
