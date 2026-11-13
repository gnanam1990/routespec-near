/**
 * M54: the static read-only demo answers the console only from the committed recording of a real
 * contained run. Recorded GETs come back unchanged and validate against the console's closed
 * schemas through the real client; unrecorded GETs and every mutation are refused with an error
 * the console shows as such, never as data.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/errors.ts';
import { ControlClient } from '../src/api/client.ts';
import {
  createSnapshotFetch,
  parseDemoSnapshot,
  snapshotKey,
  type DemoSnapshot,
} from '../src/api/static-demo.ts';

const snapshot: DemoSnapshot = parseDemoSnapshot(
  JSON.parse(
    readFileSync(
      new URL('../../../packages/distribution/console-demo/snapshot.json', import.meta.url),
      'utf8',
    ),
  ),
);

function demoClient(): ControlClient {
  const client = new ControlClient({ fetchImpl: createSnapshotFetch(snapshot), readAttempts: 1 });
  client.setToken('read-only-demo');
  return client;
}

describe('M54 static console demo', () => {
  it('keys requests by method, path and query below the API prefix', () => {
    expect(snapshotKey('get', '/routespec-near/__routespec/v1/projects')).toBe('GET /projects');
    expect(snapshotKey('GET', 'http://h/__routespec/v1/gate-runs/x/cases?limit=200')).toBe(
      'GET /gate-runs/x/cases?limit=200',
    );
    expect(snapshotKey('GET', '/assets/index.js')).toBeNull();
  });

  it('serves every recorded read through the real client and its closed schemas', async () => {
    const client = demoClient();
    const projects = await client.listProjects();
    expect(projects.items.length).toBe(1);
    const projectId = projects.items[0]?.projectId as string;
    const matrix = await client.getMatrix(projectId);
    expect(matrix.rows.length).toBeGreaterThan(0);
    const corrected = await client.getGateRun(snapshot.source.correctedGateRunId);
    expect(corrected.gateRunId).toBe(snapshot.source.correctedGateRunId);
    const cases = await client.listCases(snapshot.source.correctedGateRunId, null);
    expect(cases.items.length).toBeGreaterThan(0);
    for (const c of cases.items) {
      if (c.sessionId) {
        const events = await client.listEvents(c.sessionId, { limit: 100 });
        expect(events.items.length).toBeGreaterThan(0);
      }
    }
    expect((await client.getSettings()).bindAddress).toBe('127.0.0.1');
  });

  it('refuses an unrecorded read instead of inventing a record', async () => {
    const error = await demoClient()
      .getGateRun('00000000-0000-4000-8000-000000000000')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'NOT_FOUND', code: 'RS_STATIC_DEMO_NOT_RECORDED' });
  });

  it('refuses every mutation as read-only', async () => {
    const client = demoClient();
    const run = await client.getGateRun(snapshot.source.correctedGateRunId);
    const error = await client.evaluateGate(run.gateId as string, run.gateRunId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'PERMISSION_DENIED', code: 'RS_STATIC_DEMO_READ_ONLY' });
  });
});
