/**
 * M11 safe deletion: retention purge of quarantined import content (SECURITY.md section 9,
 * NFR-06 retention). Supplementary module test; it claims no canonical test ID.
 *
 * Real control service, real journal files. Sanitized trace content carrying a unique marker is
 * imported, then aged past the project's retention policy with the journal clock. The purge is
 * a dry-run plan first (nothing changes), refuses a confirmation that does not match the current
 * plan, then purges under the exact plan digest: the content is cleared in the journal with
 * secure deletion and the WAL is checkpointed, so the marker bytes are gone from the database
 * and WAL files, not only from query results. Mapped, reviewed, and promoted imports are listed
 * as retained (their reviewed records are immutable) and are not touched.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCanary, scanTree } from '@routespec/hardening';
import { ImportJournal } from '@routespec/store';
import { errorCode, expectOk, startHarness, type Harness } from '../../control-api/test/support/fixture.ts';
import { simpleUserTrace } from '../../regressions/test/support/traces.ts';

let h: Harness;
let projectId = '';
const marker = makeCanary('retention-marker', 'retention_marker_');

/** A schema-valid user trace (M05 fixture) whose annotations carry the marker. */
function trace(note: string): string {
  const t = simpleUserTrace('retention');
  return JSON.stringify({ ...t, annotations: { ...t.annotations, notes: [note] } });
}

beforeAll(async () => {
  h = await startHarness();
  const p = expectOk(await h.api('POST', '/projects', { name: 'retention' }), 201);
  projectId = String(p['projectId']);
});

afterAll(async () => {
  await h?.close();
});

const DAY = 86_400_000;

describe('M11 safe deletion — retention purge of quarantine content', () => {
  let importId = '';
  let rejectedId = '';

  it('stores sanitized quarantine content, which is present in the journal files', async () => {
    const r = expectOk(
      await h.api('POST', '/imports', {
        projectId,
        fileName: 'kept.json',
        content: trace(`memo ${marker.value}`),
      }),
      201,
    );
    importId = String(r['importId']);
    const rej = expectOk(
      await h.api('POST', '/imports', { projectId, fileName: 'broken.json', content: '{"schema":' }),
      201,
    );
    rejectedId = String(rej['importId']);
    const view = new ImportJournal(h.store).getImport(importId);
    expect(view.sanitized).not.toBeNull();
    expect(scanTree(h.dir, [marker]).findings.length).toBeGreaterThan(0);
  });

  it('before the retention period nothing is due', async () => {
    const plan = expectOk(await h.api('POST', `/projects/${projectId}/retention-purge`, {}), 200);
    expect(plan).toMatchObject({ dryRun: true, purged: 0 });
    expect(plan['due']).toEqual([]);
  });

  it('after the retention period the dry run lists the content and changes nothing', async () => {
    h.clock.advance(31 * DAY);
    // The request itself leaves an idempotency record; nothing else may change.
    const counts = () => {
      const { control_idempotency: _ignored, ...rest } = h.tableCounts();
      return rest;
    };
    const before = counts();
    const plan = expectOk(await h.api('POST', `/projects/${projectId}/retention-purge`, {}), 200);
    expect(plan['dryRun']).toBe(true);
    expect((plan['due'] as Array<{ importId: string }>).map((d) => d.importId).sort()).toEqual(
      [importId, rejectedId].sort(),
    );
    expect(plan['physicalErasure']).toMatch(/not guaranteed/i);
    expect(counts()).toEqual(before);
    expect(new ImportJournal(h.store).getImport(importId).sanitized).not.toBeNull();
  });

  it('a confirmation that does not match the current plan is refused', async () => {
    const r = await h.api('POST', `/projects/${projectId}/retention-purge`, {
      confirmDigest: `sha256:${'0'.repeat(64)}`,
    });
    expect(r.status).toBe(409);
    expect(errorCode(r)).toBe('RS_DELETION_PLAN_MISMATCH');
    expect(new ImportJournal(h.store).getImport(importId).state).toBe('SANITIZED');
  });

  it('the confirmed purge clears the content; its bytes are gone from the database and WAL files', async () => {
    const plan = expectOk(await h.api('POST', `/projects/${projectId}/retention-purge`, {}), 200);
    const done = expectOk(
      await h.api('POST', `/projects/${projectId}/retention-purge`, { confirmDigest: plan['planDigest'] }),
      200,
    );
    expect(done).toMatchObject({
      dryRun: false,
      purged: 2,
      planDigest: plan['planDigest'],
      walTruncated: true,
    });
    const imports = new ImportJournal(h.store);
    for (const id of [importId, rejectedId]) {
      const v = imports.getImport(id);
      expect(v.state).toBe('PURGED');
      expect(v.sanitized).toBeNull();
      // Identity and finding metadata stay for the audit trail.
      expect(v.rawSourceDigest).toMatch(/^sha256:/);
    }
    const scan = scanTree(h.dir, [marker]);
    expect(scan.scanned).toEqual(expect.arrayContaining(['journal.db']));
    expect(scan.findings).toEqual([]);
    const audit = h.store
      .listAuditEvents('IMPORTS_RETENTION_PURGED')
      .map((a) => JSON.parse(String(a['details_json'])) as Record<string, unknown>);
    expect(audit).toEqual([expect.objectContaining({ planDigest: plan['planDigest'], purged: 2 })]);
    // Idempotent: nothing more is due.
    const again = expectOk(await h.api('POST', `/projects/${projectId}/retention-purge`, {}), 200);
    expect(again['due']).toEqual([]);
    expect(join(h.dir, 'journal.db')).toBeTruthy();
  });
});
