#!/usr/bin/env node
// `pnpm run registry:reproduce`: build the routespec-registry wasm in a pinned Linux container
// (scripts/registry/container-reproduce.sh) from a clean clone of a commit. The result is the
// deployable artifact: its SHA-256 and NEAR code hash do not depend on this host.
//
// Options: --ref <commit> (default HEAD), --out <dir> (default .data/registry/repro),
// --expect <sha256> (fail unless the built wasm has this digest; use it to check a second build
// or the code of a deployed contract).
//
// The engine command comes from ROUTESPEC_CONTAINER_CLI (see
// docs/runbooks/container-containment.md), for example
// ["wsl.exe","-d","Ubuntu-24.04","-u","root","--exec","docker"] on a Windows host whose Docker
// Engine runs in WSL. The image is pinned by digest; the engine pulls it by that digest if it is
// absent.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IMAGE = 'node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee';
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

function containerCli() {
  const raw = (process.env.ROUTESPEC_CONTAINER_CLI ?? '').trim();
  if (raw === '') return ['docker'];
  if (raw.startsWith('[')) return JSON.parse(raw);
  return raw.split(/\s+/);
}
const cli = containerCli();
const viaWsl = /(^|[\\/])wsl(\.exe)?$/i.test(cli[0] ?? '');
const enginePath = (p) => {
  const abs = resolve(p);
  if (!viaWsl) return abs;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(abs);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].split('\\').join('/')}` : abs.split('\\').join('/');
};

const ref = git('rev-parse', opt('ref', 'HEAD'));
const out = resolve(ROOT, opt('out', '.data/registry/repro'));
mkdirSync(out, { recursive: true });
// In a worktree, .git is a file; the container clones from the shared git directory instead.
let gitDir = git('rev-parse', '--git-common-dir');
if (!isAbsolute(gitDir)) gitDir = resolve(ROOT, gitDir);

const run = spawnSync(
  cli[0],
  [
    ...cli.slice(1),
    'run',
    '--rm',
    '--name',
    `routespec-registry-build-${process.pid}`,
    '-v',
    `${enginePath(gitDir)}:/gitdir:ro`,
    '-v',
    `${enginePath(resolve(ROOT, 'scripts', 'registry'))}:/scripts:ro`,
    '-v',
    `${enginePath(out)}:/out`,
    '-e',
    'CARGO_HOME=/root/.cargo',
    '-e',
    'RUSTUP_HOME=/root/.rustup',
    '-e',
    `ROUTESPEC_BUILD_IMAGE=${IMAGE}`,
    IMAGE,
    'sh',
    '/scripts/container-reproduce.sh',
    ref,
  ],
  { stdio: 'inherit' },
);
if (run.error) {
  console.error(`registry:reproduce: cannot run ${cli[0]}: ${run.error.message}`);
  process.exit(2);
}
if (run.status !== 0) process.exit(run.status ?? 1);
const manifest = JSON.parse(readFileSync(resolve(out, 'build-manifest.json'), 'utf8'));
const expected = opt('expect', null);
if (expected !== null && expected !== manifest.sha256) {
  console.error(`registry:reproduce: built ${manifest.sha256}, expected ${expected}`);
  process.exit(1);
}
console.log(`registry:reproduce: ${resolve(out, 'routespec_registry.wasm')}`);
