/**
 * @routespec/kernel — pure deterministic invariant kernel and evidence classification (M04).
 *
 * Depends only on @routespec/contracts. No network, clock, randomness, database, UI, or model.
 * The kernel owns factual verdicts; no provider label, probe result, artifact writer, UI
 * component, or optional explanation can override them.
 */
export * from './types.ts';
export * from './codes.ts';
export * from './verdict.ts';
export * from './evidence.ts';
export * from './attestation.ts';
export * from './provider-facts.ts';
export * from './invariants/inv01-02.ts';
export * from './invariants/inv03.ts';
export * from './invariants/inv04.ts';
export * from './invariants/inv05.ts';
export * from './invariants/inv06-07-08.ts';
export * from './revision.ts';
export * from './evaluate.ts';
export * from './explanation.ts';
export * from './snapshot.ts';
export * from './canonical.ts';
export { deepFreeze } from './result.ts';
