/**
 * Supports T-055 (M12). An installed capture taken from a reviewed core scenario (provenance
 * SYNTHETIC) must still produce a valid source-scenario mapping proposal. A captured trace is
 * never SYNTHETIC itself, so before the fix the proposal was rejected
 * (PROVENANCE_NOT_APPLICABLE) and the service fell back to the observed-trace shape, which
 * carries only what the failing client saw: no provider timeline and no ground truth. A
 * corrected client could then never reach a terminal status in the promoted regression.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_SCENARIO_SOURCES, compileScenario } from '@routespec/scenario';
import { captureInstalledCase, proposeMapping, validateMapping, type TraceDocument } from '../src/index.ts';
import { runBaselineIncident, type BaselineRun } from './support/flows.ts';
import { LIVE_INVARIANTS, Product, tempDir } from './support/product.ts';

let tmp: ReturnType<typeof tempDir>;
let p: Product;
let baseline: BaselineRun;
let trace: TraceDocument;
let origin: string;

beforeAll(async () => {
  tmp = tempDir('routespec-m12-capture-');
  p = await Product.open(tmp.dir, 'm12core');
  baseline = await runBaselineIncident(p, {
    compiled: compileScenario(CORE_SCENARIO_SOURCES['accepted-then-lost-response'] as string),
    label: 'core-release-corpus',
  });
  const out = await captureInstalledCase(p.journal, {
    caseRunId: baseline.caseRunIds[0] as string,
    idempotencyKey: 'm12-core-capture',
  });
  const view = p.journal.getImport(out.importId);
  trace = view.sanitized as TraceDocument;
  origin = view.origin;
});

afterAll(async () => {
  await p?.close();
  tmp?.cleanup();
});

describe('installed capture of a synthetic core scenario', () => {
  it('proposes a valid source-scenario mapping labelled as an installed reproduction', () => {
    expect(origin).toBe('INSTALLED_ARTIFACT_CAPTURE');
    expect(baseline.compiled.plan.sourceProvenance.class).toBe('SYNTHETIC');
    const mapping = proposeMapping({
      trace,
      sourcePlan: baseline.compiled.plan,
      requiredInvariants: LIVE_INVARIANTS,
      requiredSinkClasses: ['fulfilment-webhook'],
    });
    expect(validateMapping(trace, origin as never, mapping).issues).toEqual([]);
    expect(mapping.provenance.class).toBe('INDEPENDENTLY_REPRODUCED');
    // The provider timeline and ground truth of the source schedule survive the mapping.
    const statuses = mapping.scenario.steps.filter((s) => s.type === 'provider_status').map((s) => s.status);
    expect(statuses).toEqual(['PROCESSING', 'SUCCESS']);
    expect(mapping.scenario.groundTruthEvents.map((e) => e.fact)).toEqual([
      'ORIGIN_DEPOSIT',
      'DESTINATION_CREDIT',
    ]);
  });

  it('never labels a user file as an installed reproduction', () => {
    const mapping = proposeMapping({
      trace: { ...trace, origin: 'USER_FILE' } as TraceDocument,
      sourcePlan: baseline.compiled.plan,
      requiredInvariants: LIVE_INVARIANTS,
    });
    expect(mapping.provenance.class).not.toBe('INDEPENDENTLY_REPRODUCED');
    expect(mapping.provenance.class).not.toBe('SYNTHETIC');
  });
});
