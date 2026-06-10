# Submission spec — zk-prover-arena

A **submission** is a directory at `submissions/incoming/<name>/` (added via PR) containing exactly two things:

```
submissions/incoming/my-submission/
  submission.json     the manifest (schema below)
  changes.patch       a git diff against the pinned bb base commit
```

Opening the PR triggers the advisory `submission-intake` workflow; a maintainer then dispatches `official-grade` (mode=submission, with your PR number) to grade it on the canonical runner — see "The canonical environment" below.

The pinned base is **aztec-packages `next` @ `7e94c2c0e32820e25e20d39a426d546dae56a34f`**. Your patch must apply cleanly (`git apply --check`) to that exact commit — not to `next` HEAD, not to your fork's tip.

## `submission.json` schema

| field | type | meaning |
|---|---|---|
| `name` | string | stack name on the boards. `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` — used in filenames and TSV rows, so no spaces/tabs. Pick a fresh name; resubmissions should be versioned (`foo-v2`). |
| `author` | string | your **GitHub handle** (used for the `Co-authored-by:` trailer on the acceptance commit). |
| `model` | string | **AI model used to produce the optimization, or `"human"`.** Required — the arena tracks model attribution. Examples: `"claude-fable-5"`, `"human"`, `"human+claude-fable-5"`. |
| `notes` | string | markdown, **≤ 10 KiB**: what you changed and why it's faster/smaller. This is the research write-up that lands in the audit log. |
| `claimedTimeS` | number | your local median prove time (`node grade.mjs` on your machine). **Advisory** — official numbers come only from the canonical machine. |
| `claimedPeakMiB` | number | your local peak RSS. Advisory, same as above. |
| `patch` | string | filename of the patch inside this directory (conventionally `"changes.patch"`). Plain filename only — no paths. |

Example:

```json
{
  "name": "msm-batch-affine-v1",
  "author": "lordshashank",
  "model": "claude-fable-5",
  "notes": "Batch-affine bucket accumulation in Pippenger; frees A_0 after Gemini fold.",
  "claimedTimeS": 22.8,
  "claimedPeakMiB": 2290,
  "patch": "changes.patch"
}
```

## editablePaths policy

The patch may **only** touch files under:

```
barretenberg/cpp/src/barretenberg/**        (no exclusions inside this tree, for now)
```

That includes the per-module `CMakeLists.txt` files inside `src/barretenberg/` (you may add/remove source files). The patch **must not** touch:

- `barretenberg/cpp/CMakePresets.json` (or any file named `CMakePresets.json`),
- anything under `cmake/**` (toolchains, compiler/linker flag modules),
- any `*.cmake` file anywhere.

Rationale: this is the **algorithm track** — flag/toolchain changes alter codegen, not the algorithm, and are out of scope (see README FAQ).

Additionally the patch must not:

- contain **binary diffs** (`GIT binary patch` / `Binary files ... differ`) — submissions are source-only,
- create **symlinks** (file mode `120000`),
- use quoted/escaped paths (no spaces or unicode tricks in filenames).

`intake.mjs` enforces all of this mechanically by parsing the diff headers and running `git apply --check` in a scratch worktree of the pinned base.

## Claimed-score pre-filter (intake)

Before any compute is spent, your **claims** are compared against the current bests (best *valid* rows in `boards/time.tsv` / `boards/memory.tsv`):

> A submission is **rejected at intake** if its claims are strictly worse than the current best on **both** boards — i.e. it must claim to at least match the best time **or** the best peak RSS.

This is deliberately lenient (a claim that merely *ties* a board passes intake — but a tie cannot pass the noise-margin acceptance rule below, so don't bother). The pre-filter exists to stop the canonical machine from burning a ~15-minute build+grade on submissions that don't even claim an improvement. Lying in your claims doesn't help: official numbers are re-measured from scratch, and a submission whose official numbers miss the margin is rejected regardless of what it claimed.

## The canonical environments (dual boards)

Official numbers are produced **only** by the [`official-grade`](../.github/workflows/official-grade.yml) workflow, dispatched by a maintainer. Every submission is graded on **two** environments in parallel:

| | arm64 board (canonical) | x86 board (Aztec's perf ISA) |
|---|---|---|
| runner | `ubuntu-24.04-arm` — Azure Cobalt 100 (Neoverse N2), 4 vCPU | `ubuntu-latest` — mixed fleet (AMD EPYC / Intel Xeon), 4 vCPU |
| time scoring | **absolute seconds** (homogeneous fleet — cross-run comparable) | **ratio to a baseline graded in the same job on the same VM** (cancels the CPU lottery) |
| memory scoring | absolute peak RSS (MiB) | absolute peak RSS (MiB) — RSS is hardware-insensitive |
| why it exists | consistent ranking fleet | upstream barretenberg's first-class perf target (`-march=skylake`, x64 asm active) — wins here translate to Aztec |

Common to both: ubuntu-24.04(+), clang-20 (apt.llvm.org), cmake preset `default`, single-thread, provisioned by [`ci/setup.sh`](../ci/setup.sh). **Every board row records the machine it was measured on** (on x86 that's the CPU model the VM landed on — e.g. `gh-x64/EPYC-7763`). Baseline and candidates are built with identical preset/flags, so deltas are attributable to the patch. Your local numbers (any OS/CPU) select what to submit; they never rank.

## Official grading & the acceptance rule (noise margin)

Wall-clock is noisy, so acceptance is **margin-based**, not "any epsilon wins". On the canonical runner, `promote.mjs`:

1. re-runs intake,
2. builds your patched `bb` from source (the standard release preset for the platform — same as the baseline build),
3. runs `node grade.mjs --runs=5` with all the validity gates from the README (fresh witness, baseline verify, single-thread, disk cap, cross-budgets),
4. computes **sigma** = the *sample standard deviation of the 5 prove times within this grading run* (run-to-run noise, measured fresh every time rather than assumed),
5. applies the **acceptance rule** (`ci/decide.mjs`) — the submission is accepted iff it wins **any** of the four boards beyond its noise margin:

```
arm64 TIME  : time row VALID  and  medianS  <  bestTimeS   − max(0.5 s, 2·σ)
arm64 MEM   : mem row VALID   and  peakMiB  <  bestPeakMiB − 75 MiB
x86  TIME   : time row VALID  and  ratio    <  bestRatio   − max(0.015, 2·σ_ratio)
x86  MEM    : mem row VALID   and  peakMiB  <  bestPeakMiB − 75 MiB
```

where the bests are the best valid rows on each board *before* this grading (x86 baseline anchor rows don't compete), `ratio = candidateMedian / sameVmBaselineMedian`, and `σ_ratio` combines both runs' sigmas in quadrature. x86 validity uses the same cross-budget semantics expressed relative to the same-VM baseline: time rows need peak RSS ≤ 4096 MiB, memory rows need ratio ≤ 2.0. The floors mean: on a quiet machine you must beat the champion by at least 0.5 s (arm64) / 1.5% (x86); on a noisy day the bar rises with the measured noise. Peak RSS is far less noisy, so its margin is a flat 75 MiB. A grading environment that fails outright (build error, infra) contributes no win but doesn't block the other.

A submission that is *graded but misses the margin* is rejected and **its rows never enter the canonical boards** (the grader writes to an isolated boards dir; rows are copied into `boards/*.tsv` only on acceptance). The boards therefore only ever contain: the maintainer's reference runs, and accepted submissions.

## Audit trail (on acceptance)

Acceptance is performed by the bot (`promote.mjs`), never by hand, and produces a monotone audit trail in one commit:

- a row appended to **`submissions/log.jsonl`** (append-only): `{ts, name, author, model, claimed, official, sigma, baseCommit, gradeTranscriptPath}`,
- the **full grader transcript** saved to `submissions/transcripts/<name>-<ts>.log`,
- the official rows appended to `boards/*.tsv`,
- `LEADERBOARD.md` regenerated via `node board.mjs --md`,
- a git commit: `Accept submission <name>: <time>s / <rss>MiB`, with `Co-authored-by: <author> <<author>@users.noreply.github.com>`.

History is never rewritten; a dethroned champion's rows stay on the boards (ranking picks each stack's best valid run).

## Champion / baseline drift watch

Wall-clock bests can rot if the canonical environment changes (runner image update, fleet hardware refresh). Periodically the maintainer dispatches `official-grade` with `mode=regrade-champion` (locally: `node promote.mjs --regrade-champion`), which re-grades the **baseline** stack (`--runs=5`, appended to the boards as usual) and compares the new median against the *trailing median of baseline's valid time-board rows*. If it deviates by **more than 10%**, the run warns loudly (exit 1): the environment's calibration has moved, and current bests / margins should be re-examined (typically by re-grading the champion's retained submission and, if needed, annotating the boards) before any further promotions. If GitHub ever changes the runner hardware class outright, the environment is re-calibrated (`mode=calibrate`) and the boards are archived and reseeded, exactly as was done for the laptop→CI move.

## Trust model & known limitations

- **Canonical environment**: official numbers are produced only by CI on GitHub-hosted `ubuntu-24.04-arm` runners (see above) — never on anyone's personal machine. Only maintainers can dispatch official grading, every executed script comes from `main` (a PR's submission dir is fetched as *data*), and the bot commit + transcript + `log.jsonl` row are pushed by the workflow itself, so the full chain from patch to board row is auditable in the Actions log.
- **The patch still runs as code**: building and grading a submission executes it — that is the point — but it happens inside a throwaway CI VM with a token that can only touch this repo. Builds have network access (documented limitation): don't submit patches with build-time network fetches or codegen that phones home; they'll be rejected on review and the author banned from the boards.
- **Grading is hardened**: each `bb prove` run inherits the grade-time gates (fresh witness, pinned-baseline verify, single-thread, disk cap), the grader is run in its own process group and killed wholesale on timeout (600 s per run), and a run that fails to emit `proof`/`public_inputs` fails closed.
- **Advisory checks on PRs** (`submission-intake` workflow) run intake from the PR's own checkout — convenient, but not a security boundary; official grading re-runs intake from `main`'s scripts before any build.
