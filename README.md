# zk-prover-arena

> **⚠️ The arena has moved → [lordshashank/aztec-packages (`zk-arena` branch)](https://github.com/lordshashank/aztec-packages).**
>
> Submissions are now plain PRs against the rolling-champion branch: your PR's merge result is
> graded paired against the branch tip on both canonical architectures, the advisory Pareto
> verdict lands on the PR, and **merged PRs become the new base everyone must beat**. See the new
> [README](https://github.com/lordshashank/aztec-packages/blob/zk-arena/zk-arena/README.md) and
> [LEADERBOARD](https://github.com/lordshashank/aztec-packages/blob/zk-arena/zk-arena/LEADERBOARD.md).
>
> This repo is **archived as the grading spec and history** of the patch-based flow (tag
> `patch-flow-final`): the rationale for every gate, the boards through `opt-next3`, the full
> grader transcripts, and [RESEARCH.md](./RESEARCH.md). The new flow inherits its task, budgets,
> margins, and the frozen-verifier soundness anchor unchanged.


An open optimization arena for **ZK prover algorithm research**.

> **The challenge:** make the [barretenberg](https://github.com/AztecProtocol/aztec-packages/tree/master/barretenberg) UltraHonk prover cheaper — in time and in memory — on one frozen, hard proving task. The circuit, the witness, the proof system, and the config never change. **The only thing you may change is the prover itself.**

A deterministic automated grader turns prover research into a loop: modify the prover → rebuild → `node grade.mjs` → one objective number per board → iterate. No human judging.

**Live leaderboard: [LEADERBOARD.md](./LEADERBOARD.md)**

## Why this exists

The cost of a SNARK prover is dominated by a handful of algorithmic kernels, identical on every platform:

- **MSM** (multi-scalar multiplication) — committing to polynomials on the curve; typically the single largest share of prove time,
- **FFT/NTT** — polynomial arithmetic for sumcheck/Gemini,
- **polynomial memory** — UltraHonk holds ~40 polynomials × N field elements simultaneously (~1.4 KB per gate), which is what decides how large a circuit *fits* anywhere (it's why browsers OOM near 2^21 under the wasm32 4 GB ceiling).

Reducing those is genuine ZK research, and every win here transfers to every environment that runs this prover — native, mobile, and browser. This arena exists to measure exactly that, and nothing else: platform tricks (threads, SIMD enablement, wasm64) deliberately don't score.

## The task (pinned, never edited)

`problem/` holds one hard instance:

| | |
|---|---|
| circuit | deterministic Poseidon2-permutation chain, **1,501,674 gates → pads to 2^21** (v2, nargo beta.22) |
| witness | pinned (`problem.gz`) |
| integrity | SHA-256 of both pinned in [`problem/manifest.json`](./problem/manifest.json) |
| proof system | UltraHonk, poseidon2 oracle, ZK on (bb defaults) — **frozen by the pinned VK** |

It's application-agnostic and arithmetic-heavy — big enough that MSM/FFT/memory dominate and real prover work shows up in the numbers.

## The rules (frozen config — not tunables)

| rule | value | why |
|---|---|---|
| runtime | **native** `bb` | isolates the algorithm from platform effects (WASM codegen, SIMD availability) |
| threads | **1** (`HARDWARE_CONCURRENCY=1`, checked from bb's own log) | rewards algorithmic work, not parallelization |
| proof system | frozen by `problem/baseline_vk/vk` | a candidate must produce proofs **the pinned baseline verifier accepts** |
| SRS | bb default (auto-sized) | not a variable |

## Grading — two boards, both lower-is-better

```
time   = median wall-clock seconds of `bb prove`   (across --runs, default 3)
memory = peak resident set size (MiB) of the prove process
```

Separate boards, no forced product: a pure-memory win and a pure-speed win are both first-class results. Peak RSS is the platform-independent proxy for "how big a circuit fits" — cut it ~30% and a 2^21 circuit fits comfortably in a browser's 4 GB; cut it in half and 2^22 opens up.

### Validity gates (fail any → INVALID, unranked)

Each gate exists because it closes a concrete exploit:

1. **Fresh witness per run** (anti proof-caching) — the grader samples a random input `x`, runs `nargo execute` to build the witness and learn the expected public output, and your emitted `public_inputs` **must equal that output**. A binary that replays a cached/embedded proof can't know the fresh output; forging a proof for it without proving would mean breaking UltraHonk soundness. (Same idea as deriving test points by Fiat-Shamir: the challenge is fresh every time.)
2. **Soundness** — the **pinned baseline `bb verify`** must accept your proof against the **pinned VK**. Your binary is never trusted to judge itself.
3. **Cross-budgets** (anti axis-trading) — you cannot blow one resource to win the other board:
   - **time board** entries must keep peak RSS ≤ **4096 MiB** (the wasm32 ceiling — also keeps every time entry browser-transferable; only ~16% headroom over baseline, so no memory-for-speed blowups),
   - **memory board** entries must keep median time ≤ **2× baseline** (no "recompute everything / stream it slowly" wins).
4. **Disk gate** (anti spill) — block-output operations ≤ 1024 (baseline does **0**). Disk-backed mmap hides from RSS — without this, bb's existing `--slow_low_memory` flag would "win" the memory board with zero research.
5. **Single-thread** — bb's log must report `num threads: 1`.
6. **Complete** — `prove` exits 0 and emits `proof` + `public_inputs`.

Time–memory tradeoffs are *real research* (bigger MSM windows, precomputed tables, recompute-vs-store) — the budgets don't forbid them, they bound them: a tradeoff must keep the other axis within its budget to rank. A genuine total-resource reduction ranks on both boards.

### Trust model & residual notes

- **Where the trust sits:** the canonical boards are produced by the [`official-grade` CI workflow](./.github/workflows/official-grade.yml) on GitHub-hosted runners — the arm64 board on `ubuntu-24.04-arm` (Azure Cobalt 100, one homogeneous fleet) and the x86 board on `ubuntu-latest` (ratio-scored against a same-VM baseline) — free, publicly reproducible environments anyone can fork. The grading scripts always run from `main` (a PR's submission directory is fetched as data only), and every result records its machine fingerprint. The fresh challenge `x` comes from the grader's CSPRNG at grade time — fine under that trust model, since prove time barely depends on `x`. If fully trustless challenges are ever wanted, the mechanical upgrade is to derive `x = H(submission binary ‖ date)` Fiat-Shamir-style, so anyone can re-derive the exact challenge from the submission itself.
- **Legitimate preprocessing:** baking **witness-independent** data (circuit structure, proving-key layout) into your binary is fair game — that's standard SNARK preprocessing, it's bounded (~5% of baseline prove time), and it cannot touch the witness-dependent bulk the arena measures (wire polynomials, z_perm, sumcheck, the MSMs). Caching anything **witness-dependent** is exactly what the fresh-witness gate kills.

> Scope note: this freezes the *proof system*, so the arena measures **implementation-level** algorithmic work (MSM, FFT, memory layout, allocation strategy, field arithmetic). Protocol-level changes (different proof system / proof format) can't be machine-checked for soundness by a fixed verifier and are out of scope for the boards — open an issue if you have one; they're interesting, just not auto-gradeable.

## Quickstart

Prereqs: Node 20+, the baseline `bb` built from aztec-packages branch `next` @ `7e94c2c0e3` (build `barretenberg/cpp` target `bb` exactly as in step 1–2 of the research loop below, from the *unpatched* base, and place it at `~/.bb-next/bb` — or set `BASELINE_BB=/path/to/bb`), and `nargo` v1.0.0-beta.22 (via [noirup](https://noir-lang.org/docs/getting_started/installation/); or set `NARGO_BIN`) for the fresh-witness gate. macOS or Linux (`/usr/bin/time` is used for peak RSS). Without nargo the grader falls back to the pinned witness and marks the row `pinned-witness` (not eligible for the canonical boards).

Local grading is the research loop; it is **advisory**. Official scores are produced only by the `official-grade` CI workflow on the two canonical environments (arm64 + x86 — see the FAQ) — `ci/setup.sh` is the exact recipe for those environments if you want to reproduce one.

```bash
# grade the reference prover (also generates the pinned VK on first run)
node grade.mjs --stack=baseline

# grade your modified prover
node grade.mjs --stack=my-msm-fix --bb=/abs/path/to/your/build/bin/bb

# ranked boards in the terminal / refresh LEADERBOARD.md
node board.mjs
node board.mjs --md
```

## How to optimize (the research loop)

1. **Get the barretenberg source at the pinned base** (aztec-packages `next` @ `7e94c2c0e3` — the task tracks upstream so optimizations can be merged directly; your patch must eventually diff against *exactly* this commit; task v1, pinned to `v3.0.0-nightly.20260102`, is archived in `boards/archive-v1/`). No fork of aztec-packages is needed — you only ever submit a patch file:
   ```bash
   git clone https://github.com/AztecProtocol/aztec-packages
   cd aztec-packages
   git checkout -b my-opt 7e94c2c0e32820e25e20d39a426d546dae56a34f
   cd barretenberg/cpp
   ```
2. **Build the native prover** (clang 20 recommended — it's what the canonical runners use — plus cmake, ninja, and corepack; no WASM toolchain required):
   ```bash
   corepack enable    # bb's cmake configure probes a small yarn package (nodejs_module) — without this, configure fails with a node-api-headers error
   cmake --preset default && cmake --build --preset default --target bb
   # binary at build/bin/bb
   # macOS with homebrew LLVM instead: BREW_PREFIX=/opt/homebrew cmake --preset homebrew && cmake --build --preset homebrew --target bb
   ```
3. **Change the prover.** Where the cost lives (file paths relative to `barretenberg/cpp/src/barretenberg/`):
   - `ecc/scalar_multiplication/` — Pippenger MSM (bucket method, window sizes, endomorphism splitting, batch affine addition)
   - `polynomials/` + `common/` — polynomial storage, `BackingMemory`, allocation strategy (this is where peak RSS comes from)
   - `numeric/` + `ecc/fields/` — field arithmetic (Montgomery mult is the innermost loop of everything)
   - `commitment_schemes/` — Gemini fold / Shplonk batching (scratch polynomials)
   - `sumcheck/` — round univariates, partial evaluation memory reuse
   - `flavor/ultra_flavor.hpp` — the ~40-polynomial set itself (careful: changing *what* is committed changes the VK → fails the soundness gate; changing *how* it's computed/stored is fair game)
4. **Grade it:** `node grade.mjs --stack=<name> --bb=<path> --runs=5` (in this repo) — the gates guarantee your speedup didn't break correctness, and the 5-run median/σ are what you'll put in your submission's claims.
5. **Iterate.** The frozen task means any delta on either board is attributable entirely to your change.

Ideas with real headroom (none of these are done in the baseline): batch-affine MSM tuning for this exact size, in-place/streamed Gemini folds, freeing precomputed polynomials after commitment, arena-allocating the proving key, NTT cache-blocking, lazy reduction in field ops.

## Submitting to the leaderboard

Promotion is **bot-operated with a monotone audit trail** (the ecdsa.fail/Yukon model, adapted for a noisy wall-clock metric), and **official grading runs in CI on two canonical environments** — arm64 (`ubuntu-24.04-arm`) and x86 (`ubuntu-latest`) — never on anyone's laptop. Format details: [`submissions/SPEC.md`](./submissions/SPEC.md). Agent-operable walkthrough of the whole loop: [`SKILL.md`](./SKILL.md).

0. **Before the PR, package and self-validate locally** (full walkthrough: [`SKILL.md`](./SKILL.md)):
   ```bash
   mkdir -p submissions/incoming/my-opt
   git -C /path/to/aztec-packages diff 7e94c2c0e32820e25e20d39a426d546dae56a34f my-opt \
     -- barretenberg/cpp/src > submissions/incoming/my-opt/changes.patch
   # write submissions/incoming/my-opt/submission.json (claims = your local grade.mjs --runs=5 numbers)
   BB_REPO=/path/to/aztec-packages node intake.mjs submissions/incoming/my-opt
   ```
   Intake passing locally means your PR won't bounce on schema/path-policy/apply errors.
1. **Fork *this* repo and open a PR** adding `submissions/incoming/<name>/` containing:
   - `submission.json` — `{name, author, model, notes, claimedTimeS, claimedPeakMiB, patch}`. **`model` is required**: the AI model that produced the optimization, or `"human"` — attribution is part of the public record.
   - `changes.patch` — a git diff against the pinned base (aztec-packages `next` @ `7e94c2c0e3`), touching only `barretenberg/cpp/src/barretenberg/**` (no cmake presets/toolchains/flags, no binaries — source-only).
2. **Intake runs automatically on your PR** ([`submission-intake` workflow](./.github/workflows/submission-intake.yml); also runnable locally as `node intake.mjs <dir>`): schema, path policy, clean `git apply --check` against the pinned base, and the **claimed-score pre-filter** — claims worse than the *baseline* on both axes are rejected before any compute is spent (claims are your local numbers, so they're compared against the baseline, not the CI bests). Claims are advisory; lying doesn't help, officials are re-measured. Intake never builds or executes your patch.
3. **A maintainer reviews the patch and dispatches the [`official-grade` workflow](./.github/workflows/official-grade.yml)** for your PR. It grades on **both canonical environments in parallel** — arm64 (`ubuntu-24.04-arm`, Cobalt 100, absolute seconds) and x86 (`ubuntu-latest`, Aztec's perf ISA, scored as a ratio to a baseline graded on the same VM) — each via `promote.mjs --grade-only`: build from source (standard preset, pinned toolchain), `grade.mjs --runs=5` under all validity gates. Then `ci/decide.mjs` applies the **noise-margin acceptance rule**: accepted iff you win *any* board beyond its margin — arm64 time by **> max(0.5 s, 2·σ)**, x86 time ratio by **> max(1.5%, 2·σ)**, or either board's peak RSS by **> 75 MiB**. Wall-clock is noisy; epsilon "wins" don't promote.
4. **On accept, the bot commits everything in one go and CI pushes it to `main`**: your submission dir, boards rows, the full grader transcript (`submissions/transcripts/`), an append-only `submissions/log.jsonl` entry (claims vs officials, σ, model, base commit, machine), a regenerated `LEADERBOARD.md` — with `Co-authored-by: <author>`. The verdict is posted back on your PR either way; on reject/failure the canonical boards are untouched.

The boards only ever gain rows; history is never rewritten. The baseline is periodically re-graded (`official-grade` workflow, `mode=regrade-champion`) and a >10% drift from its trailing median flags the environment before further promotions. The grader's verdict is final — if the pinned baseline verifier rejects your proof, the submission is invalid regardless of its numbers.

## Repo layout

```
problem/         the pinned task: circuit, witness, manifest (SHA-256), pinned VK,
                 and source/ (the Noir package the grader uses for fresh witnesses)
grade.mjs        the grader: candidate proves (timed/measured), baseline verifies
board.mjs        ranked boards; --md refreshes LEADERBOARD.md
intake.mjs       submission validation (schema, path policy, apply-check, claimed-score pre-filter)
promote.mjs      promotion pipeline: build -> grade -> noise-margin acceptance -> bot commit
ci/              provisioning + grading scripts for the canonical runner
.github/         submission-intake (advisory, on PRs) and official-grade (authoritative,
                 maintainer-dispatched) workflows
boards/          append-only result logs (time.tsv, memory.tsv; x86/ ratio boards;
                 archived eras under archive-*/)
stacks/          registry of graded provers
submissions/     SPEC.md, incoming/ submission dirs, append-only log.jsonl,
                 grader transcripts of accepted entries
SKILL.md         agent-operable walkthrough of the full optimize->submit loop
tracks/platform/ parked WASM/browser track (time x memory product under the 4 GB
                 wasm32 ceiling) — platform engineering, kept separate by design
LEADERBOARD.md   the live leaderboard
```

## FAQ

**Why not grade in WASM if browsers are the motivation?** WASM wall-clock entangles the prover with the platform (codegen quality, SIMD, threading policy). The algorithm track measures the thing that transfers; the parked platform track exists for the rest. A memory win measured here directly lowers the WASM peak too — same allocations.

**Why single-threaded?** Parallel speedup is real but it's a different (and mostly solved) axis. Holding threads at 1 makes the time board reflect algorithmic cost, not core count.

**Can I tune compiler flags?** Flag/toolchain changes affect codegen, not the algorithm — they're disallowed on the algorithm boards (use the standard preset). If there's interest, a separate "anything goes" board can track them.

**What hardware are official numbers measured on?** Two GitHub-hosted environments, both free for public repos and reproducible by forking; **every leaderboard row states its machine**. (1) **arm64** (`ubuntu-24.04-arm`): Azure Cobalt 100, a single homogeneous fleet — absolute seconds are comparable across runs (measured cross-VM drift ~0.1%). (2) **x86** (`ubuntu-latest`): the ISA Aztec's own perf work targets (`-march=skylake`, their x64 asm active — mirroring their EC2 EPYC fleet), but GitHub's x86 VMs mix EPYC/Xeon models, so time is scored as a **ratio to a baseline graded in the same job on the same VM**, which cancels the lottery. clang-20 + the standard preset are pinned by `ci/setup.sh` on both. Architecture-specific optimizations are legitimate research on either arch. The baseline is re-graded periodically — if a fleet's calibration moves >10%, promotions pause until bests are re-examined.
