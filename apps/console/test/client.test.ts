import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/errors.ts';
import { ControlClient, takeTokenFromFragment } from '../src/api/client.ts';
import { zEffectCoverage, zMatrixRow, zRecoveryResult, zSettings, zVerdict } from '../src/api/schemas.ts';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (!next) throw new Error('no response');
    return next(call);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const projectsPage = {
  items: [{ projectId: 'p1', name: 'P', description: null, settingsRevision: 1 }],
  nextCursor: null,
  total: 1,
};

describe('ControlClient transport', () => {
  it('sends the in-memory bearer token and never ambient credentials', async () => {
    const { impl, calls } = fakeFetch([() => json(200, projectsPage)]);
    const client = new ControlClient({ fetchImpl: impl });
    client.setToken('control-token-value-0001');
    await client.listProjects();
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${'control-token-value-0001'}`);
    expect(calls[0]?.init.credentials).toBe('omit');
    expect(calls[0]?.url).toBe('/__routespec/v1/projects');
    expect(client.connectionState).toBe('CONNECTED');
  });

  it('retries read-only GETs a bounded number of times and reports attempts', async () => {
    const fail = () => {
      throw new TypeError('connection refused');
    };
    const { impl, calls } = fakeFetch([fail, fail, fail, fail]);
    const client = new ControlClient({ fetchImpl: impl, readAttempts: 3, retryDelayMs: 1 });
    client.setToken('control-token-value-0001');
    const error = await client.listProjects().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('NETWORK');
    expect((error as ApiError).attempts).toBe(3);
    expect(calls).toHaveLength(3);
    expect(client.connectionState).toBe('DISCONNECTED');
  });

  it('never retries a mutation and marks a lost response as outcome unknown', async () => {
    const { impl, calls } = fakeFetch([
      () => {
        throw new TypeError('socket hang up');
      },
    ]);
    const client = new ControlClient({
      fetchImpl: impl,
      retryDelayMs: 1,
      newIdempotencyKey: () => 'key-00000001',
    });
    client.setToken('control-token-value-0001');
    const error = (await client.recoverCase('c1').catch((e: unknown) => e)) as ApiError;
    expect(calls).toHaveLength(1);
    expect(error.outcomeUnknown).toBe(true);
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('idempotency-key')).toBe('key-00000001');
    expect(calls[0]?.init.method).toBe('POST');
  });

  it('sends If-Match for revisioned mutations', async () => {
    const { impl, calls } = fakeFetch([
      () => json(409, { error: { code: 'RS_REVISION_CONFLICT', message: 'changed' } }),
    ]);
    const client = new ControlClient({ fetchImpl: impl });
    client.setToken('control-token-value-0001');
    const error = (await client
      .validateGateRun('g1', { expectedRevision: 4 })
      .catch((e: unknown) => e)) as ApiError;
    expect(new Headers(calls[0]?.init.headers).get('if-match')).toBe('"4"');
    expect(error.kind).toBe('CONFLICT');
    expect(error.outcomeUnknown).toBe(false);
  });

  it('classifies auth, unsupported-route, validation, and policy failures', async () => {
    const cases: Array<[Response, string]> = [
      [json(401, { error: { code: 'RS_CONTROL_TOKEN_EXPIRED', message: 'expired' } }), 'TOKEN_EXPIRED'],
      [json(401, { error: { code: 'RS_UNAUTHENTICATED', message: 'missing' } }), 'UNAUTHENTICATED'],
      [new Response('Not Found', { status: 404 }), 'UNSUPPORTED_ENDPOINT'],
      [json(404, { error: { code: 'RS_NOT_FOUND', message: 'none' } }), 'NOT_FOUND'],
      [json(403, { error: { code: 'RS_MODE_POLICY_DENIED', message: 'denied' } }), 'POLICY_DENIED'],
      [
        json(403, { error: { code: 'RS_RECOVERY_MUTATION_DENIED', message: 'denied' } }),
        'RECOVERY_MUTATION_DENIED',
      ],
      [json(409, { error: { code: 'RS_CONCURRENT_CLIENT', message: 'other client' } }), 'CONCURRENT_CLIENT'],
      [json(429, { error: { code: 'RS_RATE_LIMITED', message: 'slow down' } }), 'RESOURCE_LIMIT'],
    ];
    for (const [response, kind] of cases) {
      const { impl } = fakeFetch([() => response.clone()]);
      const client = new ControlClient({ fetchImpl: impl, readAttempts: 1 });
      client.setToken('control-token-value-0001');
      const error = (await client.getSettings().catch((e: unknown) => e)) as ApiError;
      expect(error.kind, kind).toBe(kind);
    }
  });

  it('returns server field errors for a rejected form submission', async () => {
    const { impl } = fakeFetch([
      () =>
        json(422, {
          error: {
            code: 'RS_VALIDATION_FAILED',
            message: 'invalid',
            requestId: 'r-1',
            details: {
              fields: [{ field: 'revisionId', code: 'RS_UNKNOWN_REVISION', message: 'Unknown revision.' }],
            },
          },
        }),
    ]);
    const client = new ControlClient({ fetchImpl: impl });
    client.setToken('control-token-value-0001');
    const error = (await client
      .createImport({ projectId: 'p', fileName: 'a.json', content: '{}' })
      .catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('VALIDATION');
    expect(error.fieldErrors).toEqual([
      { field: 'revisionId', code: 'RS_UNKNOWN_REVISION', message: 'Unknown revision.' },
    ]);
    expect(error.requestId).toBe('r-1');
  });

  it('fails closed with UNSUPPORTED_SCHEMA when a record carries an unknown axis value', async () => {
    const { impl } = fakeFetch([
      () =>
        json(200, { projectId: 'p', projectName: 'P', rows: [{ verdict: 'NOT_VISIBLE' }], nextCursor: null }),
    ]);
    const client = new ControlClient({ fetchImpl: impl });
    client.setToken('control-token-value-0001');
    const error = (await client.getMatrix('p').catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('UNSUPPORTED_SCHEMA');
  });
});

describe('control token handoff', () => {
  it('moves #token from the URL into memory and removes it from history', () => {
    const replaced: string[] = [];
    const location = {
      hash: '#token=abc123abc123abc123&view=x',
      pathname: '/projects/p/releases',
      search: '?row=1',
    } as Location;
    const history = {
      state: null,
      replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url),
    } as unknown as History;
    expect(takeTokenFromFragment(location, history)).toBe('abc123abc123abc123');
    expect(replaced).toEqual(['/projects/p/releases?row=1#view=x']);
  });

  it('ignores a fragment without a token', () => {
    const history = {
      state: null,
      replaceState: () => {
        throw new Error('must not rewrite');
      },
    } as unknown as History;
    expect(
      takeTokenFromFragment({ hash: '#section', pathname: '/', search: '' } as Location, history),
    ).toBeNull();
  });
});

describe('response contracts keep axes separate and truthful', () => {
  it('rejects NOT_VISIBLE as a verdict', () => {
    expect(zVerdict.safeParse('NOT_VISIBLE').success).toBe(false);
  });

  it('rejects declared-hooks-only coverage presented as complete', () => {
    const base = {
      missing: [],
      interceptorProfileId: null,
      interceptorFreshness: 'NOT_APPLICABLE',
      processTreeScope: null,
    };
    expect(
      zEffectCoverage.safeParse({ ...base, basis: 'DECLARED_HOOKS_ONLY', finding: 'COMPLETE' }).success,
    ).toBe(false);
    expect(
      zEffectCoverage.safeParse({ ...base, basis: 'DECLARED_HOOKS_ONLY', finding: 'INCOMPLETE' }).success,
    ).toBe(true);
    expect(zEffectCoverage.safeParse({ ...base, basis: null, finding: 'COMPLETE' }).success).toBe(false);
  });

  it('rejects a blocking enforcement mode', () => {
    const row = zMatrixRow.safeParse({ enforcementMode: 'BLOCKS_RELEASE' });
    expect(row.success).toBe(false);
    expect(row.error?.issues.some((i) => i.path.join('.') === 'enforcementMode')).toBe(true);
  });

  it('accepts recovery only when it issues a RECONCILIATION_ONLY token', () => {
    const base = {
      caseRunId: 'c',
      previousEpoch: 1,
      fencingEpoch: 2,
      revokedTokenPurpose: 'EXECUTION',
      lifecycle: 'RUNNING',
    };
    const token = { value: 'x'.repeat(24), expiresAt: '2026-11-11T00:00:00Z' };
    expect(
      zRecoveryResult.safeParse({ ...base, token: { ...token, purpose: 'RECONCILIATION_ONLY' } }).success,
    ).toBe(true);
    expect(zRecoveryResult.safeParse({ ...base, token: { ...token, purpose: 'EXECUTION' } }).success).toBe(
      false,
    );
  });

  it('rejects settings that claim committed live mode is supported', () => {
    const settings = {
      bindAddress: '127.0.0.1',
      port: 1,
      modes: [{ mode: 'COMMITTED_LIVE', supported: true, runtime: 'NONE' }],
      providerTokenState: 'NOT_REQUIRED',
      upstreamOrigin: null,
      allowlistedRoutes: [],
      retention: { days: 1, storageBytes: 0 },
      exportPolicy: 'x',
      versions: { app: 'a', protocolProfile: 'b', evaluator: 'c', sdk: 'd' },
      compatibilityRecords: [],
      dryProbe: { authorized: false, expiresAt: null },
    };
    expect(zSettings.safeParse(settings).success).toBe(false);
    expect(
      zSettings.safeParse({
        ...settings,
        modes: [{ mode: 'COMMITTED_LIVE', supported: false, runtime: 'NONE' }],
      }).success,
    ).toBe(true);
    expect(zSettings.safeParse({ ...settings, bindAddress: '0.0.0.0' }).success).toBe(false);
  });
});
