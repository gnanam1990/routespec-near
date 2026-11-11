/**
 * The reviewed CI configuration file (`routespec.ci-config/1`).
 *
 * The file is data. It is parsed with a strict duplicate-free JSON reader and a closed schema;
 * unknown fields fail closed. Before the schema runs, every key at every depth is checked for
 * caller-supplied enforcement claims (branch-protection state, screenshots, "verified" or
 * "blocking" flags): those are refused with `RS_ENFORCEMENT_CLAIM_REJECTED` because RouteSpec v2
 * has no repository-settings verification adapter and never accepts such state as proof.
 *
 * Every path is relative to the workspace and must stay inside it after symlink resolution.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { ENFORCEMENT_MODES, RouteSpecError, type EnforcementMode } from '@routespec/contracts';
import { DEFAULT_IMPORT_LIMITS, decodeUtf8, parseBoundedJson } from '@routespec/regressions';

export const CI_CONFIG_SCHEMA = 'routespec.ci-config/1' as const;
export const MAX_CONFIG_BYTES = 256 * 1024;
export const MAX_RETENTION_DAYS = 30;
export const DEFAULT_RETENTION_DAYS = 7;

export const UPLOAD_KINDS = ['gate-report-json', 'junit', 'sarif', 'evidence-bundle'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

/** Keys that try to assert repository protection or blocking state. Matched at any depth. */
const CLAIM_KEY =
  /^(?:branch[-_]?protections?|protection(?:[-_]?(?:state|rules?|screenshot|evidence|json))?|required[-_]?checks?[-_]?(?:verified|state|status)|enforcement[-_]?verified|verified[-_]?enforcement|blocking|blocks?[-_]?(?:merge|release|merging)|merge[-_]?blocking|release[-_]?blocking|screenshots?|rulesets?)$/i;

const relPath = z.string().min(1).max(512);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const invariant = z.string().regex(/^INV-(0[1-9]|1[0-2])$/);

const configSchema = z
  .object({
    schema: z.literal(CI_CONFIG_SCHEMA),
    project: z.string().min(1).max(120),
    revisionLabel: z.string().min(1).max(120),
    subject: z
      .object({
        artifactFiles: z.array(relPath).min(1).max(256),
        lockFile: relPath,
        manifestFile: relPath,
        clientModule: relPath,
        expectedArtifactDigest: digest.optional(),
      })
      .strict(),
    scenarios: z
      .array(
        z.object({ file: relPath, policy: z.enum(['REQUIRED', 'ADVISORY']).default('REQUIRED') }).strict(),
      )
      .min(1)
      .max(64),
    requiredInvariants: z.array(invariant).min(1).max(12),
    effect: z
      .object({
        sinks: z.array(z.string().min(1).max(64)).min(1).max(32),
        basis: z
          .enum([
            'INDEPENDENT_BOUNDARY_INTERCEPT',
            'TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT',
            'DECLARED_HOOKS_ONLY',
          ])
          .default('DECLARED_HOOKS_ONLY'),
      })
      .strict(),
    gate: z
      .object({
        name: z.string().min(1).max(120),
        enforcement: z.string().min(1).max(64).optional(),
        requireAttestedBuild: z.boolean().default(false),
        parallelism: z.number().int().min(1).max(16).default(1),
        mode: z.enum(['SIMULATE', 'REPLAY']).default('SIMULATE'),
      })
      .strict(),
    uploads: z
      .object({
        include: z.array(z.enum(UPLOAD_KINDS)).max(4).default(['gate-report-json', 'junit', 'sarif']),
        extraPaths: z.array(relPath).max(32).default([]),
        retentionDays: z.number().int().min(1).max(MAX_RETENTION_DAYS).default(DEFAULT_RETENTION_DAYS),
      })
      .strict()
      .default({}),
    liveDry: z
      .object({ requested: z.boolean().default(false) })
      .strict()
      .default({}),
    trustedRefs: z
      .array(z.string().regex(/^refs\/(?:heads|tags)\/[^\s]{1,200}$/))
      .max(16)
      .optional(),
    pinnedIdentity: z
      .object({
        repository: z.string().min(1).max(200).optional(),
        repositoryId: z
          .string()
          .regex(/^\d{1,20}$/)
          .optional(),
        workflowRef: z.string().min(1).max(400).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CiConfig = z.infer<typeof configSchema>;

function findClaimKeys(value: unknown, path: string[] = [], out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v, i) => findClaimKeys(v, [...path, String(i)], out));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (CLAIM_KEY.test(k)) out.push([...path, k].join('.').slice(0, 160));
      findClaimKeys(v, [...path, k], out);
    }
  }
  return out;
}

/** Refuse caller-supplied enforcement/protection claims anywhere in a parsed document. */
export function rejectEnforcementClaims(value: unknown, source: string): void {
  const claims = findClaimKeys(value);
  if (claims.length > 0) {
    throw new RouteSpecError(
      'RS_ENFORCEMENT_CLAIM_REJECTED',
      'Caller-supplied branch-protection, required-check, screenshot, or blocking state is not accepted as proof; RouteSpec v2 has no repository-settings verification adapter.',
      { details: { source, claim: claims[0] as string, count: String(claims.length) } },
    );
  }
}

/** Parse an enforcement request. Anything outside the three supported modes is a rejected claim. */
export function parseEnforcementRequest(raw: string | undefined): EnforcementMode | null {
  if (raw === undefined) return null;
  const v = raw.toUpperCase().replace(/-/g, '_');
  if ((ENFORCEMENT_MODES as readonly string[]).includes(v)) return v as EnforcementMode;
  throw new RouteSpecError(
    'RS_ENFORCEMENT_CLAIM_REJECTED',
    'Only LOCAL_ADVISORY, CI_CHECK, or REQUIRED_CHECK_UNVERIFIED can be requested; RouteSpec never records verified or blocking enforcement.',
    { details: { requested: v.slice(0, 48) } },
  );
}

export function loadCiConfig(configPath: string, workspace: string): CiConfig {
  const full = resolveInside(workspace, configPath, 'config');
  if (statSync(full).size > MAX_CONFIG_BYTES) {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'The CI configuration exceeds the size limit.');
  }
  const text = decodeUtf8(readFileSync(full));
  const json = text === null ? null : parseBoundedJson(text, DEFAULT_IMPORT_LIMITS);
  if (json === null || !json.ok) {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'The CI configuration is not strict JSON.', {
      details: { cause: json === null ? 'UTF8_INVALID' : json.category },
    });
  }
  const parsed: unknown = json.value;
  rejectEnforcementClaims(parsed, 'config');
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new RouteSpecError(
      'RS_SCHEMA_INVALID',
      'The CI configuration does not match routespec.ci-config/1.',
      {
        details: {
          path: (issue?.path ?? []).join('.').slice(0, 120),
          issue: (issue?.code ?? 'invalid').slice(0, 40),
        },
      },
    );
  }
  parseEnforcementRequest(result.data.gate.enforcement);
  return result.data;
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
}

/**
 * Resolve a configured relative path inside the workspace. Absolute paths, traversal, and
 * symlinks that leave the workspace are refused; the file must exist.
 */
export function resolveInside(workspace: string, path: string, field: string): string {
  if (isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.includes('\0')) {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'Configured paths must be relative to the workspace.', {
      details: { field },
    });
  }
  const root = realpathSync(workspace);
  const full = resolve(root, path);
  if (!within(root, full) || !existsSync(full)) {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'Configured path is outside the workspace or missing.', {
      details: { field },
    });
  }
  if (!within(root, realpathSync(full)) || lstatSync(full).isSymbolicLink()) {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'Configured path resolves outside the workspace.', {
      details: { field },
    });
  }
  return full;
}

export { within as isWithin };
