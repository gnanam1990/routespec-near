/**
 * Client for the `routespec-registry` contract (M47). Every view result is validated against a
 * closed shape before use: the RPC endpoint is not trusted to return well-formed data.
 */
import { z } from 'zod';
import { RouteSpecError } from '@routespec/contracts';
import { isRegistryAccountId, type SignedCertificate } from './certificate.ts';
import type { Ed25519Signer } from './keys.ts';
import { jsonArgs, NearRpc, type NearTransactionOutcome } from './near.ts';
import type { AttesterState, OnchainCertificate } from './release.ts';
import {
  attester,
  attesterView,
  certificate,
  certificateView,
  count,
  info,
  infoView,
  MAX_CERTIFICATES_PER_BUNDLE,
  MAX_PAGE,
  type RegistryInfo,
} from './views.ts';

export type { RegistryInfo } from './views.ts';

/** Gas attached to a registry call: far above what any registry method uses. */
export const REGISTRY_CALL_GAS = 30_000_000_000_000n;

function shape<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RouteSpecError('RS_REGISTRY_UNAVAILABLE', 'The registry returned an unexpected shape.', {
      details: { view: what, path: (parsed.error.issues[0]?.path ?? []).join('.').slice(0, 80) },
    });
  }
  return parsed.data;
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
    return { ...info(shape(infoView, value, 'get_info')), blockHeight };
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
    return shape(z.array(attesterView).max(MAX_PAGE), value, 'list_attesters').map(attester);
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
      certificates: shape(
        z.array(certificateView).max(MAX_CERTIFICATES_PER_BUNDLE),
        value,
        'get_certificates_by_bundle',
      ).map(certificate),
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
    return shape(z.array(certificateView).max(MAX_PAGE), value, 'get_certificates_by_project').map(
      certificate,
    );
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
