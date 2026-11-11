/**
 * Upstream origin and resolved-address policy for the live-dry adapter (SECURITY.md section 7,
 * TDD.md section 16; owned evidence T-038).
 *
 * The adapter never accepts an arbitrary URL. The only origin it can compile is the one pinned in
 * the protocol profile (`ONECLICK_SDK_PIN.defaultBaseUrl`), and it must be `https:` on the default
 * port with a DNS name (no IP literal, no userinfo, no path/query/fragment, no local-only name).
 * Every resolved address must be global unicast: loopback, private, link-local (including cloud
 * metadata), CGNAT, multicast, documentation, benchmarking, NAT64/6to4/Teredo transition and
 * reserved ranges are refused before any socket exists.
 */
import { BlockList, isIP } from 'node:net';
import { ONECLICK_SDK_PIN, RouteSpecError } from '@routespec/contracts';

export interface CompiledOrigin {
  readonly origin: string;
  readonly hostname: string;
  readonly port: 443;
}

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet', '.corp'];

function originDenied(reason: string): never {
  throw new RouteSpecError('RS_MODE_POLICY_DENIED', 'Upstream origin is not the pinned HTTPS origin.', {
    details: { reason, credentialAttached: false, dnsAttempted: false, upstreamAttempted: false },
  });
}

/**
 * Compile an upstream origin. Only the pinned profile origin is accepted; any other value is a
 * policy denial even when it is syntactically a valid public HTTPS URL.
 */
export function compileUpstreamOrigin(candidate: string, pinned: string = ONECLICK_SDK_PIN.defaultBaseUrl) {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 256) {
    originDenied('ORIGIN_MALFORMED');
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    originDenied('ORIGIN_MALFORMED');
  }
  if (url.protocol !== 'https:') originDenied('SCHEME_NOT_HTTPS');
  if (url.username !== '' || url.password !== '') originDenied('USERINFO_PRESENT');
  if (url.port !== '') originDenied('PORT_NOT_DEFAULT');
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') originDenied('PATH_OR_QUERY_PRESENT');
  const hostname = url.hostname.toLowerCase();
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare) !== 0) originDenied('IP_LITERAL_HOST');
  if (hostname.endsWith('.')) originDenied('TRAILING_DOT_HOST');
  if (!hostname.includes('.')) originDenied('SINGLE_LABEL_HOST');
  if (hostname === 'localhost' || LOCAL_SUFFIXES.some((s) => hostname.endsWith(s))) {
    originDenied('LOCAL_ONLY_HOST');
  }
  if (!/^[a-z0-9.-]+$/.test(hostname)) originDenied('HOST_NOT_ASCII_DNS');
  const pinnedUrl = new URL(pinned);
  if (url.origin !== pinnedUrl.origin) originDenied('ORIGIN_NOT_PINNED');
  return Object.freeze({ origin: url.origin, hostname, port: 443 as const });
}

// ---------------------------------------------------------------------------------------------
// Resolved address classification.

const V4_DENY: ReadonlyArray<readonly [string, number, string]> = [
  ['0.0.0.0', 8, 'THIS_NETWORK'],
  ['10.0.0.0', 8, 'PRIVATE'],
  ['100.64.0.0', 10, 'CGNAT'],
  ['127.0.0.0', 8, 'LOOPBACK'],
  ['169.254.0.0', 16, 'LINK_LOCAL_OR_METADATA'],
  ['172.16.0.0', 12, 'PRIVATE'],
  ['192.0.0.0', 24, 'IETF_PROTOCOL'],
  ['192.0.2.0', 24, 'DOCUMENTATION'],
  ['192.31.196.0', 24, 'AS112'],
  ['192.52.193.0', 24, 'AMT'],
  ['192.88.99.0', 24, 'RELAY_6TO4'],
  ['192.168.0.0', 16, 'PRIVATE'],
  ['192.175.48.0', 24, 'AS112'],
  ['198.18.0.0', 15, 'BENCHMARKING'],
  ['198.51.100.0', 24, 'DOCUMENTATION'],
  ['203.0.113.0', 24, 'DOCUMENTATION'],
  ['224.0.0.0', 4, 'MULTICAST'],
  ['240.0.0.0', 4, 'RESERVED'],
];

const V6_DENY: ReadonlyArray<readonly [string, number, string]> = [
  ['::', 128, 'UNSPECIFIED'],
  ['::1', 128, 'LOOPBACK'],
  ['::ffff:0:0', 96, 'IPV4_MAPPED'],
  ['::', 96, 'IPV4_COMPATIBLE'],
  ['64:ff9b::', 96, 'NAT64'],
  ['64:ff9b:1::', 48, 'NAT64'],
  ['100::', 64, 'DISCARD'],
  ['2001::', 23, 'IETF_PROTOCOL'],
  ['2001:db8::', 32, 'DOCUMENTATION'],
  ['2002::', 16, 'TRANSITION_6TO4'],
  ['3fff::', 20, 'DOCUMENTATION'],
  ['5f00::', 16, 'SEGMENT_ROUTING'],
  ['fc00::', 7, 'UNIQUE_LOCAL_OR_METADATA'],
  ['fe80::', 10, 'LINK_LOCAL'],
  ['fec0::', 10, 'SITE_LOCAL'],
  ['ff00::', 8, 'MULTICAST'],
];

const v4Lists = V4_DENY.map(([net, prefix, reason]) => {
  const list = new BlockList();
  list.addSubnet(net, prefix, 'ipv4');
  return { list, reason };
});
const v6Lists = V6_DENY.map(([net, prefix, reason]) => {
  const list = new BlockList();
  list.addSubnet(net, prefix, 'ipv6');
  return { list, reason };
});
const v6GlobalUnicast = new BlockList();
v6GlobalUnicast.addSubnet('2000::', 3, 'ipv6');

export type AddressVerdict =
  | { readonly allowed: true; readonly address: string; readonly family: 4 | 6 }
  | { readonly allowed: false; readonly address: string; readonly reason: string };

/** Classify one resolved address. Only global unicast outside every special-purpose range passes. */
export function classifyResolvedAddress(address: string): AddressVerdict {
  const raw = typeof address === 'string' ? address.replace(/^\[|\]$/g, '').split('%')[0]! : '';
  const family = isIP(raw);
  if (family === 4) {
    for (const { list, reason } of v4Lists) {
      if (list.check(raw, 'ipv4')) return { allowed: false, address: raw, reason };
    }
    if (raw === '255.255.255.255') return { allowed: false, address: raw, reason: 'BROADCAST' };
    return { allowed: true, address: raw, family: 4 };
  }
  if (family === 6) {
    if (address.includes('%')) return { allowed: false, address: raw, reason: 'SCOPED_ADDRESS' };
    for (const { list, reason } of v6Lists) {
      if (list.check(raw, 'ipv6')) return { allowed: false, address: raw, reason };
    }
    if (!v6GlobalUnicast.check(raw, 'ipv6')) {
      return { allowed: false, address: raw, reason: 'NOT_GLOBAL_UNICAST' };
    }
    return { allowed: true, address: raw, family: 6 };
  }
  return { allowed: false, address: String(address).slice(0, 64), reason: 'NOT_AN_IP_ADDRESS' };
}

/**
 * Every resolved address must pass; one forbidden answer rejects the whole set (a DNS-rebinding
 * style answer that mixes public and internal addresses never gets a connection). Returns the
 * single address the connection is pinned to.
 */
export function pinResolvedAddresses(answers: ReadonlyArray<{ address: string; family: number }>): {
  readonly address: string;
  readonly family: 4 | 6;
} {
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new RouteSpecError('RS_MODE_POLICY_DENIED', 'Upstream host resolved to no address.', {
      details: { reason: 'NO_ADDRESS', credentialAttached: false, upstreamAttempted: false },
    });
  }
  const verdicts = answers.slice(0, 32).map((a) => classifyResolvedAddress(a.address));
  const denied = verdicts.filter((v): v is Extract<AddressVerdict, { allowed: false }> => !v.allowed);
  if (denied.length > 0) {
    throw new RouteSpecError('RS_MODE_POLICY_DENIED', 'Upstream host resolved to a forbidden address.', {
      details: {
        reason: 'FORBIDDEN_RESOLVED_ADDRESS',
        addressClasses: [...new Set(denied.map((d) => d.reason))],
        credentialAttached: false,
        upstreamAttempted: false,
      },
    });
  }
  const first = verdicts[0] as Extract<AddressVerdict, { allowed: true }>;
  return { address: first.address, family: first.family };
}
