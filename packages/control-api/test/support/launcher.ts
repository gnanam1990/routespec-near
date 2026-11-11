/**
 * Reviewed local launcher used by the attestation tests. It is started by the control host over
 * an inherited IPC pipe, holds its own Ed25519 private key (read from an owner-only key file the
 * operator created; the control service never reads it), independently hashes the artifact file
 * it is told to vouch for, and signs the completion payload.
 *
 * argv: <private-key-file> <artifact-file> <build-inputs-json-file> <mode>
 * modes: honest | swap-artifact (hashes a different file) | out-of-scope (adds an extra digest)
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launcherSigningPayload } from '../../src/attestation.ts';

const [keyFile, artifactFile, inputsFile, mode] = process.argv.slice(2) as [string, string, string, string];
const privateKey = createPrivateKey(readFileSync(keyFile));
const self = `sha256:${createHash('sha256')
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest('hex')}`;

function fileDigest(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

interface Challenge {
  readonly type: 'challenge';
  readonly challengeId: string;
  readonly nonce: string;
  readonly scope: string;
  readonly bindingDigest: string;
  readonly binding: Record<string, unknown>;
}

process.on('message', (raw: unknown) => {
  const c = raw as Challenge;
  if (c === null || typeof c !== 'object' || c.type !== 'challenge') return;
  const inputs = JSON.parse(readFileSync(inputsFile, 'utf8')) as Record<string, string>;
  const artifact =
    mode === 'swap-artifact' ? fileDigest(fileURLToPath(import.meta.url)) : fileDigest(artifactFile);
  let observed: Record<string, string>;
  if (c.scope === 'BUILD_REGISTRATION') {
    observed = {
      artifactDigest: artifact,
      lockDigest: String(inputs['lockDigest']),
      toolchainDigest: String(inputs['toolchainDigest']),
      manifestDigest: String(inputs['manifestDigest']),
    };
  } else if (c.scope === 'CASE_LAUNCH') {
    observed = { artifactDigest: artifact, clientInstanceDigest: String(inputs['clientInstanceDigest']) };
  } else if (c.scope === 'EFFECT_INVENTORY') {
    observed = {
      artifactDigest: artifact,
      analyzerDigest: String(inputs['analyzerDigest']),
      inventoryDigest: String(inputs['inventoryDigest']),
      manifestDigest: String(inputs['manifestDigest']),
    };
  } else {
    observed = {
      interceptorArtifactDigest: String(inputs['interceptorArtifactDigest']),
      interceptorProfileDigest: String(inputs['interceptorProfileDigest']),
    };
  }
  if (mode === 'out-of-scope') observed = { ...observed, analyzerDigest: String(inputs['lockDigest']) };
  const payload = launcherSigningPayload({
    challengeId: c.challengeId,
    nonce: c.nonce,
    scope: c.scope,
    bindingDigest: c.bindingDigest,
    observed,
    peerPid: process.pid,
    launcherArtifactDigest: self,
  });
  const signature = sign(null, payload, privateKey).toString('base64url');
  process.send?.({ type: 'complete', challengeId: c.challengeId, nonce: c.nonce, observed, signature });
});
