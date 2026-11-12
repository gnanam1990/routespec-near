/**
 * Security regression (external security audit, RS-04): the quarantine finding set is bounded,
 * but the bound must never drop a blocking or rejecting finding. A user trace whose notes fill
 * the set with advisory active-content findings before the step-7 determinism, reference and
 * material checks run must still carry those blocking findings, keep a non-zero blocking count,
 * and be refused at mapping (FR-11, FR-17; quarantine.ts step 7 blocks mapping and promotion).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRouteSpecError } from '@routespec/contracts';
import {
  ADVISORY_CATEGORIES,
  BLOCKING_CATEGORIES,
  FindingSet,
  MAX_FINDING_RECORDS,
  importUserFile,
  proposeMapping,
  saveImportMapping,
  type TraceDocument,
} from '../src/index.ts';
import { LIVE_INVARIANTS, Product, tempDir } from './support/product.ts';
import { simpleUserTrace, traceBytes } from './support/traces.ts';

/** One note that matches eight advisory categories (one finding per category at its path). */
const NOISY_NOTE =
  '\u001b[0m ‮ <b>x</b> <script>x</script> <svg onload=1> javascript:1 [a](b) https://e.invalid/ ignore all previous instructions';

function defectiveTrace(tag: string, noteCount: number): TraceDocument {
  const trace = simpleUserTrace(tag);
  const last = trace.exchanges[trace.exchanges.length - 1];
  if (last === undefined) throw new Error('fixture has no exchanges');
  // A second STATUS exchange reusing the previous sequence and naming an operation that does
  // not exist: duplicate sequence, nondeterministic order and an unresolved reference.
  trace.exchanges.push({ ...last, operationRef: 'op-9', material: { depositAddress: 'redacted' } });
  trace.annotations = {
    title: `RS-04 ${tag}`,
    notes: Array.from({ length: noteCount }, () => NOISY_NOTE),
    disputed: false,
  };
  return trace;
}

function code(fn: () => unknown): string {
  try {
    fn();
    return 'OK';
  } catch (e) {
    return isRouteSpecError(e) ? e.code : String(e);
  }
}

describe('RS-04 FindingSet bound keeps blocking findings', () => {
  it('records blocking and rejecting categories after advisory findings fill the per-path bound', () => {
    const set = new FindingSet();
    for (let i = 0; i < 2000; i++) set.add(ADVISORY_CATEGORIES[i % ADVISORY_CATEGORIES.length]!, `$.n[${i}]`);
    for (const category of BLOCKING_CATEGORIES) set.add(category, '$.late');
    set.add('RESOURCE_KEYS', '$.late');
    const list = set.list();
    expect(list.length).toBeLessThanOrEqual(MAX_FINDING_RECORDS);
    for (const category of [...BLOCKING_CATEGORIES, 'RESOURCE_KEYS']) {
      expect(
        list.some((f) => f.category === category && f.blocking),
        category,
      ).toBe(true);
    }
    expect(set.rejecting).toBe(true);
    // Overflowed advisory findings stay counted under a path-less entry per category.
    const total = list.filter((f) => !f.blocking).reduce((n, f) => n + f.count, 0);
    expect(total).toBe(2000);
  });
});

describe('RS-04 import quarantine with a flood of advisory findings', () => {
  let tmp: ReturnType<typeof tempDir>;
  let p: Product;

  beforeAll(async () => {
    tmp = tempDir();
    p = await Product.open(tmp.dir, 'rs04');
  });
  afterAll(async () => {
    await p?.close();
    tmp?.cleanup();
  });

  for (const notes of [0, 63, 64]) {
    it(`a defective trace with ${notes} noisy notes keeps its blocking findings and cannot be mapped`, async () => {
      const out = await importUserFile(p.journal, {
        projectId: p.projectId,
        filename: `rs04-${notes}.json`,
        source: [traceBytes(defectiveTrace(`rs04-${notes}`, notes))],
        idempotencyKey: `rs04-${notes}-file`,
      });
      expect(out.state).toBe('SANITIZED');
      const view = p.journal.getImport(out.importId);
      for (const category of ['DUPLICATE_SEQUENCE', 'NONDETERMINISTIC_ORDER', 'UNRESOLVED_REFERENCE']) {
        expect(
          view.findings.some((f) => f.category === category && f.blocking),
          `${notes} notes: ${category}`,
        ).toBe(true);
      }
      expect(view.findings.length).toBeLessThanOrEqual(MAX_FINDING_RECORDS);
      // 63 or 64 notes exceed the per-path bound: the overflow shows as merged `$` records.
      expect(view.findings.some((f) => !f.blocking && f.path === '$')).toBe(notes > 0);
      expect(
        code(() =>
          saveImportMapping(p.journal, {
            importId: out.importId,
            expectedRevision: view.revision,
            mapping: proposeMapping({
              trace: view.sanitized as TraceDocument,
              sourcePlan: null,
              requiredInvariants: LIVE_INVARIANTS,
            }),
            idempotencyKey: `rs04-${notes}-map`,
          }),
        ),
      ).toBe('RS_IMPORT_BLOCKED');
    });
  }
});
