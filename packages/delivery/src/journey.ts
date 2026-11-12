/**
 * The full local product journey (M12, RP-02..RP-06 and RP-08, T-055), run from an installed
 * checkout against its own built artifacts.
 *
 * Roles. This driver plays the integrator and the operator: it registers records through the
 * public control API, starts each subject build as its own process, delivers credentials over
 * that process's IPC pipe, and reads results. The product is everything else: the control
 * service process (M08) with its journal (M01), networkless proxy and case supervisor (M02),
 * scenario runtime (M03), kernel (M04), capture-to-regression pipeline (M05), gate service,
 * reports and bundles (M06), console (M09), and the `routespec` CLI. No journal row is written
 * directly, no verdict is supplied, and no response is hand-written.
 *
 * Journey:
 *  1. register a project, revision, the baseline build (its own artifact digest), an effect
 *     manifest with a REQUIRED no-effect canary sink, and a declared-hooks-only coverage policy
 *     (the only basis this host can offer: there is no process-tree sandbox or interceptor);
 *  2. run the baseline build through the accepted-then-lost-response schedule: the kernel
 *     reports the unsafe resubmission;
 *  3. in a separate case, prove fenced recovery with single SDK calls: stale execution token,
 *     second mutation under the reconciliation token, and a read-only status under it;
 *  4. capture the failing case, quarantine, sanitize, map, replay-verify, review, and promote it
 *     to a new scenario and a new corpus;
 *  5. rerun the original build on the new corpus (it still fails) and the corrected build
 *     (a different artifact, new manifest and policy, fresh client per case);
 *  6. compare CLI, API, and console views of the same persisted records;
 *  7. export a checksummed bundle, crash the service and restart it from the same data,
 *     then verify the bundle in a clean location with no journal.
 *
 * Contained mode (M14, `--contained`): the control service is started with a subject root, the
 * configured container engine, and the reviewed attesting launcher. The driver enrolls the
 * operator's launcher key (with the local confirmation delivered over the operator channel),
 * registers each build with the container-image toolchain and its declared effect file, has the
 * launcher attest the build registration, registers an independent interceptor profile that
 * requires process-tree containment, and selects INDEPENDENT_BOUNDARY_INTERCEPT policies (one per
 * scenario). Every subject case then runs through `contained-start`: the service launches the
 * build inside the container, the launcher attests the case and interceptor launches, and the
 * subject's tokens never reach this driver.
 *
 *   node packages/delivery/src/journey.ts --work <dir> --out <json> [--commit <sha>] [--no-ui]
 *        [--contained]
 */
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeCanary, scanTree, type Canary } from '@routespec/hardening';
import { CORE_SCENARIO_SOURCES } from '@routespec/scenario';
import {
  containerCliFromEnv,
  containerToolchainDigest,
  detectContainerRuntime,
  interceptorArtifactDigest,
  launcherArtifactDigest,
} from '@routespec/containment';
import { ControlProcess, type J } from './control.ts';
import { fileDigest, sha256 } from './identity.ts';
import { offlineEnv } from './clean-install.ts';
import {
  SubjectProcess,
  buildArtifactDigest,
  buildScript,
  credentialsOf,
  probeScript,
  quoteBody,
  type Build,
} from './subjects.ts';

export const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const SCENARIO = 'accepted-then-lost-response';
const REQUIRED_INVARIANTS = ['INV-01', 'INV-02', 'INV-03', 'INV-04'];
const SINK = 'fulfilment-canary';
const WAITS_FOR_RECONCILIATION: Readonly<Record<Build, boolean>> = {
  'baseline-client': false,
  'corrected-client': true,
};

export interface JourneyOptions {
  readonly root?: string;
  readonly work: string;
  readonly commit?: string;
  readonly ui?: boolean;
  /** Run every subject case confined in a container with attested launches (M14). */
  readonly contained?: boolean;
}

interface Registered {
  buildRevisionId: string;
  artifactDigest: string;
  manifestDigest: string;
  policyDigest: string;
  /** BUILD_REGISTRATION attestation (contained mode). */
  attestationId: string | null;
  /** Effect-coverage policy per scenario revision (contained mode: one per scenario). */
  policies: Map<string, string>;
}

interface CaseOutcome {
  caseRunId: string;
  ordinal: number;
  scenarioName: string;
  lineageRole: string;
  build: Build;
  subjectPid: number;
  clientInstanceId: string;
  startEpoch: number;
  recovery: J | null;
  jobOutcome: J;
  lifecycle: string;
  verdict: string;
  fencingEpoch: number;
  evidence: unknown;
  effectCoverage: unknown;
  containment: J | null;
  runOperationIds: string[];
  invariants: Array<{ invariantId: string; status: string; facts: string[]; missingPredicates: string[] }>;
}

interface GateOutcome {
  label: string;
  gateId: string;
  gateRunId: string;
  build: Build;
  corpusRevisionId: string;
  cases: CaseOutcome[];
  gateEvaluationId: string;
  decision: string;
  decisionDigest: string | null;
  apiGateRunVerdict: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gitHead(root: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function runNode(
  root: string,
  script: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ exitCode: number | null; json: J | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['--no-warnings', join(root, script), ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('close', (code) => {
      let json: J | null = null;
      try {
        json = JSON.parse(stdout) as J;
      } catch {
        json = null;
      }
      resolveRun({ exitCode: code, json, stdout, stderr: stderr.slice(-2000) });
    });
  });
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

function containsAny(bytes: Buffer, needles: readonly string[]): string[] {
  return needles.filter((n) => n.length > 3 && bytes.indexOf(Buffer.from(n, 'utf8')) >= 0);
}

export async function runJourney(options: JourneyOptions): Promise<J> {
  const root = resolve(options.root ?? ROOT);
  const work = resolve(options.work);
  const data = join(work, 'data');
  const out = join(work, 'out');
  mkdirSync(data, { recursive: true });
  mkdirSync(out, { recursive: true });
  const env = offlineEnv();
  const commit = options.commit ?? gitHead(root);
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const mark = (name: string, since: number) => (timings[name] = Date.now() - since);
  const configured: Canary = makeCanary('configured-secret');
  const tokenCanaries: Canary[] = [];
  const keepToken = (label: string, value: string) => tokenCanaries.push({ label, value });

  // --- Containment setup (M14): engine, image, operator launcher key ------------------------
  const contained = options.contained === true;
  const containment: J = { mode: contained ? 'CONTAINED' : 'UNCONTAINED' };
  const extraArgs: string[] = [];
  // An explicit port for the control service (parallel runs pin their own range).
  const fixedPort = process.env['ROUTESPEC_DELIVERY_PORT'];
  if (fixedPort !== undefined && /^\d{2,5}$/.test(fixedPort)) extraArgs.push('--port', fixedPort);
  let launcherKeyJwk: J | null = null;
  const launcherScript = join(root, 'packages', 'containment', 'src', 'attesting-launcher.ts');
  let toolchainOverride: string | null = null;
  if (contained) {
    const rt = await detectContainerRuntime({ cli: containerCliFromEnv(process.env) });
    if (rt.status !== 'AVAILABLE') throw new Error(`containment unavailable: ${rt.reason} ${rt.detail}`);
    const keyDir = join(work, 'launcher');
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const keys = generateKeyPairSync('ed25519');
    const keyPath = join(keyDir, 'launcher-key.pem');
    writeFileSync(keyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const jwk = keys.publicKey.export({ format: 'jwk' });
    launcherKeyJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
    toolchainOverride = containerToolchainDigest(rt.imageId);
    extraArgs.push(
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
    );
    Object.assign(containment, {
      engine: rt.engine,
      serverVersion: rt.serverVersion,
      serverOs: rt.serverOs,
      imageRef: rt.imageRef,
      imageId: rt.imageId,
      imageNodeVersion: rt.imageNodeVersion,
      cliProgram: rt.cli.argv[0],
      pathStyle: rt.cli.pathStyle,
      launcherArtifactDigest: launcherArtifactDigest(launcherScript),
    });
  }

  let control = await ControlProcess.start({
    root,
    data,
    console: true,
    configuredSecrets: [configured.value],
    env,
    extraArgs,
  });
  keepToken('control-token-1', control.revealToken());
  const api = (m: string, p: string, b?: unknown, ifMatch?: number) => control.api(m, p, b, ifMatch);

  // --- Surface checks before any record exists ---------------------------------------------
  const originUrl = new URL(control.origin);
  const unauthenticated = await control.raw('GET', '/settings', undefined, undefined, null);
  const settings = await api('GET', '/settings');

  // --- 1. Registration ---------------------------------------------------------------------
  let since = Date.now();
  const project = await api('POST', '/projects', { name: 'Checkout integration (M12 delivery)' });
  const projectId = String(project['projectId']);
  const lockDigest = fileDigest(join(root, 'pnpm-lock.yaml'));
  const toolchainDigest =
    toolchainOverride ??
    sha256(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch }));
  const revision = await api('POST', `/projects/${projectId}/revisions`, {
    revisionLabel: 'release-candidate-1',
    commitSha: commit,
    configurationDigest: sha256('routespec.m12.integration-config/1'),
    protocolProfileId: 'oneclick-v0@1.0.0',
    metadata: {},
  });
  const integrationRevisionId = String(revision['integrationRevisionId']);
  const scenario = await api('POST', '/scenarios', {
    projectId,
    source: CORE_SCENARIO_SOURCES[SCENARIO] as string,
  });
  const baseScenarioRevisionId = String(scenario['scenarioRevisionId']);

  let principalId: string | null = null;
  let interceptorProfileDigest: string | null = null;
  if (contained) {
    const now = Date.now();
    const enroll = {
      projectId,
      label: 'operator launcher (contained subjects)',
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
    principalId = String(enrolled['principalId']);
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
    interceptorProfileDigest = String(profile['profileDigest']);
    // M16 (RP-02/RP-06): a locally enrolled TEST reviewer, with its own key (never the launcher
    // key), signs a review of the profile before any case runs. This exercises the real review
    // workflow end to end; it is not an independent human review (that remains NOT_RUN).
    const reviewerKeys = generateKeyPairSync('ed25519');
    const reviewerJwk = reviewerKeys.publicKey.export({ format: 'jwk' });
    const reviewerEnroll = {
      projectId,
      label: 'local test reviewer (not independent)',
      publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: String(reviewerJwk.x) },
      validFromMs: now - 60_000,
      validUntilMs: now + 24 * 3_600_000,
    };
    const launcherAsReviewer = await control.raw('POST', '/profile-reviewers', {
      ...reviewerEnroll,
      publicKeyJwk: launcherKeyJwk,
    });
    let launcherAsReviewerConfirmed = launcherAsReviewer;
    if (launcherAsReviewer.status === 202) {
      const n = await control.confirmation(String(launcherAsReviewer.body['confirmationId']));
      launcherAsReviewerConfirmed = await control.raw('POST', '/profile-reviewers', {
        ...reviewerEnroll,
        publicKeyJwk: launcherKeyJwk,
        confirmation: { confirmationId: n.confirmationId, code: n.code },
      });
    }
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
    const signature = sign(
      null,
      Buffer.from(String(challenge['signingPayload']), 'base64url'),
      reviewerKeys.privateKey,
    ).toString('base64url');
    const reviewedProfile = await api(
      'POST',
      `/profile-review-challenges/${String(challenge['challengeId'])}/complete`,
      { signature },
    );
    const replayedChallenge = await control.raw(
      'POST',
      `/profile-review-challenges/${String(challenge['challengeId'])}/complete`,
      { signature },
    );
    Object.assign(containment, {
      principalId,
      principalPolicyDigest: enrolled['policyDigest'],
      enrollmentConfirmation: 'LOCAL_OPERATOR_CHANNEL',
      interceptorProfileDigest,
      interceptorReviewStateAtRegistration: profile['reviewState'],
      profileReview: {
        reviewer: 'LOCAL_TEST_REVIEWER',
        independentHumanReview: 'NOT_RUN',
        reviewerKeyDigest: reviewer['keyDigest'],
        reviewerIndependentOfLaunchers: reviewer['independentOfLaunchers'],
        launcherKeyAsReviewer: {
          status: launcherAsReviewerConfirmed.status,
          code: ((launcherAsReviewerConfirmed.body['error'] ?? {}) as J)['code'] ?? null,
        },
        reviewId: reviewedProfile['reviewId'],
        reviewDigest: reviewedProfile['reviewDigest'],
        decision: reviewedProfile['decision'],
        stateAfterReview: (reviewedProfile['profile'] as J)['reviewState'],
        challengeReplay: {
          status: replayedChallenge.status,
          code: ((replayedChallenge.body['error'] ?? {}) as J)['code'] ?? null,
        },
      },
    });
  }

  const hooks = [
    {
      hookId: 'fulfilment',
      hookRevision: '1',
      effectType: 'DELIVER_GOODS',
      sinkClass: SINK,
      sourceLocatorDigest: null,
      mechanism: 'subject-hook',
      scenarioSelectors: ['*'],
      coverageExpectation: 'REQUIRED',
    },
  ];
  const effectsFile = (build: Build) => buildScript(root, build).replace(/\.ts$/, '.effects.json');
  const register = async (build: Build): Promise<Registered> => {
    const artifactDigest = buildArtifactDigest(root, build);
    const buildHooks = contained
      ? ((JSON.parse(readFileSync(effectsFile(build), 'utf8')) as J)['hooks'] as J[])
      : hooks;
    const b = await api('POST', `/projects/${projectId}/builds`, {
      integrationRevisionId,
      repositoryLocator: `git+file:${relative(root, buildScript(root, build)).split('\\').join('/')}`,
      commitSha: commit,
      dirtyTreeDigest: null,
      artifactDigest,
      toolchainDigest,
      lockDigest,
      effectManifestDigest: contained
        ? fileDigest(effectsFile(build))
        : sha256(JSON.stringify({ build, hooks })),
      launchRecipeDigest: sha256(`node --no-warnings ${build}.ts`),
      ciWorkflowRunId: null,
    });
    const buildRevisionId = String(b['buildRevisionId']);
    let attestationId: string | null = null;
    if (contained) {
      const a = await api('POST', '/launcher-challenges', {
        scope: 'BUILD_REGISTRATION',
        projectId,
        principalId,
        buildRevisionId,
      });
      attestationId = String(a['attestationId']);
    }
    const m = await api('POST', '/effect-manifests', {
      projectId,
      buildRevisionId,
      artifactDigest,
      adapterRevision: 'routespec-adapter@1.0.0',
      hooks: buildHooks,
    });
    const manifestDigest = String(m['manifestDigest']);
    const reg: Registered = {
      buildRevisionId,
      artifactDigest,
      manifestDigest,
      policyDigest: '',
      attestationId,
      policies: new Map(),
    };
    reg.policyDigest = await policyFor(reg, baseScenarioRevisionId);
    return reg;
  };
  const policyFor = async (reg: Registered, scenarioRevisionId: string): Promise<string> => {
    const known = reg.policies.get(scenarioRevisionId);
    if (known !== undefined) return known;
    const p = await api('POST', '/effect-coverage-policies', {
      projectId,
      buildRevisionId: reg.buildRevisionId,
      artifactDigest: reg.artifactDigest,
      selectedAttestationId: reg.attestationId,
      scenarioRevisionId,
      manifestDigest: reg.manifestDigest,
      requiredSinkClasses: [SINK],
      interceptorProfileDigest: contained ? interceptorProfileDigest : null,
      callsiteInventoryDigest: null,
      basis: contained ? 'INDEPENDENT_BOUNDARY_INTERCEPT' : 'DECLARED_HOOKS_ONLY',
    });
    reg.policies.set(scenarioRevisionId, String(p['policyDigest']));
    return String(p['policyDigest']);
  };
  const baseline = await register('baseline-client');
  const baseCorpus = await api('POST', '/corpora', {
    projectId,
    label: 'release-corpus',
    cases: [
      {
        scenarioRevisionId: baseScenarioRevisionId,
        requiredInvariants: REQUIRED_INVARIANTS,
        severity: 'HIGH',
        gatePolicy: 'REQUIRED',
      },
    ],
  });
  const baseCorpusRevisionId = String(baseCorpus['corpusRevisionId']);
  const gate = async (corpusRevisionId: string, name: string) =>
    String(
      (
        await api('POST', '/gates', {
          projectId,
          name,
          corpusRevisionId,
          enforcementMode: 'LOCAL_ADVISORY',
          buildAttestationPolicy: contained ? 'REQUIRE_TRUSTED' : 'ALLOW_USER_ASSERTED',
        })
      )['gateId'],
    );
  const baseGateId = await gate(baseCorpusRevisionId, 'release gate');
  mark('registration', since);

  // --- Gate run and case helpers -------------------------------------------------------------
  const caseGate = new Map<string, string>();
  const startGateRun = async (
    gateId: string,
    corpusRevisionId: string,
    reg: Registered,
    extraScenarios: readonly string[] = [],
  ) => {
    const casePolicies: J[] = [];
    if (contained) {
      for (const scenarioRevisionId of extraScenarios) {
        casePolicies.push({
          scenarioRevisionId,
          effectCoveragePolicyDigest: await policyFor(reg, scenarioRevisionId),
        });
      }
    }
    const g = await api('POST', '/gate-runs', {
      projectId,
      gateId,
      buildRevisionId: reg.buildRevisionId,
      artifactDigest: reg.artifactDigest,
      corpusRevisionId,
      effectManifestDigest: reg.manifestDigest,
      effectCoveragePolicyDigest: reg.policyDigest,
      callsiteInventoryDigest: null,
      interceptorProfileDigest: contained ? interceptorProfileDigest : null,
      buildAttestation:
        contained && reg.attestationId !== null
          ? { subjectAttestationId: reg.attestationId }
          : { class: 'USER_ASSERTED_LOCAL' },
      mode: 'SIMULATE',
      maxParallelCases: 1,
      ...(casePolicies.length > 0 ? { casePolicies } : {}),
    });
    const gateRunId = String(g['gateRunId']);
    const v = await api('POST', `/gate-runs/${gateRunId}/validate`, {}, Number(g['revision']));
    const s = await api('POST', `/gate-runs/${gateRunId}/start`, {}, Number((v['gateRun'] as J)['revision']));
    const cases = (await api('GET', `/gate-runs/${gateRunId}/cases?limit=200`))['items'] as J[];
    for (const c of cases) caseGate.set(String(c['caseRunId']), gateRunId);
    return { gateRunId, proxyBaseUrl: String(s['proxyBaseUrl']), cases };
  };

  const caseResult = async (caseRunId: string): Promise<J> => {
    const gateRunId = caseGate.get(caseRunId) as string;
    const items = (await api('GET', `/gate-runs/${gateRunId}/cases?limit=200`))['items'] as J[];
    return items.find((x) => x['caseRunId'] === caseRunId) as J;
  };

  const recoverIfFenced = async (caseRunId: string, startEpoch: number): Promise<J | null> => {
    const c = await caseResult(caseRunId);
    if (Number(c['fencingEpoch']) === startEpoch && c['lifecycle'] !== 'RECOVERY_REQUIRED') return null;
    return api('POST', `/case-runs/${caseRunId}/recover`, {});
  };

  const invariantsOf = async (runOperationIds: string[]) => {
    const all: CaseOutcome['invariants'] = [];
    for (const id of runOperationIds) {
      const op = await api('GET', `/run-operations/${id}`);
      for (const inv of op['invariants'] as J[]) {
        all.push({
          invariantId: String(inv['invariantId']),
          status: String(inv['status']),
          facts: (inv['facts'] as string[]) ?? [],
          missingPredicates: (inv['missingPredicates'] as string[]) ?? [],
        });
      }
    }
    return all;
  };

  const runContainedCase = async (c: J, build: Build, job: string): Promise<CaseOutcome> => {
    const caseRunId = String(c['caseRunId']);
    const started = await api('POST', `/case-runs/${caseRunId}/contained-start`, {
      attesterPrincipalId: principalId,
      job: { logicalJob: job, quote: quoteBody(), txHash: `sim-tx-${job}` },
    });
    const startCase = started['case'] as J;
    let live = (started['live'] ?? null) as J | null;
    const deadline = Date.now() + 240_000;
    while (
      live !== null &&
      (live['job'] === 'RUNNING' || live['job'] === 'STARTING') &&
      Date.now() < deadline
    ) {
      await sleep(250);
      live = ((await api('GET', `/case-runs/${caseRunId}/containment`))['live'] ?? null) as J | null;
    }
    await api('POST', `/case-runs/${caseRunId}/finish-input`, {});
    const view = await caseResult(caseRunId);
    const after = await api('GET', `/case-runs/${caseRunId}/containment`);
    const runOperationIds = (view['runOperationIds'] as string[]) ?? [];
    return {
      caseRunId,
      ordinal: Number(view['ordinal']),
      scenarioName: String(view['scenarioName']),
      lineageRole: String(view['lineageRole']),
      build,
      subjectPid: -1,
      clientInstanceId: String(startCase['clientInstanceId'] ?? ''),
      startEpoch: Number(startCase['fencingEpoch'] ?? 0),
      recovery: null,
      jobOutcome: (live?.['subjectOutcome'] ?? {}) as J,
      lifecycle: String(view['lifecycle']),
      verdict: String(view['verdict']),
      fencingEpoch: Number(view['fencingEpoch']),
      evidence: view['evidence'],
      effectCoverage: view['effectCoverage'],
      containment: {
        startTokenReturned: started['token'] !== null,
        tokenDelivery: started['tokenDelivery'],
        live,
        records: after['records'],
        runtime: after['runtime'],
      },
      runOperationIds,
      invariants: await invariantsOf(runOperationIds),
    };
  };

  const runCase = async (proxyBaseUrl: string, c: J, build: Build, job: string): Promise<CaseOutcome> => {
    if (contained) return runContainedCase(c, build, job);
    const caseRunId = String(c['caseRunId']);
    const start = await api('POST', `/case-runs/${caseRunId}/start`, {});
    const creds = credentialsOf(start);
    keepToken(`case-${caseRunId}-execution`, creds.token);
    const subject = await SubjectProcess.launch(buildScript(root, build), env);
    let recovery: J | null = null;
    let jobOutcome: J = {};
    try {
      await subject.attach(proxyBaseUrl, creds);
      let done = false;
      const running = subject
        .send({ type: 'run', request: { logicalJob: job, quote: quoteBody(), txHash: `sim-tx-${job}` } })
        .then((r) => {
          jobOutcome = (r['outcome'] as J) ?? {};
          done = true;
        });
      const deadline = Date.now() + 90_000;
      while (!done && Date.now() < deadline) {
        await sleep(100);
        // Reconciliation authority is handed over when the client waits for it (the corrected
        // build does); the baseline build never asks and finishes on its own.
        if (WAITS_FOR_RECONCILIATION[build] && recovery === null && !done) {
          const r = await recoverIfFenced(caseRunId, creds.fencingEpoch);
          if (r !== null) {
            recovery = r;
            const rc = credentialsOf({
              ...r,
              sessionId: creds.sessionId,
              clientInstanceId: r['clientInstanceId'] ?? creds.clientInstanceId,
            });
            keepToken(`case-${caseRunId}-reconciliation`, rc.token);
            await subject.credentials(rc);
          }
        }
      }
      await running;
    } finally {
      await subject.close();
    }
    await api('POST', `/case-runs/${caseRunId}/finish-input`, {});
    const view = await caseResult(caseRunId);
    const runOperationIds = (view['runOperationIds'] as string[]) ?? [];
    return {
      caseRunId,
      ordinal: Number(view['ordinal']),
      scenarioName: String(view['scenarioName']),
      lineageRole: String(view['lineageRole']),
      build,
      subjectPid: subject.child.pid ?? -1,
      clientInstanceId: creds.clientInstanceId,
      startEpoch: creds.fencingEpoch,
      recovery:
        recovery === null
          ? null
          : { ...(recovery as J), token: { purpose: ((recovery as J)['token'] as J)['purpose'] } },
      jobOutcome,
      lifecycle: String(view['lifecycle']),
      verdict: String(view['verdict']),
      fencingEpoch: Number(view['fencingEpoch']),
      evidence: view['evidence'],
      effectCoverage: view['effectCoverage'],
      containment: null,
      runOperationIds,
      invariants: await invariantsOf(runOperationIds),
    };
  };

  const runGate = async (
    label: string,
    gateId: string,
    corpusRevisionId: string,
    reg: Registered,
    build: Build,
    extraScenarios: readonly string[] = [],
  ): Promise<GateOutcome> => {
    const g = await startGateRun(gateId, corpusRevisionId, reg, extraScenarios);
    const cases: CaseOutcome[] = [];
    for (const c of g.cases)
      cases.push(await runCase(g.proxyBaseUrl, c, build, `order-${label}-${String(c['ordinal'])}`));
    const e = await api('POST', `/gates/${gateId}/evaluate`, { gateRunId: g.gateRunId });
    const gr = await api('GET', `/gate-runs/${g.gateRunId}`);
    return {
      label,
      gateId,
      gateRunId: g.gateRunId,
      build,
      corpusRevisionId,
      cases,
      gateEvaluationId: String(e['gateEvaluationId']),
      decision: String(e['decision']),
      decisionDigest: (e['decisionDigest'] as string | undefined) ?? null,
      apiGateRunVerdict: String(gr['verdict']),
    };
  };

  // --- 2. Baseline build through the accepted-then-lost-response schedule ------------------
  since = Date.now();
  const baselineRun = await runGate(
    'baseline',
    baseGateId,
    baseCorpusRevisionId,
    baseline,
    'baseline-client',
  );
  mark('baselineGateRun', since);

  // --- 3. Fenced recovery proof with single SDK calls (separate case, same build) ----------
  since = Date.now();
  const probeGate = await startGateRun(baseGateId, baseCorpusRevisionId, baseline);
  const probeCase = probeGate.cases[0] as J;
  const probeCaseId = String(probeCase['caseRunId']);
  const probeStart = await api('POST', `/case-runs/${probeCaseId}/start`, {});
  const execCreds = credentialsOf(probeStart);
  keepToken('probe-execution', execCreds.token);
  const probe = await SubjectProcess.launch(probeScript(root), env);
  const recoveryProof: J = {};
  try {
    await probe.attach(probeGate.proxyBaseUrl, execCreds);
    await probe.send({ type: 'logicalJob', key: 'order-recovery-probe' });
    const q = await probe.send({ type: 'call', op: 'getQuote', args: [quoteBody()] });
    const depositAddress = String((((q['value'] ?? {}) as J)['quote'] as J)['depositAddress']);
    const first = await probe.send({
      type: 'call',
      op: 'submitDepositTx',
      args: [{ txHash: 'sim-tx-recovery-probe', depositAddress }],
    });
    recoveryProof['firstCommit'] = { ok: first['ok'], error: first['error'] ?? null };
    let recovered: J | null = null;
    for (let i = 0; i < 100 && recovered === null; i++) {
      recovered = await recoverIfFenced(probeCaseId, execCreds.fencingEpoch);
      if (recovered === null) await sleep(100);
    }
    if (recovered === null) throw new Error('recovery was not offered after the lost commit response');
    const reconCreds = credentialsOf({
      ...recovered,
      sessionId: execCreds.sessionId,
      clientInstanceId: recovered['clientInstanceId'] ?? execCreds.clientInstanceId,
    });
    keepToken('probe-reconciliation', reconCreds.token);
    recoveryProof['recover'] = {
      previousEpoch: recovered['previousEpoch'],
      fencingEpoch: recovered['fencingEpoch'],
      revokedTokenPurpose: recovered['revokedTokenPurpose'],
      issuedTokenPurpose: reconCreds.purpose,
      allowedPhases: recovered['allowedPhases'],
      lifecycle: recovered['lifecycle'],
    };
    const staleStatus = await probe.send({ type: 'call', op: 'getExecutionStatus', args: [depositAddress] });
    recoveryProof['staleExecutionTokenStatusRead'] = {
      ok: staleStatus['ok'],
      error: staleStatus['error'] ?? null,
    };
    const staleCommit = await probe.send({
      type: 'call',
      op: 'submitDepositTx',
      args: [{ txHash: 'sim-tx-recovery-probe', depositAddress }],
    });
    recoveryProof['staleExecutionTokenCommit'] = {
      ok: staleCommit['ok'],
      error: staleCommit['error'] ?? null,
    };
    await probe.credentials(reconCreds);
    const secondMutation = await probe.send({
      type: 'call',
      op: 'submitDepositTx',
      args: [{ txHash: 'sim-tx-recovery-probe-2', depositAddress }],
    });
    recoveryProof['secondMutationUnderReconciliationToken'] = {
      ok: secondMutation['ok'],
      error: secondMutation['error'] ?? null,
    };
    const quoteAgain = await probe.send({ type: 'call', op: 'getQuote', args: [quoteBody()] });
    recoveryProof['quoteUnderReconciliationToken'] = {
      ok: quoteAgain['ok'],
      error: quoteAgain['error'] ?? null,
    };
    const readOnly = await probe.send({ type: 'call', op: 'getExecutionStatus', args: [depositAddress] });
    recoveryProof['readOnlyStatusUnderReconciliationToken'] = {
      ok: readOnly['ok'],
      status: ((readOnly['value'] ?? {}) as J)['status'] ?? null,
      error: readOnly['error'] ?? null,
    };
  } finally {
    await probe.close();
  }
  await api('POST', `/case-runs/${probeCaseId}/finish-input`, {});
  const probeView = await caseResult(probeCaseId);
  recoveryProof['case'] = {
    caseRunId: probeCaseId,
    lifecycle: probeView['lifecycle'],
    verdict: probeView['verdict'],
    fencingEpoch: probeView['fencingEpoch'],
    token: probeView['token'],
  };
  const probeEval = await api('POST', `/gates/${baseGateId}/evaluate`, { gateRunId: probeGate.gateRunId });
  recoveryProof['gateDecision'] = probeEval['decision'];
  mark('recoveryProof', since);

  // --- 4. Capture -> quarantine -> sanitize -> map -> replay -> review -> promote -----------
  since = Date.now();
  const failingCase = baselineRun.cases[0] as CaseOutcome;
  const capture = await api('POST', `/case-runs/${failingCase.caseRunId}/captures`, {});
  const importId = String(capture['importId']);
  const captured = await api('GET', `/imports/${importId}`);
  const proposed = await api('GET', `/imports/${importId}/proposed-mapping`);
  await api(
    'POST',
    `/imports/${importId}/mapping`,
    { mapping: proposed['mapping'] },
    Number(proposed['revision']),
  );
  const mapped = await api('GET', `/imports/${importId}`);
  const verified = await api('POST', `/imports/${importId}/verify-replay`, {}, Number(mapped['revision']));
  const afterVerify = await api('GET', `/imports/${importId}`);
  const reviewSpec = afterVerify['review'] as { decisions: string[]; confirmationPhrase: string };
  const reviewed = await api(
    'POST',
    `/imports/${importId}/reviews`,
    {
      reviewer: 'release engineer',
      decisions: Object.fromEntries(reviewSpec.decisions.map((k) => [k, true])),
      confirmation: reviewSpec.confirmationPhrase,
    },
    Number(afterVerify['revision']),
  );
  const afterReview = await api('GET', `/imports/${importId}`);
  // M16 (RP-08): ask whether the capture can be release evidence, try the release promotion,
  // and fall back to an explicit diagnostic-only ADVISORY promotion only when it is refused.
  const releaseEvidence = await api('GET', `/imports/${importId}/release-evidence`);
  const promoteBody = {
    reviewId: String((afterReview['review'] as J)['latestReviewId']),
    baseCorpusRevisionId,
    corpusLabel: 'release-corpus + captured regression',
    severity: 'HIGH',
    gatePolicy: 'REQUIRED',
  };
  const releaseAttempt = await control.raw(
    'POST',
    `/imports/${importId}/promote`,
    promoteBody,
    Number(afterReview['revision']),
  );
  const promotionRefusal =
    releaseAttempt.status === 201
      ? null
      : {
          status: releaseAttempt.status,
          code: ((releaseAttempt.body['error'] ?? {}) as J)['code'] ?? null,
          reasons:
            (((releaseAttempt.body['error'] ?? {}) as J)['details'] as J | undefined)?.['reasons'] ?? null,
        };
  const promoted =
    releaseAttempt.status === 201
      ? releaseAttempt.body
      : await api(
          'POST',
          `/imports/${importId}/promote`,
          { ...promoteBody, gatePolicy: 'ADVISORY', evidenceUse: 'DIAGNOSTIC_ONLY' },
          Number(afterReview['revision']),
        );
  const promotedCorpusRevisionId = String(promoted['corpusRevisionId']);
  const afterPromote = await api('GET', `/imports/${importId}`);
  mark('captureToPromotion', since);

  // --- 5. Original build on the new corpus, then the corrected build -------------------------
  since = Date.now();
  const promotedGateId = await gate(promotedCorpusRevisionId, 'release gate with captured regression');
  const promotedScenarioRevisionId = String(promoted['scenarioRevisionId']);
  const baselineOnPromoted = await runGate(
    'baseline-promoted',
    promotedGateId,
    promotedCorpusRevisionId,
    baseline,
    'baseline-client',
    [promotedScenarioRevisionId],
  );
  const corrected = await register('corrected-client');
  const correctedRun = await runGate(
    'corrected',
    promotedGateId,
    promotedCorpusRevisionId,
    corrected,
    'corrected-client',
    [promotedScenarioRevisionId],
  );
  const lineage = await api('GET', `/imports/${importId}`);
  mark('correctedGateRuns', since);

  // --- 6a. Console view of the same persisted records ---------------------------------------
  since = Date.now();
  const ui: J = { ran: false };
  if (options.ui !== false) {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const token = encodeURIComponent(control.revealToken());
      const read = async (gateRunId: string) => {
        await page.goto(`${control.origin}/projects/${projectId}/gate-runs/${gateRunId}#token=${token}`);
        await page.locator('#main').waitFor();
        await page
          .locator('[aria-busy="true"]')
          .first()
          .waitFor({ state: 'detached', timeout: 15_000 })
          .catch(() => undefined);
        const badge = page.locator('.axis-group [data-axis="Verdict"] .badge').first();
        await badge.waitFor({ timeout: 15_000 });
        const enforcement = page.locator('.axis-group [data-axis="Enforcement"] .badge').first();
        return {
          verdict: await badge.getAttribute('data-code'),
          verdictText: (await badge.innerText()).trim(),
          enforcement: await enforcement.getAttribute('data-code'),
          storage: await page.evaluate(() => Object.keys(window.localStorage)),
        };
      };
      ui['baseline'] = await read(baselineRun.gateRunId);
      ui['baselinePromoted'] = await read(baselineOnPromoted.gateRunId);
      ui['corrected'] = await read(correctedRun.gateRunId);
      ui['ran'] = true;
      const dom = await page.content();
      ui['domHoldsTokens'] = tokenCanaries.filter((c) => dom.includes(c.value)).map((c) => c.label);
    } finally {
      await browser.close();
    }
  }
  mark('consoleParity', since);

  // --- 7a. Export the corrected decision as a checksummed bundle -----------------------------
  since = Date.now();
  // M16 (RP-08): a release-evidence bundle is refused when the gate uses a capture that is not
  // release evidence; the journey then exports an explicit diagnostic-only bundle.
  const releasePlan = await control.raw('POST', '/exports', {
    gateEvaluationId: correctedRun.gateEvaluationId,
  });
  const exportRefusal =
    releasePlan.status === 201 || releasePlan.status === 200
      ? null
      : {
          status: releasePlan.status,
          code: ((releasePlan.body['error'] ?? {}) as J)['code'] ?? null,
          reasons:
            (((releasePlan.body['error'] ?? {}) as J)['details'] as J | undefined)?.['reasons'] ?? null,
        };
  const plan =
    exportRefusal === null
      ? releasePlan.body
      : await api('POST', '/exports', {
          gateEvaluationId: correctedRun.gateEvaluationId,
          evidenceUse: 'DIAGNOSTIC_ONLY',
        });
  const bundlePath = join(out, 'routespec-corrected-release.tar');
  const written = await api('POST', `/exports/${String(plan['exportId'])}/write`, {
    outPath: bundlePath,
    confirm: String(plan['planDigest']),
  });
  const reEvaluated = await api('POST', `/gates/${promotedGateId}/evaluate`, {
    gateRunId: correctedRun.gateRunId,
  });
  mark('export', since);

  // --- 7b. Crash and restart from the same data directory ----------------------------------
  since = Date.now();
  const oldToken = control.revealToken();
  await control.kill();
  const walAfterCrash = readdirSync(data).filter((f) => f.endsWith('-wal'));
  control = await ControlProcess.start({
    root,
    data,
    console: true,
    configuredSecrets: [configured.value],
    env,
    extraArgs,
  });
  keepToken('control-token-2', control.revealToken());
  const oldTokenAfterRestart = await control.raw('GET', '/settings', undefined, undefined, oldToken);
  const restarted: J = {
    walPresentAfterCrash: walAfterCrash.length > 0,
    oldControlTokenStatus: oldTokenAfterRestart.status,
    baselineVerdict: (await api('GET', `/gate-runs/${baselineRun.gateRunId}`))['verdict'],
    correctedVerdict: (await api('GET', `/gate-runs/${correctedRun.gateRunId}`))['verdict'],
    regressionStatus: (await api('GET', `/imports/${importId}`))['regressionStatus'],
    correctedCases: (
      (await api('GET', `/gate-runs/${correctedRun.gateRunId}/cases?limit=200`))['items'] as J[]
    ).map((c) => ({ caseRunId: c['caseRunId'], lifecycle: c['lifecycle'], verdict: c['verdict'] })),
  };
  const restartEval = await api('POST', `/gates/${promotedGateId}/evaluate`, {
    gateRunId: correctedRun.gateRunId,
  });
  restarted['reEvaluation'] = {
    gateEvaluationId: restartEval['gateEvaluationId'],
    decision: restartEval['decision'],
  };
  const stopCode = await control.stop();
  mark('crashRestart', since);

  // --- 6b. CLI view of the same persisted records (service stopped: single writer) ----------
  since = Date.now();
  const cli: J = {};
  for (const g of [baselineRun, baselineOnPromoted, correctedRun]) {
    const r = await runNode(
      root,
      'packages/cli/src/main.ts',
      ['gate', 'show', '--data', data, '--gate-evaluation', g.gateEvaluationId],
      root,
      env,
    );
    const report = (r.json?.['report'] ?? {}) as J;
    cli[g.label] = {
      exitCode: r.exitCode,
      decision: report['decision'] ?? null,
      enforcementMode:
        report['enforcementMode'] ?? (report['enforcement'] as J | undefined)?.['mode'] ?? null,
      reportKeys: Object.keys(report).sort(),
    };
  }
  mark('cliParity', since);

  // --- 7c. Verify the bundle in a clean location without the journal ------------------------
  since = Date.now();
  const clean = mkdtempSync(join(tmpdir(), 'routespec-m12-verify-'));
  const home = join(clean, 'home');
  const extractTo = join(clean, 'extracted');
  mkdirSync(home);
  const verify = await runNode(
    root,
    'packages/cli/src/main.ts',
    ['export', 'verify', '--bundle', bundlePath, '--extract-to', extractTo],
    clean,
    { ...env, HOME: home, USERPROFILE: home, ROUTESPEC_DATA_DIR: '' },
  );
  const extracted = listFiles(extractTo).map((f) => relative(extractTo, f).split('\\').join('/'));
  const machinePaths = [
    root,
    data,
    work,
    out,
    home,
    process.env['USERPROFILE'] ?? '',
    process.env['HOME'] ?? '',
  ].flatMap((p) => (p ? [p, p.split('\\').join('/'), p.split('\\').join('\\\\')] : []));
  const bundleBytes = readFileSync(bundlePath);
  const bundlePathHits = containsAny(bundleBytes, machinePaths).length;
  let decisionInBundle: unknown = null;
  for (const f of listFiles(extractTo)) {
    if (!f.endsWith('.json')) continue;
    const text = readFileSync(f, 'utf8');
    if (text.includes(correctedRun.gateEvaluationId) && text.includes('"decision"')) {
      try {
        const parsed = JSON.parse(text) as J;
        if (typeof parsed['decision'] === 'string') decisionInBundle = parsed['decision'];
      } catch {
        // not a JSON object document
      }
    }
  }
  mark('bundleVerify', since);

  // --- Secret and token canaries across persisted and exported files -----------------------
  const canaries = [configured, ...tokenCanaries];
  const dataScan = scanTree(data, canaries);
  const outScan = scanTree(out, canaries);
  const extractedScan = scanTree(extractTo, canaries);
  rmSync(clean, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const dataFiles = listFiles(data).map((f) => ({
    file: relative(data, f).split('\\').join('/'),
    bytes: statSync(f).size,
  }));

  const journey: J = {
    schema: 'routespec.delivery.journey/1',
    commit,
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    surface: {
      bind: originUrl.hostname,
      unauthenticatedStatus: unauthenticated.status,
      liveDry: settings['liveDry'] ?? settings['liveDryProbe'] ?? null,
      settingsKeys: Object.keys(settings).sort(),
    },
    identity: {
      projectId,
      integrationRevisionId,
      lockDigest,
      toolchainDigest,
      baseline: { ...baseline, policies: Object.fromEntries(baseline.policies) },
      corrected: { ...corrected, policies: Object.fromEntries(corrected.policies) },
    },
    containment,
    scenario: { id: SCENARIO, baseScenarioRevisionId, requiredInvariants: REQUIRED_INVARIANTS, sink: SINK },
    baselineRun,
    recoveryProof,
    regression: {
      importId,
      captureState: capture['state'],
      captureOrigin: capture['origin'],
      captureFindings: capture['findings'],
      stateAfterCapture: captured['state'],
      proposalDerivedFrom: proposed['derivedFrom'],
      mappingRequiredInvariants: (proposed['mapping'] as J)['requiredInvariants'],
      mappingProvenance: ((proposed['mapping'] as J)['provenance'] as J)['class'],
      mappingProviderStatuses: (((proposed['mapping'] as J)['scenario'] as J)['steps'] as J[])
        .filter((st) => st['type'] === 'provider_status')
        .map((st) => st['status']),
      mappingEffectCoverage: (proposed['mapping'] as J)['effectCoverage'],
      replay: {
        verified: verified['verified'],
        trialDigests: verified['trialDigests'] ?? null,
        reportDigest: verified['reportDigest'] ?? null,
        fidelity: verified['fidelity'] ?? null,
        networkAccessed: verified['networkAccessed'],
        keys: Object.keys(verified).sort(),
      },
      review: { reviewId: reviewed['reviewId'] ?? null, stateAfter: afterReview['state'] },
      releaseEvidence: {
        releaseEvidence: releaseEvidence['releaseEvidence'],
        refusalReasons: releaseEvidence['refusalReasons'],
        promotableAs: releaseEvidence['promotableAs'],
        interceptorReviewId: releaseEvidence['interceptorReviewId'],
      },
      promotionRefusal,
      promotion: {
        scenarioRevisionId: promoted['scenarioRevisionId'],
        corpusRevisionId: promotedCorpusRevisionId,
        baseCorpusRevisionId,
        baseCorpusMutated: promoted['baseCorpusMutated'],
        lineageAfterPromotion: afterPromote['regressionStatus'],
        replayOnlyPass: afterPromote['replayOnlyPass'],
        evidenceUse: promoted['evidenceUse'],
        refusalReasons: promoted['refusalReasons'],
      },
      finalRegressionStatus: lineage['regressionStatus'],
    },
    baselineOnPromoted,
    correctedRun,
    ui,
    export: {
      refusal: exportRefusal,
      evidenceUse: plan['evidenceUse'],
      exportId: plan['exportId'],
      planDigest: plan['planDigest'],
      blocked: plan['blocked'],
      findings: plan['findings'],
      outputDigest: written['outputDigest'],
      bytes: written['bytes'],
      artifactReady: written['artifactReady'],
      decisionAfterExport: reEvaluated['decision'],
      gateEvaluationIdAfterExport: reEvaluated['gateEvaluationId'],
      decisionChanged: written['decisionChanged'],
    },
    restart: { ...restarted, stopExitCode: stopCode },
    cli,
    bundleVerify: {
      exitCode: verify.exitCode,
      verified: verify.json?.['verified'] ?? null,
      result: verify.json,
      extracted,
      decisionInBundle,
      bundlePathHits,
      bundleDigest: sha256(bundleBytes),
    },
    canaries: {
      count: canaries.length,
      labels: canaries.map((c) => c.label.replace(/case-[^-]+-/, 'case-')),
      dataFindings: dataScan.findings,
      dataFilesScanned: dataScan.files,
      exportFindings: outScan.findings,
      extractedFindings: extractedScan.findings,
    },
    dataFiles,
    timings: { ...timings, total: Date.now() - t0 },
  };
  return journey;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const work = arg('work');
  const outFile = arg('out');
  if (work === undefined || outFile === undefined) {
    process.stderr.write(
      'usage: journey.ts --work <dir> --out <json> [--commit <sha>] [--no-ui] [--contained]\n',
    );
    process.exit(4);
  }
  const commit = arg('commit');
  const record = await runJourney({
    work,
    ui: !process.argv.includes('--no-ui'),
    contained: process.argv.includes('--contained'),
    ...(commit !== undefined ? { commit } : {}),
  });
  writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, out: outFile })}\n`);
}
