/**
 * Attestation verification (API-SPEC launcher-challenges, SECURITY.md TB-07/TB-08, T-044).
 *
 * Two principal kinds are supported, each with its own completion channel:
 *
 * - `LOCAL_LAUNCHER_KEY`: an enrolled Ed25519 public key plus the reviewed launcher artifact
 *   digest. Completion is accepted only over the inherited IPC pipe of a launcher process the
 *   control host started itself (`AttesterChannelHost`): the peer is the forked child, its pid is
 *   bound into the signed payload, and the launcher script digest is measured by the host before
 *   the fork and must equal the enrolled artifact digest. The private key never enters RouteSpec.
 *   An HTTP completion attempt for this kind fails with `RS_PEER_BINDING_UNAVAILABLE` and leaves
 *   the challenge unused.
 * - `CI_OIDC`: pinned issuer and ES256 signing keys (no key discovery, no network), audience,
 *   repository id, workflow ref, allowed refs, subject, token and key age. The signed token's
 *   `nonce` claim must equal the binding digest of the challenge nonce and the CI-reported
 *   digests, so the observed digests are covered by the issuer's signature.
 *
 * In both cases the scope-specific observed digests must equal the challenge binding exactly; a
 * mismatch, a stale or revoked principal, an expired challenge, a replay, or a concurrent second
 * completion is recorded as a REJECTED outcome or refused, never as an attestation.
 */
import { createHash, createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { RouteSpecError, canonicalJson, digestValue } from '@routespec/contracts';
import type { ChallengeContext, ChallengeOutcome, ChallengeVerdict, ControlJournal } from '@routespec/store';
import type { ObservedDigests } from './schemas.ts';

/** Digests each scope must vouch for, taken from the challenge binding. */
export function requiredDigests(scope: string, binding: Record<string, unknown>): Record<string, string> {
  const pick = (...keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, String(binding[k] ?? '')])) as Record<string, string>;
  switch (scope) {
    case 'BUILD_REGISTRATION':
      return pick('artifactDigest', 'lockDigest', 'toolchainDigest', 'manifestDigest');
    case 'CASE_LAUNCH':
      // A contained launch (M14) also binds the engine-verified sandbox scope.
      return 'sandboxScopeDigest' in binding
        ? pick('artifactDigest', 'clientInstanceDigest', 'sandboxScopeDigest')
        : pick('artifactDigest', 'clientInstanceDigest');
    case 'EFFECT_INVENTORY':
      return pick('artifactDigest', 'analyzerDigest', 'inventoryDigest', 'manifestDigest');
    case 'EFFECT_INTERCEPTOR_LAUNCH':
      return 'sandboxScopeDigest' in binding
        ? pick('interceptorArtifactDigest', 'interceptorProfileDigest', 'sandboxScopeDigest')
        : pick('interceptorArtifactDigest', 'interceptorProfileDigest');
    default:
      throw new RouteSpecError('RS_SCHEMA_INVALID', 'Unknown challenge scope.');
  }
}

function digestsMatch(
  scope: string,
  binding: Record<string, unknown>,
  observed: ObservedDigests,
): string | null {
  const required = requiredDigests(scope, binding);
  const presented = observed as Record<string, string | undefined>;
  for (const [k, v] of Object.entries(required)) {
    if (presented[k] !== v) return `OBSERVED_${k.replace(/([A-Z])/g, '_$1').toUpperCase()}_MISMATCH`;
  }
  const extra = Object.keys(presented).filter((k) => !(k in required));
  if (extra.length > 0) return 'OBSERVED_DIGEST_OUT_OF_SCOPE';
  return null;
}

/** Canonical bytes a local launcher signs. */
export function launcherSigningPayload(input: {
  challengeId: string;
  nonce: string;
  scope: string;
  bindingDigest: string;
  observed: ObservedDigests;
  peerPid: number;
  launcherArtifactDigest: string;
}): Buffer {
  return Buffer.from(canonicalJson({ domain: 'routespec.launcher-completion/1', ...input }), 'utf8');
}

/** The value a CI job must place in the OIDC token's `nonce` claim. */
export function ciNonceBinding(input: {
  challengeId: string;
  nonce: string;
  observed: ObservedDigests;
}): string {
  return digestValue('routespec.ci-attestation-nonce/1', input);
}

function claimsDigest(value: unknown): string {
  return digestValue('routespec.verified-claims/1', value);
}

export function verifyLauncherCompletion(
  ctx: ChallengeContext,
  input: {
    nonce: string;
    observed: ObservedDigests;
    signature: string;
    peerPid: number;
    measuredArtifactDigest: string;
  },
): ChallengeVerdict {
  const policy = ctx.policy;
  if (policy['kind'] !== 'LOCAL_LAUNCHER_KEY') return { ok: false, reasonCode: 'PRINCIPAL_KIND_MISMATCH' };
  if (input.measuredArtifactDigest !== policy['launcherArtifactDigest']) {
    return { ok: false, reasonCode: 'LAUNCHER_ARTIFACT_MISMATCH' };
  }
  const scope = String(ctx.challenge['scope']);
  const payload = launcherSigningPayload({
    challengeId: String(ctx.challenge['challenge_id']),
    nonce: input.nonce,
    scope,
    bindingDigest: String(ctx.challenge['binding_digest']),
    observed: input.observed,
    peerPid: input.peerPid,
    launcherArtifactDigest: input.measuredArtifactDigest,
  });
  let ok = false;
  try {
    const key = createPublicKey({ key: policy['publicKeyJwk'] as JsonWebKey, format: 'jwk' });
    ok = verifySignature(null, payload, key, Buffer.from(input.signature, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) return { ok: false, reasonCode: 'SIGNATURE_INVALID' };
  const mismatch = digestsMatch(scope, ctx.binding, input.observed);
  if (mismatch) return { ok: false, reasonCode: mismatch };
  return {
    ok: true,
    attestationClass: 'TRUSTED_LAUNCHER',
    observedDigests: Object.values(requiredDigests(scope, ctx.binding)),
    verifiedClaimsDigest: claimsDigest({ peerPid: input.peerPid, launcher: input.measuredArtifactDigest }),
  };
}

function b64json(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function verifyOidcCompletion(
  ctx: ChallengeContext,
  input: { nonce: string; observed: ObservedDigests; oidcToken: string },
): ChallengeVerdict {
  const policy = ctx.policy;
  if (policy['kind'] !== 'CI_OIDC') return { ok: false, reasonCode: 'PRINCIPAL_KIND_MISMATCH' };
  const parts = input.oidcToken.split('.');
  if (parts.length !== 3) return { ok: false, reasonCode: 'TOKEN_MALFORMED' };
  const [h, p, sig] = parts as [string, string, string];
  const header = b64json(h);
  const claims = b64json(p);
  if (!header || !claims) return { ok: false, reasonCode: 'TOKEN_MALFORMED' };
  if (header['alg'] !== 'ES256' || typeof header['kid'] !== 'string')
    return { ok: false, reasonCode: 'TOKEN_ALG_UNSUPPORTED' };
  const keys = policy['signingKeys'] as Array<{
    kid: string;
    jwk: JsonWebKey;
    notBeforeMs: number;
    notAfterMs: number;
  }>;
  const key = keys.find((k) => k.kid === header['kid']);
  if (!key) return { ok: false, reasonCode: 'SIGNING_KEY_UNKNOWN' };
  const now = ctx.nowMs;
  if (key.notAfterMs <= now || key.notBeforeMs > now) return { ok: false, reasonCode: 'SIGNING_KEY_EXPIRED' };
  if (now - key.notBeforeMs > Number(policy['maxKeyAgeMs']))
    return { ok: false, reasonCode: 'SIGNING_KEY_TOO_OLD' };
  let valid = false;
  try {
    valid = verifySignature(
      'sha256',
      Buffer.from(`${h}.${p}`, 'utf8'),
      { key: createPublicKey({ key: key.jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig, 'base64url'),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reasonCode: 'SIGNATURE_INVALID' };
  const nowS = Math.floor(now / 1000);
  const iat = claims['iat'];
  const exp = claims['exp'];
  const nbf = claims['nbf'];
  if (typeof iat !== 'number' || typeof exp !== 'number')
    return { ok: false, reasonCode: 'TOKEN_TIME_MISSING' };
  if (exp <= nowS) return { ok: false, reasonCode: 'TOKEN_EXPIRED' };
  if (typeof nbf === 'number' && nbf > nowS) return { ok: false, reasonCode: 'TOKEN_NOT_YET_VALID' };
  if (iat > nowS + 5 || (nowS - iat) * 1000 > Number(policy['maxTokenAgeMs'])) {
    return { ok: false, reasonCode: 'TOKEN_TOO_OLD' };
  }
  const expect: Array<[string, unknown, string]> = [
    ['iss', policy['issuer'], 'ISSUER_MISMATCH'],
    ['aud', policy['audience'], 'AUDIENCE_MISMATCH'],
    ['sub', policy['subject'], 'SUBJECT_MISMATCH'],
    ['repository_id', policy['repositoryId'], 'REPOSITORY_MISMATCH'],
    ['job_workflow_ref', policy['workflowRef'], 'WORKFLOW_MISMATCH'],
  ];
  for (const [claim, value, reason] of expect) {
    if (claims[claim] !== value) return { ok: false, reasonCode: reason };
  }
  if (!(policy['allowedRefs'] as string[]).includes(String(claims['ref'])))
    return { ok: false, reasonCode: 'REF_NOT_ALLOWED' };
  const commit = ctx.binding['commitSha'];
  if (typeof commit === 'string' && claims['sha'] !== commit)
    return { ok: false, reasonCode: 'COMMIT_MISMATCH' };
  const runId = ctx.binding['ciWorkflowRunId'];
  if (typeof claims['run_id'] !== 'string' || typeof claims['run_attempt'] !== 'string') {
    return { ok: false, reasonCode: 'RUN_IDENTITY_MISSING' };
  }
  if (typeof runId === 'string' && claims['run_id'] !== runId)
    return { ok: false, reasonCode: 'RUN_MISMATCH' };
  const challengeId = String(ctx.challenge['challenge_id']);
  if (claims['nonce'] !== ciNonceBinding({ challengeId, nonce: input.nonce, observed: input.observed })) {
    return { ok: false, reasonCode: 'NONCE_MISMATCH' };
  }
  const scope = String(ctx.challenge['scope']);
  const mismatch = digestsMatch(scope, ctx.binding, input.observed);
  if (mismatch) return { ok: false, reasonCode: mismatch };
  return {
    ok: true,
    attestationClass: 'CI_ATTESTED',
    observedDigests: Object.values(requiredDigests(scope, ctx.binding)),
    verifiedClaimsDigest: claimsDigest({
      iss: claims['iss'],
      sub: claims['sub'],
      repository_id: claims['repository_id'],
      job_workflow_ref: claims['job_workflow_ref'],
      ref: claims['ref'],
      sha: claims['sha'] ?? null,
      run_id: claims['run_id'],
      run_attempt: claims['run_attempt'],
      kid: header['kid'],
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Private launcher channel.

export function fileDigest(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

interface LauncherCompletionMessage {
  readonly type: 'complete';
  readonly challengeId: string;
  readonly nonce: string;
  readonly observed: ObservedDigests;
  readonly signature: string;
}

/**
 * A launcher started by the control host over an inherited IPC pipe. Only completion messages
 * arriving on this child's own channel are accepted; the peer pid is the forked child's pid.
 */
export class AttesterChannel {
  readonly child: ChildProcess;
  readonly measuredArtifactDigest: string;
  readonly #control: ControlJournal;

  private constructor(child: ChildProcess, measuredArtifactDigest: string, control: ControlJournal) {
    this.child = child;
    this.measuredArtifactDigest = measuredArtifactDigest;
    this.#control = control;
  }

  static launch(
    control: ControlJournal,
    scriptPath: string,
    args: readonly string[] = [],
    measure: (path: string) => string = fileDigest,
  ): AttesterChannel {
    const measured = measure(scriptPath);
    const child = fork(scriptPath, [...args], {
      execArgv: ['--no-warnings'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '' },
    });
    return new AttesterChannel(child, measured, control);
  }

  /** Deliver a challenge (id + one-time nonce) to the launcher and await its completion. */
  complete(
    challenge: {
      challengeId: string;
      nonce: string;
      scope: string;
      bindingDigest: string;
      binding: Record<string, unknown>;
    },
    timeoutMs = 30_000,
  ): Promise<ChallengeOutcome> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new RouteSpecError(
            'RS_PEER_BINDING_UNAVAILABLE',
            'The launcher did not complete the challenge in time.',
          ),
        );
      }, timeoutMs);
      const onExit = () => {
        cleanup();
        reject(new RouteSpecError('RS_PEER_BINDING_UNAVAILABLE', 'The launcher channel closed.'));
      };
      const onMessage = (raw: unknown) => {
        const m = raw as LauncherCompletionMessage;
        if (
          m === null ||
          typeof m !== 'object' ||
          m.type !== 'complete' ||
          m.challengeId !== challenge.challengeId
        )
          return;
        cleanup();
        const peerPid = this.child.pid;
        if (typeof peerPid !== 'number') {
          reject(
            new RouteSpecError('RS_PEER_BINDING_UNAVAILABLE', 'The launcher peer identity is unavailable.'),
          );
          return;
        }
        try {
          resolve(
            this.#control.completeChallenge({
              challengeId: m.challengeId,
              nonce: String(m.nonce),
              channel: 'PRIVATE_IPC',
              evaluate: (ctx) =>
                verifyLauncherCompletion(ctx, {
                  nonce: String(m.nonce),
                  observed: m.observed ?? {},
                  signature: String(m.signature),
                  peerPid,
                  measuredArtifactDigest: this.measuredArtifactDigest,
                }),
            }),
          );
        } catch (error) {
          reject(error);
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.child.off('message', onMessage);
        this.child.off('exit', onExit);
      };
      this.child.on('message', onMessage);
      this.child.once('exit', onExit);
      this.child.send({ type: 'challenge', ...challenge, peerPid: this.child.pid });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve();
      this.child.once('exit', () => resolve());
      if (this.child.connected) this.child.disconnect();
      setTimeout(() => this.child.kill(), 2000).unref();
    });
  }
}
