# zk-prover-arena

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
| circuit | deterministic Poseidon2-permutation chain, **1,501,711 gates → pads to 2^21** |
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

- **Where the trust sits:** the canonical boards are produced by the maintainer's grader (like a fixed reference evaluator). The fresh challenge `x` comes from the grader's CSPRNG at grade time — fine under that trust model, since prove time barely depends on `x`. If fully trustless challenges are ever wanted, the mechanical upgrade is to derive `x = H(submission binary ‖ date)` Fiat-Shamir-style, so anyone can re-derive the exact challenge from the submission itself.
- **Legitimate preprocessing:** baking **witness-independent** data (circuit structure, proving-key layout) into your binary is fair game — that's standard SNARK preprocessing, it's bounded (~5% of baseline prove time), and it cannot touch the witness-dependent bulk the arena measures (wire polynomials, z_perm, sumcheck, the MSMs). Caching anything **witness-dependent** is exactly what the fresh-witness gate kills.

> Scope note: this freezes the *proof system*, so the arena measures **implementation-level** algorithmic work (MSM, FFT, memory layout, allocation strategy, field arithmetic). Protocol-level changes (different proof system / proof format) can't be machine-checked for soundness by a fixed verifier and are out of scope for the boards — open an issue if you have one; they're interesting, just not auto-gradeable.

## Quickstart

Prereqs: Node 20+, the baseline `bb` v3.0.0-nightly.20260102 (install via [bbup](https://github.com/AztecProtocol/aztec-packages/tree/master/barretenberg/bbup); or set `BASELINE_BB=/path/to/bb`), and `nargo` v1.0.0-beta.18 (via [noirup](https://noir-lang.org/docs/getting_started/installation/); or set `NARGO_BIN`) for the fresh-witness gate. macOS or Linux (`/usr/bin/time` is used for peak RSS). Without nargo the grader falls back to the pinned witness and marks the row `pinned-witness` (not eligible for the canonical boards).

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

1. **Get the barretenberg source** (the baseline is `v3.0.0-nightly` / aztec-packages around `d30992f`):
   ```bash
   git clone https://github.com/AztecProtocol/aztec-packages
   cd aztec-packages/barretenberg/cpp
   ```
2. **Build the native prover** (needs clang 16+, cmake, ninja — no WASM toolchain required):
   ```bash
   cmake --preset clang16 && cmake --build --preset clang16 --target bb
   # binary at build/bin/bb
   ```
3. **Change the prover.** Where the cost lives (file paths relative to `barretenberg/cpp/src/barretenberg/`):
   - `ecc/scalar_multiplication/` — Pippenger MSM (bucket method, window sizes, endomorphism splitting, batch affine addition)
   - `polynomials/` + `common/` — polynomial storage, `BackingMemory`, allocation strategy (this is where peak RSS comes from)
   - `numeric/` + `ecc/fields/` — field arithmetic (Montgomery mult is the innermost loop of everything)
   - `commitment_schemes/` — Gemini fold / Shplonk batching (scratch polynomials)
   - `sumcheck/` — round univariates, partial evaluation memory reuse
   - `flavor/ultra_flavor.hpp` — the ~40-polynomial set itself (careful: changing *what* is committed changes the VK → fails the soundness gate; changing *how* it's computed/stored is fair game)
4. **Grade it:** `node grade.mjs --stack=<name> --bb=<path>` — the gate guarantees your speedup didn't break correctness.
5. **Iterate.** The frozen task means any delta on either board is attributable entirely to your change.

Ideas with real headroom (none of these are done in the baseline): batch-affine MSM tuning for this exact size, in-place/streamed Gemini folds, freeing precomputed polynomials after commitment, arena-allocating the proving key, NTT cache-blocking, lazy reduction in field ops.

## Submitting to the leaderboard

Open a PR that adds your entry to `stacks/registry.json` with:
- a **diff/patch** (or branch link) against the baseline barretenberg source — submissions must be reproducible from source, binaries alone aren't accepted,
- build instructions if they differ from the standard preset,
- your local numbers (`node grade.mjs` output) as a sanity reference.

The maintainer regrades every submission on the canonical machine (numbers are only comparable on the same hardware) and refreshes `LEADERBOARD.md`. The grader's verdict is final — if the baseline verifier rejects your proof, the submission is invalid regardless of its numbers.

## Repo layout

```
problem/         the pinned task: circuit, witness, manifest (SHA-256), pinned VK,
                 and source/ (the Noir package the grader uses for fresh witnesses)
grade.mjs        the grader: candidate proves (timed/measured), baseline verifies
board.mjs        ranked boards; --md refreshes LEADERBOARD.md
boards/          append-only result logs (time.tsv, memory.tsv)
stacks/          registry of graded provers
tracks/platform/ parked WASM/browser track (time x memory product under the 4 GB
                 wasm32 ceiling) — platform engineering, kept separate by design
LEADERBOARD.md   the live leaderboard
```

## FAQ

**Why not grade in WASM if browsers are the motivation?** WASM wall-clock entangles the prover with the platform (codegen quality, SIMD, threading policy). The algorithm track measures the thing that transfers; the parked platform track exists for the rest. A memory win measured here directly lowers the WASM peak too — same allocations.

**Why single-threaded?** Parallel speedup is real but it's a different (and mostly solved) axis. Holding threads at 1 makes the time board reflect algorithmic cost, not core count.

**Can I tune compiler flags?** Flag/toolchain changes affect codegen, not the algorithm — they're disallowed on the algorithm boards (use the standard preset). If there's interest, a separate "anything goes" board can track them.
