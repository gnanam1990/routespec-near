/**
 * M48: the pinned third-party example clients, run for real through the control service inside
 * the subject container. Part of the containment suite (`pnpm run test:containment`).
 *
 * Skipped as `NOT_RUN: <reason>` when there is no usable container engine or image
 * (for example CONTAINER_RUNTIME_ABSENT), or when the pinned files have not been fetched
 * (THIRD_PARTY_SOURCES_ABSENT: run `pnpm run examples:fetch` once; it needs the network, so a
 * test never does it). Skipped is not passed.
 *
 * What is asserted is what containment and identity must guarantee for any example, plus the
 * behaviour observed for the pinned bytes. No verdict is expected in advance by RouteSpec: the
 * case verdicts below are the kernel's results and are compared with the recorded run in
 * `docs/status/M48.md`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { containerCliFromEnv, detectContainerRuntime } from '@routespec/containment';
import { loadPins } from '../../../examples/third-party/support/pins.ts';
import {
  ROOT,
  SCENARIOS,
  ThirdPartyUnavailable,
  runThirdParty,
  selectVerifiedPins,
  summarize,
} from '../src/third-party.ts';
import type { J } from '../src/control.ts';

let notRun: string | null = null;
let record: J | null = null;
const work = mkdtempSync(join(tmpdir(), 'routespec-m48-run-'));

beforeAll(async () => {
  try {
    selectVerifiedPins(ROOT);
  } catch (error) {
    if (!(error instanceof ThirdPartyUnavailable)) throw error;
    notRun = error.reason;
    return;
  }
  const rt = await detectContainerRuntime({ cli: containerCliFromEnv(process.env) });
  if (rt.status !== 'AVAILABLE') {
    notRun = rt.reason;
    return;
  }
  record = await runThirdParty({ work });
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function need(ctx: TestContext): J {
  if (record === null) {
    ctx.skip(`NOT_RUN: ${notRun ?? 'UNKNOWN'}`);
    throw new Error('unreachable');
  }
  return record;
}

const casesOf = (r: J) => (r['sources'] as J[]).flatMap((s) => (s['cases'] as J[]).map((c) => ({ s, c })));

describe('M48 pinned third-party examples, contained', () => {
  it('runs every pinned example through every scenario, each in an enforced container', (ctx) => {
    const r = need(ctx);
    expect((r['containment'] as J)['mode']).toBe('CONTAINED');
    expect((r['sources'] as J[]).map((s) => s['id'])).toEqual(loadPins().map((p) => p.id));
    for (const s of r['sources'] as J[]) {
      expect((s['cases'] as J[]).map((c) => c['scenarioName'])).toEqual([...SCENARIOS]);
    }
    for (const { c } of casesOf(r)) {
      const live = (c['containment'] as J)['live'] as J;
      expect(live['containment']).toBe('PROCESS_TREE_ENFORCED');
      expect(live['findings']).toEqual([]);
      expect(((live['attestations'] as J)['CASE_LAUNCH'] as J)['outcome']).toBe('ATTESTED');
      expect(c['tokenReturnedOverHttp']).toBe(false);
      const [journaled] = (c['containment'] as J)['records'] as J[];
      expect(journaled?.['containerRemoved']).toBe(true);
      expect((journaled?.['teardown'] as J)['survivors']).toBe(0);
    }
  });

  it('loads exactly the pinned bytes, unedited, and keeps every request on the RouteSpec proxy', (ctx) => {
    const r = need(ctx);
    const pins = new Map(loadPins().map((p) => [p.id, p]));
    for (const { s, c } of casesOf(r)) {
      const pin = pins.get(String(s['id']));
      const outcome = (c['subject'] as J)['outcome'] as J;
      const source = outcome['source'] as J;
      expect(source['commit']).toBe(pin?.commit);
      expect(source['entryDigest']).toBe(pin?.files.find((f) => f.path === pin.entry)?.sha256);
      expect(source['sourceEdited']).toBe(false);
      expect(source['importsRefused']).toEqual([]);
      for (const loaded of source['filesLoaded'] as string[]) {
        expect(pin?.files.map((f) => f.path)).toContain(loaded);
      }
      expect(outcome['loadError']).toBeNull();
      const transport = outcome['transport'] as J[];
      expect(transport.length).toBeGreaterThan(0);
      for (const t of transport) expect(t['target']).toBe('PROXY');
      // Only the proxy tunnel carried traffic; the effect sink was never reached.
      const tunnels = ((((c['containment'] as J)['records'] as J[])[0] as J)['teardown'] as J)[
        'tunnels'
      ] as J;
      expect((tunnels['routespec-proxy'] as J)['connections']).toBeGreaterThan(0);
      expect((tunnels['effect-sink'] as J)['connections']).toBe(0);
    }
  });

  it('the official SDK example: what it did and what the kernel returned (recorded in docs/status/M48.md)', (ctx) => {
    const r = need(ctx);
    const source = (r['sources'] as J[]).find((s) => s['id'] === 'one-click-sdk-basic-swap-flow') as J;
    for (const c of source['cases'] as J[]) {
      const outcome = (c['subject'] as J)['outcome'] as J;
      // The example assigns the hosted 1Click URL; the assignment had no effect.
      expect(outcome['baseAssignmentsIgnored']).toEqual(['https://1click.chaindefuser.com']);
      // Its first call is the token list, a route outside RouteSpec's oneclick-v0 profile.
      expect(outcome['sdkCalls']).toEqual([
        { method: 'getTokens', outcome: 'REJECTED', status: 404, code: 'RS_UNSUPPORTED_ROUTE' },
      ]);
      // It stops there, so no quote exists and the kernel has no run operation to judge.
      expect(c['runOperationIds']).toEqual([]);
      expect(c['invariants']).toEqual([]);
      expect(c['verdict']).toBe('REVIEW');
    }
    expect((source['gate'] as J)['decision']).toBe('REVIEW');
    expect(summarize(r)).toContain('invariants: none evaluated');
  });
});
