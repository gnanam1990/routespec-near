#!/usr/bin/env node
// Builds the routespec-registry wasm from inside contracts/routespec-registry, so that
// directory's .cargo/config.toml applies (`--cfg near`, stripped symbols), with the locked
// dependencies. Then checks the artifact and prints its size, SHA-256 and NEAR code hash.
//
// Usage: pnpm run registry:build
// The digest of a host build depends on the host (cargo home path, platform). The deployable
// artifact is the one from `pnpm run registry:reproduce`, built in a pinned container.
/* global WebAssembly */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const contractDir = fileURLToPath(new URL('../../contracts/routespec-registry/', import.meta.url));
const built = spawnSync(
  'cargo',
  ['build', '-p', 'routespec-registry', '--target', 'wasm32-unknown-unknown', '--release', '--locked'],
  { cwd: contractDir, stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' },
);
if (built.status !== 0) process.exit(built.status ?? 1);

const wasm = readFileSync(
  new URL(
    '../../contracts/routespec-registry/target/wasm32-unknown-unknown/release/routespec_registry.wasm',
    import.meta.url,
  ),
);
const module = new WebAssembly.Module(wasm);
const imports = WebAssembly.Module.imports(module).map((i) => i.name);
// Without `--cfg near`, near-sdk compiles host fallbacks and contract panics lose their message.
if (!imports.includes('panic_utf8')) {
  console.error('registry wasm was built without --cfg near (panic_utf8 import missing)');
  process.exit(1);
}
// The contract holds no funds and moves none: it must not import any host function that creates
// a promise (transfers, cross-contract calls, key or account changes are all promise actions) or
// reads its balance. attached_deposit is imported only by the near-sdk check that refuses a
// deposit on a non-payable method.
const forbidden = imports.filter((name) => /^promise_|^account_balance$|^account_locked_balance$/.test(name));
if (forbidden.length > 0) {
  console.error(`registry wasm imports value or promise host functions: ${forbidden.join(', ')}`);
  process.exit(1);
}
const digest = createHash('sha256').update(wasm).digest();
console.log(
  JSON.stringify({
    artifact: 'routespec_registry.wasm',
    bytes: wasm.length,
    sha256: digest.toString('hex'),
    codeHash: base58(digest),
    exports: WebAssembly.Module.exports(module)
      .filter((e) => e.kind === 'function')
      .map((e) => e.name)
      .sort(),
  }),
);
