// Runs INSIDE a Linux container (node:22-trixie-slim; the nearcore sandbox binary needs glibc
// 2.38 or newer). Starts a local NEAR sandbox node for the registry test suite. Local only: it
// never contacts NEAR testnet or mainnet and keeps no state outside the container.
//
// The nearcore sandbox archive comes from NEAR's release bucket and is refused unless its
// SHA-256 equals the pin below. A verified copy is kept in /cache (a host directory mounted by
// the harness) and verified again before every use, so later runs need no download.
//
// usage: node sandbox-container.mjs
// Prints one JSON line when the node is ready: {"ready":true,"rpcPort":3030,...}. The validator
// account (test.near) is created by `near-sandbox init` with a fresh key in /sandbox; the
// harness reads that key file from the container. It exists only for the life of the container.
/* global fetch, setTimeout */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const NEAR_SANDBOX_VERSION = '2.14.0';
export const NEAR_SANDBOX_SHA256 = 'a0ba004218b218bd74351795e7ce2eda4a2b6af5cd3e252bd5e8bfe3c8f2e691';
const SOURCE = `https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/${NEAR_SANDBOX_VERSION}/near-sandbox.tar.gz`;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => {
  process.stderr.write(`sandbox-container: ${message}\n`);
  process.exit(1);
};

const cached = join('/cache', `near-sandbox-${NEAR_SANDBOX_VERSION}.tar.gz`);
let archive = existsSync(cached) ? readFileSync(cached) : null;
if (archive !== null && sha256(archive) !== NEAR_SANDBOX_SHA256) archive = null;
if (archive === null) {
  const response = await fetch(SOURCE);
  if (!response.ok) fail(`${SOURCE} answered ${response.status}`);
  archive = Buffer.from(await response.arrayBuffer());
  const have = sha256(archive);
  if (have !== NEAR_SANDBOX_SHA256) {
    fail(
      `near-sandbox ${NEAR_SANDBOX_VERSION} archive ${have} does not match its pinned SHA-256; refusing it`,
    );
  }
  if (existsSync('/cache')) {
    const partial = `${cached}.${process.pid}.partial`;
    writeFileSync(partial, archive);
    renameSync(partial, cached);
  }
}

mkdirSync('/opt/near', { recursive: true });
writeFileSync('/opt/near/near-sandbox.tar.gz', archive);
execFileSync('tar', ['xzf', '/opt/near/near-sandbox.tar.gz', '-C', '/opt/near']);
const binary = '/opt/near/Linux-x86_64/near-sandbox';
chmodSync(binary, 0o755);

const home = '/sandbox';
execFileSync(binary, ['--home', home, 'init', '--fast'], { stdio: ['ignore', 'ignore', 'inherit'] });
const node = spawn(binary, ['--home', home, 'run', '--rpc-addr', '0.0.0.0:3030'], {
  stdio: ['ignore', 'ignore', 'inherit'],
});
node.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => node.kill('SIGTERM'));

const deadline = Date.now() + 120_000;
for (;;) {
  try {
    const response = await fetch('http://127.0.0.1:3030/status');
    if (response.ok) break;
  } catch {
    // Not listening yet.
  }
  if (Date.now() > deadline) fail('the sandbox node did not start in time');
  await new Promise((resolve) => setTimeout(resolve, 250));
}
process.stdout.write(
  `${JSON.stringify({ ready: true, rpcPort: 3030, version: NEAR_SANDBOX_VERSION, sha256: NEAR_SANDBOX_SHA256, home })}\n`,
);
