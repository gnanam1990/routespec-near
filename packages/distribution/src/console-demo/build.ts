/**
 * Builds the static read-only console demo site (M54) for GitHub Pages.
 *
 * The site is the production console bundle built in demo mode (`VITE_ROUTESPEC_DEMO=1`) under a
 * sub-path, plus the committed recording of a real contained run:
 *
 *   <out>/index.html, assets/...       the console
 *   <out>/404.html                     the same page, so deep links work on GitHub Pages
 *   <out>/demo/snapshot.json           recorded control-API responses (record.ts)
 *   <out>/demo/evidence-bundle.tar     the run's exported evidence bundle, byte for byte
 *   <out>/demo/provenance.json         where both came from
 *
 * The build refuses a snapshot or bundle whose digest does not match the provenance record.
 *
 *   node packages/distribution/src/console-demo/build.ts [--out <dir>] [--base /routespec-near/]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../npm-package.ts';
import { DEMO_DIR } from './record.ts';

export const DEFAULT_BASE = '/routespec-near/';
export const DEFAULT_OUT = join(ROOT, '.data', 'console-demo-site');

const sha256 = (bytes: Buffer | string): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Checks the committed recording against its provenance record; returns the provenance. */
export function checkRecording(dir: string = DEMO_DIR): Record<string, unknown> {
  const provenance = JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const snapshot = readFileSync(join(dir, 'snapshot.json'));
  const bundle = readFileSync(join(dir, 'evidence-bundle.tar'));
  if (sha256(snapshot) !== provenance['snapshotDigest'])
    throw new Error('snapshot.json does not match provenance');
  if (sha256(bundle) !== (provenance['bundle'] as Record<string, unknown>)['digest']) {
    throw new Error('evidence-bundle.tar does not match provenance');
  }
  return provenance;
}

export function buildConsoleDemo(options: { out?: string; base?: string } = {}): string {
  const out = resolve(options.out ?? DEFAULT_OUT);
  const base = options.base ?? DEFAULT_BASE;
  checkRecording();
  rmSync(out, { recursive: true, force: true });
  const vite = join(ROOT, 'apps', 'console', 'node_modules', 'vite', 'bin', 'vite.js');
  execFileSync(process.execPath, [vite, 'build'], {
    cwd: join(ROOT, 'apps', 'console'),
    env: {
      ...process.env,
      VITE_ROUTESPEC_DEMO: '1',
      ROUTESPEC_CONSOLE_BASE: base,
      ROUTESPEC_CONSOLE_OUT: out,
    },
    stdio: 'pipe',
  });
  mkdirSync(join(out, 'demo'), { recursive: true });
  for (const file of ['snapshot.json', 'evidence-bundle.tar', 'provenance.json']) {
    copyFileSync(join(DEMO_DIR, file), join(out, 'demo', file));
  }
  copyFileSync(join(out, 'index.html'), join(out, '404.html'));
  writeFileSync(join(out, '.nojekyll'), '');
  return out;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const outArg = arg('out');
  const baseArg = arg('base');
  const out = buildConsoleDemo({
    ...(outArg !== undefined ? { out: outArg } : {}),
    ...(baseArg !== undefined ? { base: baseArg } : {}),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, out, base: baseArg ?? DEFAULT_BASE })}\n`);
}
