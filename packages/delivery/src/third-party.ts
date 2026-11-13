/**
 * M48: run the pinned third-party example clients through RouteSpec, contained only.
 *
 * For every pin in `examples/third-party/pins.json` this starts the real control service with
 * containment and the reviewed attesting launcher, registers the pin's adapter
 * (`examples/third-party/<id>/adapter.ts`) as a build, and runs it through the core scenarios
 * below with `contained-start`: the adapter and the example it imports run inside the subject
 * container (no network, read-only root, no capabilities, non-root), and reach only the RouteSpec
 * proxy through the launcher's tunnel. Every verdict in the record is the invariant kernel's
 * result over what the example actually sent; nothing here states or expects a verdict.
 *
 * There is no uncontained mode. Without a usable container engine and image, or without the
 * verified pinned files on disk, nothing is launched and the command exits 2.
 *
 * usage: node --no-warnings packages/delivery/src/third-party.ts --work <dir> --out <json> [--only <id>]
 */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  containerCliFromEnv,
  containerToolchainDigest,
  detectContainerRuntime,
  interceptorArtifactDigest,
  launcherArtifactDigest,
} from '@routespec/containment';
import { CORE_SCENARIO_SOURCES } from '@routespec/scenario';
import {
  loadPins,
  sourceDir,
  verifySourceTree,
  type PinnedSource,
} from '../../../examples/third-party/support/pins.ts';
import { offlineEnv } from './clean-install.ts';
import { ControlProcess, type J } from './control.ts';
import { fileDigest, sha256 } from './identity.ts';
import { quoteBody } from './subjects.ts';

export const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
/** Core scenarios every pinned example is run through, in corpus order. */
export const SCENARIOS = ['happy-path', 'accepted-then-lost-response'] as const;
const REQUIRED_INVARIANTS = ['INV-01', 'INV-02', 'INV-03', 'INV-04'];
const SINK = 'fulfilment-canary';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ThirdPartyUnavailable extends Error {
  readonly reason: string;
  constructor(reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'ThirdPartyUnavailable';
    this.reason = reason;
  }
}

export interface ThirdPartyOptions {
  readonly work: string;
  readonly root?: string;
  /** Run only this pin id. */
  readonly only?: string;
}

export function adapterScript(root: string, pin: PinnedSource): string {
  return join(root, 'examples', 'third-party', pin.id, 'adapter.ts');
}

function gitHead(root: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

/** What may be launched, checked before anything starts: pins selected and their files verified. */
export function selectVerifiedPins(root: string, only?: string): readonly PinnedSource[] {
  const pins = loadPins(join(root, 'examples', 'third-party', 'pins.json')).filter(
    (p) => only === undefined || p.id === only,
  );
  if (pins.length === 0)
    throw new ThirdPartyUnavailable('THIRD_PARTY_PIN_UNKNOWN', 'no pinned source matches');
  for (const pin of pins) {
    const check = verifySourceTree(sourceDir(root, pin), pin);
    if (!check.ok) {
      throw new ThirdPartyUnavailable(
        check.findings[0] === 'SOURCES_ABSENT' ? 'THIRD_PARTY_SOURCES_ABSENT' : 'THIRD_PARTY_SOURCES_DIFFER',
        `${pin.id}: ${check.findings.join('; ')}`,
      );
    }
  }
  return pins;
}

export async function runThirdParty(options: ThirdPartyOptions): Promise<J> {
  const root = resolve(options.root ?? ROOT);
  const work = resolve(options.work);
  const data = join(work, 'data');
  mkdirSync(data, { recursive: true });
  const pins = selectVerifiedPins(root, options.only);

  // --- Containment is a precondition, never an option ----------------------------------------
  const rt = await detectContainerRuntime({ cli: containerCliFromEnv(process.env) });
  if (rt.status !== 'AVAILABLE') throw new ThirdPartyUnavailable(rt.reason, rt.detail);
  const keyDir = join(work, 'launcher');
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const keys = generateKeyPairSync('ed25519');
  const keyPath = join(keyDir, 'launcher-key.pem');
  writeFileSync(keyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const jwk = keys.publicKey.export({ format: 'jwk' });
  const launcherKeyJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
  const launcherScript = join(root, 'packages', 'containment', 'src', 'attesting-launcher.ts');
  const toolchainDigest = containerToolchainDigest(rt.imageId);
  const extraArgs = [
    '--subject-root',
    root,
    '--container-cli',
    JSON.stringify(rt.cli.argv),
    '--container-image',
    rt.imageRef,
    '--launcher',
    launcherScript,
    '--launcher-key',
    keyPath,
  ];
  const fixedPort = process.env['ROUTESPEC_DELIVERY_PORT'];
  if (fixedPort !== undefined && /^\d{2,5}$/.test(fixedPort)) extraArgs.push('--port', fixedPort);

  const control = await ControlProcess.start({ root, data, env: offlineEnv(), extraArgs });
  const api = (m: string, p: string, b?: unknown, ifMatch?: number) => control.api(m, p, b, ifMatch);
  try {
    const commit = gitHead(root);
    const project = await api('POST', '/projects', { name: 'Third-party example clients (M48)' });
    const projectId = String(project['projectId']);
    const now = Date.now();

    // --- Launcher principal, interceptor profile, and its (local test) review -----------------
    const enroll = {
      projectId,
      label: 'operator launcher (contained third-party examples)',
      policy: {
        kind: 'LOCAL_LAUNCHER_KEY',
        publicKeyJwk: launcherKeyJwk,
        launcherArtifactDigest: launcherArtifactDigest(launcherScript),
        peerBinding: 'INHERITED_IPC_CHILD',
        validFromMs: now - 60_000,
        validUntilMs: now + 24 * 3_600_000,
        maxFreshnessMs: 6 * 3_600_000,
      },
    };
    const pending = await api('POST', '/attester-principals', enroll);
    const notice = await control.confirmation(String(pending['confirmationId']));
    const enrolled = await api('POST', '/attester-principals', {
      ...enroll,
      confirmation: { confirmationId: notice.confirmationId, code: notice.code },
    });
    const principalId = String(enrolled['principalId']);
    const profile = await api('POST', '/interceptor-profiles', {
      projectId,
      interceptorArtifactDigest: interceptorArtifactDigest(
        join(root, 'packages', 'proxy', 'src', 'interceptor', 'canary-interceptor.ts'),
      ),
      containment: 'PROCESS_TREE_ENFORCED',
      processTreeScope: 'linux-container:network-none:read-only-root:cap-drop-all:no-new-privileges:init',
      supportedSinks: [SINK],
      denialMechanism: 'CANARY_REDIRECT',
    });
    const interceptorProfileDigest = String(profile['profileDigest']);
    // As in the M16 journey: a locally enrolled TEST reviewer with its own key signs the profile
    // review. This is the real review workflow, not an independent human review (NOT_RUN).
    const reviewerKeys = generateKeyPairSync('ed25519');
    const reviewerEnroll = {
      projectId,
      label: 'local test reviewer (not independent)',
      publicKeyJwk: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: String(reviewerKeys.publicKey.export({ format: 'jwk' }).x),
      },
      validFromMs: now - 60_000,
      validUntilMs: now + 24 * 3_600_000,
    };
    const pendingReviewer = await api('POST', '/profile-reviewers', reviewerEnroll);
    const reviewerNotice = await control.confirmation(String(pendingReviewer['confirmationId']));
    const reviewer = await api('POST', '/profile-reviewers', {
      ...reviewerEnroll,
      confirmation: { confirmationId: reviewerNotice.confirmationId, code: reviewerNotice.code },
    });
    const challenge = await api(
      'POST',
      `/interceptor-profiles/${String(profile['profileId'])}/review-challenges`,
      {
        reviewerId: reviewer['reviewerId'],
        decision: 'APPROVED',
        checklist: {
          ARTIFACT_DIGEST_VERIFIED: true,
          PROCESS_TREE_SCOPE_CONFINES_SUBJECT: true,
          SUPPORTED_SINKS_COMPLETE: true,
          DENIAL_MECHANISM_HAS_NO_EFFECT: true,
          PRIVATE_CHANNEL_ISOLATED_FROM_SUBJECT: true,
        },
      },
    );
    await api('POST', `/profile-review-challenges/${String(challenge['challengeId'])}/complete`, {
      signature: sign(
        null,
        Buffer.from(String(challenge['signingPayload']), 'base64url'),
        reviewerKeys.privateKey,
      ).toString('base64url'),
    });

    const revision = await api('POST', `/projects/${projectId}/revisions`, {
      revisionLabel: 'third-party-examples',
      commitSha: commit,
      configurationDigest: fileDigest(join(root, 'examples', 'third-party', 'pins.json')),
      protocolProfileId: 'oneclick-v0@1.0.0',
      metadata: {},
    });
    const integrationRevisionId = String(revision['integrationRevisionId']);
    const scenarioRevisionIds: string[] = [];
    for (const name of SCENARIOS) {
      const s = await api('POST', '/scenarios', { projectId, source: CORE_SCENARIO_SOURCES[name] as string });
      scenarioRevisionIds.push(String(s['scenarioRevisionId']));
    }
    const corpus = await api('POST', '/corpora', {
      projectId,
      label: 'third-party-examples',
      cases: scenarioRevisionIds.map((scenarioRevisionId) => ({
        scenarioRevisionId,
        requiredInvariants: REQUIRED_INVARIANTS,
        severity: 'HIGH',
        gatePolicy: 'REQUIRED',
      })),
    });
    const corpusRevisionId = String(corpus['corpusRevisionId']);
    const gate = await api('POST', '/gates', {
      projectId,
      name: 'third-party examples gate',
      corpusRevisionId,
      enforcementMode: 'LOCAL_ADVISORY',
      buildAttestationPolicy: 'REQUIRE_TRUSTED',
    });
    const gateId = String(gate['gateId']);

    const sources: J[] = [];
    for (const pin of pins) {
      const script = adapterScript(root, pin);
      const effects = script.replace(/\.ts$/, '.effects.json');
      const artifactDigest = fileDigest(script);
      const build = await api('POST', `/projects/${projectId}/builds`, {
        integrationRevisionId,
        repositoryLocator: `git+file:${relative(root, script).split('\\').join('/')}`,
        commitSha: commit,
        dirtyTreeDigest: null,
        artifactDigest,
        toolchainDigest,
        lockDigest: fileDigest(join(root, 'pnpm-lock.yaml')),
        effectManifestDigest: fileDigest(effects),
        launchRecipeDigest: sha256(`node --no-warnings examples/third-party/${pin.id}/adapter.ts`),
        ciWorkflowRunId: null,
      });
      const buildRevisionId = String(build['buildRevisionId']);
      const attestation = await api('POST', '/launcher-challenges', {
        scope: 'BUILD_REGISTRATION',
        projectId,
        principalId,
        buildRevisionId,
      });
      const attestationId = String(attestation['attestationId']);
      const manifest = await api('POST', '/effect-manifests', {
        projectId,
        buildRevisionId,
        artifactDigest,
        adapterRevision: 'routespec-adapter@1.0.0',
        hooks: (JSON.parse(readFileSync(effects, 'utf8')) as J)['hooks'],
      });
      const manifestDigest = String(manifest['manifestDigest']);
      const policies: string[] = [];
      for (const scenarioRevisionId of scenarioRevisionIds) {
        const p = await api('POST', '/effect-coverage-policies', {
          projectId,
          buildRevisionId,
          artifactDigest,
          selectedAttestationId: attestationId,
          scenarioRevisionId,
          manifestDigest,
          requiredSinkClasses: [SINK],
          interceptorProfileDigest,
          callsiteInventoryDigest: null,
          basis: 'INDEPENDENT_BOUNDARY_INTERCEPT',
        });
        policies.push(String(p['policyDigest']));
      }
      const g = await api('POST', '/gate-runs', {
        projectId,
        gateId,
        buildRevisionId,
        artifactDigest,
        corpusRevisionId,
        effectManifestDigest: manifestDigest,
        effectCoveragePolicyDigest: policies[0],
        callsiteInventoryDigest: null,
        interceptorProfileDigest,
        buildAttestation: { subjectAttestationId: attestationId },
        mode: 'SIMULATE',
        maxParallelCases: 1,
        casePolicies: scenarioRevisionIds.slice(1).map((scenarioRevisionId, i) => ({
          scenarioRevisionId,
          effectCoveragePolicyDigest: policies[i + 1],
        })),
      });
      const gateRunId = String(g['gateRunId']);
      const validated = await api('POST', `/gate-runs/${gateRunId}/validate`, {}, Number(g['revision']));
      await api('POST', `/gate-runs/${gateRunId}/start`, {}, Number((validated['gateRun'] as J)['revision']));
      const listCases = async () =>
        (await api('GET', `/gate-runs/${gateRunId}/cases?limit=200`))['items'] as J[];

      const cases: J[] = [];
      for (const c of await listCases()) {
        const caseRunId = String(c['caseRunId']);
        const logicalJob = `third-party-${pin.id}-${String(c['ordinal'])}`.slice(0, 120);
        const started = await api('POST', `/case-runs/${caseRunId}/contained-start`, {
          attesterPrincipalId: principalId,
          job: { logicalJob, quote: quoteBody(), txHash: `sim-tx-${String(c['ordinal'])}` },
        });
        let live = (started['live'] ?? null) as J | null;
        const deadline = Date.now() + 280_000;
        while (
          live !== null &&
          (live['job'] === 'RUNNING' || live['job'] === 'STARTING') &&
          Date.now() < deadline
        ) {
          await sleep(250);
          live = ((await api('GET', `/case-runs/${caseRunId}/containment`))['live'] ?? null) as J | null;
        }
        await api('POST', `/case-runs/${caseRunId}/finish-input`, {});
        const view = (await listCases()).find((x) => x['caseRunId'] === caseRunId) as J;
        const after = await api('GET', `/case-runs/${caseRunId}/containment`);
        const runOperationIds = (view['runOperationIds'] as string[]) ?? [];
        const invariants: J[] = [];
        for (const id of runOperationIds) {
          const op = await api('GET', `/run-operations/${id}`);
          for (const inv of op['invariants'] as J[]) {
            invariants.push({
              runOperationId: id,
              invariantId: inv['invariantId'],
              status: inv['status'],
              facts: inv['facts'] ?? [],
              missingPredicates: inv['missingPredicates'] ?? [],
            });
          }
        }
        cases.push({
          caseRunId,
          ordinal: view['ordinal'],
          scenarioName: view['scenarioName'],
          lifecycle: view['lifecycle'],
          verdict: view['verdict'],
          evidence: view['evidence'],
          effectCoverage: view['effectCoverage'],
          runOperationIds,
          invariants,
          tokenReturnedOverHttp: started['token'] !== null,
          tokenDelivery: started['tokenDelivery'],
          subject: {
            job: live?.['job'] ?? null,
            error: live?.['error'] ?? null,
            outcomeClass: 'SUBJECT_REPORTED',
            outcome: live?.['subjectOutcome'] ?? null,
          },
          containment: { live, records: after['records'], runtime: after['runtime'] },
        });
      }
      const evaluation = await api('POST', `/gates/${gateId}/evaluate`, { gateRunId });
      const gateRun = await api('GET', `/gate-runs/${gateRunId}`);
      sources.push({
        id: pin.id,
        repository: pin.repository,
        standing: pin.standing,
        commit: pin.commit,
        licence: pin.licence,
        entry: pin.entry,
        files: pin.files,
        sourcesVerified: true,
        adapter: { path: relative(root, script).split('\\').join('/'), artifactDigest },
        buildAttestationId: attestationId,
        gate: {
          gateRunId,
          decision: evaluation['decision'],
          decisionDigest: evaluation['decisionDigest'] ?? null,
          gateRunVerdict: gateRun['verdict'],
        },
        cases,
      });
    }
    return {
      schema: 'routespec.third-party-run/1',
      generatedAt: new Date().toISOString(),
      routespecCommit: commit,
      mode: 'SIMULATE',
      scenarios: SCENARIOS,
      containment: {
        mode: 'CONTAINED',
        engine: rt.engine,
        serverVersion: rt.serverVersion,
        serverOs: rt.serverOs,
        imageRef: rt.imageRef,
        imageId: rt.imageId,
        imageNodeVersion: rt.imageNodeVersion,
        profileReview: { reviewer: 'LOCAL_TEST_REVIEWER', independentHumanReview: 'NOT_RUN' },
      },
      sources,
    };
  } finally {
    await control.stop();
  }
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : JSON.stringify(value ?? null);
}

/** Plain-text summary of a run record: what each example did and what the kernel returned. */
export function summarize(record: J): string {
  const lines: string[] = [];
  const containment = record['containment'] as J;
  lines.push(`containment ${text(containment['mode'])} (${text(containment['imageRef'])})`);
  for (const source of record['sources'] as J[]) {
    lines.push(
      `${text(source['id'])}: ${text(source['repository'])} @ ${text(source['commit']).slice(0, 12)} ` +
        `(${text((source['licence'] as J)['spdx'])}) gate decision ${text((source['gate'] as J)['decision'])}`,
    );
    for (const c of source['cases'] as J[]) {
      const subject = c['subject'] as J;
      const outcome = (subject['outcome'] ?? {}) as J;
      const calls = ((outcome['sdkCalls'] ?? []) as J[])
        .map(
          (k) =>
            `${text(k['method'])} ${text(k['outcome'])}${k['status'] === null ? '' : ` ${text(k['status'])}`}${k['code'] === null ? '' : ` ${text(k['code'])}`}`,
        )
        .join(', ');
      const invariants = (c['invariants'] as J[]).map(
        (i) => `${text(i['invariantId'])} ${text(i['status'])}`,
      );
      lines.push(
        `  case ${text(c['ordinal'])} ${text(c['scenarioName'])}: verdict ${text(c['verdict'])} | ` +
          `subject ${text(subject['job'])} ${text(outcome['result'] ?? subject['error'])} | ` +
          `sdk calls: ${calls === '' ? 'none' : calls} | run operations ${String((c['runOperationIds'] as unknown[]).length)} | ` +
          `invariants: ${invariants.length === 0 ? 'none evaluated' : invariants.join(', ')}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const work = arg('work');
  const out = arg('out');
  if (work === undefined || out === undefined) {
    process.stderr.write('usage: third-party.ts --work <dir> --out <json> [--only <id>]\n');
    process.exit(2);
  }
  const only = arg('only');
  try {
    const record = await runThirdParty({ work, ...(only === undefined ? {} : { only }) });
    mkdirSync(resolve(out, '..'), { recursive: true });
    writeFileSync(resolve(out), `${JSON.stringify(record, null, 2)}\n`);
    process.stdout.write(summarize(record));
  } catch (error) {
    if (error instanceof ThirdPartyUnavailable) {
      process.stderr.write(`third-party examples: NOT_RUN ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
}
