/**
 * What to verify, from the page configuration and the link the visitor opened.
 *
 * A link is untrusted input: it can name a digest, a project, a network of the configuration,
 * pinned attester keys, another registry account, and an RPC endpoint. Rules that keep a link
 * from turning the page into a "certified" stamp for someone else:
 *
 * - An RPC endpoint from a link is accepted only on a loopback host (a local node). A public
 *   endpoint comes from the configuration only, because the endpoint is trusted for enrolment
 *   and revocation state.
 * - A registry other than the configured one is accepted, but the page says so next to the
 *   result: that registry's owner decides who may attest.
 * - Attester keys in a link can only narrow trust: with keys pinned in the configuration, a link
 *   may name a subset of them and nothing else.
 */
import {
  isBundleDigest,
  isProjectKey,
  isPublicKeyText,
  isRegistryAccountId,
} from '@routespec/registry/browser';
import type { VerifyPageConfig } from './config.ts';

export type Notice = 'REGISTRY_NOT_DEFAULT' | 'RPC_FROM_LINK' | 'ATTESTERS_FROM_LINK';

export interface ResolvedRequest {
  readonly network: string;
  readonly chainId: string | null;
  readonly rpcUrl: string;
  readonly registry: string;
  readonly trustedAttesters: readonly string[];
  readonly digest: string | null;
  readonly project: string | null;
  readonly notices: readonly Notice[];
}

export class RequestError extends Error {
  override readonly name = 'RequestError';
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface RequestInput {
  readonly network?: string | null;
  readonly registry?: string | null;
  readonly rpc?: string | null;
  readonly attesters?: readonly string[];
  readonly digest?: string | null;
  readonly project?: string | null;
}

export function inputFromSearch(search: URLSearchParams): RequestInput {
  return {
    network: search.get('network'),
    registry: search.get('registry'),
    rpc: search.get('rpc'),
    attesters: search.getAll('attester'),
    digest: search.get('digest'),
    project: search.get('project'),
  };
}

function blank(v: string | null | undefined): v is null | undefined {
  return v === null || v === undefined || v.trim() === '';
}

export function resolveRequest(config: VerifyPageConfig, input: RequestInput): ResolvedRequest {
  const notices: Notice[] = [];
  const network = blank(input.network) ? config.defaultNetwork : input.network.trim();
  const net = config.networks[network];
  if (net === undefined)
    throw new RequestError(`This page does not know the network "${network.slice(0, 24)}".`);

  let registry = net.registry;
  if (!blank(input.registry)) {
    const given = input.registry.trim();
    if (!isRegistryAccountId(given)) throw new RequestError('The registry must be a NEAR account id.');
    if (given !== net.registry) notices.push('REGISTRY_NOT_DEFAULT');
    registry = given;
  }
  if (registry === null) {
    throw new RequestError(`No registry is configured for ${network} yet. Name one to verify against it.`);
  }

  let rpcUrl = net.rpcUrl;
  if (!blank(input.rpc)) {
    let url: URL;
    try {
      url = new URL(input.rpc.trim());
    } catch {
      throw new RequestError('The RPC endpoint is not a URL.');
    }
    if (!LOOPBACK.has(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username !== '') {
      throw new RequestError(
        'A link can only name an RPC endpoint on this computer (127.0.0.1 or localhost). Public endpoints come from the page configuration.',
      );
    }
    if (url.href !== new URL(net.rpcUrl).href) notices.push('RPC_FROM_LINK');
    rpcUrl = url.href;
  }

  const fromLink = [...new Set((input.attesters ?? []).map((k) => k.trim()).filter((k) => k !== ''))];
  for (const k of fromLink) {
    if (!isPublicKeyText(k)) throw new RequestError('Attester keys are written ed25519:<base58>.');
  }
  let trustedAttesters: readonly string[] = config.trustedAttesters;
  if (fromLink.length > 0) {
    if (config.trustedAttesters.length > 0 && fromLink.some((k) => !config.trustedAttesters.includes(k))) {
      throw new RequestError('A link can only narrow the attester keys this page pins, not add others.');
    }
    trustedAttesters = fromLink;
    notices.push('ATTESTERS_FROM_LINK');
  }

  const digest = blank(input.digest) ? null : input.digest.trim().toLowerCase();
  if (digest !== null && !isBundleDigest(digest)) {
    throw new RequestError('A bundle digest is written sha256: followed by 64 hex characters.');
  }
  const project = blank(input.project) ? null : input.project.trim();
  if (project !== null && !isProjectKey(project)) throw new RequestError('The project key is not valid.');
  if (digest !== null && project !== null)
    throw new RequestError('Give a bundle digest or a project, not both.');

  return { network, chainId: net.chainId, rpcUrl, registry, trustedAttesters, digest, project, notices };
}

/** The page link that verifies `digest` (or the project's newest certificate) on `network`. */
export function verifyLink(
  pageUrl: string,
  network: string,
  target: { digest: string } | { project: string },
): string {
  const url = new URL(pageUrl);
  url.search = '';
  url.hash = '';
  if ('digest' in target) url.searchParams.set('digest', target.digest);
  else url.searchParams.set('project', target.project);
  url.searchParams.set('network', network);
  return url.href;
}
