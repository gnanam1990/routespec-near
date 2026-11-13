/**
 * Client for the `routespec-registry` contract (M47). Every view result is validated against a
 * closed shape before use: the RPC endpoint is not trusted to return well-formed data.
 */
import { z } from 'zod';
import { RouteSpecError } from '@routespec/contracts';
import { isRegistryAccountId, type SignedCertificate } from './certificate.ts';
import { isPublicKeyText, type Ed25519Signer } from './keys.ts';
import { jsonArgs, NearRpc, type NearTransactionOutcome } from './near.ts';
import type { AttesterState, OnchainCertificate } from './release.ts';

/** Gas attached to a registry call: far above what any registry method uses. */
export const REGISTRY_CALL_GAS = 30_000_000_000_000n;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const optionalCount = count.nullable();

const certificateView = z
  .object({
    id: count,
    registry: z.string().max(64),
    project: z.string().max(96),
    bundle_digest: z.string().max(80),
    verdict: z.string().max(16),
    corpus_digest: z.string().max(80),
    artifact_digest: z.string().max(80),
    commit: z.string().max(64),
    timestamp_ms: count,
    attester: z.string().max(64).refine(isPublicKeyText),
    signature: z.string().max(100),
    published_at_ms: count,
    published_block_height: count,
    attester_revoked: z.boolean(),
    attester_revoked_at_ms: optionalCount,
  })
  .strict();

const attesterView = z
  .object({
    public_key: z.string().max(64).refine(isPublicKeyText),
    label: z.string().max(64),
    enrolled_at_ms: count,
    enrolled_block_height: count,
    revoked: z.boolean(),
    revoked_at_ms: optionalCount,
    revoked_block_height: optionalCount,
    revocation_reason: z.string().max(120).nullable(),
    certificates: count,
  })
  .strict();

const infoView = z
  .object({
    contract: z.string().max(64),
    version: z.string().max(32),
    payload_domain: z.string().max(64),
    owner_id: z.string().max(64),
    attesters: count,
    certificates: count,
    max_future_skew_ms: count,
    max_age_ms: count,
  })
  .strict();

export interface RegistryInfo {
  readonly contract: string;
  readonly version: string;
  readonly payloadDomain: string;
  readonly ownerId: string;
  readonly attesters: number;
  readonly certificates: number;
  readonly maxFutureSkewMs: number;
  readonly maxAgeMs: number;
}

function shape<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RouteSpecError('RS_REGISTRY_UNAVAILABLE', 'The registry returned an unexpected shape.', {
      details: { view: what, path: (parsed.error.issues[0]?.path ?? []).join('.').slice(0, 80) },
    });
  }
  return parsed.data;
}

function certificate(v: z.infer<typeof certificateView>): OnchainCertificate {
  return {
    id: v.id,
    registry: v.registry,
    project: v.project,
    bundleDigest: v.bundle_digest,
    verdict: v.verdict,
    corpusDigest: v.corpus_digest,
    artifactDigest: v.artifact_digest,
    commit: v.commit,
    timestampMs: v.timestamp_ms,
    attester: v.attester,
    signature: v.signature,
    publishedAtMs: v.published_at_ms,
    publishedBlockHeight: v.published_block_height,
    attesterRevoked: v.attester_revoked,
    attesterRevokedAtMs: v.attester_revoked_at_ms,
  };
}

function attester(v: z.infer<typeof attesterView>): AttesterState {
  return {
    publicKey: v.public_key,
    label: v.label,
    enrolledAtMs: v.enrolled_at_ms,
    enrolledBlockHeight: v.enrolled_block_height,
    revoked: v.revoked,
    revokedAtMs: v.revoked_at_ms,
    revokedBlockHeight: v.revoked_block_height,
    revocationReason: v.revocation_reason,
    certificates: v.certificates,
  };
}

export interface RegistryCaller {
  readonly accountId: string;
  readonly signer: Ed25519Signer;
}

export class RegistryClient {
  readonly rpc: NearRpc;
  readonly accountId: string;

  constructor(rpc: NearRpc, accountId: string) {
    if (!isRegistryAccountId(accountId)) {
      throw new RouteSpecError('RS_CLI_USAGE', 'The registry must be a NEAR account id.');
    }
    this.rpc = rpc;
    this.accountId = accountId;
  }

  async info(): Promise<RegistryInfo & { readonly blockHeight: number }> {
    const { value, blockHeight } = await this.rpc.view(this.accountId, 'get_info', {});
    const v = shape(infoView, value, 'get_info');
    return {
      contract: v.contract,
      version: v.version,
      payloadDomain: v.payload_domain,
      ownerId: v.owner_id,
      attesters: v.attesters,
      certificates: v.certificates,
      maxFutureSkewMs: v.max_future_skew_ms,
      maxAgeMs: v.max_age_ms,
      blockHeight,
    };
  }

  async getAttester(publicKey: string): Promise<AttesterState | null> {
    const { value } = await this.rpc.view(this.accountId, 'get_attester', { public_key: publicKey });
    return value === null ? null : attester(shape(attesterView, value, 'get_attester'));
  }

  async listAttesters(fromIndex = 0, limit = 50): Promise<AttesterState[]> {
    const { value } = await this.rpc.view(this.accountId, 'list_attesters', {
      from_index: fromIndex,
      limit,
    });
    return shape(z.array(attesterView).max(50), value, 'list_attesters').map(attester);
  }

  async getCertificate(id: number): Promise<OnchainCertificate | null> {
    const { value } = await this.rpc.view(this.accountId, 'get_certificate', { id });
    return value === null ? null : certificate(shape(certificateView, value, 'get_certificate'));
  }

  async certificatesByBundle(
    bundleDigest: string,
  ): Promise<{ certificates: OnchainCertificate[]; blockHeight: number }> {
    const { value, blockHeight } = await this.rpc.view(this.accountId, 'get_certificates_by_bundle', {
      bundle_digest: bundleDigest,
    });
    return {
      certificates: shape(z.array(certificateView).max(8), value, 'get_certificates_by_bundle').map(
        certificate,
      ),
      blockHeight,
    };
  }

  async projectCertificateCount(project: string): Promise<number> {
    const { value } = await this.rpc.view(this.accountId, 'get_project_certificate_count', { project });
    return shape(count, value, 'get_project_certificate_count');
  }

  async certificatesByProject(project: string, fromIndex = 0, limit = 50): Promise<OnchainCertificate[]> {
    const { value } = await this.rpc.view(this.accountId, 'get_certificates_by_project', {
      project,
      from_index: fromIndex,
      limit,
    });
    return shape(z.array(certificateView).max(50), value, 'get_certificates_by_project').map(certificate);
  }

  private call(caller: RegistryCaller, methodName: string, args: unknown): Promise<NearTransactionOutcome> {
    return this.rpc.sendActions({
      signerId: caller.accountId,
      signer: caller.signer,
      receiverId: this.accountId,
      actions: [
        { type: 'FunctionCall', methodName, args: jsonArgs(args), gas: REGISTRY_CALL_GAS, deposit: 0n },
      ],
    });
  }

  /** Submit a signed certificate. The caller only pays gas; the attester signature is the authority. */
  async publish(
    signed: SignedCertificate,
    caller: RegistryCaller,
  ): Promise<{ certificateId: number; transactionHash: string }> {
    const outcome = await this.call(caller, 'publish', signed);
    if (typeof outcome.returnValue !== 'number' || !Number.isSafeInteger(outcome.returnValue)) {
      throw new RouteSpecError('RS_REGISTRY_UNAVAILABLE', 'The registry did not return a certificate id.', {
        details: { transactionHash: outcome.transactionHash },
      });
    }
    return { certificateId: outcome.returnValue, transactionHash: outcome.transactionHash };
  }

  /** Owner only. */
  enrolAttester(publicKey: string, label: string, owner: RegistryCaller): Promise<NearTransactionOutcome> {
    return this.call(owner, 'enrol_attester', { public_key: publicKey, label });
  }

  /** Owner only. Permanent. */
  revokeAttester(publicKey: string, reason: string, owner: RegistryCaller): Promise<NearTransactionOutcome> {
    return this.call(owner, 'revoke_attester', { public_key: publicKey, reason });
  }
}
