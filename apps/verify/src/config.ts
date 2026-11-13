/**
 * The verify page configuration (`config.json`, served next to the page). The Pages workflow
 * writes it from repository variables; the page refuses to verify anything when it is missing
 * or malformed. It names, per network, the RPC endpoint and the registry the page trusts by
 * default, the pinned attester keys (empty: any attester the registry reports in good standing),
 * and the code hashes of known reproducible registry builds.
 */
import { z } from 'zod';
import { isProjectKey, isPublicKeyText, isRegistryAccountId } from '@routespec/registry/browser';

export const CONFIG_SCHEMA = 'routespec.verify-page-config/1' as const;
const NETWORK_NAME = /^[a-z][a-z0-9-]{0,23}$/;
const CODE_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const rpcUrl = z
  .string()
  .max(200)
  .refine((text) => {
    try {
      const url = new URL(text);
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      return (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) && url.username === '';
    } catch {
      return false;
    }
  }, 'https, or http on a loopback host');

const network = z
  .object({
    chainId: z.string().min(1).max(64).nullable(),
    rpcUrl,
    registry: z.string().refine(isRegistryAccountId, 'a NEAR account id').nullable(),
  })
  .strict();

export const verifyPageConfigSchema = z
  .object({
    schema: z.literal(CONFIG_SCHEMA),
    project: z.string().refine(isProjectKey, 'a project key').nullable(),
    defaultNetwork: z.string().regex(NETWORK_NAME),
    networks: z.record(z.string().regex(NETWORK_NAME), network).refine((n) => Object.keys(n).length > 0),
    trustedAttesters: z.array(z.string().refine(isPublicKeyText, 'ed25519:<base58>')).max(16),
    knownCodeHashes: z.array(z.string().regex(CODE_HASH)).max(16),
  })
  .strict()
  .refine((c) => c.defaultNetwork in c.networks, 'defaultNetwork must be one of networks');

export type VerifyPageConfig = z.infer<typeof verifyPageConfigSchema>;
export type NetworkConfig = z.infer<typeof network>;

export function parseConfig(value: unknown): VerifyPageConfig {
  const parsed = verifyPageConfigSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`config.json is not valid at ${(issue?.path ?? []).join('.') || '(root)'}`);
  }
  return parsed.data;
}
