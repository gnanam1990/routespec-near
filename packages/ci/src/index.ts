/**
 * @routespec/ci — CI integration for RouteSpec (M10): the gate action entrypoint, CI trust
 * classification, enforcement capped at REQUIRED_CHECK_UNVERIFIED, secret withholding, redacted
 * upload staging, a lockfile SBOM, and the separate certificate step (M47). The gate entry point
 * contacts no remote service; the certificate step contacts only the NEAR RPC endpoint it is given.
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
export * from './certificate.ts';
export { runCi, runCiMain, type CiIo } from './main.ts';
