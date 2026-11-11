/**
 * T-014 — Malformed and over-budget scenarios fail closed.
 *
 * Covers FR-05, NFR-06. Unknown fields, unsafe YAML types/tags/aliases/merge keys/duplicate keys,
 * excessive depth/events/steps/duration/size/strings, invalid amounts, unsupported versions, and
 * executable constructs are each rejected with a typed code. Nothing executes (a hostile
 * `!!js/function` payload never runs), nothing is persisted (no compiled object exists to store),
 * and runtime request/event floods are refused while the runtime stays usable.
 */
import { describe, expect, it } from 'vitest';
import {
  CORE_SCENARIO_SOURCES,
  HARD_CAPS,
  ScenarioRuntime,
  compileScenario,
  type CompileOptions,
} from '../src/index.ts';
import { quote } from './support/material.ts';

const BASE = CORE_SCENARIO_SOURCES['happy-path'] as string;

function codeOf(
  source: unknown,
  options?: CompileOptions,
): { code: string; reason: unknown; limit: unknown } {
  try {
    compileScenario(source, options);
    return { code: 'COMPILED', reason: null, limit: null };
  } catch (error) {
    const e = error as { code?: string; details?: Record<string, unknown> };
    return {
      code: e.code ?? String(error),
      reason: e.details?.['reason'] ?? null,
      limit: e.details?.['limit'] ?? null,
    };
  }
}

/** A minimal valid JSON scenario object to mutate. */
function baseObject(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    scenarioId: 'mutable-case',
    revisionLabel: 'r1',
    title: 'Mutable base',
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
    steps: [{ id: 'quote', type: 'respond', match: { route: 'QUOTE' } }],
    groundTruthEvents: [],
    expectedOutcomes: {},
    forbiddenBehaviors: [],
    requiredEvidence: [],
    resourceBudget: {},
    sourceProvenance: { class: 'SYNTHETIC' },
  };
}

describe('T-014 — Malformed and over-budget scenarios fail closed', () => {
  it('the unmodified base compiles (control)', () => {
    expect(codeOf(BASE).code).toBe('COMPILED');
    expect(codeOf(baseObject()).code).toBe('COMPILED');
  });

  it('rejects unknown fields at the root, in steps, matchers, and ground truth', () => {
    const cases: Array<(o: Record<string, unknown>) => void> = [
      (o) => (o['extra'] = 1),
      (o) => ((o['steps'] as Array<Record<string, unknown>>)[0]!['retries'] = 3),
      (o) => ((o['steps'] as Array<Record<string, unknown>>)[0]!['match'] = { route: 'QUOTE', host: 'x' }),
      (o) => (o['groundTruthEvents'] = [{ id: 'e', fact: 'REFUND', note: 'x' }]),
      (o) => ((o['initialState'] as Record<string, unknown>)['network'] = 'mainnet'),
      (o) => ((o['resourceBudget'] as Record<string, unknown>)['maxSockets'] = 1),
    ];
    for (const mutate of cases) {
      const o = baseObject();
      mutate(o);
      expect(codeOf(o)).toMatchObject({ code: 'RS_SCENARIO_INVALID', reason: 'unknown-field' });
    }
    const o = baseObject();
    ((o['steps'] as Array<Record<string, unknown>>)[0]!['match'] as Record<string, unknown>)['fields'] = {
      depositAddress: 'x',
    };
    expect(codeOf(o).code).toBe('RS_SCENARIO_INVALID');
  });

  it('rejects executable constructs and unknown step types', () => {
    for (const key of [
      'script',
      'command',
      'exec',
      'url',
      'file',
      'callback',
      'regex',
      'template',
      'import',
    ]) {
      const o = baseObject();
      (o['steps'] as Array<Record<string, unknown>>)[0]![key] = 'payload';
      expect(codeOf(o)).toMatchObject({ code: 'RS_SCENARIO_UNSAFE_CONSTRUCT', reason: 'executable-field' });
    }
    const o = baseObject();
    o['steps'] = [{ id: 'x', type: 'shell', match: { route: 'QUOTE' } }];
    expect(codeOf(o).code).toBe('RS_SCENARIO_INVALID');
  });

  it('rejects unsafe YAML types, tags, merge keys, duplicate keys, and aliases', () => {
    const hostile = [
      `${BASE}hostile: !!js/function "function () { globalThis.__routespecPwned = 1; }"\n`,
      `${BASE}blob: !!binary aGVsbG8=\n`,
      `${BASE}custom: !include /etc/passwd\n`,
      `${BASE}plain: !!str tagged\n`,
      `${BASE}merged:\n  <<: { a: 1 }\n`,
      `${BASE}title: duplicate\n`,
      `${BASE}anchor: &a x\nref: *a\n`,
    ];
    for (const src of hostile) expect(codeOf(src).code).toBe('RS_SCENARIO_UNSAFE_CONSTRUCT');
    expect((globalThis as Record<string, unknown>)['__routespecPwned']).toBeUndefined();
    expect(codeOf('steps: [unterminated').code).toBe('RS_SCENARIO_INVALID');
  });

  it('bounds alias expansion (billion laughs) even when aliases are enabled', () => {
    const laughs = [
      'a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'e: [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
    ].join('\n');
    const started = process.hrtime.bigint();
    expect(codeOf(laughs, { parseLimits: { maxAliases: 8 } })).toMatchObject({
      code: 'RS_SCENARIO_LIMIT_EXCEEDED',
      limit: 'maxAliases',
    });
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(2000);
    expect(codeOf(laughs, { parseLimits: { maxAliases: HARD_CAPS.maxAliases + 1000 } }).code).toBe(
      'RS_SCENARIO_LIMIT_EXCEEDED',
    );
  });

  it('bounds nesting depth without recursion for JSON and YAML', () => {
    const deepJson = `${'['.repeat(20_000)}${']'.repeat(20_000)}`;
    expect(codeOf(deepJson, { format: 'json' })).toMatchObject({
      code: 'RS_SCENARIO_LIMIT_EXCEEDED',
      limit: 'maxDepth',
    });
    const deepYaml = `a: ${'['.repeat(200)}${']'.repeat(200)}`;
    expect(codeOf(deepYaml).code).toBe('RS_SCENARIO_LIMIT_EXCEEDED');
  });

  it('bounds source size, string length, steps, events, and virtual duration', () => {
    expect(codeOf(`${BASE}#${'x'.repeat(70_000)}\n`)).toMatchObject({ limit: 'maxSourceBytes' });
    const longTitle = baseObject();
    longTitle['title'] = 'x'.repeat(2000);
    expect(codeOf(longTitle)).toMatchObject({ code: 'RS_SCENARIO_LIMIT_EXCEEDED', limit: 'maxStringLength' });

    const manySteps = baseObject();
    manySteps['steps'] = Array.from({ length: 300 }, (_, i) => ({
      id: `s${i}`,
      type: 'respond',
      match: { route: 'STATUS' },
    }));
    expect(codeOf(manySteps, { parseLimits: { maxSourceBytes: 200_000 } })).toMatchObject({
      limit: 'maxSteps',
    });

    const manyEvents = baseObject();
    manyEvents['groundTruthEvents'] = Array.from({ length: 80 }, (_, i) => ({ id: `e${i}`, fact: 'REFUND' }));
    expect(codeOf(manyEvents)).toMatchObject({ limit: 'maxGroundTruthEvents' });

    const longDelay = baseObject();
    longDelay['steps'] = [
      { id: 'q', type: 'respond', match: { route: 'QUOTE' } },
      { id: 'd1', type: 'delay_virtual', ms: 80_000_000 },
      { id: 'd2', type: 'late_success', afterMs: 10_000_000 },
    ];
    expect(codeOf(longDelay)).toMatchObject({ limit: 'maxVirtualDurationMs' });

    const raised = baseObject();
    raised['resourceBudget'] = { maxBodyBytes: HARD_CAPS.maxBodyBytes + 1 };
    expect(codeOf(raised)).toMatchObject({ code: 'RS_SCENARIO_LIMIT_EXCEEDED', limit: 'maxBodyBytes' });

    const lowered = baseObject();
    lowered['resourceBudget'] = { maxSteps: 0 };
    expect(codeOf(lowered)).toMatchObject({ limit: 'maxSteps' });
  });

  it('rejects invalid amounts and amount constraints', () => {
    const bad: Array<[string, unknown]> = [
      ['amountIn', 1000000],
      ['amountIn', '-1'],
      ['amountIn', '01'],
      ['amountIn', '1.5'],
      ['amountIn', '1e6'],
      ['amountIn', '0'],
      ['amountOut', '1'.repeat(79)],
      ['minAmountOut', '999001'],
    ];
    for (const [field, value] of bad) {
      const o = baseObject();
      (o['operationTemplate'] as Record<string, unknown>)[field] = value;
      expect(codeOf(o).code).toBe('RS_SCENARIO_INVALID');
    }
    const noAsset = baseObject();
    noAsset['groundTruthEvents'] = [{ id: 'e', fact: 'REFUND', amount: '5' }];
    expect(codeOf(noAsset)).toMatchObject({ reason: 'amount-without-asset' });
    const floatDelay = baseObject();
    floatDelay['steps'] = [
      { id: 'q', type: 'delay_virtual', ms: 1.5 },
      { id: 'r', type: 'respond', match: { route: 'QUOTE' } },
    ];
    expect(codeOf(floatDelay).code).toBe('RS_SCENARIO_INVALID');
  });

  it('rejects unsupported schema versions, profiles, references, and structure', () => {
    const v2 = baseObject();
    v2['schemaVersion'] = '2.0';
    expect(codeOf(v2).code).toBe('RS_SCHEMA_VERSION_UNSUPPORTED');
    const v11 = baseObject();
    v11['schemaVersion'] = '1.1';
    expect(codeOf(v11).code).toBe('RS_SCHEMA_VERSION_UNSUPPORTED');
    const profile = baseObject();
    profile['protocolProfile'] = 'oneclick-v1@9.0.0';
    expect(codeOf(profile).code).toBe('RS_SCENARIO_INVALID');
    const refs = baseObject();
    refs['steps'] = [
      { id: 'q', type: 'respond', match: { route: 'QUOTE' } },
      { id: 'g', type: 'ground_truth', event: 'missing' },
    ];
    expect(codeOf(refs)).toMatchObject({ reason: 'unknown-event' });
    const dup = baseObject();
    dup['steps'] = [
      { id: 'q', type: 'respond', match: { route: 'QUOTE' } },
      { id: 'q', type: 'end' },
    ];
    expect(codeOf(dup)).toMatchObject({ reason: 'duplicate-step-id' });
    const endFirst = baseObject();
    endFirst['steps'] = [
      { id: 'e', type: 'end' },
      { id: 'q', type: 'respond', match: { route: 'QUOTE' } },
    ];
    expect(codeOf(endFirst)).toMatchObject({ reason: 'end-not-last' });
    const pollute = JSON.stringify(baseObject()).replace(
      '"initialState":{}',
      '"initialState":{"__proto__":{"admin":true}}',
    );
    expect(codeOf(pollute, { format: 'json' })).toMatchObject({
      code: 'RS_SCENARIO_UNSAFE_CONSTRUCT',
      reason: 'forbidden-key',
    });
    expect(({} as Record<string, unknown>)['admin']).toBeUndefined();
    expect(codeOf('[1,2]', { format: 'json' })).toMatchObject({ reason: 'root-not-object' });
    expect(codeOf('{"schemaVersion":"1.0","x":NaN}', { format: 'json' }).code).toBe('RS_SCENARIO_INVALID');
  });

  it('refuses request and event floods at runtime and remains recoverable', () => {
    const o = baseObject();
    o['resourceBudget'] = { maxRequests: 5, maxEvents: 64 };
    o['steps'] = [{ id: 'q', type: 'respond', match: { route: 'QUOTE' } }];
    const runtime = new ScenarioRuntime(compileScenario(o).plan);
    const decisions = Array.from({ length: 20 }, () => runtime.commit(runtime.planRequest(quote())));
    expect(decisions.slice(0, 1).map((d) => d.kind)).toEqual(['RESPOND']);
    expect(decisions.slice(5).every((d) => d.rejectCode === 'RS_SCENARIO_LIMIT_EXCEEDED')).toBe(true);
    const summary = runtime.finish();
    expect(summary.limitBreached).toBe(true);
    expect(summary.events.length).toBeLessThanOrEqual(64);

    const poll = baseObject();
    poll['resourceBudget'] = { maxVirtualDurationMs: 3000 };
    poll['initialState'] = { statusPollIntervalMs: 1000 };
    poll['steps'] = [{ id: 'q', type: 'respond', match: { route: 'QUOTE' } }];
    const polled = new ScenarioRuntime(compileScenario(poll).plan);
    const statuses = Array.from({ length: 6 }, () =>
      polled.commit(polled.planRequest({ route: 'STATUS', material: { depositAddress: 'sim-deposit' } })),
    );
    expect(statuses.slice(0, 3).every((d) => d.kind === 'RESPOND')).toBe(true);
    expect(statuses.slice(3).every((d) => d.rejectCode === 'RS_SCENARIO_LIMIT_EXCEEDED')).toBe(true);
    expect(polled.nowMs()).toBe(3000);
  });
});
