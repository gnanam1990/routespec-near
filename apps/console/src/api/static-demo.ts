/**
 * Static read-only console demo (M54).
 *
 * The demo build replaces the network with a recorded snapshot: every GET response the console
 * needed was recorded from the real loopback control API, serving the journal of a real contained
 * RouteSpec run (`packages/distribution/src/console-demo/record.ts`). This module answers the
 * console's requests from that snapshot only:
 *
 * - a recorded GET returns the recorded status and body, unchanged;
 * - a GET that was not recorded is a 404 with `RS_STATIC_DEMO_NOT_RECORDED` (never a guess);
 * - every other method is a 403 with `RS_STATIC_DEMO_READ_ONLY`: nothing can be changed.
 *
 * No verdict is computed here; the console renders the recorded records as it would live ones.
 */
import { API_PREFIX } from './client.ts';

export const DEMO_SCHEMA = 'routespec.console-demo/1';

export interface DemoResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface DemoSource {
  readonly commit: string;
  readonly recordedAt: string;
  readonly containment: string;
  readonly platform: string;
  readonly bundleDigest: string;
  readonly correctedGateRunId: string;
  readonly correctedDecision: string;
}

export interface DemoSnapshot {
  readonly schema: typeof DEMO_SCHEMA;
  readonly source: DemoSource;
  /** Keyed by `GET <path-and-query below the API prefix>`. */
  readonly responses: Readonly<Record<string, DemoResponse>>;
}

export function parseDemoSnapshot(value: unknown): DemoSnapshot {
  const v = value as Partial<DemoSnapshot> | null;
  if (v === null || typeof v !== 'object' || v.schema !== DEMO_SCHEMA) {
    throw new Error('Not a RouteSpec console demo snapshot.');
  }
  if (typeof v.responses !== 'object' || v.responses === null || typeof v.source !== 'object') {
    throw new Error('Console demo snapshot is incomplete.');
  }
  return v as DemoSnapshot;
}

/** `GET /projects/…?x=y` for a request URL that addresses the control API. */
export function snapshotKey(method: string, url: string): string | null {
  const parsed = new URL(url, 'http://demo.invalid');
  const at = parsed.pathname.indexOf(API_PREFIX);
  if (at === -1) return null;
  return `${method.toUpperCase()} ${parsed.pathname.slice(at + API_PREFIX.length)}${parsed.search}`;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export const READ_ONLY_MESSAGE =
  'This is a read-only demo recorded from a real contained run. Nothing can be changed here; run RouteSpec locally to act on records.';

export function createSnapshotFetch(snapshot: DemoSnapshot): typeof fetch {
  return (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const key = snapshotKey(method, url);
    if (key === null)
      return Promise.resolve(json(404, { error: { code: 'RS_NOT_FOUND', message: 'Not found.' } }));
    if (method !== 'GET') {
      return Promise.resolve(
        json(403, {
          error: { code: 'RS_STATIC_DEMO_READ_ONLY', message: READ_ONLY_MESSAGE, recoverable: false },
        }),
      );
    }
    const hit = Object.hasOwn(snapshot.responses, key) ? snapshot.responses[key] : undefined;
    if (hit === undefined) {
      return Promise.resolve(
        json(404, {
          error: {
            code: 'RS_STATIC_DEMO_NOT_RECORDED',
            message: 'This view was not recorded in the demo snapshot. Run RouteSpec locally to see it.',
            recoverable: false,
          },
        }),
      );
    }
    return Promise.resolve(json(hit.status, hit.body));
  };
}
