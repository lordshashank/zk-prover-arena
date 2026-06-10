---
name: zk-prover-arena-submit
description: Operate the zk-prover-arena optimization loop end-to-end — get the pinned barretenberg base, build a modified bb, self-grade locally, package a submission, and submit it for canonical grading/promotion. Use when optimizing the UltraHonk prover for this arena or preparing/validating a leaderboard submission.
---

# zk-prover-arena — the agent-operable submission loop

The arena measures one thing: a `bb prove` on the frozen 2^21 task, single-threaded, on the canonical environments — GitHub-hosted `ubuntu-24.04-arm` (Azure Cobalt 100 / Neoverse N2; absolute seconds) and `ubuntu-latest` x86 (EPYC/Xeon; ratio vs same-VM baseline), both provisioned exactly by [`ci/setup.sh`](./ci/setup.sh). Your job is to make that cheaper (time and/or peak RSS) by patching the prover source — nothing else is a variable. Your local hardware is for iterating; only the canonical runners' numbers rank, so arch-specific work should target Neoverse (arm64 board) or Skylake+ x86 (x86 board, where upstream's x64 asm is active). Full rules: [README.md](./README.md); submission format and acceptance rule: [submissions/SPEC.md](./submissions/SPEC.md).

## 0. One-time setup

```bash
# this repo
git clone <this-repo> prover-arena && cd prover-arena

# the prover source — pinned base is aztec-packages `next` @ 7e94c2c0e32820e25e20d39a426d546dae56a34f
git clone https://github.com/AztecProtocol/aztec-packages
git -C aztec-packages checkout 7e94c2c0e32820e25e20d39a426d546dae56a34f

# baseline bb (the reference binary the grader verifies against) — build the UNPATCHED base once:
cd aztec-packages/barretenberg/cpp
corepack enable    # bb's cmake configure probes a yarn package (nodejs_module); without it configure fails on node-api-headers
BREW_PREFIX=/opt/homebrew cmake --preset homebrew && cmake --build --preset homebrew --target bb   # macOS/homebrew clang
# (Linux / plain clang-20: cmake --preset default && cmake --build --preset default --target bb)
mkdir -p ~/.bb-next && cp build/bin/bb ~/.bb-next/bb      # or: export BASELINE_BB=$PWD/build/bin/bb

# nargo v1.0.0-beta.22 (fresh-witness gate): via noirup, or export NARGO_BIN=/path/to/nargo
```

## 1. The loop

```bash
# work on a branch of the pinned base
git -C aztec-packages checkout -b my-opt 7e94c2c0e32820e25e20d39a426d546dae56a34f
# ...edit barretenberg/cpp/src/barretenberg/** ONLY (see SPEC.md editablePaths)...

# rebuild
cmake --build --preset homebrew --target bb     # in aztec-packages/barretenberg/cpp

# self-grade (local numbers — advisory; official numbers come ONLY from the canonical machine)
node grade.mjs --stack=my-opt --bb=/abs/path/to/aztec-packages/barretenberg/cpp/build/bin/bb --runs=5
node board.mjs    # see where you'd land locally
```

Iterate until you beat a current best (`LEADERBOARD.md`) by **more than its noise margin** on any of the four boards: arm64 time by > max(0.5 s, 2·sigma), x86 time *ratio* by > max(1.5%, 2·sigma), or peak RSS (either board) by > 75 MiB. Smaller wins will be rejected at promotion — don't submit them. Remember your hardware ≠ the canonical runners: an Apple-only win can evaporate on Neoverse/EPYC, and a generic algorithmic win usually carries (the official environments grade both arm64 and x86, so either surface can earn acceptance).

## 2. Package the submission

The directory must live at `submissions/incoming/<name>/` in your fork of this repo (that's the path the PR adds and the workflows look for):

```bash
mkdir -p submissions/incoming/my-opt
git -C aztec-packages diff 7e94c2c0e32820e25e20d39a426d546dae56a34f my-opt \
  -- barretenberg/cpp/src > submissions/incoming/my-opt/changes.patch
```

`submissions/incoming/my-opt/submission.json` (claims = your local `grade.mjs --runs=5` numbers):

```json
{
  "name": "my-opt",
  "author": "<your-github-handle>",
  "model": "<AI model that produced the optimization, or \"human\">",
  "notes": "What changed and why it wins (markdown, <=10KiB).",
  "claimedTimeS": 21.9,
  "claimedPeakMiB": 2200,
  "patch": "changes.patch"
}
```

**Model attribution is required.** If an AI model wrote or co-wrote the optimization, name it (e.g. `"claude-fable-5"`, `"human+claude-fable-5"`); use `"human"` only for unassisted work. It lands in the public audit log (`submissions/log.jsonl`).

Self-validate before submitting (catches schema, path-policy, apply, and claimed-score failures locally; set `BB_REPO` to your aztec-packages clone):

```bash
BB_REPO=/abs/path/to/aztec-packages node intake.mjs submissions/incoming/my-opt
```

## 3. Submit

- **Normal path (you are a contributor):** fork this repo, add `submissions/incoming/<name>/` (the directory above) on a branch, and open a PR. The `submission-intake` workflow validates it automatically (advisory). A maintainer reviews the patch and dispatches the **`official-grade`** workflow (mode=`submission`, submission=`<name>`, pr=`<your PR number>`) — it builds from source and grades 5 runs on BOTH canonical environments (arm64 absolute, x86 ratio-vs-same-VM-baseline), applies the acceptance rule across all four boards, pushes the bot commit on accept, and comments the JSON verdict on your PR either way.
- **You are a maintainer:** dispatch it from the CLI:
  ```bash
  gh workflow run official-grade.yml -f mode=submission -f submission=<name> -f pr=<N>
  gh workflow run official-grade.yml -f mode=regrade-champion   # baseline drift check (>10% warns)
  gh workflow run official-grade.yml -f mode=calibrate          # re-measure baseline, artifact only
  ```
  (`node promote.mjs <dir>` / `--regrade-champion` is the same pipeline runnable locally — useful for debugging, but local results are not official.)

`promote.mjs` prints exactly one JSON verdict on stdout (`accepted` / `rejected` / `failed` / `dry-run`); everything else streams to stderr.

## 4. Error → recovery

| verdict / failure | meaning | recovery |
|---|---|---|
| `rejected: missing/invalid <field>` | submission.json schema | fix the field; re-run `node intake.mjs` |
| `rejected: path outside editable tree` / cmake file touched | patch violates editablePaths | regenerate the diff with `-- barretenberg/cpp/src`; move any cmake/flag change out — it's not allowed on this track |
| `rejected: binary diffs are not allowed` | patch adds a binary | submissions are source-only; delete the binary, generate data at build time from source |
| `rejected: patch does not apply cleanly` | diffed against the wrong base | rebase your branch onto `7e94c2c0e3` and re-export the diff against exactly that commit |
| `rejected: claimed-score pre-filter` | claims don't beat the baseline on either axis | you're not claiming an improvement over the unmodified prover — keep optimizing, or re-measure with `--runs=5`; do NOT inflate claims (officials are re-measured anyway) |
| `failed: build` (stage configure/compile) | patched source doesn't build with the standard preset | reproduce locally: fresh worktree of the base, apply your patch, `cmake --preset homebrew && cmake --build --preset homebrew --target bb`; fix; resubmit |
| `rejected: gates` | proof invalid / wrong output / >1 thread / disk spill | your optimization broke correctness or violates the frozen config — run `node grade.mjs` locally and check each gate line; common causes: changed *what* is committed (VK mismatch), threading sneaking in, mmap/spill tricks |
| `rejected: noise-margin` | real but too-small improvement (or the canonical runner disagrees with your machine) | find more headroom; margins are in the verdict (`margins.timeS`, `margins.memMiB`). Hardware differs — only canonical-runner numbers count (e.g. Apple-specific wins may vanish on Neoverse) |
| `failed: grade` with timeout | a run exceeded 600 s — process group killed | something pathological (deadlock, swap death); profile locally at 2^21 |

## 5. Ground rules (will get a submission rejected on review even if checks pass)

- No caching anything **witness-dependent** (the fresh-witness gate kills it anyway); witness-independent preprocessing is fair game (see README "Trust model").
- No build-time network fetches or other supply-chain tricks in the patch — builds run on a throwaway CI VM but with network access (documented limitation; patches are human-reviewed before grading is dispatched).
- One optimization theme per submission where practical — it keeps the audit log legible and results attributable.
