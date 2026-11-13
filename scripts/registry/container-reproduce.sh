#!/bin/sh
# Reproducible build of the routespec-registry wasm inside an official node:22-bookworm-slim
# container (pinned by digest in scripts/registry/reproduce.mjs). It installs git, a C toolchain
# and Rust 1.97.1 with the wasm target, clones the mounted repository, checks out the given
# commit, runs the host tests of the certificate crate, and builds the contract with the locked
# dependencies. With CARGO_HOME fixed at /root/.cargo and the source at /work/src, the wasm
# digest does not depend on the host or on the checkout path.
#
#   docker run --rm -v <git dir>:/gitdir:ro -v <scripts/registry>:/scripts:ro -v <out dir>:/out \
#     -e CARGO_HOME=/root/.cargo -e RUSTUP_HOME=/root/.rustup \
#     node:22-bookworm-slim@sha256:<digest> sh /scripts/container-reproduce.sh <commit>
# (`pnpm run registry:reproduce` builds this command.) Writes /out/routespec_registry.wasm and
# /out/build-manifest.json. Nothing here talks to NEAR.
#
# rustup-init is pinned by version and SHA-256 and refused on mismatch; no installer script is
# piped to a shell. rustup then checks the toolchain components against the release manifest.
set -eu
REF="${1:?usage: container-reproduce.sh <commit>}"
RUSTUP_VERSION=1.29.3
RUSTUP_INIT_SHA256_X86_64=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55
RUSTUP_INIT_SHA256_AARCH64=9f608c142e0e38a78957d0661ba1dfaf0b6fb37184cfaa4b9a0aa57af6184282
RUST_TOOLCHAIN=1.97.1

export DEBIAN_FRONTEND=noninteractive
printf '%s\n' 'Acquire::http::Timeout "60";' 'Acquire::https::Timeout "60";' 'Acquire::Retries "5";' \
  >/etc/apt/apt.conf.d/80-routespec-network
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends git curl ca-certificates build-essential >/dev/null

case "$(uname -m)" in
  x86_64 | amd64) RUSTUP_TRIPLE=x86_64-unknown-linux-gnu RUSTUP_INIT_SHA256=$RUSTUP_INIT_SHA256_X86_64 ;;
  aarch64 | arm64) RUSTUP_TRIPLE=aarch64-unknown-linux-gnu RUSTUP_INIT_SHA256=$RUSTUP_INIT_SHA256_AARCH64 ;;
  *)
    echo "container-reproduce: no pinned rustup-init for $(uname -m)" >&2
    exit 1
    ;;
esac
export CARGO_HOME="${CARGO_HOME:-/root/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-/root/.rustup}"
for RUST_HOME_DIR in "$CARGO_HOME" "$RUSTUP_HOME"; do
  if [ -n "$(ls -A "$RUST_HOME_DIR" 2>/dev/null)" ]; then
    echo "container-reproduce: $RUST_HOME_DIR is not empty; refusing to reuse a cached toolchain" >&2
    exit 1
  fi
done
RUSTUP_INIT_DIR=$(mktemp -d)
RUSTUP_INIT="$RUSTUP_INIT_DIR/rustup-init"
curl -sSf --proto '=https' --tlsv1.2 -o "$RUSTUP_INIT" \
  "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/$RUSTUP_TRIPLE/rustup-init"
if ! echo "$RUSTUP_INIT_SHA256  $RUSTUP_INIT" | sha256sum -c - >/dev/null 2>&1; then
  echo "container-reproduce: rustup-init $RUSTUP_VERSION does not match its pinned SHA-256; refusing to run it" >&2
  exit 1
fi
chmod +x "$RUSTUP_INIT"
"$RUSTUP_INIT" -y -q --no-modify-path --profile minimal --default-toolchain "$RUST_TOOLCHAIN" >/dev/null
rm -rf "$RUSTUP_INIT_DIR"
export PATH="$CARGO_HOME/bin:$PATH"
rustup set auto-self-update disable >/dev/null 2>&1
rustup target add wasm32-unknown-unknown >/dev/null 2>&1

git config --global --add safe.directory '*'
rm -rf /work && mkdir -p /work
git clone --quiet --no-local /gitdir /work/src
cd /work/src
git -c advice.detachedHead=false checkout --quiet "$REF"
COMMIT=$(git rev-parse HEAD)
TREE=$(git rev-parse "HEAD:contracts/routespec-registry")
uname -sm
rustc --version

if ! cargo test --quiet --locked --manifest-path contracts/routespec-registry/Cargo.toml \
  -p routespec-certificate >/out/host-tests.log 2>&1; then
  cat /out/host-tests.log >&2
  exit 1
fi
grep -E "^test result" /out/host-tests.log
node scripts/registry/build.mjs >/out/build.json
cp contracts/routespec-registry/target/wasm32-unknown-unknown/release/routespec_registry.wasm /out/routespec_registry.wasm
node scripts/registry/write-manifest.mjs /out "$COMMIT" "$TREE" "${ROUTESPEC_BUILD_IMAGE:-unknown}" "$(rustc --version)"
