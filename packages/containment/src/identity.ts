/**
 * Identity digests shared by the containment launcher, the attesting launcher, and the
 * integrator that registers a contained build (M14).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { digestValue, type Digest } from '@routespec/contracts';

/** Same domain as the proxy's reviewed-interceptor digest (LF-normalized artifact text). */
export const INTERCEPTOR_ARTIFACT_DOMAIN = 'routespec.interceptor-artifact/1' as const;

/** Toolchain identity of a contained build: the immutable id of the pinned container image. */
export function containerToolchainDigest(imageId: string): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ containerImageId: imageId }))
    .digest('hex')}`;
}

/**
 * Reviewed identity of the attesting launcher: the entry script plus every source file of the
 * containment and contracts packages it runs (third-party modules are pinned by the lockfile
 * digest instead). A tree digest hashes sorted `relative-path NUL file-sha256 LF` lines, so any
 * added, removed, renamed, or edited file changes it. The service measures this before it forks
 * the launcher, and the launcher signs the same value it computes for itself.
 */
export function launcherArtifactDigest(entry: string): `sha256:${string}` {
  const src = dirname(resolve(entry));
  const packages = resolve(src, '..', '..');
  const files = new Set<string>([resolve(entry)]);
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /\.(ts|mjs)$/.test(e.name)) files.add(full);
    }
  };
  walk(join(packages, 'containment', 'src'));
  walk(join(packages, 'contracts', 'src'));
  const lines = [...files]
    .map((f) => {
      const rel = relative(packages, f).split(sep).join('/');
      return `${rel}\u0000${createHash('sha256').update(readFileSync(f)).digest('hex')}\n`;
    })
    .sort();
  return `sha256:${createHash('sha256').update(lines.join('')).digest('hex')}`;
}

/** Digest of a reviewed interceptor artifact as the proxy pins it. */
export function interceptorArtifactDigest(path: string): Digest {
  return digestValue(INTERCEPTOR_ARTIFACT_DOMAIN, readFileSync(path, 'utf8').replace(/\r\n/g, '\n'));
}
