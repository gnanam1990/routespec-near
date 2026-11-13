/**
 * M50: scenario templates. Every descriptor of the closed descriptor space renders to scenario
 * source that the product's own bounded compiler accepts, with synthetic assets, accounts and
 * amounts only, and under the restrictions the product applies to sources it did not reproduce.
 */
import { describe, expect, it } from 'vitest';
import { compileScenario } from '@routespec/scenario';
import { parseSource } from './support/scenario.ts';
import {
  TemplateDescriptor,
  allTemplateDescriptors,
  observedStatusesOf,
  renderScenario,
  scenarioIdFor,
  scriptedStatusesOf,
  type RenderContext,
} from '../src/index.ts';

const LIVE: RenderContext = {
  idPrefix: 'obs',
  provenanceClass: 'ISSUE_DERIVED_NOT_REPRODUCED',
  corpusLabel: 'mainnet-observed-2026-11',
};
const FIXTURE: RenderContext = {
  idPrefix: 'shape',
  provenanceClass: 'OFFICIAL_SPEC_DERIVED',
  corpusLabel: 'explorer-shape-fixture',
};

describe('M50 scenario templates', () => {
  const all = allTemplateDescriptors();

  it('the descriptor space is closed and non-trivial', () => {
    expect(all.length).toBeGreaterThan(150);
    for (const d of all) expect(TemplateDescriptor.safeParse(d).success).toBe(true);
    // Combinations that cannot be observed are not descriptors.
    const bad = [
      { class: 'STUCK', heldStatus: null, refundReason: null, delay: 'ge-1h', depositObserved: true },
      { class: 'STUCK', heldStatus: 'PROCESSING', refundReason: null, delay: 'not-observed', depositObserved: true },
      { class: 'REFUNDED', heldStatus: null, refundReason: null, delay: 'not-observed', depositObserved: true },
      { class: 'REFUNDED', heldStatus: null, refundReason: 'UNKNOWN', delay: 'ge-1h', depositObserved: true },
      { class: 'FAILED', heldStatus: null, refundReason: 'UNKNOWN', delay: 'not-observed', depositObserved: true },
      { class: 'LATE_SUCCESS', heldStatus: 'PROCESSING', refundReason: null, delay: 'ge-45m', depositObserved: true },
      { class: 'REFUNDED', heldStatus: null, refundReason: 'whatever.near', delay: 'not-observed', depositObserved: true },
      { class: 'REFUNDED', heldStatus: null, refundReason: 'UNKNOWN', delay: 'not-observed', depositObserved: true, note: 'x' },
    ];
    for (const d of bad) expect(TemplateDescriptor.safeParse(d).success, JSON.stringify(d)).toBe(false);
  });

  it('every descriptor has a unique, valid scenario id under both prefixes', () => {
    for (const ctx of [LIVE, FIXTURE]) {
      const ids = all.map((d) => scenarioIdFor(d, ctx.idPrefix));
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{2,63}$/);
    }
    expect(
      scenarioIdFor(
        { class: 'LATE_SUCCESS', heldStatus: 'PROCESSING', refundReason: null, delay: 'ge-30m', depositObserved: true },
        'obs',
      ),
    ).toBe('obs-late-success-proc-ge-30m');
    expect(
      scenarioIdFor(
        { class: 'REFUNDED', heldStatus: null, refundReason: 'NO_LIQUIDITY', delay: 'not-observed', depositObserved: true },
        'shape',
      ),
    ).toBe('shape-refund-no-liquidity');
  });

  it('every descriptor compiles with the product compiler, deterministically', () => {
    for (const ctx of [LIVE, FIXTURE]) {
      const digests = new Set<string>();
      for (const d of all) {
        const source = renderScenario(d, ctx);
        expect(renderScenario(d, ctx)).toBe(source);
        const compiled = compileScenario(source);
        expect(compiled.plan.scenarioId).toBe(scenarioIdFor(d, ctx.idPrefix));
        expect(compiled.revisionInput.provenanceClass).toBe(ctx.provenanceClass);
        digests.add(compiled.revisionDigest);
      }
      expect(digests.size).toBe(all.length);
    }
  });

  it('uses only synthetic assets, accounts and amounts, and applies the not-reproduced restrictions', () => {
    for (const d of all) {
      const source = renderScenario(d, LIVE);
      const s = parseSource(source);
      expect(s.operationTemplate.originAsset).toBe('nep141:origin.sim');
      expect(s.operationTemplate.destinationAsset).toBe('nep141:destination.sim');
      expect(s.operationTemplate.recipient).toBe('recipient.sim');
      expect(s.operationTemplate.refundTo).toBe('refund.sim');
      for (const e of s.groundTruthEvents) {
        if (e.assetId !== undefined) expect(e.assetId).toMatch(/^nep141:(origin|destination)\.sim$/);
        if (e.recipient !== undefined) expect(e.recipient).toMatch(/^(recipient|refund)\.sim$/);
        // A destination credit was never verified on chain by RouteSpec: it is never asserted visible.
        if (e.fact === 'DESTINATION_CREDIT') expect(e.visibility).toBe('PRIVATE');
      }
      // The same restrictions the trace-mapping step applies to ISSUE_DERIVED_NOT_REPRODUCED.
      expect(s.expectedOutcomes.terminalStatus ?? null).not.toBe('SUCCESS');
      expect(String(s.expectedOutcomes.normalizedOutcome ?? '')).not.toMatch(/^SUCCESS/);
      expect(s.expectedOutcomes.normalizedOutcome ?? '').not.toMatch(/_PROVEN$/);
      expect(s.forbiddenBehaviors).toContain('SECOND_COMMIT_UNDER_UNCERTAINTY');
      expect(s.forbiddenBehaviors).toContain('EFFECT_RELEASE_BEFORE_COMPLETION');
      expect(s.sourceProvenance.locator).toBe('intents-explorer-api:/api/v0/transactions#mainnet-observed-2026-11');
      expect(source).not.toMatch(/\.near|0x[0-9a-f]{4}/i);
    }
  });

  it('scripts the held status, the delay lower bound and the reported terminal', () => {
    const late = parseSource(
      renderScenario(
        { class: 'LATE_SUCCESS', heldStatus: 'PROCESSING', refundReason: null, delay: 'ge-3h', depositObserved: true },
        LIVE,
      ),
    );
    const lateStep = late.steps.find((s) => s.type === 'late_success');
    expect(lateStep).toMatchObject({ afterMs: 3 * 3_600_000 });
    expect(late.initialState.statusPollIntervalMs).toBe(3_600_000);
    expect(late.title).toContain('at least 3 h');

    const refund = parseSource(
      renderScenario(
        { class: 'REFUNDED', heldStatus: 'PROCESSING', refundReason: 'NO_LIQUIDITY', delay: 'ge-15m', depositObserved: true },
        LIVE,
      ),
    );
    expect(refund.steps.find((s) => s.type === 'delay_virtual')).toMatchObject({ ms: 900_000 });
    expect(refund.steps.some((s) => s.type === 'refund')).toBe(true);
    expect(refund.expectedOutcomes.terminalStatus).toBe('REFUNDED');
    expect(refund.title).toContain('NO_LIQUIDITY');
    expect(refund.requiredEvidence).toEqual([{ predicate: 'REFUND_SETTLEMENT' }]);

    const partial = parseSource(
      renderScenario(
        { class: 'REFUNDED', heldStatus: null, refundReason: 'PARTIAL_DEPOSIT', delay: 'not-observed', depositObserved: true },
        LIVE,
      ),
    );
    expect(partial.steps.some((s) => s.type === 'incomplete_deposit')).toBe(true);

    const stuck = parseSource(
      renderScenario(
        { class: 'STUCK', heldStatus: 'PROCESSING', refundReason: null, delay: 'ge-24h', depositObserved: true },
        LIVE,
      ),
    );
    expect(stuck.steps.find((s) => s.type === 'delay_virtual')).toMatchObject({ ms: 86_400_000 });
    expect(stuck.expectedOutcomes.terminalStatus ?? null).toBeNull();
    expect(stuck.expectedOutcomes.normalizedOutcome).toBe('PROCESSING');

    const failed = parseSource(
      renderScenario(
        { class: 'FAILED', heldStatus: null, refundReason: null, delay: 'not-observed', depositObserved: false },
        LIVE,
      ),
    );
    expect(failed.groundTruthEvents).toEqual([]);
    expect(failed.expectedOutcomes.terminalStatus).toBe('FAILED');
  });

  it('states which statuses were observed and which the scenario scripts', () => {
    const d = {
      class: 'LATE_SUCCESS',
      heldStatus: 'PROCESSING',
      refundReason: null,
      delay: 'ge-30m',
      depositObserved: true,
    } as const;
    expect(observedStatusesOf(d)).toEqual(['PROCESSING', 'SUCCESS']);
    expect(scriptedStatusesOf(d)).toEqual(['PROCESSING', 'SUCCESS']);
    const r = {
      class: 'REFUNDED',
      heldStatus: null,
      refundReason: 'PARTIAL_DEPOSIT',
      delay: 'not-observed',
      depositObserved: true,
    } as const;
    // Only the terminal was seen; the INCOMPLETE_DEPOSIT step before it is the documented lifecycle.
    expect(observedStatusesOf(r)).toEqual(['REFUNDED']);
    expect(scriptedStatusesOf(r)).toEqual(['INCOMPLETE_DEPOSIT', 'REFUNDED']);
  });
});
