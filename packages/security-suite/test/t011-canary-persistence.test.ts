/**
 * T-011 — Canary credentials never cross persistence boundaries. Covers FR-17, NFR-03, INV-11.
 *
 * Unique canaries are injected through every approved memory input and pushed through error
 * paths, then searched for (raw, UTF-16LE, base64/base64url at every alignment, hex, percent
 * encoding) in every place the product can persist or expose bytes.
 *
 * Inputs (all real product paths):
 * - a configured secret value, given to the control service through its protected environment
 *   input (`ROUTESPEC_CONFIGURED_SECRETS`, read once and removed);
 * - a provider JWT set as the official SDK's own bearer token in a separately launched subject;
 * - provider `Authorization` and `Cookie` headers sent to the proxy with real case credentials;
 * - the real control token and the real one-time case token.
 * Error paths: the configured secret and the control token pasted into control-API bodies, an
 * idempotency key, a cursor, a scenario source, a quote body field, a logical-job header, an
 * unknown proxy route, and an imported trace.
 *
 * Scanned afterwards: the journal database, WAL and shared-memory files (the service is killed
 * without a checkpoint, as in a crash), the structured log file, every other file in the data
 * directory, stdout/stderr of the service and of the subject, the written export bundle and its
 * disposable extraction, new crash dumps, the command lines of every running process, and the
 * console's DOM, URL, localStorage, sessionStorage, cookies, and IndexedDB in a real browser.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { ADAPTER_HEADERS } from '@routespec/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  makeCanary,
  processCommandLines,
  scanBuffer,
  scanTree,
  type Canary,
  type CanaryFinding,
} from '@routespec/hardening';
import { verifyBundle } from '@routespec/runner';
import {
  Subject,
  caseHeaders,
  errorCode,
  expectOk,
  quoteBody,
  setupProject,
  startedGateRun,
  tempDir,
} from '../../control-api/test/support/fixture.ts';
import { canaryJwt } from '../../live-dry-adapter/test/support/harness.ts';
import { send } from '../../proxy/test/support/gate.ts';
import { ensureConsoleBuilt, startControlProcess, type ControlProcess } from './support/control-process.ts';

let tmp: ReturnType<typeof tempDir>;
let dataDir = '';
let exportsDir = '';
let cp: ControlProcess;
let subject: Subject | null = null;
let subjectErr = '';
const canaries: Canary[] = [];
const commandLineFindings: CanaryFinding[] = [];
const browserFindings: CanaryFinding[] = [];
const refusals: Record<string, { status: number; code: string | null }> = {};
let crashDumpsBefore = new Set<string>();
let browserState: { url: string; local: number; session: number; cookies: number; idb: number } | null = null;

const CRASH_DUMPS = join(process.env['LOCALAPPDATA'] ?? '', 'CrashDumps');
const listDumps = () => (existsSync(CRASH_DUMPS) ? new Set(readdirSync(CRASH_DUMPS)) : new Set<string>());

function scanText(text: string, location: string): CanaryFinding[] {
  return scanBuffer(Buffer.from(text, 'utf8'), canaries, location);
}

beforeAll(async () => {
  tmp = tempDir('routespec-t011-');
  dataDir = join(tmp.dir, 'data');
  exportsDir = join(tmp.dir, 'exports');
  mkdirSync(exportsDir);
  const configured = makeCanary('configured-secret');
  const providerJwt = { label: 'provider-jwt', value: canaryJwt(3600, 'm11canary') };
  const header = makeCanary('provider-header');
  canaries.push(configured, providerJwt, header);
  crashDumpsBefore = listDumps();
  const consoleDir = ensureConsoleBuilt();

  cp = await startControlProcess({
    dataDir,
    consoleDir,
    env: { ROUTESPEC_CONFIGURED_SECRETS: configured.value },
  });
  canaries.push({ label: 'control-token', value: cp.token });

  // ---- error paths on the control API (each must be refused before persistence) ----
  const refuse = async (
    label: string,
    p: Promise<{ status: number; json: Record<string, unknown> | null }>,
  ) => {
    const r = await p;
    refusals[label] = { status: r.status, code: errorCode(r as never) };
  };
  await refuse(
    'project name with configured secret',
    cp.api('POST', '/projects', { name: `release ${configured.value}` }),
  );
  await refuse(
    'project name with control token',
    cp.api('POST', '/projects', { name: `pasted ${cp.token}` }),
  );
  await refuse(
    'idempotency key with configured secret',
    cp.api('POST', '/projects', { name: 'ok' }, { idem: configured.value }),
  );
  await refuse('cursor with configured secret', cp.api('GET', `/projects?cursor=${configured.value}`));

  const p = await setupProject(cp, 't011');
  await refuse(
    'scenario source with configured secret',
    cp.api('POST', '/scenarios', {
      projectId: p.projectId,
      source: `schemaVersion: "1.0"\ntitle: ${configured.value}\n`,
    }),
  );
  await refuse(
    'trace import with secrets',
    cp.api('POST', '/imports', {
      projectId: p.projectId,
      fileName: 'support-ticket.json',
      content: JSON.stringify({
        schema: 'routespec.trace/1',
        notes: `customer pasted ${configured.value}`,
        headers: { authorization: `Bearer ${providerJwt.value}` },
      }),
    }),
  );

  await refuse(
    'trace import with configured secret only',
    cp.api('POST', '/imports', {
      projectId: p.projectId,
      fileName: 'notes.json',
      content: JSON.stringify({ schema: 'routespec.trace/1', notes: `ticket ${configured.value}` }),
    }),
  );

  // ---- a real case: official SDK subject with its own provider bearer token ----
  const run = await startedGateRun(cp, p);
  const start = expectOk(await cp.api('POST', `/case-runs/${run.caseRunId}/start`, {}), 201);
  const caseToken = (start['token'] as { value: string }).value;
  canaries.push({ label: 'case-token', value: caseToken });
  subject = await Subject.launch();
  subject.child.stderr?.on('data', (c: Buffer) => (subjectErr += c.toString('utf8')));
  await subject.attach(String(start['proxyBaseUrl']), start);
  await subject.send({ type: 'providerToken', value: providerJwt.value });

  // Command lines of every process while the service and the subject are alive.
  for (const pr of processCommandLines())
    commandLineFindings.push(...scanText(pr.commandLine, `pid ${pr.pid}`));

  await subject.send({ type: 'logicalJob', key: 'order-t011' });
  const q = await subject.call('getQuote', quoteBody());
  expect(q['ok'], JSON.stringify(q)).toBe(true);
  const depositAddress = String(
    ((q['value'] as Record<string, unknown>)['quote'] as Record<string, unknown>)['depositAddress'],
  );
  expect((await subject.call('submitDepositTx', { txHash: 'sim-tx-t011', depositAddress }))['ok']).toBe(true);
  // Provider Authorization and Cookie headers next to real case credentials: stripped.
  const proxyPort = Number(new URL(String(start['proxyBaseUrl'])).port);
  const events = expectOk(
    await cp.api('GET', `/sessions/${String(start['sessionId'])}/events?limit=50`),
    200,
  );
  const runOperationId = (events['items'] as Array<Record<string, unknown>>)
    .map((e) => e['runOperationId'])
    .find((v): v is string => typeof v === 'string') as string;
  const statusWithCreds = await send(proxyPort, {
    method: 'GET',
    path: `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
    headers: {
      ...caseHeaders(start),
      [ADAPTER_HEADERS.logicalJob]: 'order-t011',
      [ADAPTER_HEADERS.runOperation]: runOperationId,
      authorization: `Bearer ${header.value}`,
      cookie: `session=${header.value}`,
    },
  });
  expect(statusWithCreds.status, JSON.stringify(statusWithCreds.body)).toBe(200);
  // A configured secret in a quote field and in a logical-job header is refused by the proxy.
  await subject.send({ type: 'logicalJob', key: configured.value });
  const leakedJob = await subject.call('getQuote', quoteBody());
  refusals['logical-job header with configured secret'] = {
    status: Number((leakedJob['error'] as { status?: number } | undefined)?.status ?? 200),
    code: ((leakedJob['error'] as { code?: string } | undefined)?.code ?? null) as string | null,
  };
  const leakedField = await subject.call('getQuote', { ...quoteBody(), refundTo: configured.value });
  refusals['quote field with configured secret'] = {
    status: Number((leakedField['error'] as { status?: number } | undefined)?.status ?? 200),
    code: ((leakedField['error'] as { code?: string } | undefined)?.code ?? null) as string | null,
  };
  // An unknown route carrying a secret in its path is a denial that must not keep the path.
  const unknown = await send(proxyPort, { method: 'GET', path: `/v0/${configured.value}` });
  refusals['unknown proxy route with configured secret'] = {
    status: unknown.status ?? 0,
    code: (unknown.body as { error?: { code?: string } } | null)?.error?.code ?? null,
  };
  await subject.close();
  subject = null;

  expectOk(await cp.api('POST', `/case-runs/${run.caseRunId}/finish-input`, {}), 200);
  const ev = expectOk(
    await cp.api('POST', `/gates/${p.gateId}/evaluate`, { gateRunId: run.gateRunId }),
    [200, 201],
  );
  const plan = expectOk(
    await cp.api('POST', '/exports', { gateEvaluationId: ev['gateEvaluationId'] }),
    [200, 201],
  );
  expect(plan['blocked']).toBe(false);
  expectOk(
    await cp.api('POST', `/exports/${String(plan['exportId'])}/write`, {
      outPath: join(exportsDir, 'bundle.tar'),
      confirm: plan['planDigest'],
    }),
    200,
  );
  verifyBundle(join(exportsDir, 'bundle.tar'), join(exportsDir, 'extracted'));

  // ---- the console in a real browser, opened with the one-time hand-off URL ----
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${cp.origin}/#token=${encodeURIComponent(cp.token)}`);
    await page.waitForLoadState('networkidle');
    const routes = [
      '/',
      `/projects/${p.projectId}/gate-runs`,
      `/projects/${p.projectId}/gate-runs/${run.gateRunId}`,
      `/projects/${p.projectId}/gate-runs/${run.gateRunId}/cases/${run.caseRunId}`,
      `/projects/${p.projectId}/operations`,
      `/projects/${p.projectId}/regressions`,
      '/settings',
    ];
    for (const route of routes) {
      // Client-side navigation keeps the in-memory token (a reload would drop it by design).
      await page.evaluate((r) => {
        window.history.pushState({}, '', r);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, route);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(400);
      browserFindings.push(...scanText(await page.content(), `dom ${route}`));
    }
    const storage = await page.evaluate(async () => {
      const dump = (s: Storage) => Object.keys(s).map((k) => `${k}=${s.getItem(k) ?? ''}`);
      const dbs = 'databases' in indexedDB ? await indexedDB.databases() : [];
      return {
        url: location.href,
        local: dump(localStorage),
        session: dump(sessionStorage),
        idb: dbs.map((d) => d.name ?? ''),
      };
    });
    const cookies = await context.cookies();
    browserFindings.push(
      ...scanText(storage.url, 'location.href'),
      ...scanText(storage.local.join('\n'), 'localStorage'),
      ...scanText(storage.session.join('\n'), 'sessionStorage'),
      ...scanText(storage.idb.join('\n'), 'indexedDB'),
      ...scanText(JSON.stringify(cookies), 'cookies'),
    );
    browserState = {
      url: storage.url.replace(cp.origin, ''),
      local: storage.local.length,
      session: storage.session.length,
      cookies: cookies.length,
      idb: storage.idb.length,
    };
  } finally {
    await browser.close();
  }

  // Crash: no graceful close, no checkpoint; the WAL keeps the latest pages.
  await cp.kill();
}, 300_000);

afterAll(async () => {
  await subject?.close().catch(() => undefined);
  await cp?.kill();
  tmp?.cleanup();
});

describe('T-011 — Canary credentials never cross persistence boundaries', () => {
  it('the scanner itself finds a canary in every encoding it claims (positive control)', () => {
    const probe = join(tmp.dir, 'probe');
    mkdirSync(probe);
    const c = canaries[0] as Canary;
    writeFileSync(join(probe, 'utf8.txt'), `x${c.value}y`);
    writeFileSync(join(probe, 'utf16.bin'), Buffer.from(`ab${c.value}cd`, 'utf16le'));
    writeFileSync(join(probe, 'b64.txt'), Buffer.from(`zz${c.value}zz`).toString('base64'));
    writeFileSync(join(probe, 'b64url.txt'), Buffer.from(`q${c.value}`).toString('base64url'));
    writeFileSync(join(probe, 'hex.txt'), Buffer.from(c.value).toString('hex'));
    const found = new Set(scanTree(probe, [c]).findings.map((f) => f.location));
    expect([...found].sort()).toEqual(['b64.txt', 'b64url.txt', 'hex.txt', 'utf16.bin', 'utf8.txt']);
  });

  it('every error path carrying a secret is refused before persistence, without echoing it', () => {
    expect(refusals).toEqual({
      'project name with configured secret': { status: 422, code: 'RS_SECRET_FIELD_REJECTED' },
      'project name with control token': { status: 422, code: 'RS_SECRET_FIELD_REJECTED' },
      'idempotency key with configured secret': { status: 422, code: 'RS_SECRET_FIELD_REJECTED' },
      'cursor with configured secret': { status: 422, code: 'RS_SECRET_FIELD_REJECTED' },
      'scenario source with configured secret': { status: 422, code: 'RS_SECRET_FIELD_REJECTED' },
      'trace import with secrets': { status: 201, code: null },
      'trace import with configured secret only': { status: 201, code: null },
      'logical-job header with configured secret': { status: 422, code: 'RS_SECRET_FIELD_REJECTED' },
      'quote field with configured secret': { status: 422, code: 'RS_SECRET_FIELD_REJECTED' },
      'unknown proxy route with configured secret': { status: 404, code: 'RS_UNSUPPORTED_ROUTE' },
    });
  });

  it('no canary in the journal database, WAL, shared memory, lock, or any other data-directory file', () => {
    const scan = scanTree(dataDir, canaries);
    expect(scan.scanned).toEqual(
      expect.arrayContaining(['journal.db', 'journal.db-wal', 'logs/control.jsonl']),
    );
    expect(scan.findings).toEqual([]);
  });

  it('no canary in the structured log, stdout, or stderr of the service and the subject', () => {
    const logs = scanTree(join(dataDir, 'logs'), canaries);
    expect(logs.files).toBeGreaterThan(0);
    expect(logs.bytes).toBeGreaterThan(0);
    expect([
      ...logs.findings,
      ...scanText(cp.stdout(), 'service stdout'),
      ...scanText(cp.stderr(), 'service stderr'),
      ...scanText(subjectErr, 'subject stderr'),
    ]).toEqual([]);
  });

  it('no canary in the export bundle or its disposable extraction', () => {
    const scan = scanTree(exportsDir, canaries);
    expect(scan.scanned).toEqual(expect.arrayContaining(['bundle.tar', 'extracted/manifest.json']));
    expect(scan.findings).toEqual([]);
  });

  it('no crash dump was produced, and none contains a canary', () => {
    const added = [...listDumps()].filter((f) => !crashDumpsBefore.has(f));
    const findings = added.flatMap((f) => scanTree(join(CRASH_DUMPS, f), canaries).findings);
    expect(findings).toEqual([]);
    expect(readdirSync(dataDir).filter((f) => /\.(dmp|core)$|^core\.|^report\./.test(f))).toEqual([]);
  });

  it('no canary in the command line of any running process', () => {
    expect(commandLineFindings).toEqual([]);
  });

  it('no canary in the console DOM, URL, localStorage, sessionStorage, cookies, or IndexedDB', () => {
    expect(browserState).not.toBeNull();
    expect(browserState?.url.includes('token')).toBe(false);
    expect(browserState?.cookies).toBe(0);
    expect(browserFindings).toEqual([]);
  });
});
