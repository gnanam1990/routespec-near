/**
 * M52 — explain_invariant and show_fix_pattern speak only in the kernel's own closed codes: every
 * explanation code of an invariant is listed with the kernel's verdict and template, and every
 * fix pattern answers remediation codes that exist.
 */
import { describe, expect, it } from 'vitest';
import { EXPLANATIONS, REMEDIATIONS } from '@routespec/kernel';
import {
  explainInvariant,
  FIX_PATTERNS,
  INVARIANTS,
  normalizeInvariantId,
  PATTERNS_FOR_REMEDIATION,
} from '../src/knowledge.ts';
import { REQUIRED_INVARIANTS } from '../src/gate.ts';
import { RouteSpecTools } from '../src/tools.ts';
import { REPO_ROOT } from './support/mcp-client.ts';

describe('invariant explanations', () => {
  it('cover INV-01..INV-09 and list exactly the kernel codes of each invariant', () => {
    expect(Object.keys(INVARIANTS)).toEqual([
      'INV-01',
      'INV-02',
      'INV-03',
      'INV-04',
      'INV-05',
      'INV-06',
      'INV-07',
      'INV-08',
      'INV-09',
    ]);
    for (const id of Object.keys(INVARIANTS)) {
      const e = explainInvariant(id);
      expect(e, id).not.toBeNull();
      const prefix = `INV0${id.slice(-1)}_`;
      const kernel = Object.entries(EXPLANATIONS).filter(([c]) => c.startsWith(prefix));
      expect(e?.kernelCodes.map((k) => k.code)).toEqual(kernel.map(([c]) => c));
      for (const k of e?.kernelCodes ?? []) {
        const spec = (EXPLANATIONS as Record<string, { verdict: string; template: string }>)[k.code];
        expect(k).toEqual({ code: k.code, verdict: spec?.verdict, text: spec?.template });
      }
      for (const r of e?.remediations ?? []) {
        expect(r.text).toBe((REMEDIATIONS as Record<string, string>)[r.code]);
      }
    }
    const inv03 = explainInvariant('INV-03');
    expect(
      inv03?.kernelCodes.find((k) => k.code === 'INV03_SECOND_MUTATION_UNDER_UNCERTAINTY')?.verdict,
    ).toBe('FAIL');
  });

  it('marks as required exactly the invariants the MCP gate requires', () => {
    const required = Object.values(INVARIANTS)
      .filter((i) => i.requiredByMcpGate)
      .map((i) => i.id);
    expect(required).toEqual([...REQUIRED_INVARIANTS]);
  });

  it('normalizes invariant ids and rejects others', () => {
    expect(['INV-03', 'inv-3', 'INV03', 'inv 03', ' INV_3 '].map(normalizeInvariantId)).toEqual(
      Array(5).fill('INV-03'),
    );
    expect(['INV-10', 'INV-0', 'X-03', '', 'INV-03; ls'].map(normalizeInvariantId)).toEqual(
      Array(5).fill(null),
    );
  });
});

describe('fix patterns', () => {
  it('name existing remediation codes and invariants, and have before and after code', () => {
    for (const p of Object.values(FIX_PATTERNS)) {
      expect(p.before.length, p.id).toBeGreaterThan(20);
      expect(p.after.length, p.id).toBeGreaterThan(20);
      expect(p.after).not.toBe(p.before);
      for (const code of p.remediationCodes) expect(Object.keys(REMEDIATIONS), p.id).toContain(code);
      for (const inv of p.invariants) expect(Object.keys(INVARIANTS), p.id).toContain(inv);
    }
    for (const [code, patterns] of Object.entries(PATTERNS_FOR_REMEDIATION)) {
      expect(Object.keys(REMEDIATIONS)).toContain(code);
      for (const p of patterns) expect(Object.keys(FIX_PATTERNS)).toContain(p);
    }
    for (const i of Object.values(INVARIANTS)) {
      for (const p of i.fixPatterns) expect(Object.keys(FIX_PATTERNS)).toContain(p);
    }
  });

  it('the reconcile pattern reads status and never resubmits; the slow-answer pattern places no second order', () => {
    const r = FIX_PATTERNS['reconcile-through-status'];
    expect(r?.after).toMatch(/getExecutionStatus/);
    expect(r?.after.match(/submitDepositTx/g)?.length).toBe(1);
    const n = FIX_PATTERNS['no-second-order-while-unanswered'];
    expect(n?.before).toMatch(/getQuote/);
    expect(n?.after).not.toMatch(/getQuote|submitDepositTx/);
  });

  it('show_fix_pattern returns one pattern, the patterns of an invariant, or the list', async () => {
    const tools = new RouteSpecTools({ root: REPO_ROOT });
    const one = await tools.call('show_fix_pattern', { pattern: 'reconcile-through-status' });
    expect(one.isError).toBe(false);
    expect((one.structuredContent['patterns'] as Array<{ id: string }>).map((p) => p.id)).toEqual([
      'reconcile-through-status',
    ]);
    const byInv = await tools.call('show_fix_pattern', { invariant: 'INV-03' });
    expect((byInv.structuredContent['patterns'] as Array<{ id: string }>).map((p) => p.id)).toEqual([
      'no-second-order-while-unanswered',
      'reconcile-through-status',
    ]);
    const all = await tools.call('show_fix_pattern', {});
    expect((all.structuredContent['patterns'] as unknown[]).length).toBe(Object.keys(FIX_PATTERNS).length);
    const bad = await tools.call('show_fix_pattern', { pattern: '../etc' });
    expect(bad.structuredContent).toMatchObject({ error: { code: 'UNKNOWN_PATTERN' } });
  });
});
