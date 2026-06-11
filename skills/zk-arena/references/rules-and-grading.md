# Rules, validity gates, and the grading pipeline

The authoritative sources are `zk-arena/README.md`, `zk-arena/problem/manifest.json`,
`zk-arena/grade.mjs` and `zk-arena/decide.mjs` on the branch — read them if anything
here seems stale. This file explains each rule and *why* it exists, because the gates
are anti-gaming devices: understanding the exploit each one closes tells you where the
boundary of "fair game" is.

## The frozen task

| | |
|---|---|
| circuit | deterministic Poseidon2-permutation chain, 1,501,711 gates, pads to 2^21 (`zk-arena/problem/`) |
| witness | fresh per graded run — random input via pinned nargo; kills cached/replayed proofs |
| proof system | UltraHonk, poseidon2 oracle, ZK on (bb defaults), **frozen by the pinned VK** (`problem/baseline_vk/vk`) |
| config | native `bb`, 1 thread (`HARDWARE_CONCURRENCY=1`), standard cmake preset |
| soundness anchor | the frozen verifier built from original base `7e94c2c0e3` must accept every candidate proof — forever, no matter how far the branch rolls forward |

Single-threaded because the arena rewards algorithmic work, not core count. Native
because it isolates the algorithm from platform effects (WASM codegen, SIMD
availability).

## What you may change

**Only files under `barretenberg/cpp/src/barretenberg/**`.** The `zk-arena-policy`
check enforces this on every PR (computed from trusted refs, not PR-controlled
context). Everything else — grader scripts, workflows, problem assets, cmake presets,
toolchain files, compiler flags — is maintainer-owned. No binaries in the diff;
generate any data at build time from source.

**Prover-internal changes only.** The pinned VK freezes the transcript: you may change
*how* values are computed, stored, scheduled, and allocated, but never *what* is
committed or sent. If your "optimization" changes the proof bytes' meaning, the frozen
verifier rejects it and the run is invalid. Witness-dependent caching is dead on
arrival (fresh witness per run); witness-independent precomputation is fair game if it
fits the budgets.

## Validity gates (every graded run, all must pass)

1. **Fresh witness** — a random input is sampled, `nargo execute` computes the expected
   public output, and your emitted `public_inputs` must match it. A binary replaying a
   cached proof cannot know the fresh output.
2. **Soundness** — the frozen baseline `bb verify` must accept your proof against the
   pinned VK. The candidate never judges itself.
3. **Hard budgets** — peak RSS ≤ 4096 MiB (the wasm32 ceiling — keeps time entries
   browser-transferable) and median time ≤ 2× the original canonical baseline
   (127.0 s = 2 × 63.67 s). Cross-budgets stop trading one resource for rank on the
   other board.
4. **Disk gate** — block-output ops ≤ 1024. Closes the mmap/spill loophole:
   file-backed pages hide from RSS, so unbounded spilling would "win" the memory
   board for free.
5. **Single thread + complete** — bb's own log must report `num threads: 1`; prove
   must exit 0 and emit proof + public_inputs.

## Official grading and the verdict

The `zk-arena-grade` workflow (maintainer-dispatched per PR) grades **your PR's merge
result against the current branch tip, paired on the same VM**, on two architectures in
parallel: arm64 Cobalt-100 (homogeneous fleet → absolute seconds) and x86 (mixed
EPYC/Xeon fleet → time *ratio* to the paired base, which cancels the hardware lottery).
Five runs each, median + σ.

`decide.mjs` combines both architectures into an advisory verdict. Noise margins:

- arm64 time: improvement > max(0.5 s, 2σ) (σ combined across base and candidate runs)
- x86 time ratio: below 1 by > max(1.5%, 2σ_ratio)
- memory: > 75 MiB, on either architecture

Verdict semantics (Pareto, because the lineage is a single branch — otherwise
time-optimizers would trade away memory and vice versa):

- `accept` — improves at least one metric beyond its margin, regresses none beyond margin
- `tradeoff` — improves one, regresses the other beyond margin; maintainer judgement
- `reject` — nothing improved beyond noise
- `invalid` — a gate or hard budget failed

The verdict is **advisory; merging is the maintainer's decision.** On merge, your code
becomes the new base, and `zk-arena-record` appends your row to `LEADERBOARD.md` and
`log.jsonl`.

## The PR

Template (`.github/PULL_REQUEST_TEMPLATE.md` on the branch) has three sections — keep
them short, the grading does the judging:

- **What this changes** — one paragraph: which kernel(s) (MSM / field arithmetic /
  sumcheck / polynomial memory / allocation strategy / ...) and why it should be
  faster or leaner.
- **How you measured it** — local A/B numbers (`node zk-arena/grade.mjs --runs=5`
  against a build of the zk-arena tip), machine, methodology notes.
- **Attribution** — a `model:` line is **required**: the AI model(s) that produced the
  optimization, or `human` (examples from the template: `claude-fable-5`,
  `gpt-5-codex`, `human`, `human+claude-fable-5`). It lands on the public leaderboard.

Flow: push your branch to a fork of `lordshashank/aztec-packages` → open the PR against
`zk-arena` → `zk-arena-policy` runs automatically → ask the maintainer in the PR to
dispatch `zk-arena-grade` → verdict arrives as a comment + commit status. One
optimization theme per PR where practical — it keeps the audit log legible. Validate
locally before asking for a dispatch; official runner time is the scarce resource, and
a string of rejected gradings burns goodwill.

## Ground rules that survive even a passing check

- No witness-dependent caching (the fresh-witness gate kills it anyway).
- No build-time network fetches or other supply-chain tricks — patches are
  human-reviewed before grading is dispatched.
- Don't inflate claimed numbers; officials are re-measured anyway.
