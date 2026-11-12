/**
 * Reviewed attesting launcher for contained subjects (M14; DATA-MODEL `launcher_challenges`,
 * CORE-CONTRACT FR-02, SECURITY TB-07/TB-08).
 *
 * The control service forks this script over an inherited IPC pipe when a challenge names an
 * enrolled `LOCAL_LAUNCHER_KEY` principal whose enrolled launcher artifact digest equals the
 * digest the service measured for this file. The private Ed25519 key is read here from an
 * operator key file (owner-only); the service never reads it. For every challenge the launcher
 * measures what it vouches for itself and signs the canonical completion payload:
 *
 * - BUILD_REGISTRATION: SHA-256 of the artifact file named by the build's repository locator, of
 *   the install's `pnpm-lock.yaml`, of the declared effect file next to the artifact
 *   (`<artifact>.effects.json`), and the toolchain digest of the pinned container image id it
 *   reads from the engine itself;
 * - CASE_LAUNCH: the artifact file again, the client-instance digest from the binding (not
 *   observable from outside the client; vouched as given), and the sandbox-scope digest it
 *   computes from its own `docker inspect` of the named container;
 * - EFFECT_INTERCEPTOR_LAUNCH: the reviewed interceptor artifact of this install, the registered
 *   profile digest from the binding, and its own sandbox-scope digest of the container.
 *
 * A container that this launcher does not find confined (any engine finding) gets a sandbox
 * digest that cannot match, so the challenge is consumed as REJECTED and nothing is attested.
 *
 * argv: <private-key-file> <subject-root> <container-cli-json> <image-ref>
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, digestValue } from '@routespec/contracts';
import { containerToolchainDigest, interceptorArtifactDigest, launcherArtifactDigest } from './identity.ts';
import { DEFAULT_MAX_MEMORY_BYTES, DEFAULT_MAX_PIDS } from './sandbox.ts';
import { enginePath, parseContainerCli, runEngine } from './runtime.ts';
import { verifyInspect } from './verify.ts';

const [keyFile, subjectRootArg, cliJson, imageRef] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const subjectRoot = resolve(subjectRootArg);
const cli = parseContainerCli(cliJson);
const privateKey = createPrivateKey(readFileSync(keyFile));
const self = launcherArtifactDigest(fileURLToPath(import.meta.url));
const INTERCEPTOR = fileURLToPath(
  new URL('../../proxy/src/interceptor/canary-interceptor.ts', import.meta.url),
);

const fileSha = (path: string) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const NOT_MEASURED = digestValue('routespec.launcher-not-measured/1', 'NOT_MEASURED');

function artifactPath(locator: unknown): string | null {
  if (typeof locator !== 'string' || !locator.startsWith('git+file:')) return null;
  const rel = locator.slice('git+file:'.length);
  const full = resolve(subjectRoot, rel);
  const r = relative(subjectRoot, full);
  if (r.length === 0 || r.startsWith('..') || r.split(sep).includes('..')) return null;
  return full;
}

function measure(fn: () => string): string {
  try {
    return fn();
  } catch {
    return NOT_MEASURED;
  }
}

async function imageId(): Promise<string> {
  const r = await runEngine(cli, ['image', 'inspect', '--format', '{{.Id}}', imageRef]);
  return r.exitCode === 0 ? r.stdout.trim() : '';
}

async function sandboxDigest(binding: Record<string, unknown>): Promise<string> {
  const containerId = binding['containerId'];
  const ports = binding['tunnelPorts'];
  if (typeof containerId !== 'string' || !/^[0-9a-f]{64}$/.test(containerId) || !Array.isArray(ports))
    return NOT_MEASURED;
  const id = await imageId();
  const r = await runEngine(cli, ['inspect', containerId]);
  if (r.exitCode !== 0) return NOT_MEASURED;
  let inspect: unknown;
  try {
    inspect = JSON.parse(r.stdout) as unknown;
  } catch {
    return NOT_MEASURED;
  }
  const v = verifyInspect(
    inspect,
    {
      imageId: id,
      readOnlyMounts: [enginePath(cli, subjectRoot)],
      maxPids: DEFAULT_MAX_PIDS,
      maxMemoryBytes: DEFAULT_MAX_MEMORY_BYTES,
      tunnelPorts: ports.map(Number),
    },
    null,
  );
  // The launcher cannot see inside the container; every engine-side expectation must hold.
  const engineFindings = v.findings.filter((f) => f !== 'SELF_OBSERVATION_MISSING');
  if (engineFindings.length > 0 || v.sandboxScopeDigest === null) {
    return digestValue('routespec.launcher-containment-refused/1', engineFindings);
  }
  return v.sandboxScopeDigest;
}

interface Challenge {
  readonly type: 'challenge';
  readonly challengeId: string;
  readonly nonce: string;
  readonly scope: string;
  readonly bindingDigest: string;
  readonly binding: Record<string, unknown>;
}

async function observe(c: Challenge): Promise<Record<string, string>> {
  const b = c.binding;
  const artifact = artifactPath(b['repositoryLocator']);
  const artifactDigest = artifact === null ? NOT_MEASURED : measure(() => fileSha(artifact));
  if (c.scope === 'BUILD_REGISTRATION') {
    return {
      artifactDigest,
      lockDigest: measure(() => fileSha(join(subjectRoot, 'pnpm-lock.yaml'))),
      toolchainDigest: containerToolchainDigest(await imageId()),
      manifestDigest:
        artifact === null ? NOT_MEASURED : measure(() => fileSha(artifact.replace(/\.ts$/, '.effects.json'))),
    };
  }
  if (c.scope === 'CASE_LAUNCH') {
    const out: Record<string, string> = {
      artifactDigest,
      clientInstanceDigest: String(b['clientInstanceDigest'] ?? ''),
    };
    if ('sandboxScopeDigest' in b) out['sandboxScopeDigest'] = await sandboxDigest(b);
    return out;
  }
  if (c.scope === 'EFFECT_INTERCEPTOR_LAUNCH') {
    const out: Record<string, string> = {
      interceptorArtifactDigest: measure(() => interceptorArtifactDigest(INTERCEPTOR)),
      interceptorProfileDigest: String(b['interceptorProfileDigest'] ?? ''),
    };
    if ('sandboxScopeDigest' in b) out['sandboxScopeDigest'] = await sandboxDigest(b);
    return out;
  }
  return {};
}

process.on('message', (raw: unknown) => {
  const c = raw as Challenge;
  if (c === null || typeof c !== 'object' || c.type !== 'challenge') return;
  void observe(c).then((observed) => {
    const payload = Buffer.from(
      canonicalJson({
        domain: 'routespec.launcher-completion/1',
        challengeId: c.challengeId,
        nonce: c.nonce,
        scope: c.scope,
        bindingDigest: c.bindingDigest,
        observed,
        peerPid: process.pid,
        launcherArtifactDigest: self,
      }),
      'utf8',
    );
    const signature = sign(null, payload, privateKey).toString('base64url');
    process.send?.({ type: 'complete', challengeId: c.challengeId, nonce: c.nonce, observed, signature });
  });
});
process.on('disconnect', () => process.exit(0));
