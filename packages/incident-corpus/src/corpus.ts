/**
 * The observed-incident corpus: manifest with provenance and counts, scenario files, and
 * verification of a corpus directory (M50).
 *
 * A corpus directory holds `manifest.json` and `scenarios/<scenarioId>.yaml`. The manifest is a
 * closed schema: enumerations, counts, hour-rounded times and digests. It has no free-text
 * field. Each scenario file must be exactly what `renderScenario` produces for its descriptor,
 * so a directory cannot carry a hand-edited scenario or an extra file past verification.
 *
 * Labels and honesty:
 * - `mainnet-observed-YYYY-MM` is reserved for records read from the real service over HTTPS.
 *   Its manifest says `IMPORTED` only then. Until that import has run, the committed manifest is
 *   `PENDING_LIVE_IMPORT` with zero records and zero cases.
 * - A corpus built from the documented-shape recording is labelled as a shape fixture, is
 *   `PENDING_LIVE_IMPORT` as far as mainnet data is concerned, and its scenarios carry the
 *   `OFFICIAL_SPEC_DERIVED` provenance class.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RouteSpecError, digestValue, z } from '@routespec/contracts';
import { compileScenario } from '@routespec/scenario';
import { EXPLORER_API_SPEC, EXPLORER_ENDPOINT, EXPLORER_STATUSES, isIsoInstant } from './explorer-shape.ts';
import type { ImportSummary } from './import.ts';
import { INCIDENT_CLASSES, STUCK_THRESHOLDS_SEC, TemplateDescriptor } from './sanitize.ts';
import {
  observedStatusesOf,
  renderScenario,
  scenarioIdFor,
  scriptedStatusesOf,
  undecidableInvariantsOf,
  type RenderContext,
} from './templates.ts';

export const MANIFEST_VERSION = 'routespec.observed-corpus/1' as const;
export const MAINNET_CORPUS_LABEL = 'mainnet-observed-2026-11' as const;
export const FIXTURE_CORPUS_LABEL = 'explorer-shape-fixture' as const;
export const MAINNET_LABEL_PATTERN = /^mainnet-observed-(20\d{2})-(0[1-9]|1[0-2])$/;

const Count = z.number().int().min(0).max(1_000_000_000);
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Instant = z.string().refine(isIsoInstant, 'expected an ISO 8601 UTC instant');
const Histogram = z.record(z.string().regex(/^[A-Z][A-Z_]{1,47}$/), Count);
const ScenarioId = z.string().regex(/^(obs|shape)-[a-z0-9-]{3,59}$/);

const TemplateEntry = z
  .object({
    scenarioId: ScenarioId,
    file: z.string().regex(/^scenarios\/(obs|shape)-[a-z0-9-]{3,59}\.yaml$/),
    /** Swaps that produced this descriptor. */
    count: Count.min(1),
    descriptor: TemplateDescriptor,
    observedStatuses: z.array(z.enum(EXPLORER_STATUSES)).max(4),
    scriptedStatuses: z.array(z.enum(EXPLORER_STATUSES)).max(4),
    /** Invariants left out of this case's required set by default (see `undecidableInvariantsOf`). */
    undecidableInvariants: z.array(z.string().regex(/^INV-(0[1-9]|1[0-2])$/)).max(12),
    revisionDigest: Digest,
  })
  .strict();

const ManifestBody = z
  .object({
    manifestVersion: z.literal(MANIFEST_VERSION),
    corpusLabel: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    importStatus: z.enum(['PENDING_LIVE_IMPORT', 'IMPORTED']),
    source: z
      .object({
        kind: z.enum(['INTENTS_EXPLORER_API', 'DOCUMENTED_SHAPE_FIXTURE']),
        network: z.enum(['mainnet', 'none']),
        endpoint: z.literal(EXPLORER_ENDPOINT),
        apiSpecDigest: z.literal(EXPLORER_API_SPEC.sha256),
      })
      .strict(),
    scenarioProvenanceClass: z.enum(['ISSUE_DERIVED_NOT_REPRODUCED', 'OFFICIAL_SPEC_DERIVED']),
    window: z.object({ startTimestamp: Instant.nullable(), endTimestamp: Instant.nullable() }).strict(),
    observedAtHour: Instant.nullable(),
    recheckedAtHour: Instant.nullable(),
    stuckAfterSec: z
      .number()
      .int()
      .refine((n) => STUCK_THRESHOLDS_SEC.includes(n)),
    statusesQueried: z.array(z.enum(EXPLORER_STATUSES)).max(EXPLORER_STATUSES.length),
    counts: z
      .object({
        recordsRead: Count,
        pagesRead: Count,
        truncated: z.boolean(),
        rejectedShape: Count,
        documentedShapeDeviations: Count,
        duplicates: Count,
        notIncident: z.object({ ordinarySuccess: Count, inFlightYoung: Count, unusedQuote: Count }).strict(),
        incidents: Count,
        byClass: z.object(Object.fromEntries(INCIDENT_CLASSES.map((c) => [c, Count]))).strict(),
        byRefundReason: Histogram,
        byDepositType: Histogram,
        byRecipientType: Histogram,
        byRefundType: Histogram,
        rechecked: Count,
        recheckNotFound: Count,
        recheckSkipped: Count,
        rateLimited: Count,
      })
      .strict(),
    templates: z.array(TemplateEntry).max(1024),
  })
  .strict();

export const ObservedCorpusManifest = ManifestBody.extend({ manifestDigest: Digest }).strict();
export type ObservedCorpusManifest = z.infer<typeof ObservedCorpusManifest>;
type ManifestBody = z.infer<typeof ManifestBody>;

export interface ObservedCorpus {
  readonly manifest: ObservedCorpusManifest;
  /** Scenario source by manifest-relative file path. */
  readonly files: Readonly<Record<string, string>>;
}

function fail(
  code: 'RS_MODE_POLICY_DENIED' | 'RS_IDENTITY_MISMATCH' | 'RS_SCHEMA_INVALID',
  message: string,
  details: Record<string, string | number> = {},
): never {
  throw new RouteSpecError(code, message, { details });
}

function manifestDigestOf(body: ManifestBody): string {
  return digestValue('routespec.observed-corpus.manifest/1', body);
}

function seal(body: ManifestBody): ObservedCorpusManifest {
  const parsed = ManifestBody.parse(body);
  return { ...parsed, manifestDigest: manifestDigestOf(parsed) };
}

function contextFor(label: string, kind: ManifestBody['source']['kind']): RenderContext {
  return kind === 'INTENTS_EXPLORER_API'
    ? { idPrefix: 'obs', provenanceClass: 'ISSUE_DERIVED_NOT_REPRODUCED', corpusLabel: label }
    : { idPrefix: 'shape', provenanceClass: 'OFFICIAL_SPEC_DERIVED', corpusLabel: label };
}

/** A label may say "mainnet" exactly when the records were read from the real service. */
function assertLabel(label: string, kind: ManifestBody['source']['kind']): void {
  const mainnetLabel = MAINNET_LABEL_PATTERN.test(label);
  if (kind === 'INTENTS_EXPLORER_API' && !mainnetLabel) {
    fail(
      'RS_MODE_POLICY_DENIED',
      'Records read from the real service must be labelled mainnet-observed-YYYY-MM.',
    );
  }
  if (kind === 'DOCUMENTED_SHAPE_FIXTURE' && (mainnetLabel || label.includes('mainnet'))) {
    fail('RS_MODE_POLICY_DENIED', 'Fixture data cannot carry a mainnet label.');
  }
}

/** The manifest of a mainnet corpus whose live import has not run: no records, no cases. */
export function pendingManifest(label: string): ObservedCorpusManifest {
  assertLabel(label, 'INTENTS_EXPLORER_API');
  return seal({
    manifestVersion: MANIFEST_VERSION,
    corpusLabel: label,
    importStatus: 'PENDING_LIVE_IMPORT',
    source: {
      kind: 'INTENTS_EXPLORER_API',
      network: 'mainnet',
      endpoint: EXPLORER_ENDPOINT,
      apiSpecDigest: EXPLORER_API_SPEC.sha256,
    },
    scenarioProvenanceClass: 'ISSUE_DERIVED_NOT_REPRODUCED',
    window: { startTimestamp: null, endTimestamp: null },
    observedAtHour: null,
    recheckedAtHour: null,
    stuckAfterSec: STUCK_THRESHOLDS_SEC[0] as number,
    statusesQueried: [],
    counts: {
      recordsRead: 0,
      pagesRead: 0,
      truncated: false,
      rejectedShape: 0,
      documentedShapeDeviations: 0,
      duplicates: 0,
      notIncident: { ordinarySuccess: 0, inFlightYoung: 0, unusedQuote: 0 },
      incidents: 0,
      byClass: { STUCK: 0, REFUNDED: 0, FAILED: 0, LATE_SUCCESS: 0 },
      byRefundReason: {},
      byDepositType: {},
      byRecipientType: {},
      byRefundType: {},
      rechecked: 0,
      recheckNotFound: 0,
      recheckSkipped: 0,
      rateLimited: 0,
    },
    templates: [],
  });
}

/** Turn an import summary into a corpus: one scenario template per distinct descriptor. */
export function buildCorpus(summary: ImportSummary, options: { label: string }): ObservedCorpus {
  assertLabel(options.label, summary.sourceKind);
  const ctx = contextFor(options.label, summary.sourceKind);
  const files: Record<string, string> = {};
  const templates = summary.observations
    .map(({ descriptor, count }) => {
      const scenarioId = scenarioIdFor(descriptor, ctx.idPrefix);
      const file = `scenarios/${scenarioId}.yaml`;
      const source = renderScenario(descriptor, ctx);
      files[file] = source;
      return {
        scenarioId,
        file,
        count,
        descriptor,
        observedStatuses: observedStatusesOf(descriptor),
        scriptedStatuses: scriptedStatusesOf(descriptor),
        undecidableInvariants: undecidableInvariantsOf(descriptor),
        revisionDigest: compileScenario(source).revisionDigest,
      };
    })
    .sort((a, b) => (a.scenarioId < b.scenarioId ? -1 : a.scenarioId > b.scenarioId ? 1 : 0));
  const live = summary.sourceKind === 'INTENTS_EXPLORER_API';
  const manifest = seal({
    manifestVersion: MANIFEST_VERSION,
    corpusLabel: options.label,
    importStatus: live ? 'IMPORTED' : 'PENDING_LIVE_IMPORT',
    source: {
      kind: summary.sourceKind,
      network: live ? 'mainnet' : 'none',
      endpoint: EXPLORER_ENDPOINT,
      apiSpecDigest: EXPLORER_API_SPEC.sha256,
    },
    scenarioProvenanceClass: ctx.provenanceClass,
    window: summary.window,
    observedAtHour: summary.observedAtHour,
    recheckedAtHour: summary.recheckedAtHour,
    stuckAfterSec: summary.stuckAfterSec,
    statusesQueried: [...summary.statusesQueried],
    counts: summary.counts,
    templates,
  });
  return { manifest, files };
}

function isPendingEmpty(m: ObservedCorpusManifest): boolean {
  return m.importStatus === 'PENDING_LIVE_IMPORT' && m.templates.length === 0;
}

/**
 * Write a corpus directory. An existing corpus is replaced only when it is the empty pending
 * placeholder or `replace` is set; any other non-empty directory is refused.
 */
export function writeCorpusDir(
  dir: string,
  corpus: ObservedCorpus,
  options: { replace?: boolean } = {},
): void {
  const manifestPath = join(dir, 'manifest.json');
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) {
      throw new RouteSpecError('RS_EXPORT_PATH_INVALID', 'Corpus output path is not a directory.');
    }
    const entries = readdirSync(dir);
    const known = entries.every((e) => e === 'manifest.json' || e === 'scenarios');
    let replaceable = entries.length === 0;
    if (!replaceable && known && existsSync(manifestPath)) {
      replaceable = options.replace === true;
      if (!replaceable) {
        try {
          replaceable = isPendingEmpty(readManifest(dir));
        } catch {
          replaceable = false;
        }
      }
    }
    if (!replaceable) {
      throw new RouteSpecError(
        'RS_EXPORT_OVERWRITE_DENIED',
        'Corpus output directory already holds a corpus or other files; use --replace for a corpus.',
      );
    }
    rmSync(join(dir, 'scenarios'), { recursive: true, force: true });
  }
  mkdirSync(join(dir, 'scenarios'), { recursive: true });
  for (const [file, source] of Object.entries(corpus.files)) {
    writeFileSync(join(dir, file), source, { encoding: 'utf8' });
  }
  writeFileSync(manifestPath, `${JSON.stringify(corpus.manifest, null, 2)}\n`, { encoding: 'utf8' });
}

function readManifest(dir: string): ObservedCorpusManifest {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size > 4 * 1024 * 1024) {
    throw new RouteSpecError('RS_NOT_FOUND', 'Corpus manifest not found.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('RS_SCHEMA_INVALID', 'Corpus manifest is not valid JSON.');
  }
  const parsed = ObservedCorpusManifest.safeParse(raw);
  if (!parsed.success) {
    fail('RS_SCHEMA_INVALID', 'Corpus manifest does not match the closed manifest schema.', {
      issues: parsed.error.issues.length,
      first: parsed.error.issues[0]?.path.join('.').slice(0, 96) ?? '',
    });
  }
  return parsed.data;
}

export interface VerifiedCorpus {
  readonly manifest: ObservedCorpusManifest;
  /** Scenario sources in manifest order, each proven to be the rendering of its descriptor. */
  readonly scenarios: ReadonlyArray<{ readonly scenarioId: string; readonly source: string }>;
}

/** Read a corpus directory and prove it is internally consistent and free of foreign content. */
export function verifyCorpusDir(dir: string): VerifiedCorpus {
  const manifest = readManifest(dir);
  const { manifestDigest, ...body } = manifest;
  if (manifestDigestOf(body) !== manifestDigest) {
    fail('RS_IDENTITY_MISMATCH', 'Corpus manifest does not reproduce its digest.');
  }
  const kind = manifest.source.kind;
  assertLabel(manifest.corpusLabel, kind);
  const live = kind === 'INTENTS_EXPLORER_API';
  const ctx = contextFor(manifest.corpusLabel, kind);
  const bad = (rule: string): never =>
    fail('RS_IDENTITY_MISMATCH', 'Corpus manifest is inconsistent.', { rule });
  if (manifest.scenarioProvenanceClass !== ctx.provenanceClass) bad('provenance-class');
  if (manifest.source.network !== (live ? 'mainnet' : 'none')) bad('network');
  if (manifest.importStatus === 'IMPORTED' && !live) bad('imported-requires-live-source');
  if (live && manifest.importStatus === 'PENDING_LIVE_IMPORT') {
    if (
      manifest.templates.length !== 0 ||
      manifest.counts.recordsRead !== 0 ||
      manifest.observedAtHour !== null
    ) {
      bad('pending-must-be-empty');
    }
  } else if (manifest.observedAtHour === null) bad('observation-time-missing');
  const c = manifest.counts;
  const n = c.notIncident;
  if (
    c.recordsRead !==
    c.rejectedShape + c.duplicates + n.ordinarySuccess + n.inFlightYoung + n.unusedQuote + c.incidents
  ) {
    bad('records-not-accounted');
  }
  if (Object.values(c.byClass).reduce((a, b) => a + b, 0) !== c.incidents) bad('class-counts');
  if (manifest.templates.reduce((a, t) => a + t.count, 0) !== c.incidents) bad('template-counts');
  const ids = manifest.templates.map((t) => t.scenarioId);
  if ([...ids].sort().join('\n') !== ids.join('\n') || new Set(ids).size !== ids.length)
    bad('template-order');

  const scenarioDir = join(dir, 'scenarios');
  const present = existsSync(scenarioDir) ? readdirSync(scenarioDir).sort() : [];
  const expected = manifest.templates.map((t) => t.file.slice('scenarios/'.length)).sort();
  if (present.join('\n') !== expected.join('\n')) bad('scenario-files');
  const stray = readdirSync(dir).filter((e) => e !== 'manifest.json' && e !== 'scenarios');
  if (stray.length > 0) bad('stray-files');

  const scenarios = manifest.templates.map((t) => {
    if (scenarioIdFor(t.descriptor, ctx.idPrefix) !== t.scenarioId) bad('scenario-id');
    if (t.file !== `scenarios/${t.scenarioId}.yaml`) bad('scenario-file-name');
    const rendered = renderScenario(t.descriptor, ctx);
    const onDisk = readFileSync(join(dir, t.file), 'utf8').replace(/\r\n/g, '\n');
    if (onDisk !== rendered) {
      fail('RS_IDENTITY_MISMATCH', 'A scenario file is not the rendering of its descriptor.', {
        scenarioId: t.scenarioId,
      });
    }
    if (compileScenario(rendered).revisionDigest !== t.revisionDigest) bad('revision-digest');
    if (JSON.stringify(observedStatusesOf(t.descriptor)) !== JSON.stringify(t.observedStatuses))
      bad('observed-statuses');
    if (JSON.stringify(scriptedStatusesOf(t.descriptor)) !== JSON.stringify(t.scriptedStatuses))
      bad('scripted-statuses');
    if (JSON.stringify(undecidableInvariantsOf(t.descriptor)) !== JSON.stringify(t.undecidableInvariants)) {
      bad('undecidable-invariants');
    }
    return { scenarioId: t.scenarioId, source: rendered };
  });
  return { manifest, scenarios };
}
