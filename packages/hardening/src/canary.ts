/**
 * Canary-secret persistence scanner (T-011, NFR-03, INV-11).
 *
 * A canary is a unique high-entropy value injected through an approved memory input (a
 * configured secret, a provider credential, a token). After a run, every persisted byte the
 * product may have produced is searched for it: database, WAL and shared-memory files, logs,
 * exports, extracted bundles, crash artifacts, and process arguments. The search looks for the
 * raw UTF-8 bytes and the encodings a value can take on its way to disk: UTF-16LE (SQLite text
 * and Windows APIs), base64 and base64url (JSON/JWT/HTTP), lowercase and uppercase hex, and
 * percent encoding. Findings carry the file and encoding, never the value.
 */
import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export type CanaryEncoding = 'utf8' | 'utf16le' | 'base64' | 'base64url' | 'hex' | 'HEX' | 'percent';

export interface Canary {
  readonly label: string;
  readonly value: string;
}

export interface CanaryFinding {
  readonly label: string;
  readonly location: string;
  readonly encoding: CanaryEncoding;
}

/** A fresh canary that matches no real credential format unless a prefix makes it one. */
export function makeCanary(label: string, prefix = 'rscanary_'): Canary {
  return { label, value: `${prefix}${randomBytes(18).toString('hex')}` };
}

/** The byte patterns a canary is searched for. Base64 forms use a window aligned on all three offsets. */
export function canaryPatterns(value: string): Array<{ encoding: CanaryEncoding; bytes: Buffer }> {
  const raw = Buffer.from(value, 'utf8');
  const out: Array<{ encoding: CanaryEncoding; bytes: Buffer }> = [
    { encoding: 'utf8', bytes: raw },
    { encoding: 'utf16le', bytes: Buffer.from(value, 'utf16le') },
    { encoding: 'hex', bytes: Buffer.from(raw.toString('hex'), 'latin1') },
    { encoding: 'HEX', bytes: Buffer.from(raw.toString('hex').toUpperCase(), 'latin1') },
  ];
  const pct = encodeURIComponent(value);
  if (pct !== value) out.push({ encoding: 'percent', bytes: Buffer.from(pct, 'latin1') });
  // A value embedded at an arbitrary offset of a base64 stream: for each alignment take the
  // stable interior characters (drop the first and last partial groups).
  for (let shift = 0; shift < 3; shift++) {
    const padded = Buffer.concat([Buffer.alloc(shift, 0), raw]);
    for (const enc of ['base64', 'base64url'] as const) {
      const text = padded.toString(enc).replace(/=+$/, '');
      const start = shift === 0 ? 0 : Math.ceil((shift * 4) / 3) + 1;
      const interior = text.slice(start, Math.max(start, text.length - 4));
      if (interior.length >= 16) out.push({ encoding: enc, bytes: Buffer.from(interior, 'latin1') });
    }
  }
  return out;
}

/** Search one buffer for every canary in every encoding. */
export function scanBuffer(bytes: Buffer, canaries: readonly Canary[], location: string): CanaryFinding[] {
  const findings: CanaryFinding[] = [];
  for (const c of canaries) {
    const seen = new Set<CanaryEncoding>();
    for (const p of canaryPatterns(c.value)) {
      if (seen.has(p.encoding)) continue;
      if (bytes.indexOf(p.bytes) >= 0) {
        seen.add(p.encoding);
        findings.push({ label: c.label, location, encoding: p.encoding });
      }
    }
  }
  return findings;
}

export interface TreeScan {
  readonly files: number;
  readonly bytes: number;
  readonly findings: CanaryFinding[];
  /** Relative paths of every scanned file, for evidence (no content). */
  readonly scanned: string[];
}

/** Scan every regular file under `root` (links are listed, never followed). */
export function scanTree(
  root: string,
  canaries: readonly Canary[],
  maxFileBytes = 256 * 1024 * 1024,
): TreeScan {
  const findings: CanaryFinding[] = [];
  const scanned: string[] = [];
  let files = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        scanned.push(`${relative(root, full)} (link, not followed)`);
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!st.isFile() || st.size > maxFileBytes) continue;
      const content = readFileSync(full);
      files++;
      bytes += content.length;
      const rel = relative(root, full).split('\\').join('/');
      scanned.push(rel);
      findings.push(...scanBuffer(content, canaries, rel));
    }
  };
  walk(root);
  return { files, bytes, findings, scanned };
}
