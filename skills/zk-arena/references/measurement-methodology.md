# Measurement methodology — how not to fool yourself

The arena's history contains multiple multi-hour detours caused by bad measurement
(documented in RESEARCH.md). The noise margins exist precisely because local numbers
lie. Internalize these rules before claiming any delta.

## The hierarchy of evidence (strongest first)

1. **Official paired grading** (`zk-arena-grade`): candidate vs tip on the same VM,
   5 runs, median + σ. The only numbers that rank.
2. **Same-binary interleaved A/B**: put both code paths in one binary behind a runtime
   switch (env var) and alternate runs. Removes binary-layout and build-environment
   noise entirely. Prefer this whenever the change permits it (the champion's MSM
   dispatch keeps `BB_MSM_FAST=1` / `BB_MSM_LEGACY=1` overrides for exactly this
   reason).
3. **Cross-binary interleaved grading**: `grade.mjs --runs=5` on candidate and tip,
   alternating (tip, cand, tip, cand, ...) rather than 5-then-5, so thermal/cache/page
   state drift hits both sides. Compare medians, check σ.
4. **Cross-binary single runs**: noise. On a Mac, cross-binary wall-clock A/B is
   noise-dominated at the ±1 s level. **Never trust a cross-binary single-run delta
   under ~1 s.**

## Time

- Always `--runs=5` for decisions; the official margin is max(0.5 s, 2σ) on arm64 and
  max(1.5%, 2σ) as a ratio on x86 — a local win inside your own noise band will be
  rejected officially.
- Grade the tip and the candidate in the same session, same machine state, no other
  load. Background processes, thermal throttling, and P/E-core scheduling all show up
  at the 1–2% level — which is the size of a respectable win.
- Your hardware is not the canonical runner. Local deltas are direction + rough
  magnitude; arch-specific work should target Neoverse N2 (arm64 board) or modern x86
  (where upstream's x64 asm is active). A Linux arm64 container with the CI toolchain
  predicted official seconds within ~1.5% in the last campaign — worth setting up for
  anything subtle.

## Memory

- **Never trust single-run macOS RSS.** Graded peak RSS on macOS carries ±500 MiB of
  ambient noise (page cache, compressed-memory state, `MADV_FREE` pages staying
  resident until kernel pressure). This produced two false alarms in past campaigns.
- For memory work: use a Linux container (container peak RSS tracked the official
  runner within ~0.3%), or deterministic footprint instrumentation
  (e.g. `phys_footprint` on macOS, allocation-site accounting), or accept the official
  CI grading as the only memory oracle.
- A 50 ms-granularity RSS trace is the right tool for finding *where* the peak is set —
  in the current champion the process peak is set in the first second (circuit
  construction + PK build), so prove-phase savings may not move peak RSS at all.
  Find the peak before optimizing it.

## Phase attribution

- `bb prove --print_bench` prints a phase/op-count tree to stderr. At 2^21 the prove is
  ~75% MSM (wire commitments, z_perm, Gemini folds, Shplonk quotient, KZG quotient),
  ~10% sumcheck, ~5% proving-key construction — but re-profile on the current tip;
  every merged campaign shifts the ratios.
- After the existing optimizations the MSM is **memory-latency-bound**: measured
  ~470 ns/point-add against ~85 ns of arithmetic, because bucket-sorted scheduling
  makes point loads effectively random over ~128 MB. Consequence: op-count models
  (fewer additions, smaller windows) under-deliver; cache-residency and prefetch work
  over-deliver. Size optimizations against the memory system, not the ALU.

## Hygiene that has bitten before

- A relative VK path resolved from the wrong cwd produced phantom `verify` failures —
  two false alarms in one session came from the harness, not the prover. When a gate
  fails unexpectedly, suspect your harness first; re-run the unmodified tip through the
  identical command before debugging the prover.
- Do one warm-up prove after any cold start (first run downloads the ~140 MB CRS and
  pollutes time + disk numbers).
- Pin everything you can: same machine, same power state, no parallel builds during
  graded runs.
