---
name: zk-arena
description: >-
  Autonomously participate in zk-arena, the rolling-champion optimization
  competition for the barretenberg UltraHonk ZK prover (the zk-arena branch of
  github.com/lordshashank/aztec-packages). Covers the full loop: environment
  setup, building bb, local paired grading, prover-internal optimization
  (MSM, field arithmetic, sumcheck, polynomial memory), and submitting a PR for
  official grading. Use this whenever the user wants to participate or compete
  in zk-arena, optimize the barretenberg prover, make bb / UltraHonk proving
  faster or leaner, climb the zk prover leaderboard, prepare or validate a
  zk-arena submission, or asks to "beat the champion" / "make the prover
  faster" in the context of this competition.
---

# zk-arena — compete in the rolling-champion prover arena

zk-arena is an open optimization competition for the barretenberg UltraHonk prover.
It lives on the **`zk-arena` branch (the default branch) of
https://github.com/lordshashank/aztec-packages**. The branch always holds the current
champion prover. Contributors open PRs against it; every merged PR must have beaten the
branch tip on an official paired grading; on merge, the PR becomes the new base everyone
must beat.

- Leaderboard: `zk-arena/LEADERBOARD.md` on the branch + live site
  https://lordshashank.github.io/zk-prover-arena/
- Machine-readable history: `zk-arena/log.jsonl` on the branch
- Research log (read it — see below): `RESEARCH.md` in
  https://github.com/lordshashank/zk-prover-arena (the archived spec repo)

**The task (frozen forever):** prove a pinned 1,501,711-gate (pads to 2^21)
Poseidon2-chain UltraHonk circuit, native `bb` binary, **single thread**
(`HARDWARE_CONCURRENCY=1`), fresh random witness per graded run. Assets live in
`zk-arena/problem/` on the branch.

**State as of 2026-06** (always check the leaderboard for current numbers): original
pinned base `7e94c2c0e32820e25e20d39a426d546dae56a34f` scores 63.74 s / 1973 MiB
(arm64 Cobalt-100, official); current champion is ≈ 44.79 s / 1441 MiB after one merged
campaign. The bar moves every time a PR merges — your target is always the branch tip,
not these numbers.

## Step 0 — read before touching code

Do these first, in order. Skipping them wastes days retreading known-negative results.

1. Read the current `zk-arena/LEADERBOARD.md` and `zk-arena/log.jsonl` on the branch —
   they tell you what the tip scores and what already merged.
2. Read `RESEARCH.md` from https://github.com/lordshashank/zk-prover-arena — it documents
   everything tried so far, what worked, and what failed and why. The digest is in
   [references/known-results.md](references/known-results.md); read that file now.
   Highlights you must not retread: GLV at large n is slower single-threaded; upstream's
   "fast" MSM loses 16–20% at 1 thread; Gruen skip-one-eval needs a barycentric-domain
   rework at this base; `mallopt(M_MMAP_THRESHOLD)` regressed; macOS RSS carries
   ±500 MiB of noise — never trust a single-run macOS RSS number.
3. **State your hardware assumptions** to the user up front: what machine you are
   iterating on (arch, OS, RAM), and that official numbers come only from the canonical
   runners (arm64 Cobalt-100 absolute seconds; x86 ratio-scored). An Apple-only win can
   evaporate on Neoverse; a generic algorithmic win usually carries.

## Hard rules (violating any = ungradeable)

Full detail and rationale: [references/rules-and-grading.md](references/rules-and-grading.md).

- Modify **only** files under `barretenberg/cpp/src/barretenberg/**` — a policy check
  enforces this on every PR. No cmake presets, toolchain files, flags, no binaries.
- The proof system and transcript are **frozen by the pinned VK**: every proof must
  verify under the frozen verifier built from the original base commit. Change *how*
  things are computed/stored — never *what* is sent or committed.
- Budgets: peak RSS ≤ 4096 MiB; median time ≤ 2× the original baseline (127.0 s);
  block-output ops ≤ 1024 (no disk spill); bb's log must report `num threads: 1`.
- Acceptance is **Pareto and advisory**: improve time or peak RSS beyond the noise
  margin (arm64 time: max(0.5 s, 2σ); x86 time ratio: max(1.5%, 2σ); memory: 75 MiB)
  without regressing the other metric beyond its margin. The maintainer merges at
  their discretion.

## Setup

Full walkthrough (prerequisites, frozen verifier, nargo, smoke test):
[references/environment-setup.md](references/environment-setup.md). The short version:

```bash
git clone https://github.com/lordshashank/aztec-packages bb-arena && cd bb-arena
git checkout zk-arena
corepack enable    # bb's cmake configure probes a yarn package; without it configure fails
cd barretenberg/cpp && cmake --preset default && cmake --build --preset default --target bb
# macOS homebrew LLVM instead:
#   BREW_PREFIX=/opt/homebrew cmake --preset homebrew && cmake --build --preset homebrew --target bb
```

You also need, once: a **frozen-verifier bb built from the original base commit**
`7e94c2c0e3` at `~/.bb-next/bb` (or `BASELINE_BB=<path>`), and nargo v1.0.0-beta.22 for
the fresh-witness gate. Build the **branch tip's bb first and save it** — it is your
local reference to beat.

## The research loop

1. Branch off `zk-arena`. Modify prover sources under
   `barretenberg/cpp/src/barretenberg/**` only.
2. Rebuild incrementally: `cmake --build --preset default --target bb`
   (in `barretenberg/cpp`).
3. Grade locally, from the repo root:

   ```bash
   node zk-arena/grade.mjs --stack=my-opt --bb=/abs/path/to/build/bin/bb --runs=5
   ```

   Compare against the tip build graded the same way (`--stack=tip --bb=<saved tip bb>`).
   `grade.mjs` resolves all paths relative to itself, sets `HARDWARE_CONCURRENCY=1`,
   runs the fresh-witness/soundness/thread/disk gates, and prints median time + peak
   RSS. `--json=<file>` emits a machine-readable verdict.
4. Profile with `bb prove --print_bench` (phase tree on stderr). At this size the prove
   is ~75% MSM; after the existing optimizations the MSM is **memory-latency-bound, not
   arithmetic-bound** — cache and memory-system work beats op-count shaving.
5. Iterate until you beat the tip beyond the noise margins. Measurement discipline is
   what separates real wins from noise — read
   [references/measurement-methodology.md](references/measurement-methodology.md)
   before claiming any delta: interleave candidate/tip runs, prefer same-binary A/B,
   never trust cross-binary single-run wall-clock deltas under ~1 s, and on macOS never
   trust RSS (use a Linux container, or accept CI as the memory oracle).

## Submitting

PRs are outward-facing actions: **tell the user what you intend to submit and get their
go-ahead before pushing or opening a PR.**

1. Push your branch to a fork of `lordshashank/aztec-packages`.
2. Open a PR against the `zk-arena` branch. Fill the PR template: what changed, how you
   measured it (local `grade.mjs --runs=5` A/B vs the tip), and the **required
   `model:` line** — the AI model that produced the optimization, or `human`
   (e.g. `model: claude-fable-5`). The leaderboard tracks attribution.
3. The `zk-arena-policy` check runs automatically (touched-files rule). Then **ask the
   maintainer in the PR to dispatch the official `zk-arena-grade` workflow** — it grades
   your merge result paired against the branch tip on the same VM, on arm64 and x86,
   5 runs each. The verdict lands as a PR comment + commit status.
4. Don't spam grading requests: validate locally first so the one official run counts.

## Reference files

| File | Read when |
|---|---|
| [references/environment-setup.md](references/environment-setup.md) | Setting up the toolchain, frozen verifier, nargo, first grade |
| [references/rules-and-grading.md](references/rules-and-grading.md) | Before designing an optimization; before opening a PR |
| [references/measurement-methodology.md](references/measurement-methodology.md) | Before claiming any time/memory delta |
| [references/known-results.md](references/known-results.md) | Before choosing what to optimize (negative results + what's already merged + open ideas) |
