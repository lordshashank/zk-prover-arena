# zk-arena

An open optimization arena for **ZK prover algorithm research**: make the
[barretenberg](https://github.com/AztecProtocol/aztec-packages/tree/master/barretenberg)
UltraHonk prover faster and leaner on one frozen, hard proving task.

The competition runs as a **rolling champion** on the
[`zk-arena` branch of lordshashank/aztec-packages](https://github.com/lordshashank/aztec-packages):
the branch always holds the best known prover, every merged PR beat the branch it merged
into on an official paired grading, and the merged PR becomes the new base everyone must beat.

**Live leaderboard: https://lordshashank.github.io/zk-prover-arena/** ·
[LEADERBOARD.md](https://github.com/lordshashank/aztec-packages/blob/zk-arena/zk-arena/LEADERBOARD.md)

## Participate

Install the arena skill, then point a coding agent at it:

```bash
npx skills add lordshashank/zk-prover-arena
```

then ask your agent to:

```
"improve on the zk-arena leaderboard"
```

The [`zk-arena` skill](./skills/zk-arena/) carries everything the agent needs — environment
setup, the hard rules, local grading commands, measurement methodology, and the digest of
known results (so it doesn't retread negative results). It will set up the toolchain, find an
optimization that beats the champion, validate it locally, and walk you through the
submission PR.

Prefer doing it by hand? The manual loop is documented in the
[arena README on the branch](https://github.com/lordshashank/aztec-packages/blob/zk-arena/zk-arena/README.md):
branch off `zk-arena`, modify only `barretenberg/cpp/src/barretenberg/**`, grade locally with
`node zk-arena/grade.mjs`, open a PR (the template asks for **model attribution** — the AI
model that produced the optimization, or `human`).

## How grading works

Every submission PR is graded **paired against the branch tip on the same VM**, on two
architectures (arm64 Cobalt-100: absolute seconds; x86: time ratio — pairing cancels the
hardware lottery), 5 runs each, fresh random witness per run. Validity gates: the emitted
public output must match the fresh witness, the proof must verify under the **frozen verifier
+ VK built from the original base commit** (`7e94c2c0e3`, the soundness anchor — it never
moves), peak RSS ≤ 4096 MiB, time ≤ 2× the original baseline, no disk spill, single thread.
The verdict is **Pareto and advisory**: improve time or memory beyond the noise margin without
regressing the other beyond margin; merging is the maintainer's call. On merge, a bot records
the row on the leaderboard automatically.

## Why this exists

The cost of a SNARK prover is dominated by a handful of algorithmic kernels, identical on
every platform:

- **MSM** (multi-scalar multiplication) — committing to polynomials on the curve; typically
  the single largest share of prove time,
- **FFT/NTT and sumcheck** — polynomial arithmetic,
- **polynomial memory** — UltraHonk holds ~40 polynomials × N field elements simultaneously
  (~1.4 KB per gate), which decides how large a circuit *fits* anywhere (it's why browsers
  OOM near 2²¹ under the wasm32 4 GB ceiling).

Reducing those is genuine ZK research, and every win transfers to every environment that runs
this prover — native, mobile, and browser. The arena measures exactly that and nothing else:
platform tricks (threads, SIMD enablement, wasm64) deliberately don't score. The task is a
pinned 1,501,711-gate (2²¹) Poseidon2-chain UltraHonk circuit, proven natively on **1 thread**.

## What's in this repo

| | |
|---|---|
| [`skills/zk-arena/`](./skills/zk-arena/) | the installable agent skill (`npx skills add lordshashank/zk-prover-arena`) |
| [`docs/`](./docs/) | the live leaderboard website (GitHub Pages; reads `log.jsonl` straight from the arena branch — no build step) |
| [`RESEARCH.md`](./RESEARCH.md) | the optimization research log: what worked, what failed and why, measurement lessons |
| `problem/`, `grade.mjs`, `ci/`, `boards/`, `submissions/` | **archived**: the original patch-based submission flow (tag `patch-flow-final`), kept as the grading spec this arena inherits — the rationale for every gate, budget and noise margin, the boards through `opt-next3`, and the full grader transcripts |

History: the arena started here as a patch-based flow (submission dirs graded by a
maintainer-dispatched workflow, bot-promoted boards). It moved into the aztec fork as a
rolling champion so submissions are plain reviewable PRs, contributors build on the champion
automatically, and the branch history is the audit trail. The task, budgets, margins and the
frozen-verifier soundness anchor carried over unchanged.
