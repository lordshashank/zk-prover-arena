# Known results — what's merged, what failed, what's open

Digest of `RESEARCH.md` from https://github.com/lordshashank/zk-prover-arena (the
archived spec repo), current as of 2026-06. **This is a snapshot**: before relying on
it, check the actual branch tip (`git log --oneline -- barretenberg` on `zk-arena`,
plus `zk-arena/log.jsonl`) — anything merged after this digest changes the picture, and
the only target that matters is the current tip.

## Already in the champion — do not re-implement

Time:

- **arm64 hand-scheduled Montgomery multiplication** (no-carry CIOS, two-pass carry
  scheduling), enabled on **all aarch64**, not just Apple — the single biggest win.
  ~1.4× field-mul throughput. Gotchas already handled: the build defines
  `-DDISABLE_ASM=1` on arm64 builds (means "x64 asm unavailable" — the arm64 gate
  ignores it); `__builtin_constant_p` guard keeps compile-time constants like `fr(1)`
  from becoming opaque runtime calls.
- **Single-thread MSM routing**: legacy Pippenger when `get_num_cpus() <= 1`, upstream
  fast path otherwise; `BB_MSM_FAST=1` / `BB_MSM_LEGACY=1` runtime overrides.
- **Signed-Booth digits in the legacy Pippenger** (bucket = |digit|, branchless sign on
  entry), window moved 17 → 16 rounds at 2^21. Booth encodes some zero digits with the
  sign bit set — stored sign-cleared for the radix sort's zero-count.
- **Prefetch lookahead 256** in the MSM accumulation loop (sweep: 64/128/256 monotone
  improvement, 512 regresses).
- **Fused Shplonk quotient accumulation** (synthetic division fused with ν-scaled
  accumulation, single pass, no full-size temporaries).

Memory (champion ≈ 1441 MiB vs 1973 base):

- Release every prover polynomial after its last read (opt-in consume flag through the
  Gemini ρ-batching pass).
- Gate-separator pow table split (Dao–Thaler): 64 MiB → ~100 KB, L1-resident.
- σ/id stored as u32 sidecars after sumcheck's first-round fold (~384 MiB of Fr
  originals dropped).
- Builder-consume + staged PK allocation: builder blocks freed as they transfer into
  polynomials; σ/id/z_perm/table/lagrange allocated only after the builder is consumed.
- Flat CSR layout for per-variable copy-cycle vectors (−160 MiB of peak — millions of
  32-byte vectors were both live footprint and allocator fragmentation).
- Wide selectors trimmed to nonzero support after population (q_m at this trace is
  pure zeros; q_c/q_r/q_o/q_4 are 75–96% zeros).
- z_perm allocation deferred to first write; `malloc_trim` before the σ/id
  materialization climb.

## Negative results — do not retread

| Tried | Outcome | Why |
|---|---|---|
| Upstream "fast" round-parallel MSM at 1 thread | 16–20% **slower** than legacy Pippenger at n ≥ 2^16 | its gains come from round-parallelism; single-threaded, only schedule/scatter overhead remains |
| GLV endomorphism decomposition at large n | +35% slower single-threaded | halving scalar bits while doubling points leaves the dominant rounds×n addition term unchanged; memory-bound, not arithmetic-bound. Upstream's n < 2^16 cap is correct |
| Gruen skip-one-evaluation (sumcheck) | descoped at this base | the base removed the `Univariate` skip machinery; subrelation accumulators' barycentric extension assumes consecutive 0..L−1 domains — a transcript-identical version means reworking the barycentric layer for every subrelation length, for ~0.3 s |
| `mallopt(M_MMAP_THRESHOLD)` to force arena reuse | **+90 MiB regression** | fragmentation |
| BGMW/Yao fixed-base precomputation | priced out analytically | precompute can't reduce Pippenger's dominant n·b/s addition term, only ~7% bucket/doubling overhead; the table blows the 4 GiB budget or saves nothing |
| NEON/SIMD field mul, Karatsuba, FP64-FMA limbs | ruled out | no 64×64→128 vector multiply on NEON; scalar multiply CPI beats the Karatsuba crossover; FMA-limb tricks are WASM/GPU-shaped |
| MSM bucket window c=17 | −17% | 6.3 MB of buckets blows the 4 MB L2 |
| Prefetch lookahead 512; "prefetch only new window entries" | both regress | 256 + redundant half-window re-prefetch keeps lines resident |
| Signed-Booth bolted onto legacy MSM via thread-pool round-trips | catastrophic stalls at 1 thread (~180 s) | needed the clean single-thread implementation that later merged |
| Batch scratch sizing (512/4096 vs 2048) | noise-level | |
| Single-run macOS RSS comparisons | two false alarms | ±500 MiB ambient noise — see measurement-methodology.md |

## Open ideas (researched, unimplemented as of the digest)

Verify none of these has merged since (check the tip), then in rough
value-per-risk order:

- **CycloneMSM-style delayed scheduler** replacing the radix sort (~4–8% of MSM).
  Aligned with the "MSM is memory-latency-bound" finding.
- **Dao–Thaler evaluation-at-infinity** in sumcheck (+5–10% of sumcheck time;
  transcript-compatible).
- **Blendy-style late materialization** of the sumcheck partial-evaluation table
  (−0.5–0.7 GiB for ~1–2 s of time — attractive for the memory board, which has a 2×
  time budget).
- **Gruen skip-one-eval** — only if you are willing to rework the barycentric domain
  layer per subrelation length (see negative results).
- The PK-build phase sets the process RSS peak (first ~1 s); further peak reduction
  must attack circuit construction / PK build, not the prove phases (those are already
  flat at the floor).

General guidance: the prove is ~75% MSM and the MSM is memory-system-bound
(~470 ns/add vs ~85 ns arithmetic) — prefer cache-residency, layout, and scheduling
work over op-count reductions, and re-profile the current tip with `--print_bench`
before committing to a direction.
