/**
 * T-044 — Control mutations are idempotent and schema-strict.
 *
 * Real ControlServer instances on loopback sockets over the real journal. Attestation uses
 * keys generated here at run time: a separately launched reviewed launcher process signs with
 * its own Ed25519 key over its inherited IPC pipe, and CI OIDC tokens are ES256 tokens from a
 * locally generated issuer key pinned in the enrolled policy (no issuer is contacted). Case runs
 * drive the pinned official SDK in a separate subject process through the networkless proxy.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT_INSTANCE_DIGEST_DOMAIN, digestValue } from '@routespec/contracts';
import { ciNonceBinding, fileDigest, inventoryContentDigest } from '../src/index.ts';
import {
  LAUNCHER_SCRIPT,
  SUBJECT_SCRIPT,
  caseHeaders,
  credentialsOf,
  d,
  enroll,
  errorCode,
  expectOk,
  gateRunBody,
  key,
  launcherKeyFile,
  quoteBody,
  raw,
  setupProject,
  startHarness,
  startedGateRun,
  PREFIX,
  Subject,
  type Harness,
  type ProjectSetup,
} from './support/fixture.ts';

type J = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
describe('T-044 — Control mutations are idempotent and schema-strict', () => {
  describe('schema strictness, idempotency, optimistic revisions, bounds, and project scoping', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness();
    });
    afterAll(async () => {
      await h?.close();
    });

    it('rejects unknown fields, duplicate keys, bad JSON, BOMs, oversize bodies, and missing preconditions', async () => {
      const before = h.tableCounts();
      const noKey = await h.api('POST', '/projects', { name: 'x' }, { idem: null });
      expect([noKey.status, errorCode(noKey)]).toEqual([428, 'RS_IDEMPOTENCY_KEY_REQUIRED']);
      const shortKey = await h.api('POST', '/projects', { name: 'x' }, { idem: 'short' });
      expect(errorCode(shortKey)).toBe('RS_SCHEMA_INVALID');
      const unknown = await h.api('POST', '/projects', { name: 'x', owner: 'someone' });
      expect(unknown.status).toBe(400);
      const details = (unknown.json?.['error'] as J)['details'] as J;
      expect(details['unknownFields']).toEqual(['owner']);
      expect((details['fields'] as J[])[0]).toMatchObject({ code: 'UNKNOWN_FIELD' });
      expect(unknown.text).not.toContain('someone');
      const headers = { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' };
      const dup = await raw(h.port, {
        method: 'POST',
        path: `${PREFIX}/projects`,
        headers: { ...headers, 'idempotency-key': key() },
        body: '{"name":"a","name":"b"}',
      });
      expect([dup.status, errorCode(dup)]).toEqual([400, 'RS_SCHEMA_INVALID']);
      const bad = await raw(h.port, {
        method: 'POST',
        path: `${PREFIX}/projects`,
        headers: { ...headers, 'idempotency-key': key() },
        body: '{"name":',
      });
      expect(errorCode(bad)).toBe('RS_SCHEMA_INVALID');
      const bom = await raw(h.port, {
        method: 'POST',
        path: `${PREFIX}/projects`,
        headers: { ...headers, 'idempotency-key': key() },
        body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"name":"b"}')]),
      });
      expect(errorCode(bom)).toBe('RS_SCHEMA_INVALID');
      const big = await raw(h.port, {
        method: 'POST',
        path: `${PREFIX}/projects`,
        headers: { ...headers, 'idempotency-key': key() },
        body: JSON.stringify({ name: 'x'.repeat(300_000) }),
      });
      expect([big.status, errorCode(big)]).toEqual([413, 'RS_BODY_TOO_LARGE']);
      const deep = await raw(h.port, {
        method: 'POST',
        path: `${PREFIX}/projects`,
        headers: { ...headers, 'idempotency-key': key() },
        body: '{"name":"x","d":' + '['.repeat(40) + ']'.repeat(40) + '}',
      });
      expect(errorCode(deep)).toBe('RS_SCHEMA_INVALID');
      const long = await h.api('POST', '/projects', { name: 'n'.repeat(201) });
      expect(errorCode(long)).toBe('RS_SCHEMA_INVALID');
      const bodyOnGet = await raw(h.port, { method: 'GET', path: `${PREFIX}/projects`, headers, body: '{}' });
      expect(errorCode(bodyOnGet)).toBe('RS_SCHEMA_INVALID');
      expect(h.tableCounts()).toEqual(before);
    });

    it('replays an identical retry, refuses a changed body under the same key, and checks If-Match', async () => {
      const idem = key('proj');
      const a = await h.api('POST', '/projects', { name: 'alpha' }, { idem });
      const b = await h.api('POST', '/projects', { name: 'alpha' }, { idem });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.headers['idempotent-replay']).toBe('true');
      expect(b.json).toEqual(a.json);
      const projects = h.store.countRows('projects');
      const changed = await h.api('POST', '/projects', { name: 'alpha-changed' }, { idem });
      expect([changed.status, errorCode(changed)]).toEqual([409, 'RS_IDEMPOTENCY_KEY_REUSED']);
      expect(h.store.countRows('projects')).toBe(projects);
      const projectId = String(a.json?.['projectId']);
      const noMatch = await h.api('PATCH', `/projects/${projectId}`, { name: 'beta' });
      expect([noMatch.status, errorCode(noMatch)]).toEqual([428, 'RS_PRECONDITION_REQUIRED']);
      const stale = await h.api('PATCH', `/projects/${projectId}`, { name: 'beta' }, { ifMatch: 7 });
      expect([stale.status, errorCode(stale)]).toEqual([412, 'RS_REVISION_CONFLICT']);
      const okPatch = expectOk(
        await h.api('PATCH', `/projects/${projectId}`, { name: 'beta' }, { ifMatch: 1 }),
        200,
      );
      expect(okPatch['settingsRevision']).toBe(2);
      const again = await h.api('PATCH', `/projects/${projectId}`, { name: 'gamma' }, { ifMatch: 1 });
      expect(errorCode(again)).toBe('RS_REVISION_CONFLICT');
      // Deletion is a dry run until the exact plan digest is confirmed.
      const plan = expectOk(await h.api('DELETE', `/projects/${projectId}`, {}, { ifMatch: 2 }), 200);
      expect(plan).toMatchObject({ dryRun: true, deleted: false, repositoriesAffected: false });
      const wrong = await h.api(
        'DELETE',
        `/projects/${projectId}`,
        { confirmDigest: d('other') },
        { ifMatch: 2 },
      );
      expect(errorCode(wrong)).toBe('RS_DELETION_PLAN_MISMATCH');
      expectOk(await h.api('GET', `/projects/${projectId}`), 200);
      const del = expectOk(
        await h.api(
          'DELETE',
          `/projects/${projectId}`,
          { confirmDigest: plan['planDigest'] },
          { ifMatch: 2 },
        ),
        200,
      );
      expect(del).toMatchObject({ deleted: true, physicalPurge: 'PENDING_RETENTION_SCHEDULER' });
      expect((await h.api('GET', `/projects/${projectId}`)).status).toBe(404);
    });

    it('keeps builds USER_ASSERTED_LOCAL, immutable, and project-scoped; caller claims are unknown fields', async () => {
      const a = await setupProject(h, 'scope-a');
      const b = await setupProject(h, 'scope-b');
      const build = expectOk(await h.api('GET', `/projects/${a.projectId}/builds`), 200);
      const items = build['items'] as J[];
      expect(items).toHaveLength(1);
      expect(items[0]?.['registrationClaim']).toBe('USER_ASSERTED_LOCAL');
      const body = {
        integrationRevisionId: a.integrationRevisionId,
        repositoryLocator: 'git+file:subject/scope-a',
        commitSha: 'a'.repeat(40),
        dirtyTreeDigest: null,
        artifactDigest: a.artifactDigest,
        toolchainDigest: d('toolchain'),
        lockDigest: d('lock'),
        effectManifestDigest: d('manifest-scope-a'),
        launchRecipeDigest: d('recipe'),
        ciWorkflowRunId: null,
      };
      const same = expectOk(await h.api('POST', `/projects/${a.projectId}/builds`, body), 201);
      expect(same['buildRevisionId']).toBe(a.buildRevisionId);
      for (const claim of [
        { registrationClaim: 'TRUSTED_LAUNCHER' },
        { attestationClass: 'CI_ATTESTED' },
        { verified: true },
      ]) {
        const r = await h.api('POST', `/projects/${a.projectId}/builds`, { ...body, ...claim });
        expect(errorCode(r), JSON.stringify(claim)).toBe('RS_SCHEMA_INVALID');
      }
      const crossBuild = await h.api('POST', `/projects/${b.projectId}/builds`, { ...body });
      expect(errorCode(crossBuild)).toBe('RS_NOT_FOUND');
      const crossRun = await h.api(
        'POST',
        '/gate-runs',
        gateRunBody({ ...b, buildRevisionId: a.buildRevisionId, artifactDigest: a.artifactDigest }),
      );
      expect(errorCode(crossRun)).toBe('RS_NOT_FOUND');
      const crossCorpus = await h.api(
        'POST',
        '/gate-runs',
        gateRunBody({ ...a, corpusRevisionId: b.corpusRevisionId }),
      );
      expect(errorCode(crossCorpus)).toBe('RS_NOT_FOUND');
      const crossPolicy = await h.api(
        'POST',
        '/gate-runs',
        gateRunBody({ ...a, policyDigest: b.policyDigest }),
      );
      expect(errorCode(crossPolicy)).toBe('RS_NOT_FOUND');
      const live = await h.api('POST', '/gate-runs', gateRunBody(a, { mode: 'LIVE_DRY_PROBE' }));
      expect([live.status, errorCode(live)]).toEqual([403, 'RS_MODE_POLICY_DENIED']);
      const blocking = await h.api('POST', '/gates', {
        projectId: a.projectId,
        name: 'blocking',
        corpusRevisionId: a.corpusRevisionId,
        enforcementMode: 'BLOCKS_RELEASE',
        buildAttestationPolicy: 'ALLOW_USER_ASSERTED',
      });
      expect(errorCode(blocking)).toBe('RS_ENFORCEMENT_CLAIM_REJECTED');
      for (const limit of ['0', '201', 'x']) {
        expect(errorCode(await h.api('GET', `/projects?limit=${limit}`))).toBe('RS_SCHEMA_INVALID');
      }
      const probe = await h.api('POST', '/compatibility-probes', {
        buildRevisionId: a.buildRevisionId,
        protocolProfileId: 'oneclick-v0@1.0.0',
      });
      expect([probe.status, errorCode(probe)]).toEqual([403, 'RS_PROBE_NOT_AUTHORIZED']);
    });

    it('refuses complete-effect claims without an attested independent interceptor and keeps direct inventories declared-only', async () => {
      const a = await setupProject(h, 'effects');
      const policy = (extra: J) => ({
        projectId: a.projectId,
        buildRevisionId: a.buildRevisionId,
        artifactDigest: a.artifactDigest,
        selectedAttestationId: null,
        scenarioRevisionId: a.scenarioRevisionId,
        manifestDigest: a.manifestDigest,
        requiredSinkClasses: ['fulfilment-webhook'],
        interceptorProfileDigest: null,
        callsiteInventoryDigest: null,
        basis: 'INDEPENDENT_BOUNDARY_INTERCEPT',
        ...extra,
      });
      expect(errorCode(await h.api('POST', '/effect-coverage-policies', policy({})))).toBe(
        'RS_SINK_UNSUPPORTED',
      );
      const hooksOnly = expectOk(
        await h.api('POST', '/interceptor-profiles', {
          projectId: a.projectId,
          interceptorArtifactDigest: d('icpt'),
          containment: 'DECLARED_HOOKS_ONLY',
          processTreeScope: 'subject only',
          supportedSinks: ['fulfilment-webhook'],
          denialMechanism: 'DENY',
        }),
        201,
      );
      expect(hooksOnly['reviewState']).toBe('DECLARED_UNREVIEWED');
      expect(
        errorCode(
          await h.api(
            'POST',
            '/effect-coverage-policies',
            policy({ interceptorProfileDigest: hooksOnly['profileDigest'] }),
          ),
        ),
      ).toBe('RS_SINK_UNSUPPORTED');
      const narrow = expectOk(
        await h.api('POST', '/interceptor-profiles', {
          projectId: a.projectId,
          interceptorArtifactDigest: d('icpt2'),
          containment: 'PROCESS_TREE_ENFORCED',
          processTreeScope: 'job object',
          supportedSinks: ['email'],
          denialMechanism: 'CANARY_REDIRECT',
        }),
        201,
      );
      expect(
        errorCode(
          await h.api(
            'POST',
            '/effect-coverage-policies',
            policy({ interceptorProfileDigest: narrow['profileDigest'] }),
          ),
        ),
      ).toBe('RS_SINK_UNSUPPORTED');
      const inv = {
        projectId: a.projectId,
        buildRevisionId: a.buildRevisionId,
        manifestDigest: a.manifestDigest,
        analyzerDigest: d('analyzer'),
        attestationId: null,
        callsites: [
          { callsiteId: 'c1', sinkClass: 'fulfilment-webhook', hookId: 'fulfilment', dynamic: false },
        ],
        unsupportedFindings: 0,
      };
      const declared = expectOk(await h.api('POST', '/effect-callsite-inventories', inv), 201);
      expect(declared).toMatchObject({ trust: 'DECLARED_HOOKS_ONLY', replacesRuntimeInterception: false });
      const full = expectOk(
        await h.api('POST', '/interceptor-profiles', {
          projectId: a.projectId,
          interceptorArtifactDigest: d('icpt3'),
          containment: 'PROCESS_TREE_ENFORCED',
          processTreeScope: 'job object',
          supportedSinks: ['fulfilment-webhook'],
          denialMechanism: 'DENY',
        }),
        201,
      );
      const inventoryOnly = await h.api(
        'POST',
        '/effect-coverage-policies',
        policy({
          basis: 'TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT',
          interceptorProfileDigest: full['profileDigest'],
          callsiteInventoryDigest: declared['inventoryDigest'],
        }),
      );
      expect(errorCode(inventoryOnly)).toBe('RS_SINK_UNSUPPORTED');
      expect(
        errorCode(
          await h.api('POST', '/effect-coverage-policies', { ...policy({}), inventoryComplete: true }),
        ),
      ).toBe('RS_SCHEMA_INVALID');
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('attester enrollment, launcher and CI challenges, revocation', () => {
    let h: Harness;
    let p: ProjectSetup;
    let launcherKey: ReturnType<typeof launcherKeyFile>;
    let inputsFile: string;
    let localPrincipal = '';
    let buildAttestationId = '';
    const writeInputs = (v: J) => writeFileSync(inputsFile, JSON.stringify(v));
    const buildInputs = () => ({
      lockDigest: d('lock'),
      toolchainDigest: d('toolchain'),
      manifestDigest: d('manifest-attest'),
    });
    const launcherPolicy = (overrides: J = {}) => ({
      kind: 'LOCAL_LAUNCHER_KEY',
      publicKeyJwk: launcherKey.publicJwk,
      launcherArtifactDigest: fileDigest(LAUNCHER_SCRIPT),
      peerBinding: 'INHERITED_IPC_CHILD',
      validFromMs: h.clock.nowMs() - 1000,
      validUntilMs: h.clock.nowMs() + 86_400_000,
      maxFreshnessMs: 3_600_000,
      ...overrides,
    });

    beforeAll(async () => {
      h = await startHarness();
      p = await setupProject(h, 'attest');
      launcherKey = launcherKeyFile(h.dir, 'launcher');
      inputsFile = join(h.dir, 'launcher-inputs.json');
      writeInputs(buildInputs());
    });
    afterAll(async () => {
      await h?.close();
    });

    it('enrollment needs a distinct out-of-band local confirmation and never accepts private key material', async () => {
      const policy = launcherPolicy();
      const before = h.store.countRows('attester_principals');
      const first = expectOk(
        await h.api('POST', '/attester-principals', {
          projectId: p.projectId,
          label: 'local launcher',
          policy,
        }),
        202,
      );
      expect(first['status']).toBe('LOCAL_CONFIRMATION_REQUIRED');
      const notice = h.confirmations.at(-1);
      expect(notice?.confirmationId).toBe(first['confirmationId']);
      expect(JSON.stringify(first)).not.toContain(String(notice?.code));
      const wrong = await h.api('POST', '/attester-principals', {
        projectId: p.projectId,
        label: 'local launcher',
        policy,
        confirmation: { confirmationId: notice?.confirmationId, code: 'A'.repeat(24) },
      });
      expect([wrong.status, errorCode(wrong)]).toEqual([403, 'RS_LOCAL_CONFIRMATION_INVALID']);
      const otherPlan = await h.api('POST', '/attester-principals', {
        projectId: p.projectId,
        label: 'local launcher',
        policy: { ...policy, maxFreshnessMs: 7_200_000 },
        confirmation: { confirmationId: notice?.confirmationId, code: notice?.code },
      });
      expect(errorCode(otherPlan)).toBe('RS_LOCAL_CONFIRMATION_INVALID');
      const priv = launcherKey.privateKey.export({ format: 'jwk' }) as J;
      const withPrivate = await h.api('POST', '/attester-principals', {
        projectId: p.projectId,
        label: 'leaky',
        policy: { ...policy, publicKeyJwk: { ...launcherKey.publicJwk, d: priv['d'] } },
      });
      expect(errorCode(withPrivate)).toBe('RS_SCHEMA_INVALID');
      expect(withPrivate.text).not.toContain(String(priv['d']));
      const caseTokenCall = await raw(h.port, {
        method: 'POST',
        path: `${PREFIX}/attester-principals`,
        headers: {
          'content-type': 'application/json',
          'idempotency-key': key(),
          'x-routespec-case-token': `rsct_${'c'.repeat(43)}`,
        },
        body: JSON.stringify({ projectId: p.projectId, label: 'x', policy }),
      });
      expect([caseTokenCall.status, errorCode(caseTokenCall)]).toEqual([401, 'RS_CONTROL_AUTH_INVALID']);
      expect(h.store.countRows('attester_principals')).toBe(before);
      const done = expectOk(
        await h.api('POST', '/attester-principals', {
          projectId: p.projectId,
          label: 'local launcher',
          policy,
          confirmation: { confirmationId: notice?.confirmationId, code: notice?.code },
        }),
        201,
      );
      localPrincipal = String(done['principalId']);
      expect(done).toMatchObject({ kind: 'LOCAL_LAUNCHER_KEY', enabled: true, revocationEpoch: 0 });
      expect(JSON.stringify(done)).not.toMatch(/"d"|PRIVATE/);
      const reuse = await h.api('POST', '/attester-principals', {
        projectId: p.projectId,
        label: 'second',
        policy,
        confirmation: { confirmationId: notice?.confirmationId, code: notice?.code },
      });
      expect(errorCode(reuse)).toBe('RS_LOCAL_CONFIRMATION_INVALID');
    });

    it('a launcher principal completes only over its own private channel and binds independently computed digests', async () => {
      const challenges = h.store.countRows('launcher_challenges');
      const detached = await h.api('POST', '/launcher-challenges', {
        scope: 'BUILD_REGISTRATION',
        projectId: p.projectId,
        principalId: localPrincipal,
        buildRevisionId: p.buildRevisionId,
      });
      expect([detached.status, errorCode(detached)]).toEqual([403, 'RS_PEER_BINDING_UNAVAILABLE']);
      expect(h.store.countRows('launcher_challenges')).toBe(challenges);

      const buildBefore = h.store.journal.read((db) =>
        db.prepare('SELECT * FROM build_revisions WHERE build_revision_id = ?').get(p.buildRevisionId),
      );
      const prior = expectOk(await h.api('POST', '/gate-runs', gateRunBody(p)), 201);
      const priorRow = h.store.getGateRun(String(prior['gateRunId']));

      h.server.attachLauncher(localPrincipal, LAUNCHER_SCRIPT, [
        launcherKey.path,
        SUBJECT_SCRIPT,
        inputsFile,
        'honest',
      ]);
      writeInputs({ ...buildInputs(), manifestDigest: d('manifest-attest') });
      const ok1 = expectOk(
        await h.api('POST', '/launcher-challenges', {
          scope: 'BUILD_REGISTRATION',
          projectId: p.projectId,
          principalId: localPrincipal,
          buildRevisionId: p.buildRevisionId,
        }),
        201,
      );
      expect(ok1).toMatchObject({
        outcome: 'ATTESTED',
        attestationClass: 'TRUSTED_LAUNCHER',
        scope: 'BUILD_REGISTRATION',
        channel: 'PRIVATE_IPC',
      });
      expect(JSON.stringify(ok1)).not.toContain('nonce":"');
      buildAttestationId = String(ok1['attestationId']);

      // A later attestation never mutates the build or an existing gate run.
      expect(
        h.store.journal.read((db) =>
          db.prepare('SELECT * FROM build_revisions WHERE build_revision_id = ?').get(p.buildRevisionId),
        ),
      ).toEqual(buildBefore);
      expect(h.store.getGateRun(String(prior['gateRunId']))).toEqual(priorRow);
      const priorView = expectOk(await h.api('GET', `/gate-runs/${String(prior['gateRunId'])}`), 200);
      expect((priorView['attestation'] as J)['class']).toBe('USER_ASSERTED_LOCAL');
      const builds = expectOk(await h.api('GET', `/projects/${p.projectId}/builds`), 200);
      expect((builds['items'] as J[])[0]?.['registrationClaim']).toBe('USER_ASSERTED_LOCAL');

      // Only a new gate run can select it.
      const attested = expectOk(
        await h.api(
          'POST',
          '/gate-runs',
          gateRunBody(p, { buildAttestation: { subjectAttestationId: buildAttestationId } }),
        ),
        201,
      );
      expect(attested['attestation']).toMatchObject({
        class: 'TRUSTED_LAUNCHER',
        attestationId: buildAttestationId,
        freshness: 'FRESH',
      });
      const forged = await h.api(
        'POST',
        '/gate-runs',
        gateRunBody(p, { buildAttestation: { class: 'TRUSTED_LAUNCHER' } }),
      );
      expect(errorCode(forged)).toBe('RS_SCHEMA_INVALID');

      // The HTTP completion path is closed for this principal kind.
      const http = await h.api('POST', `/launcher-challenges/${String(ok1['challengeId'])}/complete`, {
        nonce: 'A'.repeat(43),
        observed: {},
      });
      expect([http.status, errorCode(http)]).toEqual([403, 'RS_PEER_BINDING_UNAVAILABLE']);
      const status = expectOk(await h.api('GET', `/launcher-challenges/${String(ok1['challengeId'])}`), 200);
      expect(status).toMatchObject({ consumed: true, outcome: 'ATTESTED' });
    });

    it('a swapped artifact, an out-of-scope digest, a wrong key, or an unreviewed launcher is rejected', async () => {
      const attempt = async (mode: string, keyPath: string) => {
        h.server.attachLauncher(localPrincipal, LAUNCHER_SCRIPT, [keyPath, SUBJECT_SCRIPT, inputsFile, mode]);
        return h.api('POST', '/launcher-challenges', {
          scope: 'BUILD_REGISTRATION',
          projectId: p.projectId,
          principalId: localPrincipal,
          buildRevisionId: p.buildRevisionId,
        });
      };
      const attestations = h.store.countRows('subject_attestations');
      const swap = await attempt('swap-artifact', launcherKey.path);
      expect([swap.status, errorCode(swap)]).toEqual([403, 'RS_ATTESTATION_REJECTED']);
      expect(((swap.json?.['error'] as J)['details'] as J)['reasonCode']).toBe(
        'OBSERVED_ARTIFACT_DIGEST_MISMATCH',
      );
      const scope = await attempt('out-of-scope', launcherKey.path);
      expect(((scope.json?.['error'] as J)['details'] as J)['reasonCode']).toBe(
        'OBSERVED_DIGEST_OUT_OF_SCOPE',
      );
      const otherKey = launcherKeyFile(h.dir, 'other');
      const wrongKey = await attempt('honest', otherKey.path);
      expect(((wrongKey.json?.['error'] as J)['details'] as J)['reasonCode']).toBe('SIGNATURE_INVALID');
      expect(h.store.countRows('subject_attestations')).toBe(attestations);
      // A principal enrolled for a different reviewed launcher artifact refuses this launcher.
      const unreviewed = await enroll(
        h,
        p.projectId,
        'other launcher',
        launcherPolicy({ launcherArtifactDigest: d('another-launcher') }),
      );
      h.server.attachLauncher(unreviewed, LAUNCHER_SCRIPT, [
        launcherKey.path,
        SUBJECT_SCRIPT,
        inputsFile,
        'honest',
      ]);
      const r = await h.api('POST', '/launcher-challenges', {
        scope: 'BUILD_REGISTRATION',
        projectId: p.projectId,
        principalId: unreviewed,
        buildRevisionId: p.buildRevisionId,
      });
      expect(((r.json?.['error'] as J)['details'] as J)['reasonCode']).toBe('LAUNCHER_ARTIFACT_MISMATCH');
      h.server.attachLauncher(localPrincipal, LAUNCHER_SCRIPT, [
        launcherKey.path,
        SUBJECT_SCRIPT,
        inputsFile,
        'honest',
      ]);
    });

    it('an attested inventory is bound to its exact content; it supplements but never replaces interception', async () => {
      const inv = {
        projectId: p.projectId,
        buildRevisionId: p.buildRevisionId,
        manifestDigest: p.manifestDigest,
        analyzerDigest: d('analyzer-pinned'),
        callsites: [
          { callsiteId: 'c1', sinkClass: 'fulfilment-webhook', hookId: 'fulfilment', dynamic: false },
        ],
        unsupportedFindings: 0,
      };
      const content = inventoryContentDigest(inv);
      writeInputs({
        analyzerDigest: inv.analyzerDigest,
        inventoryDigest: content,
        manifestDigest: p.manifestDigest,
      });
      const att = expectOk(
        await h.api('POST', '/launcher-challenges', {
          scope: 'EFFECT_INVENTORY',
          projectId: p.projectId,
          principalId: localPrincipal,
          buildRevisionId: p.buildRevisionId,
          manifestDigest: p.manifestDigest,
          analyzerDigest: inv.analyzerDigest,
          inventoryDigest: content,
        }),
        201,
      );
      const attestationId = String(att['attestationId']);
      const registered = expectOk(
        await h.api('POST', '/effect-callsite-inventories', { ...inv, attestationId }),
        201,
      );
      expect(registered['trust']).toBe('ATTESTED_SUPPLEMENTAL');
      const changed = await h.api('POST', '/effect-callsite-inventories', {
        ...inv,
        attestationId,
        callsites: [...inv.callsites, { callsiteId: 'c2', sinkClass: 'email', hookId: null, dynamic: true }],
      });
      expect(errorCode(changed)).toBe('RS_IDENTITY_MISMATCH');
      const wrongScope = await h.api('POST', '/effect-callsite-inventories', {
        ...inv,
        attestationId: buildAttestationId,
      });
      expect(errorCode(wrongScope)).toBe('RS_IDENTITY_MISMATCH');
      const profile = expectOk(
        await h.api('POST', '/interceptor-profiles', {
          projectId: p.projectId,
          interceptorArtifactDigest: d('icpt-a'),
          containment: 'PROCESS_TREE_ENFORCED',
          processTreeScope: 'job object',
          supportedSinks: ['fulfilment-webhook'],
          denialMechanism: 'DENY',
        }),
        201,
      );
      const policy = expectOk(
        await h.api('POST', '/effect-coverage-policies', {
          projectId: p.projectId,
          buildRevisionId: p.buildRevisionId,
          artifactDigest: p.artifactDigest,
          selectedAttestationId: buildAttestationId,
          scenarioRevisionId: p.scenarioRevisionId,
          manifestDigest: p.manifestDigest,
          requiredSinkClasses: ['fulfilment-webhook'],
          interceptorProfileDigest: profile['profileDigest'],
          callsiteInventoryDigest: registered['inventoryDigest'],
          basis: 'TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT',
        }),
        201,
      );
      expect(policy['completeEffectPredicates']).toBe('REQUIRES_ATTESTED_INTERCEPTOR');
    });

    it('CI OIDC: pinned issuer key and claims, single-use nonce, replay and concurrent completion fail closed', async () => {
      const issuer = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const jwk = issuer.publicKey.export({ format: 'jwk' }) as J;
      const now = h.clock.nowMs();
      const policy = {
        kind: 'CI_OIDC',
        issuer: 'https://ci-issuer.routespec.test',
        signingKeys: [
          {
            kid: 'k1',
            jwk: { kty: 'EC', crv: 'P-256', x: jwk['x'], y: jwk['y'] },
            notBeforeMs: now - 60_000,
            notAfterMs: now + 86_400_000,
          },
        ],
        audience: 'routespec-local',
        repositoryId: '424242',
        workflowRef: 'example/subject/.github/workflows/routespec.yml@refs/heads/main',
        allowedRefs: ['refs/heads/main'],
        subject: 'repo:example/subject:ref:refs/heads/main',
        maxTokenAgeMs: 300_000,
        maxKeyAgeMs: 30 * 86_400_000,
        validFromMs: now - 1000,
        validUntilMs: now + 86_400_000,
        maxFreshnessMs: 3_600_000,
      };
      const ci = await enroll(h, p.projectId, 'ci', policy);
      const observed = {
        artifactDigest: p.artifactDigest,
        lockDigest: d('lock'),
        toolchainDigest: d('toolchain'),
        manifestDigest: d('manifest-attest'),
      };
      const challenge = async () =>
        expectOk(
          await h.api('POST', '/launcher-challenges', {
            scope: 'BUILD_REGISTRATION',
            projectId: p.projectId,
            principalId: ci,
            buildRevisionId: p.buildRevisionId,
          }),
          201,
        );
      const token = (c: J, claims: J = {}, header: J = {}, signer: KeyObject = issuer.privateKey) => {
        const nowS = Math.floor(h.clock.nowMs() / 1000);
        const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT', ...header })).toString(
          'base64url',
        );
        const body = Buffer.from(
          JSON.stringify({
            iss: policy.issuer,
            aud: policy.audience,
            sub: policy.subject,
            repository_id: policy.repositoryId,
            job_workflow_ref: policy.workflowRef,
            ref: 'refs/heads/main',
            sha: 'a'.repeat(40),
            run_id: '9001',
            run_attempt: '1',
            iat: nowS - 5,
            nbf: nowS - 5,
            exp: nowS + 300,
            nonce: ciNonceBinding({
              challengeId: String(c['challengeId']),
              nonce: String(c['nonce']),
              observed,
            }),
            ...claims,
          }),
        ).toString('base64url');
        const sig = sign('sha256', Buffer.from(`${head}.${body}`), {
          key: signer,
          dsaEncoding: 'ieee-p1363',
        }).toString('base64url');
        return `${head}.${body}.${sig}`;
      };

      const c1 = await challenge();
      expect(String(c1['nonce'])).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const idem = key('ci-complete');
      const done = await h.api(
        'POST',
        `/launcher-challenges/${String(c1['challengeId'])}/complete`,
        { nonce: c1['nonce'], oidcToken: token(c1), observed },
        { idem },
      );
      expect(done.status).toBe(201);
      expect(done.json).toMatchObject({ outcome: 'ATTESTED', attestationClass: 'CI_ATTESTED' });
      const replay = await h.api(
        'POST',
        `/launcher-challenges/${String(c1['challengeId'])}/complete`,
        { nonce: c1['nonce'], oidcToken: token(c1), observed },
        { idem },
      );
      // The retry re-signed a token at a different second; the body differs, so the key is refused.
      expect([409, 201]).toContain(replay.status);
      const second = await h.api('POST', `/launcher-challenges/${String(c1['challengeId'])}/complete`, {
        nonce: c1['nonce'],
        oidcToken: token(c1),
        observed,
      });
      expect([second.status, errorCode(second)]).toEqual([409, 'RS_CHALLENGE_UNAVAILABLE']);

      // Concurrent completion of a fresh challenge: exactly one attestation.
      const c2 = await challenge();
      const t2 = token(c2);
      const racers = await Promise.all(
        [0, 1, 2].map(() =>
          h.api('POST', `/launcher-challenges/${String(c2['challengeId'])}/complete`, {
            nonce: c2['nonce'],
            oidcToken: t2,
            observed,
          }),
        ),
      );
      expect(racers.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(racers.filter((r) => errorCode(r) === 'RS_CHALLENGE_UNAVAILABLE')).toHaveLength(2);

      // Copy: a nonce from another challenge never completes this one (and leaves it unused).
      const c3 = await challenge();
      const copied = await h.api('POST', `/launcher-challenges/${String(c3['challengeId'])}/complete`, {
        nonce: c1['nonce'],
        oidcToken: token(c3),
        observed,
      });
      expect(errorCode(copied)).toBe('RS_ATTESTATION_REJECTED');
      expect(
        expectOk(await h.api('GET', `/launcher-challenges/${String(c3['challengeId'])}`), 200)['consumed'],
      ).toBe(false);
      // A case token cannot complete trust.
      const viaCase = await raw(h.port, {
        method: 'POST',
        path: `${PREFIX}/launcher-challenges/${String(c3['challengeId'])}/complete`,
        headers: {
          'content-type': 'application/json',
          'idempotency-key': key(),
          'x-routespec-case-token': `rsct_${'d'.repeat(43)}`,
        },
        body: JSON.stringify({ nonce: c3['nonce'], oidcToken: token(c3), observed }),
      });
      expect(viaCase.status).toBe(401);

      const nowS = Math.floor(h.clock.nowMs() / 1000);
      const otherIssuer = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const rejected: Array<[string, (c: J) => string, J?]> = [
        ['ISSUER_MISMATCH', (c) => token(c, { iss: 'https://evil.example' })],
        ['AUDIENCE_MISMATCH', (c) => token(c, { aud: 'other' })],
        ['SUBJECT_MISMATCH', (c) => token(c, { sub: 'repo:example/subject:pull_request' })],
        ['REPOSITORY_MISMATCH', (c) => token(c, { repository_id: '1' })],
        [
          'WORKFLOW_MISMATCH',
          (c) =>
            token(c, { job_workflow_ref: 'example/subject/.github/workflows/other.yml@refs/heads/main' }),
        ],
        ['REF_NOT_ALLOWED', (c) => token(c, { ref: 'refs/heads/feature' })],
        ['COMMIT_MISMATCH', (c) => token(c, { sha: 'b'.repeat(40) })],
        ['RUN_IDENTITY_MISSING', (c) => token(c, { run_id: 9001 })],
        ['NONCE_MISMATCH', (c) => token(c, { nonce: 'sha256:' + '0'.repeat(64) })],
        ['TOKEN_EXPIRED', (c) => token(c, { exp: nowS - 1 })],
        ['TOKEN_TOO_OLD', (c) => token(c, { iat: nowS - 3600 })],
        ['TOKEN_NOT_YET_VALID', (c) => token(c, { nbf: nowS + 600 })],
        ['SIGNING_KEY_UNKNOWN', (c) => token(c, {}, { kid: 'k9' })],
        ['TOKEN_ALG_UNSUPPORTED', (c) => token(c, {}, { alg: 'none' })],
        ['SIGNATURE_INVALID', (c) => token(c, {}, {}, otherIssuer.privateKey)],
        ['OBSERVED_ARTIFACT_DIGEST_MISMATCH', (c) => token(c), { artifactDigest: d('swapped-artifact') }],
      ];
      const attestations = h.store.countRows('subject_attestations');
      for (const [reason, make, observedOverride] of rejected) {
        const c = await challenge();
        const obs = observedOverride ? { ...observed, ...observedOverride } : observed;
        const tok = observedOverride
          ? (() => {
              // The token must bind the observed digests actually submitted.
              const nonceClaim = ciNonceBinding({
                challengeId: String(c['challengeId']),
                nonce: String(c['nonce']),
                observed: obs,
              });
              return token(c, { nonce: nonceClaim });
            })()
          : make(c);
        const r = await h.api('POST', `/launcher-challenges/${String(c['challengeId'])}/complete`, {
          nonce: c['nonce'],
          oidcToken: tok,
          observed: obs,
        });
        expect([r.status, errorCode(r)], reason).toEqual([403, 'RS_ATTESTATION_REJECTED']);
        expect(((r.json?.['error'] as J)['details'] as J)['reasonCode'], reason).toBe(reason);
        // Rejection consumed the challenge: a corrected retry cannot reuse it.
        const retry = await h.api('POST', `/launcher-challenges/${String(c['challengeId'])}/complete`, {
          nonce: c['nonce'],
          oidcToken: token(c),
          observed,
        });
        expect(errorCode(retry), reason).toBe('RS_CHALLENGE_UNAVAILABLE');
      }
      expect(h.store.countRows('subject_attestations')).toBe(attestations);

      // Expired challenge.
      const late = await challenge();
      h.clock.advance(301_000);
      const expired = await h.api('POST', `/launcher-challenges/${String(late['challengeId'])}/complete`, {
        nonce: late['nonce'],
        oidcToken: token(late),
        observed,
      });
      expect(((expired.json?.['error'] as J)['details'] as J)['reasonCode']).toBe('CHALLENGE_EXPIRED');
      // Interceptor launch attestation is never accepted from a CI principal.
      const icpt = await h.api('POST', '/launcher-challenges', {
        scope: 'EFFECT_INTERCEPTOR_LAUNCH',
        projectId: p.projectId,
        principalId: ci,
        caseRunId: '00000000-0000-4000-8000-000000000000',
        interceptorProfileDigest: d('x'),
      });
      expect(errorCode(icpt)).toBe('RS_NOT_FOUND');
    });

    it('revocation needs local confirmation, stops new challenges and selections, and leaves history immutable', async () => {
      const run = expectOk(
        await h.api(
          'POST',
          '/gate-runs',
          gateRunBody(p, { buildAttestation: { subjectAttestationId: buildAttestationId } }),
        ),
        201,
      );
      const runRow = h.store.getGateRun(String(run['gateRunId']));
      const attRow = h.store.journal.read((db) =>
        db.prepare('SELECT * FROM subject_attestations WHERE attestation_id = ?').get(buildAttestationId),
      );
      const runId = String(run['gateRunId']);
      const before = expectOk(
        await h.api('POST', `/gates/${p.gateId}/evaluate`, { gateRunId: runId }),
        [200, 201],
      );
      expect((before['findings'] as string[]).filter((f) => f.startsWith('BUILD_'))).toEqual([]);
      const first = expectOk(
        await h.api('POST', `/attester-principals/${localPrincipal}/revoke`, {
          reasonCode: 'KEY_COMPROMISED',
        }),
        202,
      );
      const notice = h.confirmations.find((n) => n.confirmationId === first['confirmationId']);
      expect(notice?.actionCode).toBe('ATTESTER_REVOKE');
      const revoked = expectOk(
        await h.api('POST', `/attester-principals/${localPrincipal}/revoke`, {
          reasonCode: 'KEY_COMPROMISED',
          confirmation: { confirmationId: notice?.confirmationId, code: notice?.code },
        }),
        200,
      );
      expect(revoked).toMatchObject({
        enabled: false,
        revocationEpoch: 1,
        historicalAttestations: 'IMMUTABLE',
      });
      const challenge = await h.api('POST', '/launcher-challenges', {
        scope: 'BUILD_REGISTRATION',
        projectId: p.projectId,
        principalId: localPrincipal,
        buildRevisionId: p.buildRevisionId,
      });
      expect(['RS_ATTESTER_UNAVAILABLE', 'RS_PEER_BINDING_UNAVAILABLE']).toContain(errorCode(challenge));
      const select = await h.api(
        'POST',
        '/gate-runs',
        gateRunBody(p, { buildAttestation: { subjectAttestationId: buildAttestationId } }),
      );
      expect([select.status, errorCode(select)]).toEqual([409, 'RS_ATTESTER_UNAVAILABLE']);
      expect(h.store.getGateRun(String(run['gateRunId']))).toEqual(runRow);
      expect(
        h.store.journal.read((db) =>
          db.prepare('SELECT * FROM subject_attestations WHERE attestation_id = ?').get(buildAttestationId),
        ),
      ).toEqual(attRow);
      const view = expectOk(await h.api('GET', `/gate-runs/${String(run['gateRunId'])}`), 200);
      expect(view['attestation']).toMatchObject({ class: 'TRUSTED_LAUNCHER', freshness: 'REVOKED' });
      // An evaluation after revocation re-reads the principal (TB-07): the in-progress gate run
      // records the revoked attester; the earlier evaluation is kept unchanged.
      const after = expectOk(await h.api('POST', `/gates/${p.gateId}/evaluate`, { gateRunId: runId }), 201);
      expect(after['findings']).toEqual(
        expect.arrayContaining(['BUILD_ATTESTER_DISABLED', 'BUILD_ATTESTER_REVOKED']),
      );
      expect(after['decisionDigest']).not.toBe(before['decisionDigest']);
      expect(after['decision']).not.toBe('PASS');
      const kept = h.store.journal.read((db) =>
        db
          .prepare('SELECT decision, decision_digest FROM gate_evaluations WHERE gate_evaluation_id = ?')
          .get(String(before['gateEvaluationId'])),
      ) as { decision: string; decision_digest: string };
      expect(kept).toEqual({ decision: before['decision'], decision_digest: before['decisionDigest'] });
      const again = await enroll(h, p.projectId, 'local launcher re-enrolled', launcherPolicy());
      expect(again).not.toBe(localPrincipal);
      const list = expectOk(await h.api('GET', `/projects/${p.projectId}/attester-principals`), 200);
      const old = (list['items'] as J[]).find((x) => x['principalId'] === localPrincipal);
      expect(old).toMatchObject({ enabled: false, revocationEpoch: 1 });
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('gate runs, case runs, case-token boundaries, recovery, evaluation, export, and promotion', () => {
    let h: Harness;
    let p: ProjectSetup;
    let subject: Subject | null = null;
    beforeAll(async () => {
      h = await startHarness({ leaseTtlMs: 60_000, tokenTtlMs: 600_000 });
      p = await setupProject(h, 'life');
    });
    afterAll(async () => {
      await subject?.close().catch(() => undefined);
      await h?.close();
    });

    it('gate-run lifecycle mutations are revision-checked and case starts are fenced and single-client', async () => {
      const g = expectOk(await h.api('POST', '/gate-runs', gateRunBody(p)), 201);
      const gateRunId = String(g['gateRunId']);
      expect(g).toMatchObject({
        lifecycle: 'DRAFT',
        verdict: 'NOT_RUN',
        artifactReady: null,
        enforcementMode: 'LOCAL_ADVISORY',
      });
      expect((g['officialCompatibility'] as J)['status']).toBe('NOT_RUN');
      expect(errorCode(await h.api('POST', `/gate-runs/${gateRunId}/validate`, {}))).toBe(
        'RS_PRECONDITION_REQUIRED',
      );
      expect(errorCode(await h.api('POST', `/gate-runs/${gateRunId}/validate`, {}, { ifMatch: 3 }))).toBe(
        'RS_REVISION_CONFLICT',
      );
      const v = expectOk(await h.api('POST', `/gate-runs/${gateRunId}/validate`, {}, { ifMatch: 1 }), 200);
      expect(v['ready']).toBe(true);
      expect((v['findings'] as J[]).map((f) => f['code'])).toContain(
        'DECLARED_HOOKS_ONLY_COMPLETE_EFFECT_REVIEW',
      );
      const caseRunId = String(
        ((expectOk(await h.api('GET', `/gate-runs/${gateRunId}/cases`), 200)['items'] as J[])[0] as J)[
          'caseRunId'
        ],
      );
      const early = await h.api('POST', `/case-runs/${caseRunId}/start`, {});
      expect(errorCode(early)).toBe('RS_MODE_POLICY_DENIED');
      expectOk(await h.api('POST', `/gate-runs/${gateRunId}/start`, {}, { ifMatch: 3 }), 200);
      const idem = key('case-start');
      const start = await h.api('POST', `/case-runs/${caseRunId}/start`, {}, { idem });
      expect(start.status).toBe(201);
      const s = start.json as J;
      expect((s['token'] as J)['purpose']).toBe('EXECUTION');
      const replay = await h.api('POST', `/case-runs/${caseRunId}/start`, {}, { idem });
      expect(replay.headers['idempotent-replay']).toBe('true');
      expect(replay.json?.['token']).toBeUndefined();
      expect(replay.text).not.toContain(String((s['token'] as J)['value']));
      expect((replay.json?.['tokenDelivery'] as J)['value']).toBe('DELIVERED_ONCE_NOT_REPLAYED');
      const concurrent = await h.api('POST', `/case-runs/${caseRunId}/start`, {});
      expect([concurrent.status, errorCode(concurrent)]).toEqual([409, 'RS_LEASE_HELD']);
      const tokenValue = String((s['token'] as J)['value']);
      expect(
        h.store.journal.read((db) =>
          db
            .prepare('SELECT count(*) AS n FROM control_idempotency WHERE response_json LIKE ?')
            .get(`%${tokenValue}%`),
        ),
      ).toEqual({ n: 0 });

      // The case token is never a control credential and cannot write boundary observations.
      const ch = caseHeaders(s);
      const asControl = await raw(h.port, { method: 'GET', path: `${PREFIX}/settings`, headers: ch });
      expect([asControl.status, errorCode(asControl)]).toEqual([401, 'RS_CONTROL_AUTH_INVALID']);
      for (const path of ['/boundary-observations', '/effects/boundary', '/interceptor-observations']) {
        expect(
          (
            await raw(h.port, {
              method: 'POST',
              path: `${PREFIX}${path}`,
              headers: { ...ch, 'content-type': 'application/json' },
              body: '{}',
            })
          ).status,
          path,
        ).toBe(401);
        expect((await h.api('POST', path, {})).status, path).toBe(404);
      }
      const observe = (extra: J = {}, headers: Record<string, string> = ch) =>
        raw(h.port, {
          method: 'POST',
          path: `${PREFIX}/effects/observe`,
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            runOperationId: null,
            effectManifestDigest: p.manifestDigest,
            effectCoveragePolicyDigest: p.policyDigest,
            hookId: 'fulfilment',
            hookRevision: '1',
            effectId: 'effect-1',
            effectType: 'DELIVER_GOODS',
            action: 'ATTEMPTED',
            idempotencyKey: 'observe-key-0001',
            fencingEpoch: s['fencingEpoch'],
            ...extra,
          }),
        });
      const o1 = await observe();
      expect(o1.status).toBe(201);
      expect(o1.json).toMatchObject({
        evidenceScope: 'SUBJECT_REPORTED',
        provesCoverage: false,
        boundaryObservation: false,
      });
      const o2 = await observe();
      expect([o2.status, o2.json?.['duplicate']]).toEqual([200, true]);
      expect(errorCode(await observe({ action: 'RELEASED' }))).not.toBeNull();
      expect(
        errorCode(
          await observe({ fencingEpoch: Number(s['fencingEpoch']) + 1, idempotencyKey: 'observe-key-0002' }),
        ),
      ).toBe('RS_STALE_FENCING_EPOCH');
      expect(errorCode(await observe({}, { ...ch, authorization: `Bearer ${h.token}` }))).toBe(
        'RS_CONTROL_AUTH_INVALID',
      );
      expect(errorCode(await observe({ hookId: 'undeclared', idempotencyKey: 'observe-key-0003' }))).toBe(
        'RS_EFFECT_HOOK_UNDECLARED',
      );
      expect((await observe({}, { ...ch, 'x-routespec-case-token': `rsct_${'e'.repeat(43)}` })).status).toBe(
        401,
      );

      // The official SDK runs the case through the proxy with the delivered credentials.
      subject = await Subject.launch();
      await subject.attach(String(s['proxyBaseUrl']), s);
      await subject.send({ type: 'logicalJob', key: 'order-life-1' });
      const q = await subject.call('getQuote', quoteBody());
      expect(q['ok']).toBe(true);
      const depositAddress = String(((q['value'] as J)['quote'] as J)['depositAddress']);
      expect((await subject.call('submitDepositTx', { txHash: 'sim-tx-life-1', depositAddress }))['ok']).toBe(
        true,
      );

      // Lease expiry: fenced recovery revokes the execution token and issues read-only authority.
      h.clock.advance(61_000);
      const recIdem = key('recover');
      const rec = await h.api('POST', `/case-runs/${caseRunId}/recover`, {}, { idem: recIdem });
      expect(rec.status).toBe(200);
      const r = rec.json as J;
      expect(r).toMatchObject({
        previousEpoch: s['fencingEpoch'],
        fencingEpoch: Number(s['fencingEpoch']) + 1,
        allowedPhases: ['READ_ONLY_RECONCILIATION'],
      });
      expect((r['token'] as J)['purpose']).toBe('RECONCILIATION_ONLY');
      const recReplay = await h.api('POST', `/case-runs/${caseRunId}/recover`, {}, { idem: recIdem });
      expect(recReplay.headers['idempotent-replay']).toBe('true');
      expect(recReplay.json?.['token']).toBeUndefined();
      const recOther = await h.api('POST', `/case-runs/${caseRunId}/recover`, {});
      expect([recOther.status, errorCode(recOther)]).toEqual([409, 'RS_LEASE_HELD']);
      const stale = await subject.call('getExecutionStatus', depositAddress);
      expect(stale['ok']).toBe(false);
      expect(['RS_TOKEN_REVOKED', 'RS_STALE_FENCING_EPOCH']).toContain((stale['error'] as J)['code']);
      await subject.send({
        type: 'credentials',
        credentials: credentialsOf(
          { ...r, sessionId: s['sessionId'] },
          'RECONCILIATION_ONLY',
          String(s['clientInstanceId']),
        ),
      });
      expect((await subject.call('getExecutionStatus', depositAddress))['ok']).toBe(true);
      const mutation = await subject.call('submitDepositTx', { txHash: 'sim-tx-life-2', depositAddress });
      expect(mutation['ok']).toBe(false);
      await subject.close();
      subject = null;

      // Close input, evaluate through the kernel and the gate aggregator; nothing is upgraded.
      const fin = expectOk(await h.api('POST', `/case-runs/${caseRunId}/finish-input`, {}), 200);
      expect(fin['lifecycle']).toBe('COMPLETED');
      const caseVerdict = String(fin['verdict']);
      expect(caseVerdict).toBe(String(h.store.getCaseRun(caseRunId)?.['verdict']));
      const ev = expectOk(await h.api('POST', `/gates/${p.gateId}/evaluate`, { gateRunId }), [200, 201]);
      expect(ev).toMatchObject({
        enforcementMode: 'LOCAL_ADVISORY',
        blocksRelease: false,
        repositoryProtectionVerified: false,
        artifactReady: false,
      });
      expect(ev['decision']).not.toBe('PASS');
      const evAgain = expectOk(await h.api('POST', `/gates/${p.gateId}/evaluate`, { gateRunId }), [200, 201]);
      expect(evAgain['gateEvaluationId']).toBe(ev['gateEvaluationId']);
      const view = expectOk(await h.api('GET', `/gate-runs/${gateRunId}`), 200);
      expect(view).toMatchObject({ verdict: ev['decision'], lifecycle: 'COMPLETED', artifactReady: null });

      // Export: plan and privacy scan first; writing needs the exact plan digest.
      const plan = expectOk(
        await h.api('POST', '/exports', { gateEvaluationId: ev['gateEvaluationId'] }),
        [200, 201],
      );
      expect(plan['written']).toBe(false);
      const out = join(h.dir, 'bundle.tar');
      const wrong = await h.api('POST', `/exports/${String(plan['exportId'])}/write`, {
        outPath: out,
        confirm: d('not-the-plan'),
      });
      expect(errorCode(wrong)).toBe('RS_EXPORT_CONFIRMATION_REQUIRED');
      expect(existsSync(out)).toBe(false);
      const written = expectOk(
        await h.api('POST', `/exports/${String(plan['exportId'])}/write`, {
          outPath: out,
          confirm: plan['planDigest'],
        }),
        200,
      );
      expect(written).toMatchObject({ artifactReady: true, decisionChanged: false });
      expect(existsSync(out)).toBe(true);
      const overwrite = await h.api('POST', `/exports/${String(plan['exportId'])}/write`, {
        outPath: out,
        confirm: plan['planDigest'],
      });
      expect(errorCode(overwrite)).toBe('RS_EXPORT_OVERWRITE_DENIED');
      const after = expectOk(await h.api('GET', `/gate-runs/${gateRunId}`), 200);
      expect(after['verdict']).toBe(view['verdict']);
      expect(after['artifactReady']).toBe(true);
    });

    it('captures the installed client run and promotes it to a new immutable corpus revision', async () => {
      const run = await startedGateRun(h, p);
      const start = expectOk(await h.api('POST', `/case-runs/${run.caseRunId}/start`, {}), 201);
      subject = await Subject.launch();
      await subject.attach(run.proxyBaseUrl, start);
      await subject.send({ type: 'logicalJob', key: 'order-life-2' });
      const q = await subject.call('getQuote', quoteBody());
      const depositAddress = String(((q['value'] as J)['quote'] as J)['depositAddress']);
      await subject.call('submitDepositTx', { txHash: 'sim-tx-life-3', depositAddress });
      for (let i = 0; i < 3; i++) await subject.call('getExecutionStatus', depositAddress);
      await subject.close();
      subject = null;
      expectOk(await h.api('POST', `/case-runs/${run.caseRunId}/finish-input`, {}), 200);
      const cap = expectOk(await h.api('POST', `/case-runs/${run.caseRunId}/captures`, {}), 201);
      expect(cap['origin']).toBe('INSTALLED_ARTIFACT_CAPTURE');
      const importId = String(cap['importId']);
      const listed = expectOk(await h.api('GET', `/projects/${p.projectId}/imports`), 200);
      expect((listed['items'] as J[]).map((i) => i['importId'])).toContain(importId);
      const detail = expectOk(await h.api('GET', `/imports/${importId}`), 200);
      expect(detail).toMatchObject({ state: 'SANITIZED', promotable: false });
      const proposed = expectOk(await h.api('GET', `/imports/${importId}/proposed-mapping`), 200);
      const rev0 = Number(proposed['revision']);
      const staleMap = await h.api(
        'POST',
        `/imports/${importId}/mapping`,
        { mapping: proposed['mapping'] },
        { ifMatch: rev0 + 5 },
      );
      expect(staleMap.status).toBeGreaterThanOrEqual(400);
      const mapped = expectOk(
        await h.api(
          'POST',
          `/imports/${importId}/mapping`,
          { mapping: proposed['mapping'] },
          { ifMatch: rev0 },
        ),
        201,
      );
      const replayRev = Number(mapped['revision']);
      const verified = expectOk(
        await h.api('POST', `/imports/${importId}/verify-replay`, {}, { ifMatch: replayRev }),
        200,
      );
      expect(verified).toMatchObject({ verified: true, networkAccessed: false });
      const decisions = Object.fromEntries(
        [
          'REDACTIONS_APPROVED',
          'SOURCE_BINDING_APPROVED',
          'OPERATION_LINEAGE_APPROVED',
          'EXPECTED_TERMINAL_APPROVED',
          'FORBIDDEN_BEHAVIORS_APPROVED',
          'EVIDENCE_LIMITS_APPROVED',
          'EFFECT_COVERAGE_APPROVED',
          'PROVENANCE_APPROVED',
        ].map((k) => [k, true]),
      );
      const review = expectOk(
        await h.api(
          'POST',
          `/imports/${importId}/reviews`,
          {
            reviewer: 'local reviewer',
            decisions,
            confirmation: 'I reviewed this sanitized trace and its mapping locally.',
          },
          { ifMatch: Number(verified['revision']) },
        ),
        201,
      );
      expect(expectOk(await h.api('GET', `/imports/${importId}`), 200)['promotable']).toBe(true);
      const corpusBefore = h.store.journal.read((db) =>
        db
          .prepare('SELECT * FROM corpus_cases WHERE corpus_revision_id = ? ORDER BY case_ordinal')
          .all(p.corpusRevisionId),
      );
      // M16 (RP-08): this capture ran without containment or a reviewed interceptor profile, so
      // the default release-evidence promotion is refused with a stable code and its reasons.
      const evidence = expectOk(await h.api('GET', `/imports/${importId}/release-evidence`), 200);
      expect(evidence).toMatchObject({ releaseEvidence: false, promotableAs: ['DIAGNOSTIC_ONLY'] });
      const refused = await h.api(
        'POST',
        `/imports/${importId}/promote`,
        {
          reviewId: review['reviewId'],
          baseCorpusRevisionId: p.corpusRevisionId,
          corpusLabel: 'corpus-life-promoted',
          severity: 'HIGH',
          gatePolicy: 'REQUIRED',
        },
        { ifMatch: Number(review['revision']), idem: key('promote-release') },
      );
      expect(refused.status).toBe(422);
      expect(errorCode(refused)).toBe('RS_CAPTURE_NOT_RELEASE_EVIDENCE');
      expect((refused.json?.['error'] as Record<string, unknown>)['details']).toEqual({
        reasons: evidence['refusalReasons'],
      });
      expect(evidence['refusalReasons']).toEqual(
        expect.arrayContaining(['DECLARED_HOOKS_ONLY', 'PROCESS_TREE_NOT_CONFINED']),
      );
      const promoteBody = {
        reviewId: review['reviewId'],
        baseCorpusRevisionId: p.corpusRevisionId,
        corpusLabel: 'corpus-life-promoted',
        severity: 'HIGH',
        gatePolicy: 'ADVISORY',
        evidenceUse: 'DIAGNOSTIC_ONLY',
      };
      const pIdem = key('promote');
      const promoted = await h.api('POST', `/imports/${importId}/promote`, promoteBody, {
        ifMatch: Number(review['revision']),
        idem: pIdem,
      });
      expect(promoted.status).toBe(201);
      expect(promoted.json).toMatchObject({
        baseCorpusMutated: false,
        baseCorpusRevisionId: p.corpusRevisionId,
        evidenceUse: 'DIAGNOSTIC_ONLY',
        refusalReasons: evidence['refusalReasons'],
      });
      const newCorpus = String(promoted.json?.['corpusRevisionId']);
      expect(newCorpus).not.toBe(p.corpusRevisionId);
      const promotedReplay = await h.api('POST', `/imports/${importId}/promote`, promoteBody, {
        ifMatch: Number(review['revision']),
        idem: pIdem,
      });
      expect(promotedReplay.json).toEqual(promoted.json);
      const changedPromote = await h.api(
        'POST',
        `/imports/${importId}/promote`,
        { ...promoteBody, corpusLabel: 'other' },
        { ifMatch: Number(review['revision']), idem: pIdem },
      );
      expect(errorCode(changedPromote)).toBe('RS_IDEMPOTENCY_KEY_REUSED');
      expect(
        h.store.journal.read((db) =>
          db
            .prepare('SELECT * FROM corpus_cases WHERE corpus_revision_id = ? ORDER BY case_ordinal')
            .all(p.corpusRevisionId),
        ),
      ).toEqual(corpusBefore);
      // The promoted corpus is usable by a new gate run of the same project only.
      const g = expectOk(
        await h.api(
          'POST',
          '/gate-runs',
          gateRunBody({ ...p, gateId: null as unknown as string, corpusRevisionId: newCorpus }),
        ),
        201,
      );
      expect(g['identity']).toMatchObject({ corpusRevisionId: newCorpus });
      const other = await setupProject(h, 'life-other');
      expect(
        errorCode(await h.api('POST', '/gate-runs', gateRunBody({ ...other, corpusRevisionId: newCorpus }))),
      ).toBe('RS_NOT_FOUND');
      void digestValue;
      void CLIENT_INSTANCE_DIGEST_DOMAIN;
    });
  });
});
