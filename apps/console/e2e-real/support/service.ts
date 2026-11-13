/**
 * Real control service for the console acceptance suite (M09, T-047..T-051).
 *
 * Starts the real `ControlServer` (M08) over a real SQLite journal (M01) and serves the built
 * console (`apps/console/dist`) from the same origin with the production CSP. Every record the
 * browser later reads is created through the public control API and the real product path:
 * the networkless proxy and scenario runtime (M02/M03), separately launched official-SDK
 * subjects, the invariant kernel (M04), the gate service and aggregation (M06), and the
 * capture-to-regression pipeline (M05). Nothing is written to the journal directly and no
 * response is hand-written.
 *
 * Run as its own Node process (built-in type stripping). It reports `{ type: 'ready', ... }`
 * over IPC with the origin, the ephemeral control token, and the ids of the seeded records.
 * The token travels only over IPC and test-process environment; it is never written to disk.
 *
 * Time: the journal clock is a manual offset clock owned by this process. One crashed case is
 * left holding an expired lease by advancing that clock once, after all other seeding.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { digestValue } from '@routespec/contracts';
import { ControlServer } from '@routespec/control-api';
import { CORE_SCENARIO_SOURCES } from '@routespec/scenario';
import { RouteSpecStore } from '@routespec/store';
import { Subject, driveJob, quoteBody, subjectArtifactDigest, type CaseCredentials } from './subject.ts';

type J = Record<string, unknown>;
const PREFIX = '/__routespec/v1';
const LEASE_TTL_MS = 30 * 60_000;
const DENSE_EVENT_TARGET = Number(process.env['ROUTESPEC_DENSE_EVENTS'] ?? 10_000);
const DENSE_SESSION_POLLS = Number(process.env['ROUTESPEC_DENSE_SESSION_POLLS'] ?? 8_188);
const DENSE_CASES = 100;

class OffsetClock {
  offsetMs = 0;
  nowMs(): number {
    return Date.now() + this.offsetMs;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'routespec-console-real-'));
const clock = new OffsetClock();
const store = RouteSpecStore.open({ path: join(dir, 'journal.db'), clock });
const consoleDir = fileURLToPath(new URL('../../dist', import.meta.url));
const server = await ControlServer.start({
  store,
  // Optional fixed loopback port for manual runs (screenshots, demo recording); ephemeral otherwise.
  ...(process.env['ROUTESPEC_REAL_PORT'] ? { port: Number(process.env['ROUTESPEC_REAL_PORT']) } : {}),
  dataDirectory: dir,
  consoleDir,
  leaseTtlMs: LEASE_TTL_MS,
  tokenTtlMs: 2 * LEASE_TTL_MS,
  onLocalConfirmation: () => undefined,
});
const origin = server.origin;
const token = server.token.reveal();
let keyN = 0;

async function api(method: string, path: string, body?: unknown, ifMatch?: number): Promise<J> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['idempotency-key'] = `seed-${process.pid}-${++keyN}`;
  if (ifMatch !== undefined) headers['if-match'] = `"${ifMatch}"`;
  const res = await fetch(`${origin}${PREFIX}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return JSON.parse(text) as J;
}

const d = (label: string) => digestValue('routespec.console-acceptance.digest/1', label);

function credentials(start: J): CaseCredentials {
  const t = start['token'] as { value: string; purpose: 'EXECUTION' | 'RECONCILIATION_ONLY' };
  return {
    purpose: t.purpose,
    token: t.value,
    sessionId: String(start['sessionId']),
    caseRunId: String(start['caseRunId']),
    fencingEpoch: Number(start['fencingEpoch']),
    clientInstanceId: String(start['clientInstanceId']),
  };
}

/**
 * Scenario sources: the reviewed core scenarios, plus a refund-shortfall variant of the
 * incomplete-deposit refund scenario (the settled refund is 100000 base units short, which the
 * kernel's value-conservation invariant reports as FAIL).
 */
function scenarioSource(id: string): string {
  if (id === 'refund-shortfall') {
    return (CORE_SCENARIO_SOURCES['incomplete-deposit-refund'] as string)
      .replace('scenarioId: incomplete-deposit-refund', 'scenarioId: refund-shortfall')
      .replace('seed: core-refund-1', 'seed: console-refund-shortfall-1')
      .replace(
        '{ id: refund-settled, fact: REFUND, assetId: nep141:origin.sim, amount: "400000", recipient: refund.sim }',
        '{ id: refund-settled, fact: REFUND, assetId: nep141:origin.sim, amount: "300000", recipient: refund.sim }',
      );
  }
  const s = CORE_SCENARIO_SOURCES[id];
  if (!s) throw new Error(`unknown scenario ${id}`);
  return s;
}

interface ProjectIds {
  projectId: string;
  integrationRevisionId: string;
  buildRevisionId: string;
  artifactDigest: string;
  manifestDigest: string;
  policyDigest: string;
  scenarios: Record<string, string>;
  configurationDigest: string;
}

async function project(name: string, scenarioIds: readonly string[]): Promise<ProjectIds> {
  const p = await api('POST', '/projects', { name });
  const projectId = String(p['projectId']);
  const configurationDigest = d(`config-${name}`);
  const rev = await api('POST', `/projects/${projectId}/revisions`, {
    revisionLabel: 'release-candidate-1',
    commitSha: null,
    configurationDigest,
    protocolProfileId: 'oneclick-v0@1.0.0',
    metadata: {},
  });
  const integrationRevisionId = String(rev['integrationRevisionId']);
  const artifactDigest = subjectArtifactDigest();
  const build = await api('POST', `/projects/${projectId}/builds`, {
    integrationRevisionId,
    repositoryLocator: 'git+file:installed-subject',
    commitSha: 'c0ffee0'.padEnd(40, '0'),
    dirtyTreeDigest: null,
    artifactDigest,
    toolchainDigest: d('toolchain-node-22'),
    lockDigest: d('pnpm-lock'),
    effectManifestDigest: d(`manifest-${name}`),
    launchRecipeDigest: d('launch-recipe'),
    ciWorkflowRunId: null,
  });
  const buildRevisionId = String(build['buildRevisionId']);
  const manifest = await api('POST', '/effect-manifests', {
    projectId,
    buildRevisionId,
    artifactDigest,
    adapterRevision: 'routespec-adapter@1.0.0',
    hooks: [
      {
        hookId: 'fulfilment',
        hookRevision: '1',
        effectType: 'DELIVER_GOODS',
        sinkClass: 'fulfilment-webhook',
        sourceLocatorDigest: null,
        mechanism: 'subject-hook',
        scenarioSelectors: ['*'],
        coverageExpectation: 'REQUIRED',
      },
    ],
  });
  const manifestDigest = String(manifest['manifestDigest']);
  const scenarios: Record<string, string> = {};
  for (const id of scenarioIds) {
    const sc = await api('POST', '/scenarios', { projectId, source: scenarioSource(id) });
    scenarios[id] = String(sc['scenarioRevisionId']);
  }
  const first = scenarios[scenarioIds[0] as string] as string;
  const policy = await api('POST', '/effect-coverage-policies', {
    projectId,
    buildRevisionId,
    artifactDigest,
    selectedAttestationId: null,
    scenarioRevisionId: first,
    manifestDigest,
    requiredSinkClasses: ['fulfilment-webhook'],
    interceptorProfileDigest: null,
    callsiteInventoryDigest: null,
    basis: 'DECLARED_HOOKS_ONLY',
  });
  return {
    projectId,
    integrationRevisionId,
    buildRevisionId,
    artifactDigest,
    manifestDigest,
    policyDigest: String(policy['policyDigest']),
    scenarios,
    configurationDigest,
  };
}

async function registerBuild(
  p: ProjectIds,
  label: string,
): Promise<{ buildRevisionId: string; manifestDigest: string; policyDigest: string }> {
  const build = await api('POST', `/projects/${p.projectId}/builds`, {
    integrationRevisionId: p.integrationRevisionId,
    repositoryLocator: 'git+file:installed-subject',
    commitSha: 'c0ffee1'.padEnd(40, '1'),
    dirtyTreeDigest: null,
    artifactDigest: p.artifactDigest,
    toolchainDigest: d('toolchain-node-22'),
    lockDigest: d('pnpm-lock'),
    effectManifestDigest: d(`manifest-${label}`),
    launchRecipeDigest: d('launch-recipe'),
    ciWorkflowRunId: null,
  });
  const buildRevisionId = String(build['buildRevisionId']);
  const manifest = await api('POST', '/effect-manifests', {
    projectId: p.projectId,
    buildRevisionId,
    artifactDigest: p.artifactDigest,
    adapterRevision: 'routespec-adapter@1.0.0',
    hooks: [
      {
        hookId: 'fulfilment',
        hookRevision: '1',
        effectType: 'DELIVER_GOODS',
        sinkClass: 'fulfilment-webhook',
        sourceLocatorDigest: null,
        mechanism: 'subject-hook',
        scenarioSelectors: ['*'],
        coverageExpectation: 'REQUIRED',
      },
    ],
  });
  const manifestDigest = String(manifest['manifestDigest']);
  const policy = await api('POST', '/effect-coverage-policies', {
    projectId: p.projectId,
    buildRevisionId,
    artifactDigest: p.artifactDigest,
    selectedAttestationId: null,
    scenarioRevisionId: Object.values(p.scenarios)[0],
    manifestDigest,
    requiredSinkClasses: ['fulfilment-webhook'],
    interceptorProfileDigest: null,
    callsiteInventoryDigest: null,
    basis: 'DECLARED_HOOKS_ONLY',
  });
  return { buildRevisionId, manifestDigest, policyDigest: String(policy['policyDigest']) };
}

async function corpusAndGate(
  p: ProjectIds,
  label: string,
  cases: Array<{ scenario: string; invariants: string[] }>,
): Promise<{ corpusRevisionId: string; gateId: string }> {
  const corpus = await api('POST', '/corpora', {
    projectId: p.projectId,
    label,
    cases: cases.map((c) => ({
      scenarioRevisionId: p.scenarios[c.scenario],
      requiredInvariants: c.invariants,
      severity: 'HIGH',
      gatePolicy: 'REQUIRED',
    })),
  });
  const corpusRevisionId = String(corpus['corpusRevisionId']);
  const gate = await api('POST', '/gates', {
    projectId: p.projectId,
    name: `${label} gate`,
    corpusRevisionId,
    enforcementMode: 'LOCAL_ADVISORY',
    buildAttestationPolicy: 'ALLOW_USER_ASSERTED',
  });
  return { corpusRevisionId, gateId: String(gate['gateId']) };
}

async function gateRun(
  p: ProjectIds,
  corpusRevisionId: string,
  gateId: string,
  maxParallelCases: number,
): Promise<{ gateRunId: string; proxyBaseUrl: string; cases: J[] }> {
  const g = await api('POST', '/gate-runs', {
    projectId: p.projectId,
    gateId,
    buildRevisionId: p.buildRevisionId,
    artifactDigest: p.artifactDigest,
    corpusRevisionId,
    effectManifestDigest: p.manifestDigest,
    effectCoveragePolicyDigest: p.policyDigest,
    callsiteInventoryDigest: null,
    interceptorProfileDigest: null,
    buildAttestation: { class: 'USER_ASSERTED_LOCAL' },
    mode: 'SIMULATE',
    maxParallelCases,
  });
  const gateRunId = String(g['gateRunId']);
  const v = await api('POST', `/gate-runs/${gateRunId}/validate`, {}, Number(g['revision']));
  const s = await api('POST', `/gate-runs/${gateRunId}/start`, {}, Number((v['gateRun'] as J)['revision']));
  const cases = (await api('GET', `/gate-runs/${gateRunId}/cases?limit=200`))['items'] as J[];
  return { gateRunId, proxyBaseUrl: String(s['proxyBaseUrl']), cases };
}

/** Start one case, drive it with a separately launched subject, close its input. */
async function runCase(
  proxyBaseUrl: string,
  caseRunId: string,
  key: string,
  behaviour: 'RECONCILING' | 'NAIVE_RESUBMIT',
): Promise<string> {
  const start = await api('POST', `/case-runs/${caseRunId}/start`, {});
  progress(`case ${caseRunId} started`);
  const subject = await Subject.launch();
  progress('subject launched');
  try {
    await subject.attach(proxyBaseUrl, credentials(start));
    await driveJob(subject, key, behaviour);
  } finally {
    await subject.close();
  }
  await api('POST', `/case-runs/${caseRunId}/finish-input`, {});
  return String(start['sessionId']);
}

const t0 = performance.now();
const timings: Record<string, number> = {};
const mark = (name: string, since: number) => {
  timings[name] = Math.round(performance.now() - since);
  progress(`${name} ${timings[name]} ms`);
};
function progress(line: string): void {
  if (process.env['ROUTESPEC_SEED_PROGRESS'] === '1')
    process.stderr.write(`seed: ${line}
`);
}

// 1. Release check: four isolated cases evaluated by the kernel and aggregated by the gate.
let since = performance.now();
const release = await project('Release check', [
  'happy-path',
  'private-not-visible',
  'accepted-then-lost-response',
  'terminal-contradiction',
  'refund-shortfall',
]);
const releaseCases = [
  { scenario: 'happy-path', invariants: ['INV-01', 'INV-02', 'INV-03', 'INV-05'] },
  { scenario: 'private-not-visible', invariants: ['INV-01', 'INV-02', 'INV-03', 'INV-05'] },
  { scenario: 'accepted-then-lost-response', invariants: ['INV-01', 'INV-02', 'INV-03'] },
  { scenario: 'terminal-contradiction', invariants: ['INV-01', 'INV-03', 'INV-06'] },
  { scenario: 'refund-shortfall', invariants: ['INV-01', 'INV-02', 'INV-03', 'INV-05'] },
];
const releaseGate = await corpusAndGate(release, 'release-corpus', releaseCases);
const evaluated = await gateRun(release, releaseGate.corpusRevisionId, releaseGate.gateId, 2);
const evaluatedSessions: string[] = [];
for (const [i, c] of evaluated.cases.entries()) {
  const scenario = releaseCases[i]?.scenario ?? 'happy-path';
  evaluatedSessions.push(
    await runCase(
      evaluated.proxyBaseUrl,
      String(c['caseRunId']),
      `order-${scenario}`,
      scenario === 'accepted-then-lost-response' ? 'NAIVE_RESUBMIT' : 'RECONCILING',
    ),
  );
}
const evaluation = await api('POST', `/gates/${releaseGate.gateId}/evaluate`, {
  gateRunId: evaluated.gateRunId,
});
for (const c of (await api('GET', `/gate-runs/${evaluated.gateRunId}/cases`))['items'] as J[]) {
  progress(
    `release case ${String(c['scenarioName'])}: ${String(c['lifecycle'])} ${String(c['verdict'])} ${JSON.stringify(c['evidence'])}`,
  );
}
mark('releaseGateRun', since);

// 2. A gate run on the happy-path corpus left for the operator: created only, so the
//    keyboard journey validates, starts, and drives it from the console.
const journeyGate = await corpusAndGate(release, 'journey-corpus', [releaseCases[2] as never]);
// A second build registration for the corrected installed client (same project and revision;
// a different commit), with its own manifest and declared-hooks-only policy.
const corrected = await registerBuild(release, 'corrected');

// 3. Dense session: one isolated case on a long-polling scenario. The scenario declares the
//    largest request budget the M03 runtime accepts (HARD_CAPS.maxRequests = 8192), so one
//    session holds at most about 8,190 journal events; the 10,000-event load is the 100-case
//    gate run below.
since = performance.now();
const denseSource = (CORE_SCENARIO_SOURCES['happy-path'] as string)
  .replace('scenarioId: happy-path', 'scenarioId: long-poll-status')
  .replace(
    'title: Quote, commit, and a proven delivered swap',
    'title: Quote, commit, and a long status poll',
  )
  .replace('resourceBudget: {}', 'resourceBudget: { maxRequests: 8192, maxEvents: 65536 }');
const denseScenario = String(
  (await api('POST', '/scenarios', { projectId: release.projectId, source: denseSource }))[
    'scenarioRevisionId'
  ],
);
release.scenarios['long-poll-status'] = denseScenario;
const denseGate = await corpusAndGate(release, 'dense-session-corpus', [
  { scenario: 'long-poll-status', invariants: ['INV-01', 'INV-02', 'INV-03', 'INV-05'] },
]);
const dense = await gateRun(release, denseGate.corpusRevisionId, denseGate.gateId, 1);
const denseCase = String((dense.cases[0] as J)['caseRunId']);
const denseStart = await api('POST', `/case-runs/${denseCase}/start`, {});
const denseSession = String(denseStart['sessionId']);
{
  const subject = await Subject.launch();
  await subject.attach(dense.proxyBaseUrl, credentials(denseStart));
  // One long-running logical job: quote, submit, then status polls (each poll is one
  // persisted provider observation) up to the scenario's request budget.
  await driveJob(subject, 'dense-order', 'RECONCILING', DENSE_SESSION_POLLS, false);
  await subject.close();
}
await api('POST', `/case-runs/${denseCase}/finish-input`, {});
const denseEvents = Number((await api('GET', `/sessions/${denseSession}`))['eventCount']);
progress(`dense session events ${denseEvents}`);
mark('denseSession', since);

// 4. A 100-case corpus whose cases together journal 10,000 events, executed under bounded
//    parallelism (4) by separately launched subjects, then evaluated (NFR-04 timing).
since = performance.now();
const many = await corpusAndGate(
  release,
  'hundred-case-corpus',
  Array.from({ length: DENSE_CASES }, () => releaseCases[0] as never),
);
const hundred = await gateRun(release, many.corpusRevisionId, many.gateId, 4);
const perCasePolls = Math.max(1, Math.ceil(DENSE_EVENT_TARGET / DENSE_CASES) - 2);
let caseEvaluationMs = 0;
{
  const queue = hundred.cases.map((c) => String(c['caseRunId']));
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const start = await api('POST', `/case-runs/${id}/start`, {});
      const subject = await Subject.launch();
      try {
        await subject.attach(hundred.proxyBaseUrl, credentials(start));
        await driveJob(subject, `bulk-${id}`, 'RECONCILING', perCasePolls, false);
      } finally {
        await subject.close();
      }
      const e0 = performance.now();
      await api('POST', `/case-runs/${id}/finish-input`, {});
      caseEvaluationMs += performance.now() - e0;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}
let hundredEvents = 0;
for (const c of (await api('GET', `/gate-runs/${hundred.gateRunId}/cases?limit=200`))['items'] as J[]) {
  hundredEvents += Number((await api('GET', `/sessions/${String(c['sessionId'])}`))['eventCount']);
}
const g0 = performance.now();
const hundredEvaluation = await api('POST', `/gates/${many.gateId}/evaluate`, {
  gateRunId: hundred.gateRunId,
});
const gateEvaluationMs = performance.now() - g0;
timings['hundredCaseKernelEvaluationMs'] = Math.round(caseEvaluationMs);
timings['hundredCaseGateEvaluationMs'] = Math.round(gateEvaluationMs);
mark('hundredCaseGateRun', since);
progress(`hundred-case events ${hundredEvents}, decision ${String(hundredEvaluation['decision'])}`);

// 4b. A second 100-case gate run, started but not driven: its cases wait for slots.
const queued = await gateRun(release, many.corpusRevisionId, many.gateId, 4);

// 5. Installed capture of the failing case, quarantined for the regression journey.
const failingCase = String((evaluated.cases[2] as J)['caseRunId']);
const capture = await api('POST', `/case-runs/${failingCase}/captures`, {});

// 5b. M16 (RP-08): an installed capture of an uncontained case is refused as release evidence;
//     it is promoted as an explicit diagnostic-only ADVISORY case, and a gate on that corpus is
//     evaluated so the console can show the release-evidence export refusal.
const diagCase = String((evaluated.cases[0] as J)['caseRunId']);
const diagCapture = await api('POST', `/case-runs/${diagCase}/captures`, {});
const diagImportId = String(diagCapture['importId']);
const diagProposal = await api('GET', `/imports/${diagImportId}/proposed-mapping`);
await api(
  'POST',
  `/imports/${diagImportId}/mapping`,
  { mapping: diagProposal['mapping'] },
  Number(diagProposal['revision']),
);
const diagMapped = await api('GET', `/imports/${diagImportId}`);
await api('POST', `/imports/${diagImportId}/verify-replay`, {}, Number(diagMapped['revision']));
const diagVerified = await api('GET', `/imports/${diagImportId}`);
const diagReview = diagVerified['review'] as { decisions: string[]; confirmationPhrase: string };
await api(
  'POST',
  `/imports/${diagImportId}/reviews`,
  {
    reviewer: 'seed reviewer',
    decisions: Object.fromEntries(diagReview.decisions.map((k) => [k, true])),
    confirmation: diagReview.confirmationPhrase,
  },
  Number(diagVerified['revision']),
);
const diagReviewed = await api('GET', `/imports/${diagImportId}`);
const diagPromoted = await api(
  'POST',
  `/imports/${diagImportId}/promote`,
  {
    reviewId: String((diagReviewed['review'] as J)['latestReviewId']),
    baseCorpusRevisionId: releaseGate.corpusRevisionId,
    corpusLabel: 'release corpus + diagnostic capture',
    severity: 'HIGH',
    gatePolicy: 'ADVISORY',
    evidenceUse: 'DIAGNOSTIC_ONLY',
  },
  Number(diagReviewed['revision']),
);
const diagCorpus = String(diagPromoted['corpusRevisionId']);
const diagGate = await api('POST', '/gates', {
  projectId: release.projectId,
  name: 'release gate with a diagnostic capture',
  corpusRevisionId: diagCorpus,
  enforcementMode: 'LOCAL_ADVISORY',
  buildAttestationPolicy: 'ALLOW_USER_ASSERTED',
});
const diagRun = await gateRun(release, diagCorpus, String(diagGate['gateId']), 1);
const diagEvaluation = await api('POST', `/gates/${String(diagGate['gateId'])}/evaluate`, {
  gateRunId: diagRun.gateRunId,
});

// 6. Crashed runners: each subject is killed mid-job and its lease is left to expire.
const crashGate = await corpusAndGate(release, 'crash-corpus', [releaseCases[0] as never]);
const crashes: Array<{ gateRunId: string; caseRunId: string }> = [];
for (let i = 0; i < 3; i++) {
  const crash = await gateRun(release, crashGate.corpusRevisionId, crashGate.gateId, 1);
  const crashCase = String((crash.cases[0] as J)['caseRunId']);
  const start = await api('POST', `/case-runs/${crashCase}/start`, {});
  const subject = await Subject.launch();
  await subject.attach(crash.proxyBaseUrl, credentials(start));
  await subject.logicalJob(`order-crash-${i}`);
  const q = await subject.call('getQuote', quoteBody());
  const depositAddress = String((((q['value'] ?? {}) as J)['quote'] as J)['depositAddress']);
  await subject.call('submitDepositTx', { txHash: `sim-tx-crash-${i}`, depositAddress });
  await subject.kill();
  crashes.push({ gateRunId: crash.gateRunId, caseRunId: crashCase });
}
// Every case that is still executing now holds an expired lease (only the crashed one is).
clock.offsetMs += LEASE_TTL_MS + 60_000;

timings['total'] = Math.round(performance.now() - t0);

const seed = {
  dataDirectory: dir,
  release: {
    ...release,
    corpusRevisionId: releaseGate.corpusRevisionId,
    gateId: releaseGate.gateId,
    gateRunId: evaluated.gateRunId,
    caseRunIds: evaluated.cases.map((c) => String(c['caseRunId'])),
    sessionIds: evaluatedSessions,
    gateEvaluationId: String(evaluation['gateEvaluationId']),
    decision: String(evaluation['decision']),
  },
  journey: { corpusRevisionId: journeyGate.corpusRevisionId, gateId: journeyGate.gateId, corrected },
  dense: { gateRunId: dense.gateRunId, caseRunId: denseCase, sessionId: denseSession, events: denseEvents },
  hundred: {
    gateRunId: hundred.gateRunId,
    gateId: many.gateId,
    events: hundredEvents,
    decision: String(hundredEvaluation['decision']),
  },
  queued: { gateRunId: queued.gateRunId },
  capture: { importId: String(capture['importId']), sourceCaseRunId: failingCase },
  diagnostic: {
    importId: diagImportId,
    gateRunId: diagRun.gateRunId,
    gateEvaluationId: String(diagEvaluation['gateEvaluationId']),
  },
  crashes,
  timings,
};

process.send?.({ type: 'ready', origin, token, seed });
if (!process.send) {
  // Manual run: print ids (never the token) and keep serving.
  process.stderr.write(`${JSON.stringify({ origin, seed }, null, 2)}\n`);
}

const stop = async () => {
  await server.close().catch(() => undefined);
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  process.exit(0);
};
process.on('message', (m) => {
  if ((m as J)['type'] === 'stop') void stop();
});
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
