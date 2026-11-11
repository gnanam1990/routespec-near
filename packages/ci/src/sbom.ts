/**
 * Software bill of materials from the committed lockfile (M10 deliverable 7, NFR-11).
 *
 * Reads the `packages:` section of a pnpm v9 lockfile (name, version, integrity) and emits a
 * CycloneDX 1.5 JSON document with the lockfile digest and the toolchain that produced it. The
 * output is deterministic for the same lockfile and toolchain: no timestamp, serial number, or
 * host path. It is an inventory, not a vulnerability or license verdict, and it is unsigned.
 */
import { createHash } from 'node:crypto';
import { RouteSpecError } from '@routespec/contracts';

export interface SbomComponent {
  readonly name: string;
  readonly version: string;
  readonly integrity: string | null;
}

const ENTRY = /^ {2}'?((?:@[^@\s'/]+\/)?[^@\s'/]+)@([^\s'():]+)'?:\s*$/;
const INTEGRITY = /^ {4}resolution:\s*\{[^}]*integrity:\s*([A-Za-z0-9+/=-]+)/;

export function parsePnpmLock(text: string): SbomComponent[] {
  if (!/^lockfileVersion:\s*'9\./m.test(text)) {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'Only pnpm lockfile version 9 is supported.');
  }
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf('packages:');
  if (start === -1) return [];
  const out: SbomComponent[] = [];
  let current: { name: string; version: string; integrity: string | null } | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\S/.test(line)) break; // next top-level section (snapshots:)
    const entry = ENTRY.exec(line);
    if (entry) {
      if (current) out.push(current);
      current = { name: entry[1] as string, version: entry[2] as string, integrity: null };
      continue;
    }
    const integrity = INTEGRITY.exec(line);
    if (integrity && current) current.integrity = integrity[1] as string;
  }
  if (current) out.push(current);
  return out.sort((a, b) =>
    a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1,
  );
}

function purl(c: SbomComponent): string {
  const name = c.name.startsWith('@') ? `%40${c.name.slice(1)}` : c.name;
  return `pkg:npm/${name}@${c.version}`;
}

/** CycloneDX hashes are hex; pnpm integrity is `<alg>-<base64>`. */
function hashOf(integrity: string | null): { hashes?: Array<{ alg: string; content: string }> } {
  const m = integrity === null ? null : /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(integrity);
  if (!m) return {};
  const alg = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' }[m[1] as 'sha512'];
  return { hashes: [{ alg, content: Buffer.from(m[2] as string, 'base64').toString('hex') }] };
}

export function buildSbom(
  lockText: string,
  toolchain: { readonly node: string; readonly pnpm: string | null },
): Record<string, unknown> {
  const components = parsePnpmLock(lockText);
  const lockDigest = `sha256:${createHash('sha256').update(lockText, 'utf8').digest('hex')}`;
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: { type: 'application', name: 'routespec', version: '0.0.0' },
      properties: [
        { name: 'routespec:lockfileDigest', value: lockDigest },
        { name: 'routespec:node', value: toolchain.node },
        { name: 'routespec:pnpm', value: toolchain.pnpm ?? 'unknown' },
        { name: 'routespec:signed', value: 'false' },
      ],
    },
    components: components.map((c) => ({
      type: 'library',
      name: c.name,
      version: c.version,
      purl: purl(c),
      ...hashOf(c.integrity),
    })),
  };
}
