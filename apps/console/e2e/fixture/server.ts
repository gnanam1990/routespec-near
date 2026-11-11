/**
 * Loopback contract-fixture server for console shell tests (SIMULATED; see data.ts).
 *
 * Serves the built console (dist/) with the strict CSP the real control API must send, and a
 * stateful in-memory implementation of the read/mutation shapes the console client uses. Every
 * fixture response is validated against the console's own response schemas before it is sent,
 * so a fixture drifting from the contract fails loudly. It is not the M08 control API.
 *
 * Usage: node e2e/fixture/server.ts   (env: FIXTURE_PORT, FIXTURE_CONTROL_TOKEN)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import {
  zCaseRun,
  zCaseRunPage,
  zCaseStart,
  zEventPage,
  zGateRun,
  zImportDetail,
  zImportPage,
  zImportRow,
  zMatrix,
  zPage,
  zProject,
  zRecoveryResult,
  zRunOperation,
  zSettings,
  type CaseRun,
  type GateRun,
  type ImportDetail,
} from '../../src/api/schemas.ts';
import {
  PROJECTS,
  at,
  buildMatrix,
  d,
  fixtureSettings,
  gateRun,
  identity,
  initialCases,
  initialImports,
  runOperation,
  sessionEvent,
  sessionEventCount,
} from './data.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const DIST = resolve(here, '../../dist');
const PORT = Number(process.env['FIXTURE_PORT'] ?? 4319);
const TOKEN = process.env['FIXTURE_CONTROL_TOKEN'] ?? randomBytes(24).toString('base64url');
const PREFIX = '/__routespec/v1';

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

interface State {
  cases: Record<string, CaseRun[]>;
  created: GateRun[];
  imports: ImportDetail[];
  idempotency: Map<string, { status: number; body: unknown }>;
  offline: boolean;
  delayMs: number;
  seq: number;
}

function freshState(): State {
  return {
    cases: initialCases(),
    created: [],
    imports: initialImports(),
    idempotency: new Map(),
    offline: false,
    delayMs: 0,
    seq: 0,
  };
}
let state = freshState();

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: { field: string; code: string; message: string }[];
  constructor(
    status: number,
    code: string,
    message: string,
    fields: { field: string; code: string; message: string }[] = [],
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
};

function securityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(DIST, rel);
  if (!file.startsWith(DIST + sep) && file !== DIST) file = join(DIST, 'index.html');
  try {
    const s = await stat(file);
    if (!s.isFile()) file = join(DIST, 'index.html');
  } catch {
    file = join(DIST, 'index.html'); // SPA fallback
  }
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  res.end(body);
}

function send<S extends z.ZodTypeAny>(
  res: ServerResponse,
  status: number,
  schema: S,
  body: z.infer<S>,
): void {
  const checked = schema.safeParse(body);
  if (!checked.success) {
    // The fixture drifted from the console contract: fail loudly rather than serve it.
    throw new HttpError(
      500,
      'RS_FIXTURE_CONTRACT_DRIFT',
      checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendRaw(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4 * 1024 * 1024)
      throw new HttpError(413, 'RS_RESOURCE_LIMIT', 'Request body exceeds the limit.');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'RS_VALIDATION_FAILED', 'Body must be a JSON object.');
  }
}

const encodeCursor = (offset: number) => Buffer.from(`o:${offset}`).toString('base64url');
function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const m = /^o:(\d+)$/.exec(raw);
  if (!m) throw new HttpError(400, 'RS_VALIDATION_FAILED', 'Invalid cursor.');
  return Number(m[1]);
}

function findCase(caseRunId: string): CaseRun {
  for (const list of Object.values(state.cases)) {
    const found = list.find((c) => c.caseRunId === caseRunId);
    if (found) return found;
  }
  throw new HttpError(404, 'RS_NOT_FOUND', 'No such case run.');
}

function replaceCase(next: CaseRun): void {
  const list = state.cases[next.gateRunId];
  if (!list) return;
  const i = list.findIndex((c) => c.caseRunId === next.caseRunId);
  if (i >= 0) list[i] = next;
}

function findGateRun(gateRunId: string): GateRun {
  const created = state.created.find((g) => g.gateRunId === gateRunId);
  if (created) return created;
  const base = gateRun(gateRunId);
  if (!base) throw new HttpError(404, 'RS_NOT_FOUND', 'No such gate run.');
  return base;
}

function checkRevision(req: IncomingMessage, current: number): void {
  const header = req.headers['if-match'];
  if (header === undefined) throw new HttpError(428, 'RS_REVISION_REQUIRED', 'If-Match is required.');
  if (header !== `"${current}"`)
    throw new HttpError(409, 'RS_REVISION_CONFLICT', `Gate run changed (revision ${current}).`);
}

function idempotent(
  req: IncomingMessage,
  res: ServerResponse,
  scope: string,
  run: () => { status: number; schema: z.ZodTypeAny; body: unknown },
): void {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8)
    throw new HttpError(400, 'RS_IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required.');
  const cacheKey = `${scope}|${key}`;
  const prior = state.idempotency.get(cacheKey);
  if (prior) {
    sendRaw(res, prior.status, prior.body);
    return;
  }
  const out = run();
  send(res, out.status, out.schema, out.body);
  state.idempotency.set(cacheKey, { status: out.status, body: out.body });
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const auth = req.headers['authorization'];
  if (auth === undefined) throw new HttpError(401, 'RS_UNAUTHENTICATED', 'A control token is required.');
  if (auth !== `Bearer ${TOKEN}`)
    throw new HttpError(401, 'RS_CONTROL_TOKEN_EXPIRED', 'The control token is expired or unknown.');
  if (req.method !== 'GET') {
    const origin = req.headers['origin'];
    if (origin !== undefined && origin !== `http://127.0.0.1:${PORT}`)
      throw new HttpError(403, 'RS_ORIGIN_DENIED', 'Origin not allowed.');
  }
  const path = url.pathname.slice(PREFIX.length);
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const method = req.method ?? 'GET';
  const [a, b, c] = parts;

  if (method === 'GET' && a === 'projects' && parts.length === 1) {
    return send(res, 200, zPage(zProject), { items: PROJECTS, nextCursor: null, total: PROJECTS.length });
  }
  if (method === 'GET' && a === 'projects' && c === 'matrix' && b) {
    if (b === 'proj-broken') {
      // Deliberately invalid: NOT_VISIBLE is an evidence reason, never a verdict.
      const m = buildMatrix('proj-alpha', []);
      return sendRaw(res, 200, {
        ...m,
        projectId: 'proj-broken',
        rows: m.rows.slice(0, 1).map((r) => ({ ...r, verdict: 'NOT_VISIBLE' })),
      });
    }
    if (!['proj-alpha', 'proj-empty', 'proj-legacy'].includes(b))
      throw new HttpError(404, 'RS_NOT_FOUND', 'No such project.');
    return send(res, 200, zMatrix, buildMatrix(b, state.created));
  }
  if (method === 'GET' && a === 'projects' && c === 'imports' && b) {
    if (b === 'proj-legacy') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    const items =
      b === 'proj-alpha'
        ? state.imports.map(
            ({ lineage: _l, sourceEvents: _s, proposedEvents: _p, replayOnlyPass: _r, ...row }) => row,
          )
        : [];
    return send(res, 200, zImportPage, { items, nextCursor: null, total: items.length });
  }
  if (method === 'GET' && a === 'imports' && b && parts.length === 2) {
    const imp = state.imports.find((i) => i.importId === b);
    if (!imp) throw new HttpError(404, 'RS_NOT_FOUND', 'No such import.');
    return send(res, 200, zImportDetail, imp);
  }
  if (method === 'GET' && a === 'settings')
    return send(res, 200, zSettings, { ...fixtureSettings(), port: PORT });
  if (method === 'GET' && a === 'gate-runs' && b && parts.length === 2)
    return send(res, 200, zGateRun, findGateRun(b));
  if (method === 'GET' && a === 'gate-runs' && b && c === 'cases') {
    findGateRun(b);
    const all = state.cases[b] ?? [];
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 200);
    const offset = decodeCursor(url.searchParams.get('cursor'));
    const items = all.slice(offset, offset + limit);
    return send(res, 200, zCaseRunPage, {
      items,
      nextCursor: offset + limit < all.length ? encodeCursor(offset + limit) : null,
      total: all.length,
    });
  }
  if (method === 'GET' && a === 'run-operations' && b) {
    const op = runOperation(b);
    if (!op) throw new HttpError(404, 'RS_NOT_FOUND', 'No such run operation.');
    return send(res, 200, zRunOperation, op);
  }
  if (method === 'GET' && a === 'sessions' && b && c === 'events') {
    const total = sessionEventCount(b);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100), 1), 200);
    const offset = decodeCursor(url.searchParams.get('cursor'));
    const kind = url.searchParams.get('kind');
    const KINDS = [
      'CLIENT_REQUEST',
      'PROXY_RESPONSE',
      'PHASE_BINDING',
      'PROVIDER_OBSERVATION',
      'SUBJECT_REPORT',
      'BOUNDARY_OBSERVATION',
      'EVIDENCE',
      'INVARIANT',
    ];
    let sequences: (i: number) => number;
    let matching: number;
    if (kind) {
      const k = KINDS.indexOf(kind);
      if (k < 0) {
        matching = 0;
        sequences = (i) => i;
      } else {
        matching = Math.floor((total - (k + 1)) / KINDS.length) + 1;
        sequences = (i) => k + 1 + i * KINDS.length;
      }
    } else {
      matching = total;
      sequences = (i) => i + 1;
    }
    const items = [];
    for (let i = offset; i < Math.min(offset + limit, matching); i++)
      items.push(sessionEvent(b, sequences(i)));
    return send(res, 200, zEventPage, {
      items,
      nextCursor: offset + limit < matching ? encodeCursor(offset + limit) : null,
      total: matching,
    });
  }

  // ------------------------------------------------------------------ mutations
  if (method === 'POST' && a === 'gate-runs' && parts.length === 1) {
    const body = await readJson(req);
    return idempotent(req, res, 'gate-runs', () => {
      const fields: { field: string; code: string; message: string }[] = [];
      if (body['revisionId'] === 'rev-unknown')
        fields.push({
          field: 'revisionId',
          code: 'RS_UNKNOWN_REVISION',
          message: 'Integration revision rev-unknown is not registered in this project.',
        });
      for (const f of [
        'artifactDigest',
        'effectManifestDigest',
        'effectCoveragePolicyDigest',
        'configurationDigest',
      ]) {
        if (typeof body[f] !== 'string' || !DIGEST.test(body[f] as string))
          fields.push({ field: f, code: 'RS_DIGEST_FORMAT', message: `${f} must be a sha256 digest.` });
      }
      if (body['mode'] === 'LIVE_DRY_PROBE')
        fields.push({
          field: 'mode',
          code: 'RS_MODE_POLICY_DENIED',
          message: 'LIVE_DRY_PROBE is not a gate-run mode.',
        });
      if (fields.length > 0)
        throw new HttpError(422, 'RS_VALIDATION_FAILED', 'The gate run request is invalid.', fields);
      state.seq += 1;
      const id = `gr-new-${state.seq}`;
      const g: GateRun = {
        lifecycle: 'DRAFT',
        verdict: 'NOT_RUN',
        verdictReason: null,
        evidence: { class: 'UNKNOWN', scope: null, reasons: ['MISSING'] },
        attestation: {
          class: 'USER_ASSERTED_LOCAL',
          attestationId: null,
          observedAt: null,
          freshness: 'NOT_APPLICABLE',
        },
        effectCoverage: {
          basis: 'INDEPENDENT_BOUNDARY_INTERCEPT',
          finding: 'NOT_EVALUATED',
          missing: [],
          interceptorProfileId: 'icp-01',
          interceptorFreshness: 'FRESH',
          processTreeScope: 'subject process tree',
        },
        artifactReady: null,
        enforcementMode: 'LOCAL_ADVISORY',
        officialCompatibility: { status: 'NOT_RUN', recordId: null, observedAt: null },
        evaluatedAt: null,
        evidenceObservedAt: null,
        gateRunId: id,
        projectId: String(body['projectId']),
        revisionId: String(body['revisionId']),
        mode: body['mode'] === 'REPLAY' ? 'REPLAY' : 'SIMULATE',
        identity: {
          ...identity('gr-fail', String(body['buildRevisionId'])),
          artifactDigest: String(body['artifactDigest']),
        },
        interceptorAttestation: null,
        parallelism: { declared: Number(body['parallelism']), running: 0, queued: 0 },
        counts: { total: 2, passed: 0, failed: 0, review: 0, unsupportedRequired: 0, notRun: 2 },
        findings: [],
        revision: 1,
      };
      state.created.push(g);
      state.cases[id] = [1, 2].map((n) => ({
        ...(initialCases()['gr-fail']?.[2] as CaseRun),
        caseRunId: `${id}-c${n}`,
        gateRunId: id,
        ordinal: n,
        scenarioName:
          n === 1 ? 'Accepted then response lost (promoted regression)' : 'Happy path quote and commit',
        lineageRole: n === 1 ? 'PROMOTED_REGRESSION' : 'BASELINE',
        lifecycle: 'PENDING',
        verdict: 'NOT_RUN',
        evidence: { class: 'UNKNOWN', scope: null, reasons: ['MISSING'] },
        clientState: 'NOT_STARTED',
        resetState: 'PENDING',
        token: { state: 'NOT_ISSUED', purpose: null, expiresAt: null },
        sessionId: null,
        runOperationIds: [],
      }));
      return { status: 201, schema: zGateRun, body: g };
    });
  }
  if (method === 'POST' && a === 'gate-runs' && b && (c === 'validate' || c === 'start')) {
    await readJson(req);
    const g = state.created.find((x) => x.gateRunId === b);
    if (!g)
      throw new HttpError(409, 'RS_LIFECYCLE_CONFLICT', 'Only a new gate run can be validated or started.');
    checkRevision(req, g.revision);
    return idempotent(req, res, `${b}/${c}`, () => {
      if (c === 'validate') {
        if (g.lifecycle !== 'DRAFT')
          throw new HttpError(409, 'RS_LIFECYCLE_CONFLICT', 'Gate run is not in DRAFT.');
        g.lifecycle = 'READY';
      } else {
        if (g.lifecycle !== 'READY')
          throw new HttpError(409, 'RS_LIFECYCLE_CONFLICT', 'Gate run is not READY.');
        g.lifecycle = 'RUNNING';
        g.parallelism = { ...g.parallelism, running: 0, queued: 0 };
        state.cases[b] = (state.cases[b] ?? []).map((x) => ({ ...x, lifecycle: 'READY' }));
      }
      g.revision += 1;
      return { status: 200, schema: zGateRun, body: g };
    });
  }
  if (method === 'POST' && a === 'case-runs' && b && c) {
    await readJson(req);
    const current = findCase(b);
    if (c === 'start') {
      if (current.token.state === 'ACTIVE')
        throw new HttpError(
          409,
          'RS_CONCURRENT_CLIENT',
          'Another client already holds this case. The original client keeps its lease.',
        );
      if (current.lifecycle !== 'READY')
        throw new HttpError(409, 'RS_LIFECYCLE_CONFLICT', 'Case is not READY.');
      return idempotent(req, res, `${b}/start`, () => {
        const sessionId = `s-${b}`;
        const expiresAt = at(7200);
        replaceCase({
          ...current,
          lifecycle: 'RUNNING',
          clientState: 'CONNECTED',
          token: { state: 'ACTIVE', purpose: 'EXECUTION', expiresAt },
          sessionId,
          runOperationIds: ['op-fail-1'],
        });
        return {
          status: 200,
          schema: zCaseStart,
          body: {
            caseRunId: b,
            sessionId,
            clientInstanceId: `client-${b}`,
            proxyBaseUrl: `http://127.0.0.1:${PORT + 1}`,
            fencingEpoch: current.fencingEpoch,
            headers: {
              session: sessionId,
              caseRun: b,
              logicalJob: current.logicalJobLabel,
              adapter: 'one-click-sdk-adapter@0.1.26+1',
              fencingEpoch: String(current.fencingEpoch),
            },
            token: { value: randomBytes(24).toString('base64url'), purpose: 'EXECUTION', expiresAt },
          },
        };
      });
    }
    if (c === 'abort') {
      if (current.lifecycle !== 'RUNNING')
        throw new HttpError(409, 'RS_LIFECYCLE_CONFLICT', 'Case is not running.');
      return idempotent(req, res, `${b}/abort`, () => {
        const next: CaseRun = {
          ...current,
          lifecycle: 'ABORTED',
          verdict: 'NOT_RUN',
          evidence: { class: 'UNKNOWN', scope: null, reasons: ['MISSING'] },
          token: { state: 'REVOKED', purpose: current.token.purpose, expiresAt: null },
          clientState: 'TORN_DOWN',
        };
        replaceCase(next);
        return { status: 200, schema: zCaseRun, body: next };
      });
    }
    if (c === 'recover') {
      return idempotent(req, res, `${b}/recover`, () => {
        if (current.recovery?.available !== true)
          throw new HttpError(409, 'RS_RECOVERY_NOT_REQUIRED', 'This case does not need recovery.');
        const epoch = current.fencingEpoch + 1;
        const expiresAt = at(7200);
        replaceCase({
          ...current,
          lifecycle: 'RUNNING',
          recovery: null,
          fencingEpoch: epoch,
          token: { state: 'ACTIVE', purpose: 'RECONCILIATION_ONLY', expiresAt },
        });
        return {
          status: 200,
          schema: zRecoveryResult,
          body: {
            caseRunId: b,
            previousEpoch: current.fencingEpoch,
            fencingEpoch: epoch,
            revokedTokenPurpose: 'EXECUTION',
            lifecycle: 'RUNNING',
            token: {
              value: randomBytes(24).toString('base64url'),
              purpose: 'RECONCILIATION_ONLY',
              expiresAt,
            },
          },
        };
      });
    }
    if (c === 'captures') {
      if (current.lifecycle !== 'COMPLETED')
        throw new HttpError(409, 'RS_LIFECYCLE_CONFLICT', 'Only a completed case can be captured.');
      return idempotent(req, res, `${b}/capture`, () => {
        state.seq += 1;
        const imp: ImportDetail = {
          ...(initialImports()[1] as ImportDetail),
          importId: `imp-cap-${state.seq}`,
          sanitizedName: `capture-${b}`,
          digest: d(`cap-${state.seq}`),
          state: 'QUARANTINED',
          source: {
            buildRevisionId: 'build-rev-140',
            gateRunId: current.gateRunId,
            caseRunId: b,
            sessionId: current.sessionId ?? 's-none',
          },
        };
        state.imports.unshift(imp);
        const { lineage: _l, sourceEvents: _s, proposedEvents: _p, replayOnlyPass: _r, ...row } = imp;
        return { status: 201, schema: zImportRow, body: row };
      });
    }
  }
  if (method === 'POST' && a === 'imports' && parts.length === 1) {
    const body = await readJson(req);
    return idempotent(req, res, 'imports', () => {
      const content = typeof body['content'] === 'string' ? body['content'] : '';
      const fileName = typeof body['fileName'] === 'string' ? body['fileName'] : '';
      if (content.includes('ROUTESPEC_TEST_SECRET_MARKER')) {
        throw new HttpError(422, 'RS_VALIDATION_FAILED', 'The import was blocked by the secret scan.', [
          {
            field: 'traceFile',
            code: 'RS_SECRET_DETECTED',
            message:
              'The trace contains a secret-shaped value at line 2. Only its digest and finding class were kept.',
          },
        ]);
      }
      state.seq += 1;
      const imp: ImportDetail = {
        ...(initialImports()[1] as ImportDetail),
        importId: `imp-file-${state.seq}`,
        origin: 'USER_FILE',
        source: null,
        sanitizedName: fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80),
        digest: d(content),
        sizeBytes: Buffer.byteLength(content),
        state: 'QUARANTINED',
      };
      state.imports.unshift(imp);
      const { lineage: _l, sourceEvents: _s, proposedEvents: _p, replayOnlyPass: _r, ...row } = imp;
      return { status: 201, schema: zImportRow, body: row };
    });
  }
  if (method === 'POST' && a === 'imports' && b && (c === 'verify-replay' || c === 'promote')) {
    const body = await readJson(req);
    const imp = state.imports.find((i) => i.importId === b);
    if (!imp) throw new HttpError(404, 'RS_NOT_FOUND', 'No such import.');
    return idempotent(req, res, `${b}/${c}`, () => {
      if (c === 'verify-replay') {
        if (imp.state !== 'MAPPED')
          throw new HttpError(409, 'RS_LIFECYCLE_CONFLICT', 'Only a mapped import can be replay-verified.');
        imp.state = 'REVIEWED';
        imp.promotable = true;
        imp.blockers = [];
        imp.lineage = imp.lineage.map((n) =>
          n.stage === 'REPLAY_VERIFICATION' || n.stage === 'REVIEW'
            ? { ...n, state: 'DONE', digest: d(n.stage) }
            : n,
        );
      } else {
        if (!imp.promotable)
          throw new HttpError(409, 'RS_PROMOTION_BLOCKED', 'This import is not promotable.');
        if (typeof body['reviewNote'] !== 'string' || body['reviewNote'].length === 0) {
          throw new HttpError(422, 'RS_VALIDATION_FAILED', 'A review note is required.', [
            { field: 'reviewNote', code: 'REQUIRED', message: 'Enter a review note.' },
          ]);
        }
        imp.state = 'PROMOTED';
        imp.promotable = false;
        imp.replayOnlyPass = true;
        imp.lineage = imp.lineage.map((n) =>
          n.stage === 'PROMOTED_SCENARIO' || n.stage === 'NEW_CORPUS'
            ? { ...n, state: 'DONE', digest: d(n.stage), recordId: `${n.stage.toLowerCase()}-new` }
            : n,
        );
      }
      return { status: 200, schema: zImportDetail, body: imp };
    });
  }
  throw new HttpError(404, 'RS_NOT_FOUND', `No such route: ${method} ${path}`);
}

const server = createServer((req, res) => {
  void (async () => {
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) {
      res.writeHead(421, { 'Content-Type': 'text/plain' });
      res.end('Misdirected request');
      return;
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    securityHeaders(res);
    try {
      if (url.pathname === '/__fixture/reset' && req.method === 'POST') {
        state = freshState();
        res.writeHead(204).end();
        return;
      }
      if (url.pathname === '/__fixture/mode' && req.method === 'POST') {
        const body = await readJson(req);
        state.offline = body['offline'] === true;
        state.delayMs = typeof body['delayMs'] === 'number' ? Math.min(body['delayMs'], 30_000) : 0;
        res.writeHead(204).end();
        return;
      }
      if (url.pathname.startsWith(PREFIX + '/') || url.pathname === PREFIX) {
        if (state.offline) {
          req.socket.destroy();
          return;
        }
        if (state.delayMs > 0) await new Promise((r) => setTimeout(r, state.delayMs));
        await api(req, res, url);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD')
        throw new HttpError(405, 'RS_METHOD_NOT_ALLOWED', 'Method not allowed.');
      await serveStatic(url.pathname, res);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const e =
        error instanceof HttpError ? error : new HttpError(500, 'RS_INTERNAL', 'Internal fixture error.');
      sendRaw(res, e.status, {
        error: {
          code: e.code,
          message: e.message,
          requestId: randomBytes(8).toString('hex'),
          recoverable: e.status < 500,
          ...(e.fields.length > 0 ? { details: { fields: e.fields } } : {}),
        },
      });
    }
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  const bound = typeof addr === 'object' && addr ? `${addr.address}:${addr.port}` : String(addr);
  // The token is never printed; tests receive it through the environment.
  console.log(`console fixture listening on http://${bound} (contract fixture, simulated data)`);
});
