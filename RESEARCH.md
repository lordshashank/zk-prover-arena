# Prover optimization research log

What was tried to speed up the barretenberg UltraHonk prover on the frozen 2^21 task, what worked, what didn't, and why. All numbers are single-threaded (`HARDWARE_CONCURRENCY=1`) on Apple M-series (arm64, macOS), graded by `grade.mjs` unless noted. Every accepted change is gated on the pinned baseline verifier accepting the proof — the transcript and proof format are frozen, so only *how* the prover computes is fair game, never *what* it sends.

The work happened in two phases: against the task-v1 baseline (`bb v3.0.0-nightly.20260102`, 30.85 s / 3453 MiB) and, after the arena retargeted to upstream `next` @ `7e94c2c0e3` (task v2, 28.38 s / 2611 MiB), a rebase that kept what upstream didn't already have. Champion as of writing: **22.29 s official (−21.5% vs v2 baseline)** via the submission pipeline ([PR #2](https://github.com/lordshashank/aztec-packages/pull/2)).

## Where the time goes

Profiling (bb's built-in `--print_bench`) showed the prove is **~80% multi-scalar multiplication (MSM)** at this size: wire commitments, z_perm, the ZK masking commitment, Gemini fold commitments, the Shplonk batched quotient, and the KZG opening quotient. Sumcheck is only ~10%, proving-key construction ~5%. Every optimization below is downstream of that fact: either make field multiplications cheaper (they dominate MSM), make MSMs smaller (fewer/sparser points), or stop wasting memory passes.

---

## 1. Sparse structured Gemini masking polynomial (v1 only; upstream independently removed it)

**Problem.** ZK-UltraHonk masked the Gemini batched polynomial with a *fully dense* random polynomial of size n = 2^21. That cost a full n-point MSM to commit (~3.4 s), ~0.6 s of random generation, and — worse — it densified the batched polynomial A₀, so every Gemini fold, the Shplonk quotient and the KZG quotient became dense too (another ~3 s).

**Idea.** The prover chooses its own masking randomness. The Gemini/Shplemini opening transcript reveals exactly **22 nontrivial scalar functionals** of A₀: its univariate evaluations at r and −r, and the 20 fold evaluations at −r^(2^l). (A 23rd value, the masking MLE evaluation, is *structurally dependent* — the fold recursion reconstructs it, and that combination equals the already-public batched sumcheck evaluation. This holds for any masking polynomial, so 22 is the maximum masking dimension achievable, dense or not.) A masking polynomial is therefore exactly as good as dense iff the linear map from its random coefficients to those 22 functionals is surjective.

**Construction.** Random coefficients in dyadic blocks: positions {0..7} ∪ {2^l .. 2^l+3} for l = 3..20 — 80 coefficients. Folding halves coefficient positions, so each fold round retains at least two fresh independent random coefficients all the way down. A numerical rank check (random challenges, 127-bit prime field) confirms **rank 22/22 — full**. The control experiment matters: a *contiguous* block of 512 low-position random coefficients collapses to a single coefficient after 9 folds and achieves only rank 10/23 — a naive sparse design would genuinely leak witness information. The dyadic structure is what makes sparsity safe.

**Result (v1).** Commit cost drops from ~2.1M points to ~80 points; the batched polynomial keeps its natural ~1.5M support so folds/quotients sparsify too. Graded: **30.85 → 27.94 s (−9.4%), 3453 → 3067 MiB (−11.2%)** — both boards improved from one change.

**Epilogue.** Upstream `next` removed the dense masking polynomial entirely (different transcript), so this became obsolete in task v2 — independent confirmation the dense polynomial was overkill, though the arena variant had to preserve the frozen transcript and therefore solved a harder version of the problem.

## 2. arm64 hand-scheduled Montgomery multiplication (the single biggest portable win)

**Problem.** barretenberg has hand-written x86-64 assembly for field arithmetic but runs generic `__int128` C++ on arm64. Microbenchmarks: 8.2–8.5 ns/mul throughput, ~13 ns latency — about 3.5× off the multiply-issue bound of the core. The gap is carry-chain handling: clang's `__int128` codegen serializes through the single arm64 flags register.

**Fix.** A new `field_impl_arm64.hpp`: no-carry CIOS Montgomery multiplication (valid because BN254's top modulus limb < 2^62) with **two-pass carry scheduling** (EdMSM §6 / gnark style) — the low-product and high-product `adcs` chains each propagate uninterrupted, using arm64's ~28 GPRs to hold the intermediate row. 64 mul-class instructions per multiply, 52 per square (the squaring's doubling uses flag-free `extr`/`lsl` because flag-op issue, ~2.8/cycle, turned out to be the real bottleneck, not the multipliers).

Two integration gotchas that cost real debugging time: (a) the build defines `-DDISABLE_ASM=1` on *every* arm64 build (it means "x64 asm unavailable") — the arm64 gate must ignore it; (b) without a `__builtin_constant_p` guard, compile-time constants like `fr(1)` become opaque runtime asm calls and *regress* latency.

**Correctness.** Bit-for-bit identical to the generic path for **all** inputs including out-of-contract ones — 10M random pairs per field, 441 edge-value combinations, algebraic identities, for both fr and fq. (Field elements live in coarse [0, 2p) representation; downstream code may depend on the exact representative, so "same canonical value" is not enough.)

**Result.** 1.40–1.42× field-mul throughput (8.3 → 5.9 ns); prover −13.5% cycles; **~26.8 → ~23.4 s** wall in v1 measurements, −11.3% in the v2 A/B. Memory unchanged. The prover gain is smaller than the microbench gain because much of the prover is memory-bound.

## 3. Single-threaded MSM routing (a negative result turned into a patch)

**Finding.** Upstream's rewritten "fast" round-parallel Pippenger (Booth signed digits, dedup stripping, batch-affine buckets) is **16–20% slower than the legacy Pippenger when single-threaded** on Apple arm64 at n ≥ 2^16 (isolated 2^21 MSM: 3.11 s legacy vs 3.63 s fast; multithreaded the fast path wins as designed). Its gains come from round-parallelism, which a single-thread constraint removes; what remains is schedule/scatter constant-factor overhead.

Also confirmed in the same harness: **GLV endomorphism decomposition at large n is +35% slower** — upstream's n < 2^16 cap is correct on this hardware (memory throughput, not arithmetic, is the limit). The Pippenger cost model explains why GLV disappoints here: halving scalar bits while doubling points leaves the dominant `rounds × n` addition term unchanged; only the small bucket term shrinks.

**Fix.** Dispatch: legacy Pippenger when `get_num_cpus() ≤ 1`, fast path otherwise; `BB_MSM_FAST=1` / `BB_MSM_LEGACY=1` overrides. In the v2 A/B this was worth **−10.5%** on top of the asm (25.36 → 22.70 s) because `next` had switched single-thread proves onto the fast path.

## 4. Fused Shplonk quotient accumulation

**Problem.** `compute_batched_quotient` processed each of ~25 opening claims as: copy the claim polynomial into a full-size temporary (64 MiB), divide in place by (X − x) (`factor_roots`), then `add_scaled` into Q — three memory passes per claim plus a large allocation.

**Fix.** The quotient coefficients satisfy q_i = f_{i+1} + x·q_{i+1} and **do not depend on f₀** (the evaluation shift only affects the discarded remainder), so synthetic division fuses with the ν-scaled accumulation into Q in a single top-down pass per claim, reading the claim polynomial once and never copying it. Field arithmetic is exact, so the result is identical — same field values, same commitment, same transcript. The Gemini A₀ buffer is also released as soon as the folds are computed.

**Result.** Time-neutral to slightly positive; **−70 MB** peak footprint; one less 64 MiB allocation. Architecture-independent — the most "obviously upstreamable" change of the set.

## 5. PK-phase memory: consume the builder, stage the allocations

**Problem.** At "Proving key computed" the process already sat at ~2.8 GiB: the circuit builder (~1.25 GiB — variables 256 MiB, copy-constraint indices ~96 MiB, block wire indices 40 MiB, block selectors ~340 MiB, plus lookup/memory bookkeeping) coexisted with ~1.2 GiB of freshly allocated prover polynomials. macOS RSS checkpoints were misleading during diagnosis (`MADV_FREE` pages stay resident until kernel pressure); `phys_footprint` instrumentation gave the deterministic picture.

**Fix.** Two parts: (a) an opt-in consume path that releases each builder block's wire indices and selectors immediately after they are transferred into polynomials, then the variables and permutation/lookup data as soon as their consumers finish; (b) **staged allocation** — only wires+selectors are needed during trace population, so σ/id/z_perm/table/lagrange polynomials are allocated *after* the builder is consumed. The builder and the full polynomial set never coexist. Ultra flavors only (Mega needs databus/ecc-op data and is force-disabled). `write_vk` output stays byte-identical.

**Result.** PK-phase live footprint **2820 → 2380 MiB**; post-PK floor **−640 MiB**; PK construction ~20% *faster* (1.05 s → 0.87 s — freeing is cheaper than keeping caches polluted); **−348 MB** end-to-end in the v2 A/B.

## 6. Things that failed or didn't pay

- **Wholesale backport of the upstream fast MSM to v1** — worked and verified, but slower single-threaded (see §3). The port survives as the dispatch patch plus a correctness harness.
- **Signed Booth digits + dedup bolted onto the legacy MSM** (agent-built): the implementation verified but introduced thread-pool round-trips that stall catastrophically at 1 thread (38 s CPU + ~180 s stalls). Reverted. The underlying idea remains sound — the legacy window-size model assumes Jacobian bucket costs (×5) that batch-affine buckets don't have, and signed s=17 windows price out ~13% fewer point additions — but it needs a clean single-thread implementation.
- **BGMW/Yao fixed-base precomputation** — priced out analytically: precompute cannot reduce Pippenger's dominant `n·b/s` addition term, only bucket/doubling overhead (~7%), and the table either blows the 4 GiB time-board RSS budget or saves nothing.
- **NEON/SIMD field mul, Karatsuba, FP64-FMA limbs** — ruled out by literature + ISA reality (no 64×64→128 vector multiply on NEON; Apple's scalar multiply CPI beats Karatsuba crossover; FMA-limb tricks are WASM/GPU-shaped).
- **Measurement lesson:** graded peak RSS on macOS carries ±500 MiB of ambient noise (page cache, compressed-memory state, `MADV_FREE`). Single-run RSS comparisons produced two false alarms in this work. Decisions should use deterministic footprint instrumentation; board-level claims need interleaved multi-run grading — which is why the submission pipeline grades 5 runs and accepts only beyond a 2σ noise margin.

## 7. Researched but not yet implemented

From the sumcheck/PCS literature survey (all transcript-compatible): Gruen's skip-one-evaluation via the round-sum constraint (~8–12% of sumcheck; Jolt ships it), Dao–Thaler evaluation-at-infinity (+5–10%), Blendy-style late materialization of the sumcheck partial-evaluation table (−0.5–0.7 GiB for ~1–2 s — attractive for the memory board with its 2× time budget), σ/id stored as u32 indices with lazy field materialization (~−350 MiB), gate-separator table split (−64 MiB). From the MSM side: a clean signed-digit legacy implementation and a CycloneMSM-style delayed scheduler replacing the radix sort (~4–8%). The remaining gap to the original "halve the baseline" target (≤ ~14 s) plausibly closes with the signed-digit redo plus two of the sumcheck items.

## Provenance

Optimization branches live in [lordshashank/aztec-packages](https://github.com/lordshashank/aztec-packages): PR #1 (task-v1 variant, base `zk-arena-base`), PR #2 (task-v2 / upstream-`next` variant, base `next-base`). Each accepted arena submission carries its full grader transcript under `submissions/transcripts/`. Much of the implementation and measurement was done by coding agents (Claude) driving the build–grade–verify loop; the masking rank analysis, cost modeling, and acceptance decisions are documented in the commit messages and this file.
