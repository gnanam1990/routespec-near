/**
 * @routespec/ci — CI integration for RouteSpec (M10): the gate action entrypoint, CI trust
 * classification, enforcement capped at REQUIRED_CHECK_UNVERIFIED, secret withholding, redacted
 * upload staging, and a lockfile SBOM. Nothing here contacts a remote service.
 */
export * from './context.ts';
export * from './config.ts';
export * from './enforcement.ts';
export * from './secrets.ts';
export * from './identity.ts';
export * from './uploads.ts';
export * from './attestation.ts';
export * from './outputs.ts';
export * from './sbom.ts';
export * from './action.ts';
export { runCi, runCiMain, type CiIo } from './main.ts';
