/**
 * M13 (dependency upgrades): scenario compile errors keep the issue codes they reported before
 * the validation library moved to its next major version. The one closed single-value enum in
 * the authoring schema (`transport_error.error`) still reports an enum mismatch, not a literal
 * mismatch, and literal / multi-value enum mismatches keep their own codes.
 */
import { describe, expect, it } from 'vitest';
import { compileScenario } from '../src/index.ts';

function baseObject(steps: unknown[]): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    scenarioId: 'm13-issue-codes',
    revisionLabel: 'r1',
    title: 'Issue code parity',
    protocolProfile: 'oneclick-v0@1.0.0',
    seed: 'seed-1',
    initialState: {},
    operationTemplate: {
      originAsset: 'nep141:origin.sim',
      destinationAsset: 'nep141:destination.sim',
      amountIn: '1000000',
      amountOut: '999000',
      minAmountOut: '989010',
    },
    steps,
    groundTruthEvents: [],
    expectedOutcomes: {},
    forbiddenBehaviors: [],
    requiredEvidence: [],
    resourceBudget: {},
    sourceProvenance: { class: 'SYNTHETIC' },
  };
}

function issuesOf(source: unknown): string[] {
  try {
    compileScenario(source);
  } catch (error) {
    const e = error as { code?: string; details?: Record<string, unknown> };
    expect(e.code).toBe('RS_SCENARIO_INVALID');
    return e.details?.['issues'] as string[];
  }
  throw new Error('expected the scenario to be rejected');
}

describe('M13 scenario compile issue codes', () => {
  it('an unknown transport error kind is an enum mismatch', () => {
    const issues = issuesOf(
      baseObject([{ id: 'reset', type: 'transport_error', match: { route: 'QUOTE' }, error: 'TIMEOUT' }]),
    );
    expect(issues).toEqual(['steps.0.error: invalid_enum_value']);
  });

  it('a multi-value enum mismatch keeps the enum code', () => {
    const issues = issuesOf(baseObject([{ id: 'dup', type: 'duplicate', of: 'LAST_QUOTE' }]));
    expect(issues).toEqual(['steps.0.of: invalid_enum_value']);
  });

  it('a wrong protocol profile keeps the literal code', () => {
    const source = { ...baseObject([{ id: 'quote', type: 'respond', match: { route: 'QUOTE' } }]) };
    source['protocolProfile'] = 'other@1.0.0';
    expect(issuesOf(source)).toEqual(['protocolProfile: invalid_literal']);
  });
});

describe('M13 scenario compile issue codes for enum type mismatches', () => {
  it('a non-string or absent enum value reports a type mismatch', () => {
    expect(issuesOf(baseObject([{ id: 'dup', type: 'duplicate', of: 5 }]))).toEqual([
      'steps.0.of: invalid_type',
    ]);
    expect(issuesOf(baseObject([{ id: 'dup', type: 'duplicate' }]))).toEqual(['steps.0.of: invalid_type']);
    expect(
      issuesOf(baseObject([{ id: 'reset', type: 'transport_error', match: { route: 'QUOTE' }, error: 1 }])),
    ).toEqual(['steps.0.error: invalid_type']);
  });
});
