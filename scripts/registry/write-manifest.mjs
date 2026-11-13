// Runs inside the reproducible-build container (scripts/registry/container-reproduce.sh):
// turns the JSON line printed by build.mjs into /out/build-manifest.json.
//
// usage: node write-manifest.mjs <out dir> <commit> <contract tree> <image> <rustc version>
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [out, commit, contractTree, image, rustc] = process.argv.slice(2);
const build = JSON.parse(readFileSync(join(out, 'build.json'), 'utf8'));
const manifest = {
  schema: 'routespec.registry-build/1',
  commit,
  // The git tree of contracts/routespec-registry: commits that do not touch the contract keep
  // this value and build the same wasm.
  contractTree,
  artifact: build.artifact,
  bytes: build.bytes,
  sha256: build.sha256,
  codeHash: build.codeHash,
  exports: build.exports,
  toolchain: { rustc, target: 'wasm32-unknown-unknown', profile: 'release', nearSdk: '5.30.1' },
  image,
};
writeFileSync(join(out, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
rmSync(join(out, 'build.json'));
console.log(
  `routespec_registry.wasm ${build.bytes} bytes sha256 ${build.sha256} code hash ${build.codeHash}`,
);
