/**
 * Shared T-009 replay fixture: one fixed identity and client exchange sequence over the
 * reviewed `duplicate-retry` core scenario. Imported both by the test and by a separately
 * spawned Node process so the digest is shown to be independent of process state.
 */
import { digestValue } from '@routespec/contracts';
import {
  CORE_SCENARIO_SOURCES,
  compileScenario,
  type ReplayExchange,
  type ReplayIdentity,
} from '../../src/index.ts';
import { quoteMaterial } from './material.ts';

export const REPLAY_COMPILED = compileScenario(CORE_SCENARIO_SOURCES['duplicate-retry'] as string);

export function replayIdentity(): ReplayIdentity {
  const d = (label: string) => digestValue('routespec.test.digest/1', label);
  return {
    projectRevisionId: 'integration-revision-1',
    buildRevisionId: 'build-revision-1',
    artifactDigest: d('artifact'),
    buildAttestationClass: 'USER_ASSERTED_LOCAL',
    buildAttestationId: null,
    gateRunId: 'gate-run-1',
    caseRunId: 'case-run-1',
    runOperationLineage: [],
    scenarioRevisionDigest: REPLAY_COMPILED.revisionDigest,
    seed: REPLAY_COMPILED.plan.seed,
    adapterRevision: 'routespec-adapter@1.0.0',
    protocolProfileId: 'oneclick-v0@1.0.0',
    evaluatorRevision: 'routespec-kernel@1.0.0',
    effectCoveragePolicyDigest: d('policy'),
    effectManifestDigest: d('manifest'),
    callsiteInventoryDigest: null,
    interceptorProfileDigest: null,
    configurationDigest: d('configuration'),
    fencingEpoch: 1,
  };
}

/** The deposit address the scenario's seeded PRNG assigns; the client echoes it in later calls. */
export function replayExchanges(depositAddress: string): ReplayExchange[] {
  const q = { route: 'QUOTE' as const, material: quoteMaterial(), logicalJobKey: 'job-1' };
  return [
    { request: q },
    { request: q },
    { request: { route: 'COMMIT', material: { txHash: 'sim-tx-1', depositAddress } } },
    { request: { route: 'STATUS', material: { depositAddress } } },
    { request: { route: 'STATUS', material: { depositAddress } } },
  ];
}
