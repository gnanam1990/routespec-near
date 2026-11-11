/**
 * Control API route handlers (API-SPEC section 4).
 *
 * Every handler receives a body already validated by its strict schema. Handlers enforce
 * project scoping (a record from another project is `RS_NOT_FOUND`), never accept caller-
 * supplied verdicts, attestation classes, coverage completeness, or repository protection, and
 * return one-time secrets (case/recovery token values, CI challenge nonces) only in the live
 * response: the idempotency record keeps a redacted copy, so a replay never re-delivers them.
 */
import {
  ADAPTER_HEADERS,
  ADAPTER_REVISION,
  CLIENT_INSTANCE_DIGEST_DOMAIN,
  ONECLICK_PROFILE,
  ONECLICK_SDK_PIN,
  RouteSpecError,
  digestValue,
  type CaseLineageRole,
} from '@routespec/contracts';
import { EVALUATOR_REVISION } from '@routespec/kernel';
import type { LaunchCredentials } from '@routespec/proxy';
import {
  captureInstalledCase,
  importUserFile,
  promoteImport,
  proposeMapping,
  regressionLineage,
  reviewImport,
  saveImportMapping,
  verifyReplay,
  validateMapping,
  type TraceDocument,
} from '@routespec/regressions';
import { planExport, writeExport, type GateService } from '@routespec/runner';
import { compileScenario } from '@routespec/scenario';
import type { CaseAuth, ControlJournal, GateJournal, ImportJournal, RouteSpecStore } from '@routespec/store';
import type { ZodTypeAny } from 'zod';
import { AttesterChannel, verifyOidcCompletion } from './attestation.ts';
import { CursorCodec, parseLimit, type CursorPosition } from './cursor.ts';
import { importDetailView, runOperationView } from './detail-views.ts';
import * as S from './schemas.ts';
import {
  buildView,
  caseRunView,
  eventView,
  gateRunRevision,
  gateRunView,
  iso,
  projectView,
  revisionView,
  sessionView,
  type ViewDeps,
} from './views.ts';

type Row = Record<string, unknown>;

export interface RouteCtx {
  readonly params: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly query: URLSearchParams;
  readonly ifMatch: number | null;
  readonly idempotencyKey: string | null;
  readonly caseAuth: CaseAuth | null;
}

export interface RouteResult {
  readonly status: number;
  readonly body: unknown;
  /** Redacted copy kept in the idempotency record (one-time secrets removed). */
  readonly record?: unknown;
}

export interface RouteDef {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly auth: 'control' | 'case';
  /** Requires Idempotency-Key and is replay-safe. */
  readonly mutation: boolean;
  readonly ifMatch?: boolean;
  readonly schema?: ZodTypeAny;
  readonly maxBody?: number;
  /**
   * `pipeline`: the body is untrusted content that the import pipeline itself scans and
   * quarantines (a secret becomes a recorded finding, not a refused request). Default: the
   * service refuses any body carrying a configured secret or a RouteSpec credential.
   */
  readonly secretScan?: 'boundary' | 'pipeline';
  readonly handle: (ctx: RouteCtx) => RouteResult | Promise<RouteResult>;
}

export interface LocalConfirmationNotice {
  readonly confirmationId: string;
  readonly actionCode: string;
  readonly planDigest: string;
  readonly code: string;
  readonly expiresAt: string;
  readonly summary: string;
}

export interface AppDeps extends ViewDeps {
  readonly gates: GateJournal;
  readonly imports: ImportJournal;
  readonly service: GateService;
  readonly cursors: CursorCodec;
  readonly bind: { readonly host: string; readonly port: () => number };
  readonly launchers: Map<string, AttesterChannel>;
  readonly pendingCredentials: Map<string, LaunchCredentials>;
  readonly onLocalConfirmation: (notice: LocalConfirmationNotice) => void;
  readonly confirmationTtlMs: number;
  readonly challengeTtlMs: number;
  /** Local service metrics (M11): coded counters and process resource gauges only. */
  readonly metrics: () => Record<string, unknown>;
  /** Configured secret values (memory only) for import scans and export plans. */
  readonly configuredSecrets: readonly string[];
}

const ok = (body: unknown, status = 200, record?: unknown): RouteResult =>
  record === undefined ? { status, body } : { status, body, record };

function notFound(what: string): never {
  throw new RouteSpecError('RS_NOT_FOUND', `${what} not found.`);
}

function s(row: Row, key: string): string {
  return String(row[key]);
}

/**
 * Lineage roles come from persisted promotions, never from the caller: a gate run on a corpus
 * produced by an import promotion runs its promoted scenario as PROMOTED_REGRESSION and the
 * inherited cases as CORRECTED; every other gate run is BASELINE. A gate run of the very build
 * whose capture was promoted is the original revision re-run, so its inherited cases stay
 * BASELINE (the promoted scenario is still PROMOTED_REGRESSION; regression status ignores runs
 * of the captured build either way).
 */
function promotionLineageRoles(
  store: RouteSpecStore,
  corpusRevisionId: string,
  buildRevisionId: string,
): { lineageRole: CaseLineageRole; lineageRoleByScenario?: Record<string, CaseLineageRole> } {
  const promotions = store.journal.read(
    (db) =>
      db
        .prepare(
          `SELECT p.scenario_revision_id, b.build_revision_id AS captured_build
             FROM import_promotions p
             LEFT JOIN import_capture_bindings b ON b.import_id = p.import_id
            WHERE p.corpus_revision_id = ?`,
        )
        .all(corpusRevisionId) as Row[],
  );
  if (promotions.length === 0) return { lineageRole: 'BASELINE' };
  const rerunOfCapturedBuild = promotions.some((p) => p['captured_build'] === buildRevisionId);
  return {
    lineageRole: rerunOfCapturedBuild ? 'BASELINE' : 'CORRECTED',
    lineageRoleByScenario: Object.fromEntries(
      promotions.map((p) => [String(p['scenario_revision_id']), 'PROMOTED_REGRESSION' as CaseLineageRole]),
    ),
  };
}

function strictQuery(query: URLSearchParams, allowed: readonly string[]): void {
  for (const k of new Set(query.keys())) {
    if (!allowed.includes(k)) {
      throw new RouteSpecError('RS_SCHEMA_INVALID', 'Unknown query parameter.', {
        details: { parameter: k.slice(0, 64) },
      });
    }
    if (query.getAll(k).length > 1) {
      throw new RouteSpecError('RS_SCHEMA_INVALID', 'Query parameters must appear once.', {
        details: { parameter: k.slice(0, 64) },
      });
    }
  }
}

/** Keyset page over an append-only journal table (rowid order = commit order). */
function keyPage(
  d: AppDeps,
  list: string,
  query: URLSearchParams,
  fetch: (afterRowid: number, limit: number) => Row[],
  view: (r: Row) => unknown,
  total: number,
): Record<string, unknown> {
  strictQuery(query, ['cursor', 'limit']);
  const limit = parseLimit(query.get('limit'));
  const cursor = query.get('cursor');
  const pos: CursorPosition | null = cursor === null ? null : d.cursors.decode(cursor, list, {});
  if (pos !== null && pos.kind !== 'seq')
    throw new RouteSpecError('RS_CURSOR_INVALID', 'The pagination cursor is invalid.');
  const items = fetch(pos === null ? 0 : pos.seq, limit);
  const last = items[items.length - 1];
  return {
    items: items.map(view),
    nextCursor:
      items.length === limit && last
        ? d.cursors.encode(list, {}, { kind: 'seq', seq: Number(last['_rowid']) })
        : null,
    total,
  };
}

export function buildRoutes(d: AppDeps): RouteDef[] {
  const { store, control, gates, service } = d;
  const lineageRolesFor = (corpusRevisionId: string, buildRevisionId: string) =>
    promotionLineageRoles(store, corpusRevisionId, buildRevisionId);

  const mustProject = (projectId: string): Row => {
    const p = control.getProject(projectId);
    if (!p || p['deleted_at_ms'] !== null) notFound('Project');
    return p;
  };
  const mustScoped = (
    projectId: string,
    kind: Parameters<ControlJournal['inProject']>[1],
    id: string,
    what: string,
  ) => {
    if (!control.inProject(projectId, kind, id)) notFound(what);
  };
  const mustBuild = (projectId: string, buildRevisionId: string): Row => {
    const b = control.getBuild(buildRevisionId);
    if (!b || b['project_id'] !== projectId) notFound('Build revision');
    return b;
  };
  const mustGateRun = (gateRunId: string): Row => {
    const g = store.getGateRun(gateRunId);
    if (!g) notFound('Gate run');
    mustProject(s(g, 'project_id'));
    return g;
  };
  const mustCase = (caseRunId: string): { c: Row; g: Row } => {
    const c = store.getCaseRun(caseRunId);
    if (!c) notFound('Case run');
    return { c, g: mustGateRun(s(c, 'gate_run_id')) };
  };
  const confirmFlow = (
    actionCode: string,
    planDigest: string,
    summary: string,
    confirmation: { confirmationId: string; code: string } | undefined,
  ): { confirmationId: string; code: string; planDigest: string } | RouteResult => {
    if (confirmation !== undefined) return { ...confirmation, planDigest };
    const issued = control.issueConfirmation({ actionCode, planDigest, ttlMs: d.confirmationTtlMs });
    d.onLocalConfirmation({
      confirmationId: issued.confirmationId,
      actionCode,
      planDigest,
      code: issued.code,
      expiresAt: iso(issued.expiresAtMs) as string,
      summary,
    });
    return ok(
      {
        status: 'LOCAL_CONFIRMATION_REQUIRED',
        actionCode,
        confirmationId: issued.confirmationId,
        planDigest,
        expiresAt: iso(issued.expiresAtMs),
        delivery: 'LOCAL_OPERATOR_CHANNEL',
      },
      202,
    );
  };
  const attestationUsable = (
    attestationId: string,
    scope: string,
    projectId: string,
    buildRevisionId: string | null,
  ): Row => {
    const a = control.getAttestation(attestationId);
    if (!a || a['project_id'] !== projectId) notFound('Attestation');
    if (a['scope'] !== scope)
      throw new RouteSpecError('RS_IDENTITY_MISMATCH', 'The attestation has a different scope.');
    if (buildRevisionId !== null && a['build_revision_id'] !== buildRevisionId) {
      throw new RouteSpecError('RS_IDENTITY_MISMATCH', 'The attestation binds a different build.');
    }
    if (
      a['principal_enabled'] !== 1 ||
      a['principal_current_revocation_epoch'] !== a['principal_revocation_epoch'] ||
      a['principal_current_policy_digest'] !== a['principal_policy_digest']
    ) {
      throw new RouteSpecError('RS_ATTESTER_UNAVAILABLE', 'The attesting principal was revoked or changed.');
    }
    if (Number(a['expires_at_ms']) <= d.nowMs()) {
      throw new RouteSpecError('RS_ATTESTER_UNAVAILABLE', 'The attestation is stale.');
    }
    return a;
  };
  const tokenOut = (c: LaunchCredentials) => ({
    value: c.token,
    purpose: c.purpose,
    expiresAt: iso(d.nowMs() + service.tokenTtlMs),
  });
  /** The replayable record: the one-time token value is never kept, only its delivery. */
  const redactToken = (body: Record<string, unknown>) => {
    const { token, ...rest } = body;
    const t = token as { purpose: string; expiresAt: string | null };
    return {
      ...rest,
      tokenDelivery: { purpose: t.purpose, expiresAt: t.expiresAt, value: 'DELIVERED_ONCE_NOT_REPLAYED' },
    };
  };

  const routes: RouteDef[] = [
    // -----------------------------------------------------------------------------------------
    // Settings and profile discovery.
    {
      method: 'GET',
      path: '/metrics',
      auth: 'control',
      mutation: false,
      handle: () => ok(d.metrics()),
    },
    {
      method: 'GET',
      path: '/settings',
      auth: 'control',
      mutation: false,
      handle: () =>
        ok({
          bindAddress: d.bind.host,
          port: d.bind.port(),
          modes: [
            { mode: 'SIMULATE', supported: true, runtime: 'NETWORKLESS_SCENARIO' },
            { mode: 'REPLAY', supported: true, runtime: 'NETWORKLESS_SCENARIO' },
            { mode: 'LIVE_DRY_PROBE', supported: true, runtime: 'LIVE_DRY_ADAPTER' },
            { mode: 'COMMITTED_LIVE', supported: false, runtime: 'NONE' },
          ],
          providerTokenState: 'NOT_REQUIRED',
          upstreamOrigin: null,
          allowlistedRoutes: ['POST /v0/quote (dry: true only, separate live-dry adapter)'],
          retention: { days: 30, storageBytes: 0 },
          exportPolicy:
            'Redacted bundles only; plan, privacy scan, and explicit local confirmation before any write.',
          versions: {
            app: d.appRevision,
            protocolProfile: ONECLICK_PROFILE.profileId,
            evaluator: EVALUATOR_REVISION,
            sdk: `${ONECLICK_SDK_PIN.packageName}@${ONECLICK_SDK_PIN.version}`,
          },
          compatibilityRecords: [],
          dryProbe: { authorized: false, expiresAt: null },
        }),
    },
    {
      method: 'GET',
      path: '/protocol-profiles/:profileId',
      auth: 'control',
      mutation: false,
      handle: ({ params }) => {
        if (params['profileId'] !== ONECLICK_PROFILE.profileId) notFound('Protocol profile');
        return ok({
          profile: ONECLICK_PROFILE,
          liveDryAllowlist: ['POST /v0/quote with dry: true'],
          compatibilityLimits: [
            'Committed live quotes, deposit submission, and status lookups are not supported live.',
          ],
        });
      },
    },

    // -----------------------------------------------------------------------------------------
    // Projects, revisions, builds.
    {
      method: 'POST',
      path: '/projects',
      auth: 'control',
      mutation: true,
      schema: S.projectCreate,
      handle: ({ body, idempotencyKey }) => {
        const b = body as { name: string; description?: string | null };
        const { projectId } = store.createProject({
          name: b.name,
          description: b.description ?? null,
          idempotencyKey: idempotencyKey as string,
        });
        return ok(projectView(mustProject(projectId)), 201);
      },
    },
    {
      method: 'GET',
      path: '/projects',
      auth: 'control',
      mutation: false,
      handle: ({ query }) =>
        ok(
          keyPage(
            d,
            'projects',
            query,
            (a, limit) => control.listProjects(a, limit),
            projectView,
            control.countRows('SELECT count(*) AS n FROM projects WHERE deleted_at_ms IS NULL'),
          ),
        ),
    },
    {
      method: 'GET',
      path: '/projects/:projectId',
      auth: 'control',
      mutation: false,
      handle: ({ params }) => ok(projectView(mustProject(params['projectId'] as string))),
    },
    {
      method: 'PATCH',
      path: '/projects/:projectId',
      auth: 'control',
      mutation: true,
      ifMatch: true,
      schema: S.projectPatch,
      handle: ({ params, body, ifMatch, idempotencyKey }) => {
        const projectId = params['projectId'] as string;
        mustProject(projectId);
        const patch = body as { name?: string; description?: string | null };
        store.updateProject({
          projectId,
          expectedRevision: ifMatch as number,
          patch: {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
          },
          idempotencyKey: idempotencyKey as string,
        });
        return ok(projectView(mustProject(projectId)));
      },
    },
    {
      // M11 safe deletion: retention purge of quarantine content. Without `confirmDigest` this
      // is a dry run that changes nothing; with it, exactly the confirmed plan is purged.
      method: 'POST',
      path: '/projects/:projectId/retention-purge',
      auth: 'control',
      mutation: true,
      schema: S.retentionPurge,
      handle: ({ params, body }) => {
        const projectId = params['projectId'] as string;
        const row = store.journal.read((db) =>
          db.prepare('SELECT project_id FROM projects WHERE project_id = ?').get(projectId),
        );
        if (!row) notFound('Project');
        const confirmDigest = (body as { confirmDigest?: string }).confirmDigest;
        const physicalErasure =
          'Content is cleared with SQLite secure deletion and the WAL is checkpointed; physical media erasure is not guaranteed (file system, SSD, snapshots, and backups are outside RouteSpec).';
        if (confirmDigest === undefined) {
          const plan = d.imports.planRetentionPurge(projectId);
          return ok({ dryRun: true, purged: 0, ...plan, physicalErasure });
        }
        const done = d.imports.executeRetentionPurge(projectId, confirmDigest);
        return ok({ dryRun: false, ...done, physicalErasure });
      },
    },
    {
      method: 'DELETE',
      path: '/projects/:projectId',
      auth: 'control',
      mutation: true,
      ifMatch: true,
      schema: S.projectDelete,
      handle: ({ params, body, ifMatch }) => {
        const projectId = params['projectId'] as string;
        const p = mustProject(projectId);
        if (Number(p['revision']) !== ifMatch) {
          throw new RouteSpecError(
            'RS_REVISION_CONFLICT',
            'Project revision does not match the expected revision.',
          );
        }
        const affected = control.deletionPlan(projectId);
        const planDigest = digestValue('routespec.project-deletion-plan/1', {
          projectId,
          revision: ifMatch,
          affected,
        });
        const confirmDigest = (body as { confirmDigest?: string }).confirmDigest;
        if (confirmDigest === undefined) {
          return ok({
            dryRun: true,
            deleted: false,
            projectId,
            planDigest,
            affected,
            repositoriesAffected: false,
            upstreamAffected: false,
          });
        }
        if (confirmDigest !== planDigest) {
          throw new RouteSpecError(
            'RS_DELETION_PLAN_MISMATCH',
            'The confirmation does not match the current deletion plan.',
          );
        }
        store.journal.transact('project.delete', (db) => {
          const changed = Number(
            db
              .prepare(
                'UPDATE projects SET deleted_at_ms = ?, revision = revision + 1 WHERE project_id = ? AND revision = ? AND deleted_at_ms IS NULL',
              )
              .run(d.nowMs(), projectId, ifMatch).changes,
          );
          if (changed !== 1)
            throw new RouteSpecError('RS_REVISION_CONFLICT', 'Project changed concurrently.');
        });
        control.audit('PROJECT_DELETED', 'project', projectId, { planDigest, purge: 'RETENTION_PENDING' });
        return ok({
          dryRun: false,
          deleted: true,
          projectId,
          planDigest,
          affected,
          physicalPurge: 'PENDING_RETENTION_SCHEDULER',
          repositoriesAffected: false,
          upstreamAffected: false,
        });
      },
    },
    {
      method: 'POST',
      path: '/projects/:projectId/revisions',
      auth: 'control',
      mutation: true,
      schema: S.revisionCreate,
      handle: ({ params, body }) => {
        const projectId = params['projectId'] as string;
        mustProject(projectId);
        const b = body as {
          revisionLabel: string;
          commitSha: string | null;
          configurationDigest: string;
          protocolProfileId: string;
          metadata: Record<string, string | number | boolean>;
        };
        if (b.protocolProfileId !== ONECLICK_PROFILE.profileId) notFound('Protocol profile');
        store.registerProtocolProfile();
        const { integrationRevisionId } = store.createIntegrationRevision({ projectId, ...b });
        return ok(revisionView(control.getRevision(integrationRevisionId) as Row), 201);
      },
    },
    {
      method: 'GET',
      path: '/projects/:projectId/revisions',
      auth: 'control',
      mutation: false,
      handle: ({ params, query }) => {
        const projectId = params['projectId'] as string;
        mustProject(projectId);
        return ok(
          keyPage(
            d,
            `revisions:${projectId}`,
            query,
            (a, limit) => control.listRevisions(projectId, a, limit),
            (r) => ({
              ...revisionView(r),
              gateRunCount: control.countRows(
                'SELECT count(*) AS n FROM gate_runs WHERE integration_revision_id = ?',
                s(r, 'integration_revision_id'),
              ),
            }),
            control.countRows(
              'SELECT count(*) AS n FROM integration_revisions WHERE project_id = ?',
              projectId,
            ),
          ),
        );
      },
    },
    {
      method: 'POST',
      path: '/projects/:projectId/builds',
      auth: 'control',
      mutation: true,
      schema: S.buildCreate,
      handle: ({ params, body }) => {
        const projectId = params['projectId'] as string;
        mustProject(projectId);
        const b = body as Omit<Parameters<RouteSpecStore['registerBuild']>[0], 'projectId'>;
        const rev = control.getRevision(b.integrationRevisionId);
        if (!rev || rev['project_id'] !== projectId) notFound('Integration revision');
        const { buildRevisionId } = store.registerBuild({ projectId, ...b });
        return ok(buildView(control.getBuild(buildRevisionId) as Row), 201);
      },
    },
    {
      method: 'GET',
      path: '/projects/:projectId/builds',
      auth: 'control',
      mutation: false,
      handle: ({ params, query }) => {
        const projectId = params['projectId'] as string;
        mustProject(projectId);
        return ok(
          keyPage(
            d,
            `builds:${projectId}`,
            query,
            (a, limit) => control.listBuilds(projectId, a, limit),
            buildView,
            control.countRows('SELECT count(*) AS n FROM build_revisions WHERE project_id = ?', projectId),
          ),
        );
      },
    },
    {
      method: 'GET',
      path: '/projects/:projectId/matrix',
      auth: 'control',
      mutation: false,
      handle: ({ params, query }) => {
        const projectId = params['projectId'] as string;
        const project = mustProject(projectId);
        const page = keyPage(
          d,
          `matrix:${projectId}`,
          query,
          (a, limit) => control.listGateRuns(projectId, a, limit),
          (g) => {
            const v = gateRunView(d, g);
            const rev = control.getRevision(s(g, 'integration_revision_id'));
            const identity = v['identity'] as Record<string, unknown>;
            return {
              lifecycle: v['lifecycle'],
              verdict: v['verdict'],
              verdictReason: v['verdictReason'],
              evidence: v['evidence'],
              attestation: v['attestation'],
              effectCoverage: v['effectCoverage'],
              artifactReady: v['artifactReady'],
              enforcementMode: v['enforcementMode'],
              officialCompatibility: v['officialCompatibility'],
              evaluatedAt: v['evaluatedAt'],
              evidenceObservedAt: v['evidenceObservedAt'],
              revisionId: s(g, 'integration_revision_id'),
              revisionLabel: rev ? s(rev, 'revision_label') : 'unknown',
              commitSha: identity['commitSha'],
              buildRevisionId: s(g, 'build_revision_id'),
              artifactDigest: s(g, 'artifact_digest'),
              corpusRevisionId: s(g, 'corpus_revision_id'),
              corpusDigest: identity['corpusDigest'],
              caseCount: (v['counts'] as { total: number }).total,
              gateRunId: s(g, 'gate_run_id'),
              counts: v['counts'],
            };
          },
          control.countRows('SELECT count(*) AS n FROM gate_runs WHERE project_id = ?', projectId),
        );
        return ok({
          projectId,
          projectName: s(project, 'name'),
          rows: page['items'],
          nextCursor: page['nextCursor'],
        });
      },
    },

    // -----------------------------------------------------------------------------------------
    // Effect manifests, interceptor profiles, coverage policies, call-site inventories.
    {
      method: 'POST',
      path: '/effect-manifests',
      auth: 'control',
      mutation: true,
      schema: S.manifestCreate,
      handle: ({ body }) => {
        const b = body as { projectId: string } & Parameters<RouteSpecStore['createEffectManifest']>[0];
        mustProject(b.projectId);
        const build = mustBuild(b.projectId, b.buildRevisionId);
        if (build['artifact_digest'] !== b.artifactDigest) {
          throw new RouteSpecError(
            'RS_IDENTITY_MISMATCH',
            'The artifact digest is not the registered build artifact.',
          );
        }
        const { projectId, ...input } = b;
        const r = store.createEffectManifest(input);
        control.scopeRecord(projectId, 'EFFECT_MANIFEST', r.manifestDigest);
        return ok({ ...r, declaration: 'SELF_REPORTED', provesCompleteness: false }, 201);
      },
    },
    {
      method: 'POST',
      path: '/interceptor-profiles',
      auth: 'control',
      mutation: true,
      schema: S.interceptorProfileCreate,
      handle: ({ body }) => {
        const b = body as Parameters<ControlJournal['registerInterceptorProfile']>[0];
        mustProject(b.projectId);
        const r = control.registerInterceptorProfile(b);
        return ok(
          { profileId: r.profileId, profileDigest: r.profileDigest, reviewState: 'DECLARED_UNREVIEWED' },
          201,
        );
      },
    },
    {
      method: 'POST',
      path: '/effect-coverage-policies',
      auth: 'control',
      mutation: true,
      schema: S.policyCreate,
      handle: ({ body }) => {
        const b = body as { projectId: string } & Parameters<RouteSpecStore['createEffectCoveragePolicy']>[0];
        mustProject(b.projectId);
        const build = mustBuild(b.projectId, b.buildRevisionId);
        if (build['artifact_digest'] !== b.artifactDigest) {
          throw new RouteSpecError(
            'RS_IDENTITY_MISMATCH',
            'The artifact digest is not the registered build artifact.',
          );
        }
        mustScoped(b.projectId, 'SCENARIO_REVISION', b.scenarioRevisionId, 'Scenario revision');
        mustScoped(b.projectId, 'EFFECT_MANIFEST', b.manifestDigest, 'Effect manifest');
        if (b.selectedAttestationId !== null) {
          attestationUsable(b.selectedAttestationId, 'BUILD_REGISTRATION', b.projectId, b.buildRevisionId);
        }
        if (b.interceptorProfileDigest !== null) {
          const profile = control.getInterceptorProfile(b.projectId, b.interceptorProfileDigest);
          if (!profile) notFound('Interceptor profile');
          if (b.basis !== 'DECLARED_HOOKS_ONLY') {
            const sinks = JSON.parse(s(profile, 'supported_sinks_json')) as string[];
            if (
              profile['containment'] !== 'PROCESS_TREE_ENFORCED' ||
              !b.requiredSinkClasses.every((x) => sinks.includes(x))
            ) {
              throw new RouteSpecError(
                'RS_SINK_UNSUPPORTED',
                'The interceptor profile does not cover the complete process tree and every required sink.',
              );
            }
          }
        } else if (b.basis !== 'DECLARED_HOOKS_ONLY') {
          throw new RouteSpecError(
            'RS_SINK_UNSUPPORTED',
            'Complete-effect coverage requires an independent interceptor profile.',
          );
        }
        if (b.callsiteInventoryDigest !== null) {
          const inv = control.getInventoryByDigest(b.callsiteInventoryDigest);
          if (!inv || !control.inProject(b.projectId, 'CALLSITE_INVENTORY', b.callsiteInventoryDigest))
            notFound('Call-site inventory');
          if (
            b.basis === 'TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT' &&
            (inv['attestation_id'] === null || Number(inv['unsupported_findings']) > 0)
          ) {
            throw new RouteSpecError(
              'RS_SINK_UNSUPPORTED',
              'A trusted-inventory basis needs an attested inventory without unsupported findings; an inventory alone is never complete.',
            );
          }
        }
        const { projectId, ...input } = b;
        const r = store.createEffectCoveragePolicy(input);
        control.scopeRecord(projectId, 'EFFECT_POLICY', r.policyDigest);
        return ok(
          {
            ...r,
            basis: b.basis,
            completeEffectPredicates:
              b.basis === 'DECLARED_HOOKS_ONLY' ? 'REVIEW_ONLY' : 'REQUIRES_ATTESTED_INTERCEPTOR',
          },
          201,
        );
      },
    },
    {
      method: 'POST',
      path: '/effect-callsite-inventories',
      auth: 'control',
      mutation: true,
      schema: S.inventoryCreate,
      handle: ({ body }) => {
        const b = body as { projectId: string } & Parameters<RouteSpecStore['registerCallsiteInventory']>[0];
        mustProject(b.projectId);
        const build = mustBuild(b.projectId, b.buildRevisionId);
        mustScoped(b.projectId, 'EFFECT_MANIFEST', b.manifestDigest, 'Effect manifest');
        if (b.attestationId !== null) {
          const a = attestationUsable(b.attestationId, 'EFFECT_INVENTORY', b.projectId, b.buildRevisionId);
          const observed = JSON.parse(s(a, 'observed_digests_json')) as string[];
          const content = inventoryContentDigest(b);
          if (
            !observed.includes(content) ||
            !observed.includes(b.analyzerDigest) ||
            !observed.includes(s(build, 'artifact_digest'))
          ) {
            throw new RouteSpecError(
              'RS_IDENTITY_MISMATCH',
              'The attestation does not vouch for this inventory content.',
            );
          }
        }
        const { projectId, ...input } = b;
        const r = store.registerCallsiteInventory(input);
        control.scopeRecord(projectId, 'CALLSITE_INVENTORY', r.inventoryDigest);
        const gaps = b.unsupportedFindings > 0 || b.callsites.some((c) => c.dynamic);
        return ok(
          {
            ...r,
            contentDigest: inventoryContentDigest(b),
            trust: b.attestationId === null || gaps ? 'DECLARED_HOOKS_ONLY' : 'ATTESTED_SUPPLEMENTAL',
            replacesRuntimeInterception: false,
          },
          201,
        );
      },
    },

    // -----------------------------------------------------------------------------------------
    // Attester principals and launcher challenges.
    {
      method: 'POST',
      path: '/attester-principals',
      auth: 'control',
      mutation: true,
      schema: S.attesterEnroll,
      handle: ({ body }) => {
        const b = body as {
          projectId: string;
          label: string;
          policy: Record<string, unknown> & {
            kind: 'LOCAL_LAUNCHER_KEY' | 'CI_OIDC';
            validFromMs: number;
            validUntilMs: number;
            maxFreshnessMs: number;
          };
          confirmation?: { confirmationId: string; code: string };
        };
        mustProject(b.projectId);
        const p = b.policy;
        if (p.validUntilMs <= p.validFromMs || p.validUntilMs <= d.nowMs()) {
          throw new RouteSpecError('RS_SCHEMA_INVALID', 'The validity window is empty or already over.');
        }
        if (p.kind === 'CI_OIDC') {
          for (const k of p['signingKeys'] as Array<{ notBeforeMs: number; notAfterMs: number }>) {
            if (k.notAfterMs <= k.notBeforeMs)
              throw new RouteSpecError('RS_SCHEMA_INVALID', 'A signing key window is empty.');
          }
        }
        const planDigest = digestValue('routespec.attester-policy/1', { kind: p.kind, policy: p });
        const flow = confirmFlow(
          'ATTESTER_ENROLL',
          planDigest,
          `Enroll ${p.kind} attester "${b.label}"`,
          b.confirmation,
        );
        if ('status' in flow) return flow;
        const keyPolicy =
          p.kind === 'LOCAL_LAUNCHER_KEY'
            ? { publicKeyJwk: p['publicKeyJwk'], launcher: p['launcherArtifactDigest'] }
            : { issuer: p['issuer'], signingKeys: p['signingKeys'] };
        const claimPolicy =
          p.kind === 'LOCAL_LAUNCHER_KEY'
            ? { peerBinding: p['peerBinding'] }
            : {
                audience: p['audience'],
                repositoryId: p['repositoryId'],
                workflowRef: p['workflowRef'],
                allowedRefs: p['allowedRefs'],
                subject: p['subject'],
                maxTokenAgeMs: p['maxTokenAgeMs'],
                maxKeyAgeMs: p['maxKeyAgeMs'],
              };
        const r = control.enrollPrincipal({
          projectId: b.projectId,
          label: b.label,
          kind: p.kind,
          policy: p,
          keyOrIssuerPolicyDigest: digestValue('routespec.attester-key-policy/1', keyPolicy),
          claimPolicyDigest: digestValue('routespec.attester-claim-policy/1', claimPolicy),
          audience: p.kind === 'CI_OIDC' ? String(p['audience']) : null,
          maxFreshnessMs: p.maxFreshnessMs,
          validFromMs: p.validFromMs,
          validUntilMs: p.validUntilMs,
          confirmation: flow,
        });
        return ok(
          {
            principalId: r.principalId,
            kind: p.kind,
            label: b.label,
            policyDigest: r.policyDigest,
            revocationEpoch: 0,
            enabled: true,
          },
          201,
        );
      },
    },
    {
      method: 'GET',
      path: '/projects/:projectId/attester-principals',
      auth: 'control',
      mutation: false,
      handle: ({ params }) => {
        const projectId = params['projectId'] as string;
        mustProject(projectId);
        return ok({
          items: control.listPrincipals(projectId).map((p) => ({
            principalId: s(p, 'principal_id'),
            kind: s(p, 'kind'),
            label: s(p, 'label'),
            policyDigest: s(p, 'policy_digest'),
            enabled: p['enabled'] === 1,
            revocationEpoch: Number(p['revocation_epoch']),
            validFrom: iso(p['valid_from_ms']),
            validUntil: iso(p['valid_until_ms']),
          })),
        });
      },
    },
    {
      method: 'POST',
      path: '/attester-principals/:principalId/revoke',
      auth: 'control',
      mutation: true,
      schema: S.attesterRevoke,
      handle: ({ params, body }) => {
        const principalId = params['principalId'] as string;
        const p = control.getPrincipal(principalId);
        if (!p) notFound('Attester principal');
        mustProject(p.projectId);
        const b = body as { reasonCode: string; confirmation?: { confirmationId: string; code: string } };
        const planDigest = digestValue('routespec.attester-revocation-plan/1', {
          principalId,
          reasonCode: b.reasonCode,
          revocationEpoch: Number(p.principal['revocation_epoch']),
        });
        const flow = confirmFlow(
          'ATTESTER_REVOKE',
          planDigest,
          `Revoke attester "${p.label}"`,
          b.confirmation,
        );
        if ('status' in flow) return flow;
        const r = control.revokePrincipal({ principalId, reasonCode: b.reasonCode, confirmation: flow });
        d.launchers.delete(principalId);
        return ok({ ...r, historicalAttestations: 'IMMUTABLE', newEvaluations: 'REVIEW' });
      },
    },
    {
      method: 'POST',
      path: '/launcher-challenges',
      auth: 'control',
      mutation: true,
      schema: S.challengeCreate,
      handle: async ({ body }) => {
        const b = body as { scope: string; projectId: string; principalId: string } & Record<string, string>;
        mustProject(b.projectId);
        const principal = control.getPrincipal(b.principalId);
        if (!principal || principal.projectId !== b.projectId) notFound('Attester principal');
        const binding = challengeBinding(b);
        const kind = String(principal.principal['kind']);
        if (kind === 'LOCAL_LAUNCHER_KEY') {
          const channel = d.launchers.get(b.principalId);
          if (!channel) {
            throw new RouteSpecError(
              'RS_PEER_BINDING_UNAVAILABLE',
              'No launcher of this principal is attached to the local service.',
            );
          }
          const created = control.createChallenge({
            projectId: b.projectId,
            scope: b.scope as 'BUILD_REGISTRATION',
            principalId: b.principalId,
            binding,
            ttlMs: d.challengeTtlMs,
          });
          const outcome = await channel.complete({
            challengeId: created.challengeId,
            nonce: created.nonce,
            scope: b.scope,
            bindingDigest: created.bindingDigest,
            binding,
          });
          if (outcome.outcome === 'REJECTED') {
            return ok(
              new RouteSpecError(
                'RS_ATTESTATION_REJECTED',
                'The attestation was rejected; nothing was attested.',
                {
                  details: {
                    reasonCode: outcome.reasonCode,
                    outcome: 'REJECTED',
                    challengeId: created.challengeId,
                  },
                },
              ).toEnvelope('recorded'),
              403,
            );
          }
          return ok(
            {
              ...outcome,
              expiresAt: iso(outcome.expiresAtMs),
              bindingDigest: created.bindingDigest,
              channel: 'PRIVATE_IPC',
            },
            201,
          );
        }
        if (b.scope === 'EFFECT_INTERCEPTOR_LAUNCH') {
          throw new RouteSpecError(
            'RS_PEER_BINDING_UNAVAILABLE',
            'Interceptor launch attestation requires a private-channel launcher principal.',
          );
        }
        const created = control.createChallenge({
          projectId: b.projectId,
          scope: b.scope as 'BUILD_REGISTRATION',
          principalId: b.principalId,
          binding,
          ttlMs: d.challengeTtlMs,
        });
        const out = {
          challengeId: created.challengeId,
          scope: b.scope,
          principalId: b.principalId,
          bindingDigest: created.bindingDigest,
          binding,
          expiresAt: iso(created.expiresAtMs),
          nonce: created.nonce,
        };
        return ok(out, 201, { ...out, nonce: null, nonceDelivery: 'DELIVERED_ONCE' });
      },
    },
    {
      method: 'GET',
      path: '/launcher-challenges/:challengeId',
      auth: 'control',
      mutation: false,
      handle: ({ params }) => {
        const c = control.getChallenge(params['challengeId'] as string);
        if (!c) notFound('Launcher challenge');
        mustProject(c.projectId);
        return ok({
          challengeId: s(c.challenge, 'challenge_id'),
          scope: s(c.challenge, 'scope'),
          principalId: s(c.challenge, 'principal_id'),
          bindingDigest: s(c.challenge, 'binding_digest'),
          expiresAt: iso(c.challenge['expires_at_ms']),
          consumed: c.challenge['consumed_at_ms'] !== null,
          outcome: c.outcome ? s(c.outcome, 'outcome') : null,
          reasonCode: c.outcome ? (c.outcome['reason_code'] as string | null) : null,
          attestationId: c.outcome ? (c.outcome['attestation_id'] as string | null) : null,
        });
      },
    },
    {
      method: 'POST',
      path: '/launcher-challenges/:challengeId/complete',
      auth: 'control',
      mutation: true,
      schema: S.challengeCompleteHttp,
      handle: ({ params, body }) => {
        const challengeId = params['challengeId'] as string;
        const c = control.getChallenge(challengeId);
        if (!c) notFound('Launcher challenge');
        mustProject(c.projectId);
        const principal = control.getPrincipal(s(c.challenge, 'principal_id'));
        if (!principal) notFound('Attester principal');
        const b = body as { nonce: string; oidcToken?: string; observed: S.ObservedDigests };
        if (principal.principal['kind'] !== 'CI_OIDC') {
          throw new RouteSpecError(
            'RS_PEER_BINDING_UNAVAILABLE',
            'This principal completes only over its inherited private launcher channel, never over HTTP.',
          );
        }
        if (b.oidcToken === undefined)
          throw new RouteSpecError('RS_SCHEMA_INVALID', 'A CI completion requires a signed OIDC token.');
        const token = b.oidcToken;
        const outcome = control.completeChallenge({
          challengeId,
          nonce: b.nonce,
          channel: 'HTTP',
          evaluate: (ctx) =>
            verifyOidcCompletion(ctx, { nonce: b.nonce, observed: b.observed, oidcToken: token }),
        });
        if (outcome.outcome === 'REJECTED') {
          return ok(
            new RouteSpecError(
              'RS_ATTESTATION_REJECTED',
              'The attestation was rejected; nothing was attested.',
              {
                details: { reasonCode: outcome.reasonCode, outcome: 'REJECTED', challengeId },
              },
            ).toEnvelope('recorded'),
            403,
          );
        }
        return ok({ ...outcome, expiresAt: iso(outcome.expiresAtMs) }, 201);
      },
    },

    // -----------------------------------------------------------------------------------------
    // Scenarios, corpora, gates.
    {
      method: 'POST',
      path: '/scenarios/validate',
      auth: 'control',
      mutation: false,
      schema: S.scenarioValidate,
      maxBody: 300_000,
      handle: ({ body }) => {
        try {
          const compiled = compileScenario((body as { source: string }).source);
          return ok({
            valid: true,
            errors: [],
            compiledDigest: compiled.revisionDigest,
            scenarioStableId: compiled.revisionInput.scenarioStableId,
            resourceEstimate: compiled.revisionInput.resourceBudget,
            provenanceClass: compiled.revisionInput.provenanceClass,
            warnings:
              compiled.revisionInput.provenanceClass === 'SYNTHETIC'
                ? []
                : ['SOURCE_PROVENANCE_REVIEW_REQUIRED'],
            networkAccessed: false,
            persisted: false,
          });
        } catch (error) {
          if (!(error instanceof RouteSpecError)) throw error;
          return ok({
            valid: false,
            errors: [{ code: error.code, details: error.details }],
            compiledDigest: null,
            networkAccessed: false,
            persisted: false,
          });
        }
      },
    },
    {
      method: 'POST',
      path: '/scenarios',
      auth: 'control',
      mutation: true,
      schema: S.scenarioCreate,
      maxBody: 300_000,
      handle: ({ body }) => {
        const b = body as { projectId: string; source: string };
        mustProject(b.projectId);
        const compiled = compileScenario(b.source);
        const r = store.createScenarioRevision({ ...compiled.revisionInput, reviewStatus: 'UNREVIEWED' });
        control.scopeRecord(b.projectId, 'SCENARIO_REVISION', r.scenarioRevisionId);
        return ok(
          { ...r, scenarioStableId: compiled.revisionInput.scenarioStableId, reviewStatus: 'UNREVIEWED' },
          201,
        );
      },
    },
    {
      method: 'POST',
      path: '/corpora',
      auth: 'control',
      mutation: true,
      schema: S.corpusCreate,
      handle: ({ body }) => {
        const b = body as {
          projectId: string;
          label: string;
          cases: Parameters<RouteSpecStore['createCorpusRevision']>[0]['cases'];
        };
        mustProject(b.projectId);
        for (const c of b.cases)
          mustScoped(b.projectId, 'SCENARIO_REVISION', c.scenarioRevisionId, 'Scenario revision');
        const r = store.createCorpusRevision({ label: b.label, cases: b.cases });
        control.scopeRecord(b.projectId, 'CORPUS_REVISION', r.corpusRevisionId);
        return ok({ ...r, caseCount: b.cases.length }, 201);
      },
    },
    {
      method: 'POST',
      path: '/gates',
      auth: 'control',
      mutation: true,
      schema: S.gateCreate,
      handle: ({ body }) => {
        const b = body as Parameters<GateJournal['createGateDefinition']>[0];
        mustProject(b.projectId);
        mustScoped(b.projectId, 'CORPUS_REVISION', b.corpusRevisionId, 'Corpus revision');
        const r = gates.createGateDefinition(b);
        control.scopeRecord(b.projectId, 'GATE_DEFINITION', r.gateId);
        return ok(
          {
            ...r,
            enforcementMode: b.enforcementMode,
            buildAttestationPolicy: b.buildAttestationPolicy,
            blocksRelease: false,
          },
          201,
        );
      },
    },
    {
      method: 'POST',
      path: '/gates/:gateId/evaluate',
      auth: 'control',
      mutation: true,
      schema: S.gateEvaluate,
      handle: ({ params, body }) => {
        const gateId = params['gateId'] as string;
        const def = gates.latestGateDefinition(gateId);
        mustProject(def.projectId);
        const g = mustGateRun((body as { gateRunId: string }).gateRunId);
        const runDef = g['gate_definition_revision_id']
          ? gates.getGateDefinitionRevision(s(g, 'gate_definition_revision_id'))
          : null;
        if (!runDef || runDef.gateId !== gateId)
          throw new RouteSpecError('RS_IDENTITY_MISMATCH', 'The gate run was not created for this gate.');
        const { evaluation, created } = service.evaluateGate(s(g, 'gate_run_id'));
        return ok(
          {
            gateEvaluationId: evaluation.gateEvaluationId,
            gateRunId: evaluation.gateRunId,
            decision: evaluation.decision,
            decisionDigest: evaluation.decisionDigest,
            findings: evaluation.findings,
            enforcementMode: evaluation.enforcementMode,
            artifactReady: evaluation.artifactReady,
            blocksRelease: false,
            repositoryProtectionVerified: false,
            created,
            evaluatedAt: iso(evaluation.createdAtMs),
          },
          created ? 201 : 200,
        );
      },
    },

    // -----------------------------------------------------------------------------------------
    // Gate runs and case runs.
    {
      method: 'POST',
      path: '/gate-runs',
      auth: 'control',
      mutation: true,
      schema: S.gateRunCreate,
      handle: ({ body }) => {
        const b = body as {
          projectId: string;
          gateId: string | null;
          buildRevisionId: string;
          artifactDigest: string;
          corpusRevisionId: string;
          effectManifestDigest: string;
          effectCoveragePolicyDigest: string;
          callsiteInventoryDigest: string | null;
          interceptorProfileDigest: string | null;
          buildAttestation: { class: 'USER_ASSERTED_LOCAL' } | { subjectAttestationId: string };
          mode: string;
          maxParallelCases: number;
        };
        if (b.mode === 'LIVE_DRY_PROBE') {
          throw new RouteSpecError(
            'RS_MODE_POLICY_DENIED',
            'Gate runs execute only in SIMULATE or REPLAY; official compatibility is a separate probe.',
          );
        }
        if (b.mode !== 'SIMULATE' && b.mode !== 'REPLAY')
          throw new RouteSpecError('RS_SCHEMA_INVALID', 'Unknown mode.');
        mustProject(b.projectId);
        mustBuild(b.projectId, b.buildRevisionId);
        mustScoped(b.projectId, 'CORPUS_REVISION', b.corpusRevisionId, 'Corpus revision');
        mustScoped(b.projectId, 'EFFECT_MANIFEST', b.effectManifestDigest, 'Effect manifest');
        mustScoped(b.projectId, 'EFFECT_POLICY', b.effectCoveragePolicyDigest, 'Effect coverage policy');
        if (b.callsiteInventoryDigest !== null)
          mustScoped(b.projectId, 'CALLSITE_INVENTORY', b.callsiteInventoryDigest, 'Call-site inventory');
        if (
          b.interceptorProfileDigest !== null &&
          !control.getInterceptorProfile(b.projectId, b.interceptorProfileDigest)
        ) {
          notFound('Interceptor profile');
        }
        let gate = null;
        if (b.gateId !== null) {
          mustScoped(b.projectId, 'GATE_DEFINITION', b.gateId, 'Gate');
          gate = gates.latestGateDefinition(b.gateId);
        }
        let buildAttestation: {
          attestationClass: 'USER_ASSERTED_LOCAL' | 'TRUSTED_LAUNCHER' | 'CI_ATTESTED';
          attestationId: string | null;
        } = {
          attestationClass: 'USER_ASSERTED_LOCAL',
          attestationId: null,
        };
        if ('subjectAttestationId' in b.buildAttestation) {
          const a = attestationUsable(
            b.buildAttestation.subjectAttestationId,
            'BUILD_REGISTRATION',
            b.projectId,
            b.buildRevisionId,
          );
          buildAttestation = {
            attestationClass: s(a, 'attestation_class') as 'TRUSTED_LAUNCHER',
            attestationId: s(a, 'attestation_id'),
          };
        }
        const created = service.createGateRun({
          gate,
          projectId: b.projectId,
          buildRevisionId: b.buildRevisionId,
          artifactDigest: b.artifactDigest,
          corpusRevisionId: b.corpusRevisionId,
          effectManifestDigest: b.effectManifestDigest,
          effectCoveragePolicyDigest: b.effectCoveragePolicyDigest,
          callsiteInventoryDigest: b.callsiteInventoryDigest,
          interceptorProfileDigest: b.interceptorProfileDigest,
          buildAttestation,
          mode: b.mode,
          maxParallelCases: b.maxParallelCases,
          ...lineageRolesFor(b.corpusRevisionId, b.buildRevisionId),
        });
        control.setGateRunMode(created.gateRunId, b.mode);
        return ok(gateRunView(d, store.getGateRun(created.gateRunId) as Row), 201);
      },
    },
    {
      method: 'GET',
      path: '/gate-runs/:gateRunId',
      auth: 'control',
      mutation: false,
      handle: ({ params }) => ok(gateRunView(d, mustGateRun(params['gateRunId'] as string))),
    },
    {
      method: 'GET',
      path: '/gate-runs/:gateRunId/cases',
      auth: 'control',
      mutation: false,
      handle: ({ params, query }) => {
        const g = mustGateRun(params['gateRunId'] as string);
        strictQuery(query, ['cursor', 'limit']);
        const limit = parseLimit(query.get('limit'));
        const list = `cases:${s(g, 'gate_run_id')}`;
        const cursor = query.get('cursor');
        const pos = cursor === null ? null : d.cursors.decode(cursor, list, {});
        if (pos !== null && pos.kind !== 'seq')
          throw new RouteSpecError('RS_CURSOR_INVALID', 'The pagination cursor is invalid.');
        const afterOrdinal = pos === null ? -1 : pos.seq - 1;
        const items = control.caseRunsPage(s(g, 'gate_run_id'), afterOrdinal, limit);
        const last = items[items.length - 1];
        return ok({
          items: items.map((c) => caseRunView(d, c, g)),
          nextCursor:
            items.length === limit && last
              ? d.cursors.encode(list, {}, { kind: 'seq', seq: Number(last['case_ordinal']) + 1 })
              : null,
          total: control.caseRunsOf(s(g, 'gate_run_id')).length,
        });
      },
    },
    {
      method: 'POST',
      path: '/gate-runs/:gateRunId/validate',
      auth: 'control',
      mutation: true,
      ifMatch: true,
      schema: S.empty,
      handle: ({ params, ifMatch }) => {
        const g = mustGateRun(params['gateRunId'] as string);
        if (gateRunRevision(g) !== ifMatch)
          throw new RouteSpecError('RS_REVISION_CONFLICT', 'Gate run changed since it was read.');
        const r = service.validateGateRun(s(g, 'gate_run_id'));
        return ok({
          ready: r.ready,
          findings: r.findings,
          gateRun: gateRunView(d, mustGateRun(s(g, 'gate_run_id'))),
        });
      },
    },
    {
      method: 'POST',
      path: '/gate-runs/:gateRunId/start',
      auth: 'control',
      mutation: true,
      ifMatch: true,
      schema: S.empty,
      handle: async ({ params, ifMatch }) => {
        const g = mustGateRun(params['gateRunId'] as string);
        if (gateRunRevision(g) !== ifMatch)
          throw new RouteSpecError('RS_REVISION_CONFLICT', 'Gate run changed since it was read.');
        const mode = control.gateRunMode(s(g, 'gate_run_id')) ?? 'SIMULATE';
        const proxyBaseUrl = await service.openProxy(mode);
        service.startGateRun(s(g, 'gate_run_id'));
        return ok({ proxyBaseUrl, gateRun: gateRunView(d, mustGateRun(s(g, 'gate_run_id'))) });
      },
    },
    {
      method: 'POST',
      path: '/case-runs/:caseRunId/start',
      auth: 'control',
      mutation: true,
      schema: S.empty,
      handle: ({ params }) => {
        const { c, g } = mustCase(params['caseRunId'] as string);
        const mode = control.gateRunMode(s(g, 'gate_run_id')) ?? 'SIMULATE';
        const { handoff } = service.startExternalCase(s(c, 'case_run_id'), mode);
        const cr = handoff.credentials;
        const body = {
          caseRunId: cr.caseRunId,
          gateRunId: handoff.gateRunId,
          sessionId: cr.sessionId,
          clientInstanceId: cr.clientInstanceId,
          proxyBaseUrl: handoff.proxyOrigin,
          fencingEpoch: cr.fencingEpoch,
          mode,
          headers: {
            session: cr.sessionId,
            caseRun: cr.caseRunId,
            logicalJob: 'set per logical job by the adapter',
            adapter: cr.adapterRevision,
            fencingEpoch: String(cr.fencingEpoch),
            names: ADAPTER_HEADERS,
          },
          token: tokenOut(cr),
          buildAttestation: {
            class: s(g, 'build_attestation_class'),
            attestationId: g['build_attestation_id'] ?? null,
            caseLaunchChallenge:
              g['build_attestation_id'] === null
                ? 'NOT_APPLICABLE_USER_ASSERTED'
                : 'REQUEST_VIA_LAUNCHER_CHALLENGES',
          },
        };
        return ok(body, 201, redactToken(body));
      },
    },
    {
      method: 'POST',
      path: '/case-runs/:caseRunId/finish-input',
      auth: 'control',
      mutation: true,
      schema: S.empty,
      handle: ({ params }) => {
        const { c, g } = mustCase(params['caseRunId'] as string);
        service.finishExternalCase(s(c, 'case_run_id'));
        return ok(caseRunView(d, store.getCaseRun(s(c, 'case_run_id')) as Row, g));
      },
    },
    {
      method: 'POST',
      path: '/case-runs/:caseRunId/abort',
      auth: 'control',
      mutation: true,
      schema: S.abortBody,
      handle: ({ params, body }) => {
        const { c, g } = mustCase(params['caseRunId'] as string);
        service.abortExternalCase(
          s(c, 'case_run_id'),
          (body as { reasonCode?: string }).reasonCode ?? 'OPERATOR_CANCELLED',
        );
        return ok(caseRunView(d, store.getCaseRun(s(c, 'case_run_id')) as Row, g));
      },
    },
    {
      method: 'POST',
      path: '/case-runs/:caseRunId/recover',
      auth: 'control',
      mutation: true,
      schema: S.empty,
      handle: ({ params }) => {
        const { c } = mustCase(params['caseRunId'] as string);
        const caseRunId = s(c, 'case_run_id');
        const pending = d.pendingCredentials.get(caseRunId);
        let previousEpoch: number;
        let credentials: LaunchCredentials;
        if (pending && pending.fencingEpoch === Number(c['fencing_epoch'])) {
          d.pendingCredentials.delete(caseRunId);
          previousEpoch = pending.fencingEpoch - 1;
          credentials = pending;
        } else {
          const r = service.recoverForReconciliation(caseRunId);
          previousEpoch = r.previousEpoch;
          credentials = r.credentials;
        }
        const after = store.getCaseRun(caseRunId) as Row;
        const body = {
          caseRunId,
          previousEpoch,
          fencingEpoch: credentials.fencingEpoch,
          revokedTokenPurpose: 'EXECUTION',
          lifecycle: s(after, 'execution_lifecycle'),
          clientInstanceId: credentials.clientInstanceId || null,
          allowedPhases: ['READ_ONLY_RECONCILIATION'],
          token: tokenOut(credentials),
        };
        return ok(body, 200, redactToken(body));
      },
    },
    {
      method: 'POST',
      path: '/case-runs/:caseRunId/captures',
      auth: 'control',
      mutation: true,
      schema: S.captureCreate,
      handle: async ({ params, idempotencyKey }) => {
        const { c } = mustCase(params['caseRunId'] as string);
        const r = await captureInstalledCase(d.imports, {
          caseRunId: s(c, 'case_run_id'),
          configuredSecrets: d.configuredSecrets,
          idempotencyKey: idempotencyKey as string,
        });
        return ok(
          {
            importId: r.importId,
            state: r.state,
            revision: r.revision,
            rawSourceDigest: r.rawSourceDigest,
            findings: r.findings,
            origin: 'INSTALLED_ARTIFACT_CAPTURE',
          },
          201,
        );
      },
    },

    // -----------------------------------------------------------------------------------------
    // Sessions, events, run operations.
    {
      method: 'GET',
      path: '/sessions/:sessionId',
      auth: 'control',
      mutation: false,
      handle: ({ params }) => {
        const sess = store.getSession(params['sessionId'] as string);
        if (!sess) notFound('Session');
        mustGateRun(s(sess, 'gate_run_id'));
        return ok(sessionView(d, sess));
      },
    },
    {
      method: 'GET',
      path: '/sessions/:sessionId/events',
      auth: 'control',
      mutation: false,
      handle: ({ params, query }) => {
        const sessionId = params['sessionId'] as string;
        const sess = store.getSession(sessionId);
        if (!sess) notFound('Session');
        mustGateRun(s(sess, 'gate_run_id'));
        strictQuery(query, [
          'cursor',
          'limit',
          'runOperationId',
          'eventKind',
          'phase',
          'logicalJobDigest',
          'fromSequence',
          'toSequence',
        ]);
        const limit = parseLimit(query.get('limit'));
        const filters: Record<string, string | number> = {};
        for (const k of ['runOperationId', 'eventKind', 'phase', 'logicalJobDigest'] as const) {
          const v = query.get(k);
          if (v !== null) {
            if (!/^[A-Za-z0-9:_.-]{1,80}$/.test(v))
              throw new RouteSpecError('RS_SCHEMA_INVALID', 'Invalid filter value.', {
                details: { parameter: k },
              });
            filters[k] = v;
          }
        }
        for (const k of ['fromSequence', 'toSequence'] as const) {
          const v = query.get(k);
          if (v !== null) {
            if (!/^\d{1,12}$/.test(v))
              throw new RouteSpecError('RS_SCHEMA_INVALID', 'Invalid sequence bound.', {
                details: { parameter: k },
              });
            filters[k] = Number(v);
          }
        }
        const list = `session-events:${sessionId}`;
        const cursor = query.get('cursor');
        const pos = cursor === null ? null : d.cursors.decode(cursor, list, filters);
        if (pos !== null && pos.kind !== 'seq')
          throw new RouteSpecError('RS_CURSOR_INVALID', 'The pagination cursor is invalid.');
        // Cursor position = the first sequence not yet returned.
        const next = pos === null ? 0 : pos.seq;
        const items = control.listSessionEvents(sessionId, next - 1, limit, filters);
        const last = items[items.length - 1];
        const resumeAt = last ? Number(last['sequence']) + 1 : next;
        return ok({
          items: items.map(eventView),
          // Always a resume cursor: an empty or short page is not the end of a live session.
          nextCursor: d.cursors.encode(list, filters, { kind: 'seq', seq: resumeAt }),
          hasMore: items.length === limit,
          // A filtered listing reports the filtered total (bounded by the runtime's event cap).
          total:
            Object.keys(filters).length === 0
              ? control.sessionEventStats(sessionId).count
              : control.listSessionEvents(sessionId, -1, 100_000, filters).length,
        });
      },
    },
    {
      method: 'GET',
      path: '/run-operations/:runOperationId',
      auth: 'control',
      mutation: false,
      handle: ({ params }) => {
        const op = store.getRunOperation(params['runOperationId'] as string);
        if (!op) notFound('Run operation');
        mustGateRun(s(op, 'gate_run_id'));
        return ok(runOperationView(d, op));
      },
    },
    {
      method: 'POST',
      path: '/effects/observe',
      auth: 'case',
      mutation: false,
      schema: S.effectObserve,
      handle: ({ body, caseAuth }) => {
        const auth = caseAuth as CaseAuth;
        const b = body as {
          runOperationId: string | null;
          effectManifestDigest: string;
          effectCoveragePolicyDigest: string;
          hookId: string;
          hookRevision: string;
          effectId: string;
          effectType: string;
          action: 'ATTEMPTED' | 'BLOCKED' | 'RELEASED';
          idempotencyKey: string;
          fencingEpoch: number;
          virtualMs?: number | null;
        };
        if (b.fencingEpoch !== auth.fencingEpoch) {
          throw new RouteSpecError('RS_STALE_FENCING_EPOCH', 'The body and header fencing epochs differ.');
        }
        const r = store.recordSubjectEffectReport(auth, {
          runOperationId: b.runOperationId,
          policyDigest: b.effectCoveragePolicyDigest,
          manifestDigest: b.effectManifestDigest,
          hookId: b.hookId,
          hookRevision: b.hookRevision,
          effectId: b.effectId,
          effectType: b.effectType,
          action: b.action,
          idempotencyKey: b.idempotencyKey,
          virtualMs: b.virtualMs ?? null,
        });
        return ok(
          { ...r, evidenceScope: 'SUBJECT_REPORTED', provesCoverage: false, boundaryObservation: false },
          r.duplicate ? 200 : 201,
        );
      },
    },

    // -----------------------------------------------------------------------------------------
    // Imports (read), exports, compatibility probes.
    {
      method: 'POST',
      path: '/imports',
      auth: 'control',
      mutation: true,
      secretScan: 'pipeline',
      schema: S.importCreate,
      handle: async ({ body, idempotencyKey }) => {
        const b = body as { projectId: string; fileName: string; content: string };
        mustProject(b.projectId);
        const r = await importUserFile(d.imports, {
          projectId: b.projectId,
          filename: b.fileName,
          source: [Buffer.from(b.content, 'utf8')],
          configuredSecrets: d.configuredSecrets,
          idempotencyKey: idempotencyKey as string,
        });
        return ok(importRow(d, r.importId), 201);
      },
    },
    {
      method: 'GET',
      path: '/projects/:projectId/imports',
      auth: 'control',
      mutation: false,
      handle: ({ params, query }) => {
        const projectId = params['projectId'] as string;
        mustProject(projectId);
        return ok(
          keyPage(
            d,
            `imports:${projectId}`,
            query,
            (a, limit) => control.listImports(projectId, a, limit),
            (r) => importRow(d, s(r, 'import_id')),
            control.countRows('SELECT count(*) AS n FROM imports WHERE project_id = ?', projectId),
          ),
        );
      },
    },
    {
      method: 'GET',
      path: '/imports/:importId',
      auth: 'control',
      mutation: false,
      handle: ({ params }) => {
        const view = d.imports.getImport(params['importId'] as string);
        mustProject(view.projectId);
        return ok(importDetailView(d.imports, view.importId, importRow(d, view.importId)));
      },
    },
    {
      method: 'GET',
      path: '/imports/:importId/proposed-mapping',
      auth: 'control',
      mutation: false,
      handle: ({ params }) => {
        const view = d.imports.getImport(params['importId'] as string);
        mustProject(view.projectId);
        if (view.sanitized === null)
          throw new RouteSpecError('RS_IMPORT_STATE_INVALID', 'Import has no sanitized trace.');
        const binding = view.captureBinding;
        const scenario = binding
          ? store.getScenarioRevision(String(binding['scenario_revision_id']))
          : undefined;
        const caseRun = binding ? store.getCaseRun(String(binding['case_run_id'])) : undefined;
        const policy = binding
          ? control.getPolicyByDigest(String(binding['effect_coverage_policy_digest']))
          : undefined;
        const trace = view.sanitized as TraceDocument;
        const base = {
          trace,
          requiredInvariants: caseRun
            ? (JSON.parse(String(caseRun['required_invariants_json'])) as string[])
            : [],
          ...(policy
            ? { requiredSinkClasses: JSON.parse(String(policy['required_sink_classes_json'])) as string[] }
            : {}),
        };
        // Prefer the source scenario's shape; fall back to the observed trace when the source
        // plan does not describe what was actually observed (the draft must match the trace).
        let mapping = proposeMapping({
          ...base,
          sourcePlan: scenario ? (JSON.parse(String(scenario['compiled_json'])) as never) : null,
        });
        let derivedFrom = scenario ? 'SOURCE_SCENARIO' : 'OBSERVED_TRACE';
        if (validateMapping(trace, view.origin, mapping).issues.length > 0) {
          mapping = proposeMapping({ ...base, sourcePlan: null });
          derivedFrom = 'OBSERVED_TRACE';
        }
        return ok({
          importId: view.importId,
          revision: view.revision,
          mapping,
          derivedFrom,
          proposal: 'UNREVIEWED_DRAFT',
        });
      },
    },
    {
      method: 'POST',
      path: '/imports/:importId/mapping',
      auth: 'control',
      mutation: true,
      ifMatch: true,
      schema: S.mappingSave,
      handle: ({ params, body, ifMatch, idempotencyKey }) => {
        const view = d.imports.getImport(params['importId'] as string);
        mustProject(view.projectId);
        const r = saveImportMapping(d.imports, {
          importId: view.importId,
          expectedRevision: ifMatch as number,
          mapping: (body as { mapping: unknown }).mapping,
          idempotencyKey: idempotencyKey as string,
        });
        return ok({ ...r, state: d.imports.getImport(view.importId).state, executesCode: false }, 201);
      },
    },
    {
      method: 'POST',
      path: '/imports/:importId/verify-replay',
      auth: 'control',
      mutation: true,
      ifMatch: true,
      schema: S.empty,
      handle: async ({ params, ifMatch, idempotencyKey }) => {
        const view = d.imports.getImport(params['importId'] as string);
        mustProject(view.projectId);
        const r = await verifyReplay(d.imports, {
          importId: view.importId,
          expectedRevision: ifMatch as number,
          idempotencyKey: idempotencyKey as string,
        });
        return ok({ ...r, state: d.imports.getImport(view.importId).state, networkAccessed: false });
      },
    },
    {
      method: 'POST',
      path: '/imports/:importId/reviews',
      auth: 'control',
      mutation: true,
      ifMatch: true,
      schema: S.importReview,
      handle: ({ params, body, ifMatch, idempotencyKey }) => {
        const view = d.imports.getImport(params['importId'] as string);
        mustProject(view.projectId);
        const b = body as { reviewer: string; decisions: Record<string, boolean>; confirmation: string };
        const r = reviewImport(d.imports, {
          importId: view.importId,
          expectedRevision: ifMatch as number,
          reviewer: b.reviewer,
          decisions: b.decisions as never,
          confirmation: b.confirmation,
          idempotencyKey: idempotencyKey as string,
        });
        return ok({ ...r, state: d.imports.getImport(view.importId).state }, 201);
      },
    },
    {
      method: 'POST',
      path: '/imports/:importId/promote',
      auth: 'control',
      mutation: true,
      ifMatch: true,
      schema: S.importPromote,
      handle: ({ params, body, ifMatch, idempotencyKey }) => {
        const view = d.imports.getImport(params['importId'] as string);
        mustProject(view.projectId);
        const b = body as {
          reviewId: string;
          baseCorpusRevisionId: string | null;
          corpusLabel: string;
          severity: string;
          gatePolicy: string;
        };
        if (b.baseCorpusRevisionId !== null)
          mustScoped(view.projectId, 'CORPUS_REVISION', b.baseCorpusRevisionId, 'Corpus revision');
        const r = promoteImport(d.imports, {
          importId: view.importId,
          expectedRevision: ifMatch as number,
          reviewId: b.reviewId,
          baseCorpusRevisionId: b.baseCorpusRevisionId,
          corpusLabel: b.corpusLabel,
          severity: b.severity,
          gatePolicy: b.gatePolicy,
          idempotencyKey: idempotencyKey as string,
        });
        control.scopeRecord(view.projectId, 'SCENARIO_REVISION', r.scenarioRevisionId);
        control.scopeRecord(view.projectId, 'CORPUS_REVISION', r.corpusRevisionId);
        return ok(
          { ...r, lineage: regressionLineage(d.imports, view.importId), baseCorpusMutated: false },
          201,
        );
      },
    },
    {
      method: 'POST',
      path: '/exports',
      auth: 'control',
      mutation: true,
      schema: S.exportPlan,
      handle: ({ body, idempotencyKey }) => {
        const b = body as {
          gateEvaluationId: string;
          includeAddresses?: boolean;
          acknowledgeAddresses?: boolean;
        };
        const view = gates.getGateEvaluation(b.gateEvaluationId);
        mustGateRun(view.gateRunId);
        const plan = planExport(store, b.gateEvaluationId, {
          idempotencyKey: idempotencyKey as string,
          configuredSecrets: d.configuredSecrets,
          ...(b.includeAddresses !== undefined ? { includeAddresses: b.includeAddresses } : {}),
          ...(b.acknowledgeAddresses !== undefined ? { acknowledgeAddresses: b.acknowledgeAddresses } : {}),
        });
        return ok({ ...plan, written: false }, plan.created ? 201 : 200);
      },
    },
    {
      method: 'POST',
      path: '/exports/:exportId/write',
      auth: 'control',
      mutation: true,
      schema: S.exportWrite,
      handle: ({ params, body, idempotencyKey }) => {
        const exportId = params['exportId'] as string;
        const plan = gates.getExportPlan(exportId);
        mustGateRun(gates.getGateEvaluation(plan.gateEvaluationId).gateRunId);
        const b = body as { outPath: string; confirm: string; overwrite?: boolean };
        const r = writeExport(store, exportId, {
          outPath: b.outPath,
          confirm: b.confirm,
          ...(b.overwrite !== undefined ? { overwrite: b.overwrite } : {}),
          idempotencyKey: idempotencyKey as string,
        });
        return ok({ ...r, decisionChanged: false });
      },
    },
    {
      method: 'POST',
      path: '/compatibility-probes',
      auth: 'control',
      mutation: true,
      schema: S.compatibilityProbe,
      handle: ({ body }) => {
        const b = body as { buildRevisionId: string };
        if (!control.getBuild(b.buildRevisionId)) notFound('Build revision');
        throw new RouteSpecError(
          'RS_PROBE_NOT_AUTHORIZED',
          'An official dry probe needs a separately authorized operator run of the live-dry adapter with a memory-only provider credential.',
          { details: { compatibility: 'NOT_RUN', localVerdictAffected: false } },
        );
      },
    },
  ];

  function challengeBinding(
    b: { scope: string; projectId: string } & Record<string, string>,
  ): Record<string, unknown> {
    const projectId = b.projectId;
    if (b.scope === 'BUILD_REGISTRATION' || b.scope === 'EFFECT_INVENTORY') {
      const build = mustBuild(projectId, b['buildRevisionId'] as string);
      const base = {
        projectId,
        buildRevisionId: s(build, 'build_revision_id'),
        artifactDigest: s(build, 'artifact_digest'),
        commitSha: s(build, 'commit_sha'),
        ciWorkflowRunId: (build['ci_workflow_run_id'] as string | null) ?? null,
      };
      if (b.scope === 'BUILD_REGISTRATION') {
        return {
          ...base,
          lockDigest: s(build, 'lock_digest'),
          toolchainDigest: s(build, 'toolchain_digest'),
          manifestDigest: s(build, 'effect_manifest_digest'),
          adapterRevision: ADAPTER_REVISION,
        };
      }
      mustScoped(projectId, 'EFFECT_MANIFEST', b['manifestDigest'] as string, 'Effect manifest');
      return {
        ...base,
        manifestDigest: b['manifestDigest'],
        analyzerDigest: b['analyzerDigest'],
        inventoryDigest: b['inventoryDigest'],
      };
    }
    const { c, g } = mustCase(b['caseRunId'] as string);
    if (s(g, 'project_id') !== projectId) notFound('Case run');
    if (c['execution_lifecycle'] !== 'RUNNING' || c['session_id'] === null) {
      throw new RouteSpecError('RS_PHASE_INVALID', 'The case run is not running.');
    }
    const build = mustBuild(projectId, s(g, 'build_revision_id'));
    const caseBase = {
      projectId,
      gateRunId: s(g, 'gate_run_id'),
      caseRunId: s(c, 'case_run_id'),
      sessionId: s(c, 'session_id'),
      fencingEpoch: Number(c['fencing_epoch']),
      buildRevisionId: s(g, 'build_revision_id'),
      commitSha: s(build, 'commit_sha'),
    };
    if (b.scope === 'CASE_LAUNCH') {
      if (g['build_attestation_id'] === null) {
        throw new RouteSpecError(
          'RS_IDENTITY_MISMATCH',
          'Case launch attestation requires the gate run to select a build attestation.',
        );
      }
      return {
        ...caseBase,
        artifactDigest: s(g, 'artifact_digest'),
        clientInstanceDigest: s(c, 'client_instance_digest'),
        buildAttestationId: s(g, 'build_attestation_id'),
      };
    }
    const profile = control.getInterceptorProfile(projectId, b['interceptorProfileDigest'] as string);
    if (!profile) notFound('Interceptor profile');
    return {
      ...caseBase,
      interceptorProfileDigest: s(profile, 'profile_digest'),
      interceptorArtifactDigest: s(profile, 'interceptor_artifact_digest'),
      processTreeScope: s(profile, 'process_tree_scope'),
    };
  }

  return routes;
}

/** Digest of an inventory's content, excluding the attestation that later vouches for it. */
export function inventoryContentDigest(input: {
  buildRevisionId: string;
  manifestDigest: string;
  analyzerDigest: string;
  callsites: ReadonlyArray<{
    callsiteId: string;
    sinkClass: string;
    hookId: string | null;
    dynamic: boolean;
  }>;
  unsupportedFindings: number;
}): string {
  const callsites = [...input.callsites]
    .map((c) => ({ callsiteId: c.callsiteId, sinkClass: c.sinkClass, hookId: c.hookId, dynamic: c.dynamic }))
    .sort((a, b) => (a.callsiteId < b.callsiteId ? -1 : a.callsiteId > b.callsiteId ? 1 : 0));
  return digestValue('routespec.effect-callsite-inventory-content/1', {
    buildRevisionId: input.buildRevisionId,
    manifestDigest: input.manifestDigest,
    analyzerDigest: input.analyzerDigest,
    callsites,
    unsupportedFindings: input.unsupportedFindings,
  });
}

function importRow(d: AppDeps, importId: string): Record<string, unknown> {
  const v = d.imports.getImport(importId);
  const b = v.captureBinding;
  const secret = v.findings.filter((f) => f.category.startsWith('SECRET')).reduce((n, f) => n + f.count, 0);
  const nondeterminism = v.findings
    .filter((f) => /NONDETERMIN|TIMER/.test(f.category))
    .reduce((n, f) => n + f.count, 0);
  const unresolved = v.findings.filter((f) => /UNRESOLVED/.test(f.category)).reduce((n, f) => n + f.count, 0);
  return {
    importId: v.importId,
    origin: v.origin,
    source: b
      ? {
          buildRevisionId: String(b['build_revision_id']),
          gateRunId: String(b['gate_run_id']),
          caseRunId: String(b['case_run_id']),
          sessionId: String(b['session_id']),
        }
      : null,
    sanitizedName: v.sourceFilename ?? 'installed-capture',
    digest: v.rawSourceDigest,
    sizeBytes: v.rawByteCount,
    state: v.state,
    revision: v.revision,
    findings: { secret, nondeterminism, unresolved },
    expiresAt: null,
    promotable: v.state === 'REVIEWED',
    blockers: v.findings
      .filter((f) => f.blocking)
      .slice(0, 64)
      .map((f) => ({
        field: f.path.slice(0, 200),
        code: `RS_${f.category.replace(/[^A-Z0-9_]/g, '_')}`.slice(0, 64),
        message: 'Blocking finding.',
      })),
  };
}

/** Build the CaseAuth for a subject call from the adapter's headers (never a control token). */
export function caseAuthFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  store: RouteSpecStore,
): CaseAuth {
  const h = ADAPTER_HEADERS;
  const one = (name: string): string => {
    const v = headers[name];
    if (typeof v !== 'string' || v.length === 0 || v.length > 256) {
      throw new RouteSpecError('RS_HEADER_INVALID', 'A required case header is missing or repeated.', {
        details: { header: name },
      });
    }
    return v;
  };
  if (headers['authorization'] !== undefined) {
    throw new RouteSpecError(
      'RS_CONTROL_AUTH_INVALID',
      'Subject calls authenticate with the case token, not a bearer token.',
    );
  }
  const token = one(h.caseToken);
  const sessionId = one(h.session);
  const caseRunId = one(h.caseRun);
  const epoch = one(h.fencingEpoch);
  if (!/^(0|[1-9][0-9]{0,8})$/.test(epoch))
    throw new RouteSpecError('RS_HEADER_INVALID', 'Invalid fencing epoch header.');
  const clientInstance = one(h.clientInstance);
  const session = store.getSession(sessionId);
  if (!session || session['case_run_id'] !== caseRunId) {
    throw new RouteSpecError('RS_TOKEN_INVALID', 'Case token is not recognized for this session.');
  }
  return {
    token,
    sessionId,
    caseRunId,
    gateRunId: String(session['gate_run_id']),
    buildRevisionId: String(session['build_revision_id']),
    artifactDigest: String(session['artifact_digest']),
    clientInstanceDigest: digestValue(CLIENT_INSTANCE_DIGEST_DOMAIN, clientInstance),
    adapterRevision: one(h.adapter),
    fencingEpoch: Number(epoch),
  };
}
