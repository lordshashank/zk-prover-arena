#!/usr/bin/env bash
# zk-prover-arena CI — provision the official grading environment.
#
# Target: GitHub-hosted ubuntu-24.04-arm runner (Azure Cobalt 100 / Neoverse N2,
# 4 vCPU, 16 GiB — a homogeneous fleet, which is what makes scores comparable).
#
# Installs: GNU time (grade.mjs RSS/disk metrics), ninja, ccache, clang-20 (apt.llvm.org —
# same major as the maintainer's local LLVM toolchain), pinned nargo; clones
# aztec-packages at the pinned base commit (blob-filtered + sparse: barretenberg/cpp
# only); builds the baseline bb unless the cache already restored it.
#
# Layout (consumed by ci/grade.sh):
#   $HOME/aztec-packages       BB_REPO (sparse clone @ pinned base)
#   $HOME/bb-baseline/bb       BASELINE_BB (cache key: base commit + toolchain)
#   $HOME/.nargo/bin/nargo     NARGO_BIN
#   $HOME/.ccache              CCACHE_DIR
set -euo pipefail

ARENA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BASE_COMMIT=$(sed -n "s/^export const BASE_COMMIT = '\([0-9a-f]\{40\}\)';$/\1/p" "$ARENA_DIR/intake.mjs")
[ -n "$BASE_COMMIT" ] || { echo "could not parse BASE_COMMIT from intake.mjs" >&2; exit 1; }
NARGO_VERSION="${NARGO_VERSION:-1.0.0-beta.22}"
LLVM_MAJOR=20
BB_REPO="$HOME/aztec-packages"

echo "== apt packages =="
sudo apt-get update -qq
sudo apt-get install -y -qq time ninja-build ccache jq >/dev/null

# bb's cmake configure probes node/yarn for the nodejs_module subproject (a tiny
# self-contained yarn-4 package). corepack makes `yarn` resolve to the version pinned
# in its package.json. (BB_LITE would skip this entirely but cannot link `bb` at the
# pinned commit: api_msgpack.cpp references ipc unconditionally on non-WASM.)
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
sudo env "PATH=$PATH" corepack enable || corepack enable
yarn --version || true

echo "== clang-$LLVM_MAJOR (apt.llvm.org) =="
if ! command -v clang-$LLVM_MAJOR >/dev/null; then
  # Explicit repo lines instead of llvm.sh — the script can hang on prompts in
  # non-interactive environments, and pinning the suite is more deterministic anyway.
  CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
  wget -qO- https://apt.llvm.org/llvm-snapshot.gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/llvm.gpg
  echo "deb [signed-by=/usr/share/keyrings/llvm.gpg] http://apt.llvm.org/$CODENAME/ llvm-toolchain-$CODENAME-$LLVM_MAJOR main" | sudo tee /etc/apt/sources.list.d/llvm.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq clang-$LLVM_MAJOR >/dev/null
fi
# bb's `default` preset expects plain `clang`/`clang++` on PATH.
sudo ln -sf "$(command -v clang-$LLVM_MAJOR)" /usr/local/bin/clang
sudo ln -sf "$(command -v clang++-$LLVM_MAJOR)" /usr/local/bin/clang++
clang --version | head -1

echo "== nargo $NARGO_VERSION =="
if [ ! -x "$HOME/.nargo/bin/nargo" ]; then
  mkdir -p "$HOME/.nargo/bin"
  ARCH=$(uname -m); case "$ARCH" in aarch64|arm64) TRIPLE=aarch64-unknown-linux-gnu ;; x86_64) TRIPLE=x86_64-unknown-linux-gnu ;; *) echo "unsupported arch $ARCH" >&2; exit 1 ;; esac
  curl -fsSL "https://github.com/noir-lang/noir/releases/download/v$NARGO_VERSION/nargo-$TRIPLE.tar.gz" | tar -xz -C "$HOME/.nargo/bin"
fi
"$HOME/.nargo/bin/nargo" --version

echo "== aztec-packages @ ${BASE_COMMIT:0:10} (sparse) =="
if ! git -C "$BB_REPO" cat-file -e "$BASE_COMMIT^{commit}" 2>/dev/null; then
  rm -rf "$BB_REPO"
  git init -q "$BB_REPO"
  git -C "$BB_REPO" remote add origin https://github.com/AztecProtocol/aztec-packages.git
  git -C "$BB_REPO" config remote.origin.promisor true
  git -C "$BB_REPO" config remote.origin.partialclonefilter blob:none
  git -C "$BB_REPO" fetch -q --depth 1 --filter=blob:none origin "$BASE_COMMIT"
  git -C "$BB_REPO" sparse-checkout set --cone barretenberg/cpp
  git -C "$BB_REPO" checkout -q --detach "$BASE_COMMIT"
fi

echo "== baseline bb =="
export CCACHE_DIR="$HOME/.ccache" CCACHE_MAXSIZE=4G
export CMAKE_C_COMPILER_LAUNCHER=ccache CMAKE_CXX_COMPILER_LAUNCHER=ccache
export CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-4}"
if [ ! -x "$HOME/bb-baseline/bb" ]; then
  echo "cache miss — building baseline from pristine ${BASE_COMMIT:0:10} (cold: ~15-40 min on 4 vCPU)"
  cd "$BB_REPO/barretenberg/cpp"
  cmake --preset default >/dev/null
  # Stream sampled progress lines for liveness; keep the full log and dump its tail on
  # failure (linker diagnostics like "undefined reference" don't match progress patterns).
  set +e
  cmake --build --preset default --target bb 2>&1 | tee /tmp/bb-build.log | grep --line-buffered -E '^\[[0-9]+/[0-9]+\]' | sed -n '1~50p'
  build_rc=${PIPESTATUS[0]}
  set -e
  if [ "$build_rc" != 0 ]; then
    echo "=== baseline build FAILED — last 150 lines ==="
    tail -150 /tmp/bb-build.log
    exit 1
  fi
  mkdir -p "$HOME/bb-baseline"
  cp build/bin/bb "$HOME/bb-baseline/bb"
fi
"$HOME/bb-baseline/bb" --version || true

echo "== CRS pre-warm + VK determinism check =="
# First bb use downloads ~140MB of SRS points to ~/.bb-crs — inside a graded run that
# trips the disk-spill gate (286k block writes). Warm it here (cached across runs), and
# use the same write_vk to assert the CI-built baseline reproduces the pinned VK exactly.
mkdir -p /tmp/crswarm
"$HOME/bb-baseline/bb" write_vk --scheme ultra_honk -b "$ARENA_DIR/problem/problem.json" -o /tmp/crswarm
cmp /tmp/crswarm/vk "$ARENA_DIR/problem/baseline_vk/vk" || { echo "FATAL: CI-built baseline VK differs from pinned VK — environment/build divergence" >&2; exit 1; }
echo "VK matches pinned baseline VK"

ccache -s | head -6 || true
df -h / | tail -1
echo "setup complete"
