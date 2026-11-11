/**
 * @routespec/regressions — trace quarantine, sanitization, mapping, deterministic replay
 * verification, explicit review, immutable promotion, and corpus versioning (module M05).
 *
 * Quarantine analysis is pure and networkless. The only process capability used is launching
 * one separate replay-trial process over IPC. No module here imports an HTTP client, socket,
 * DNS, provider SDK, or model client; a static test enforces this.
 */
export * from './findings.ts';
export * from './limits.ts';
export * from './ingest.ts';
export * from './scan.ts';
export * from './trace.ts';
export * from './serialize.ts';
export * from './quarantine.ts';
export * from './capture.ts';
export * from './pipeline.ts';
export * from './mapping.ts';
export * from './replay.ts';
export * from './workflow.ts';
export * from './corpus.ts';
export * from './incidents.ts';
export * from './export-scan.ts';
export * from './status.ts';
