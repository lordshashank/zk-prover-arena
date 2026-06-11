# Environment setup

Everything needed to go from a bare machine to a graded local run. The canonical
grading runners are GitHub-hosted `ubuntu-24.04-arm` (Azure Cobalt 100 / Neoverse N2)
and x86 `ubuntu-latest`, provisioned by `zk-arena/setup.sh` on the branch — the closer
your environment is to that, the better your local numbers predict official ones.

## Prerequisites

| Requirement | Notes |
|---|---|
| git | |
| cmake ≥ 3.24, ninja | `apt install ninja-build` / `brew install cmake ninja` |
| clang 20 | canonical runners use `clang-20` from apt.llvm.org; macOS: `brew install llvm` |
| node ≥ 20 + corepack | `corepack enable` — bb's cmake configure probes a yarn package (nodejs_module); without corepack, configure fails on node-api-headers |
| nargo v1.0.0-beta.22 | via [noirup](https://github.com/noir-lang/noirup): `noirup -v 1.0.0-beta.22`; the grader looks at `~/.nargo/bin/nargo` or `NARGO_BIN=<path>` |
| GNU/BSD time | the grader spawns `/usr/bin/time` for RSS/disk accounting; on Linux `apt install time` |
| ~15 GB disk | source + two build trees |
| Linux or macOS | official numbers are Linux; macOS is fine for time iteration (see measurement-methodology.md for the RSS caveat) |

## 1. Clone the arena branch

```bash
git clone https://github.com/lordshashank/aztec-packages bb-arena
cd bb-arena
git checkout zk-arena    # the default branch — always the current champion
```

## 2. Build the champion (the tip — your reference to beat)

```bash
corepack enable
cd barretenberg/cpp
cmake --preset default && cmake --build --preset default --target bb
```

macOS with homebrew LLVM:

```bash
BREW_PREFIX=/opt/homebrew cmake --preset homebrew
cmake --build --preset homebrew --target bb
```

Cold build is long (~15–40 min on 4 vCPU); incremental rebuilds after source edits are
fast. **Save the tip binary before you start editing** so you always have a local
reference:

```bash
mkdir -p ~/.bb-arena && cp build/bin/bb ~/.bb-arena/bb-tip
```

## 3. Build the frozen verifier (one-time)

Local grading needs a pristine bb built from the **original base commit**
`7e94c2c0e32820e25e20d39a426d546dae56a34f` — it computes/checks the pinned VK and
verifies every candidate proof (the soundness anchor; the candidate never judges
itself). Use a worktree so your main checkout stays on `zk-arena`:

```bash
git worktree add /tmp/bb-original 7e94c2c0e32820e25e20d39a426d546dae56a34f
cd /tmp/bb-original/barretenberg/cpp
cmake --preset default && cmake --build --preset default --target bb   # or the homebrew preset on macOS
mkdir -p ~/.bb-next && cp build/bin/bb ~/.bb-next/bb
cd - && git worktree remove --force /tmp/bb-original
```

`grade.mjs` finds it at `~/.bb-next/bb` by default, or set `BASELINE_BB=<path>`.

## 4. Smoke-test the grader

From the repo root (grade.mjs resolves all paths relative to itself, so the repo root
or `zk-arena/` both work):

```bash
node zk-arena/grade.mjs --stack=tip --bb=$HOME/.bb-arena/bb-tip --runs=2
```

Expected output: per-run lines with `prove ...s peakRSS ...MiB ... verified=true
outputMatch=true`, then a gates summary where every gate reads PASS and both boards
read VALID. Things to check:

- `fresh witness per run: yes (nargo)` — if it says the pinned-witness fallback is in
  use, nargo is missing or the wrong version; the output gate is then skipped (fine for
  rough time iteration, but officials always enforce it).
- First-ever `bb prove` downloads the ~140 MB CRS; do one warm-up run before timing
  anything, or the first run's time and disk numbers are polluted.
- `num threads: 1` — `grade.mjs` sets `HARDWARE_CONCURRENCY=1` itself; when running bb
  manually for profiling, set it yourself.

Useful flags/env: `--runs=N` (use 5 for decisions), `--json=<file>` for a
machine-readable result (`{medianS, peakMiB, runs:[...], gates:{...}}`), `BASELINE_BB`,
`NARGO_BIN`. Results are appended to `zk-arena/boards/*.tsv` tagged with a machine
fingerprint — local rows are advisory only.

## 5. Manual profiling run

```bash
HARDWARE_CONCURRENCY=1 ./build/bin/bb prove --scheme ultra_honk \
  -b zk-arena/problem/problem.json -w zk-arena/problem/problem.gz \
  -k zk-arena/problem/baseline_vk/vk -o /tmp/out --print_bench
```

`--print_bench` prints a human-readable phase/op-count tree to stderr — your phase
attribution tool. The pinned witness (`problem.gz`) is fine for profiling; graded runs
use a fresh witness.

## Linux container on a Mac (recommended for memory work)

macOS RSS is too noisy to optimize against (±500 MiB ambient). A Linux arm64 container
reproducing the CI toolchain (clang-20, preset `default`) tracked the official runner's
peak RSS within ~0.3% and its time ratios predicted official seconds within ~1.5%
during the last campaign. If you are optimizing memory on a Mac, build and grade inside
such a container — or treat the official CI grading as the only memory oracle.
