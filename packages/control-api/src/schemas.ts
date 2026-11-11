/**
 * Strict request schemas for every control mutation (API-SPEC section 1: unknown fields are
 * rejected on mutation requests). Every object is `.strict()`; every string and array is
 * bounded; amounts and identities are typed strings. Schema failures become
 * `RS_SCHEMA_INVALID` with field-level `{ field, code, message }` details and never echo the
 * submitted value.
 */
import { z } from 'zod';
import { RouteSpecError, type SafeDetails } from '@routespec/contracts';

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'expected a sha256 digest');
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'expected a lowercase UUID');
const label = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[\x20-\x7e]+$/, 'printable ASCII only');
const code = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'expected an upper-case code');
const sha = z.string().regex(/^[0-9a-f]{7,64}$/, 'expected a hexadecimal commit SHA');
const ms = z.number().int().min(0).max(8_640_000_000_000_000);
const shortId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:@/-]+$/, 'unsupported characters');
const invariant = z.string().regex(/^INV-\d{2}$/);

export const projectCreate = z
  .object({ name: z.string().min(1).max(200), description: z.string().max(2000).nullable().optional() })
  .strict();

export const projectPatch = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.description !== undefined, 'at least one field is required');

export const revisionCreate = z
  .object({
    revisionLabel: label,
    commitSha: sha.nullable(),
    configurationDigest: digest,
    protocolProfileId: shortId,
    metadata: z
      .record(
        z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/),
        z.union([z.string().max(200), z.number().int(), z.boolean()]),
      )
      .refine((m) => Object.keys(m).length <= 32, 'at most 32 metadata keys'),
  })
  .strict();

export const buildCreate = z
  .object({
    integrationRevisionId: uuid,
    repositoryLocator: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x7e]+$/),
    commitSha: sha,
    dirtyTreeDigest: digest.nullable(),
    artifactDigest: digest,
    toolchainDigest: digest,
    lockDigest: digest,
    effectManifestDigest: digest,
    launchRecipeDigest: digest,
    ciWorkflowRunId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:/-]+$/)
      .nullable(),
  })
  .strict();

const hook = z
  .object({
    hookId: shortId,
    hookRevision: shortId,
    effectType: code,
    sinkClass: shortId,
    sourceLocatorDigest: digest.nullable(),
    mechanism: shortId,
    scenarioSelectors: z
      .array(z.string().regex(/^(\*|[A-Za-z0-9._:@/-]{1,128})$/))
      .min(1)
      .max(32),
    coverageExpectation: z.enum(['REQUIRED', 'OPTIONAL']),
  })
  .strict();

export const manifestCreate = z
  .object({
    projectId: uuid,
    buildRevisionId: uuid,
    artifactDigest: digest,
    adapterRevision: shortId,
    hooks: z.array(hook).min(1).max(64),
  })
  .strict();

export const interceptorProfileCreate = z
  .object({
    projectId: uuid,
    interceptorArtifactDigest: digest,
    containment: z.enum(['PROCESS_TREE_ENFORCED', 'DECLARED_HOOKS_ONLY']),
    processTreeScope: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\x20-\x7e]+$/),
    supportedSinks: z.array(shortId).min(1).max(64),
    denialMechanism: z.enum(['DENY', 'CANARY_REDIRECT']),
  })
  .strict();

export const policyCreate = z
  .object({
    projectId: uuid,
    buildRevisionId: uuid,
    artifactDigest: digest,
    selectedAttestationId: uuid.nullable(),
    scenarioRevisionId: uuid,
    manifestDigest: digest,
    requiredSinkClasses: z.array(shortId).min(1).max(64),
    interceptorProfileDigest: digest.nullable(),
    callsiteInventoryDigest: digest.nullable(),
    basis: z.enum([
      'INDEPENDENT_BOUNDARY_INTERCEPT',
      'TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT',
      'DECLARED_HOOKS_ONLY',
    ]),
  })
  .strict();

export const inventoryCreate = z
  .object({
    projectId: uuid,
    buildRevisionId: uuid,
    manifestDigest: digest,
    analyzerDigest: digest,
    attestationId: uuid.nullable(),
    callsites: z
      .array(
        z
          .object({
            callsiteId: shortId,
            sinkClass: shortId,
            hookId: shortId.nullable(),
            dynamic: z.boolean(),
          })
          .strict(),
      )
      .max(2000),
    unsupportedFindings: z.number().int().min(0).max(100_000),
  })
  .strict();

const confirmation = z
  .object({
    confirmationId: uuid,
    code: z
      .string()
      .min(16)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

const ed25519Jwk = z
  .object({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
const ecJwk = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

const window = {
  validFromMs: ms,
  validUntilMs: ms,
  maxFreshnessMs: z
    .number()
    .int()
    .min(1000)
    .max(7 * 24 * 3_600_000),
};

export const launcherPolicy = z
  .object({
    kind: z.literal('LOCAL_LAUNCHER_KEY'),
    publicKeyJwk: ed25519Jwk,
    launcherArtifactDigest: digest,
    peerBinding: z.literal('INHERITED_IPC_CHILD'),
    ...window,
  })
  .strict();

export const oidcPolicy = z
  .object({
    kind: z.literal('CI_OIDC'),
    issuer: z.string().url().max(256).startsWith('https://'),
    signingKeys: z
      .array(z.object({ kid: shortId, jwk: ecJwk, notBeforeMs: ms, notAfterMs: ms }).strict())
      .min(1)
      .max(8),
    audience: z.string().min(1).max(256),
    repositoryId: z.string().regex(/^\d{1,20}$/),
    workflowRef: z.string().min(1).max(512),
    allowedRefs: z.array(z.string().min(1).max(256)).min(1).max(16),
    subject: z.string().min(1).max(512),
    maxTokenAgeMs: z.number().int().min(1000).max(3_600_000),
    maxKeyAgeMs: z
      .number()
      .int()
      .min(60_000)
      .max(366 * 24 * 3_600_000),
    ...window,
  })
  .strict();

export const attesterEnroll = z
  .object({
    projectId: uuid,
    label,
    policy: z.discriminatedUnion('kind', [launcherPolicy, oidcPolicy]),
    confirmation: confirmation.optional(),
  })
  .strict();

export const attesterRevoke = z
  .object({
    reasonCode: z.enum(['KEY_COMPROMISED', 'POLICY_SUPERSEDED', 'OPERATOR_REQUEST', 'LAUNCHER_RETIRED']),
    confirmation: confirmation.optional(),
  })
  .strict();

export const challengeCreate = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal('BUILD_REGISTRATION'),
      projectId: uuid,
      principalId: uuid,
      buildRevisionId: uuid,
    })
    .strict(),
  z.object({ scope: z.literal('CASE_LAUNCH'), projectId: uuid, principalId: uuid, caseRunId: uuid }).strict(),
  z
    .object({
      scope: z.literal('EFFECT_INVENTORY'),
      projectId: uuid,
      principalId: uuid,
      buildRevisionId: uuid,
      manifestDigest: digest,
      analyzerDigest: digest,
      inventoryDigest: digest,
    })
    .strict(),
  z
    .object({
      scope: z.literal('EFFECT_INTERCEPTOR_LAUNCH'),
      projectId: uuid,
      principalId: uuid,
      caseRunId: uuid,
      interceptorProfileDigest: digest,
    })
    .strict(),
]);

export const observedDigests = z
  .object({
    artifactDigest: digest.optional(),
    lockDigest: digest.optional(),
    toolchainDigest: digest.optional(),
    manifestDigest: digest.optional(),
    analyzerDigest: digest.optional(),
    inventoryDigest: digest.optional(),
    interceptorArtifactDigest: digest.optional(),
    interceptorProfileDigest: digest.optional(),
    clientInstanceDigest: digest.optional(),
  })
  .strict();
export type ObservedDigests = z.infer<typeof observedDigests>;

export const challengeCompleteHttp = z
  .object({
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    oidcToken: z
      .string()
      .min(20)
      .max(8192)
      .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
      .optional(),
    observed: observedDigests,
  })
  .strict();

export const scenarioValidate = z.object({ source: z.string().min(1).max(262_144) }).strict();
export const scenarioCreate = z.object({ projectId: uuid, source: z.string().min(1).max(262_144) }).strict();

export const corpusCreate = z
  .object({
    projectId: uuid,
    label,
    cases: z
      .array(
        z
          .object({
            scenarioRevisionId: uuid,
            requiredInvariants: z.array(invariant).min(1).max(16),
            severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
            gatePolicy: z.enum(['REQUIRED', 'ADVISORY']),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

export const gateCreate = z
  .object({
    projectId: uuid,
    name: label,
    corpusRevisionId: uuid,
    enforcementMode: z.string().max(64),
    buildAttestationPolicy: z.enum(['ALLOW_USER_ASSERTED', 'REQUIRE_TRUSTED']),
  })
  .strict();

export const gateRunCreate = z
  .object({
    projectId: uuid,
    gateId: uuid.nullable(),
    buildRevisionId: uuid,
    artifactDigest: digest,
    corpusRevisionId: uuid,
    effectManifestDigest: digest,
    effectCoveragePolicyDigest: digest,
    callsiteInventoryDigest: digest.nullable(),
    interceptorProfileDigest: digest.nullable(),
    buildAttestation: z.union([
      z.object({ class: z.literal('USER_ASSERTED_LOCAL') }).strict(),
      z.object({ subjectAttestationId: uuid }).strict(),
    ]),
    mode: z.string().max(32),
    maxParallelCases: z.number().int().min(1).max(64),
  })
  .strict();

export const empty = z.object({}).strict();
export const abortBody = z
  .object({ reasonCode: z.enum(['OPERATOR_CANCELLED', 'CLIENT_FAILED']).optional() })
  .strict();

export const effectObserve = z
  .object({
    runOperationId: uuid.nullable(),
    effectManifestDigest: digest,
    effectCoveragePolicyDigest: digest,
    hookId: shortId,
    hookRevision: shortId,
    effectId: shortId,
    effectType: code,
    action: z.enum(['ATTEMPTED', 'BLOCKED', 'RELEASED']),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
    fencingEpoch: z.number().int().min(0),
    virtualMs: z.number().int().min(0).nullable().optional(),
  })
  .strict();

export const gateEvaluate = z.object({ gateRunId: uuid }).strict();

export const exportPlan = z
  .object({
    gateEvaluationId: uuid,
    includeAddresses: z.boolean().optional(),
    acknowledgeAddresses: z.boolean().optional(),
  })
  .strict();

export const exportWrite = z
  .object({ outPath: z.string().min(1).max(1024), confirm: digest, overwrite: z.boolean().optional() })
  .strict();

export const captureCreate = z.object({}).strict();

/**
 * User trace upload (API-SPEC "POST /imports"). The trace travels as a JSON string field inside
 * the bounded request body; the service never parses it with the request parser, only with the
 * M05 bounded ingest after quarantine.
 */
export const importCreate = z
  .object({
    projectId: uuid,
    fileName: z.string().min(1).max(255),
    content: z.string().max(200_000),
  })
  .strict();

export const mappingSave = z.object({ mapping: z.unknown() }).strict();
export const importReview = z
  .object({
    reviewer: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[ -~]+$/),
    decisions: z
      .record(z.string().regex(/^[A-Z_]{3,64}$/), z.boolean())
      .refine((v) => Object.keys(v).length <= 16),
    confirmation: z.string().max(200),
  })
  .strict();
export const importPromote = z
  .object({
    reviewId: uuid,
    baseCorpusRevisionId: uuid.nullable(),
    corpusLabel: label,
    severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    gatePolicy: z.enum(['REQUIRED', 'ADVISORY']),
  })
  .strict();

export const projectDelete = z.object({ confirmDigest: digest.optional() }).strict();

export const compatibilityProbe = z.object({ buildRevisionId: uuid, protocolProfileId: shortId }).strict();

/** Parse with a strict schema; failures carry only field paths and issue codes. */
export function parseBody<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data as z.infer<S>;
  const fields = r.error.issues.slice(0, 32).map((i) => ({
    field: i.path.length === 0 ? '$' : i.path.map(String).join('.').slice(0, 120),
    code: i.code === 'unrecognized_keys' ? 'UNKNOWN_FIELD' : i.code.toUpperCase(),
    message: i.code === 'unrecognized_keys' ? 'Unknown field.' : 'Invalid value.',
  }));
  const unknown = r.error.issues
    .filter((i) => i.code === 'unrecognized_keys')
    .flatMap((i) => (i as { keys: string[] }).keys.slice(0, 16).map((k) => k.slice(0, 64)));
  throw new RouteSpecError('RS_SCHEMA_INVALID', 'The request body does not match the schema.', {
    details: {
      fields: fields as unknown as SafeDetails[string],
      unknownFields: unknown,
    } as unknown as SafeDetails,
  });
}
