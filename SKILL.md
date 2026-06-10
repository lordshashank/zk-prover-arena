---
name: zk-prover-arena-submit
description: Operate the zk-prover-arena optimization loop end-to-end — get the pinned barretenberg base, build a modified bb, self-grade locally, package a submission, and submit it for canonical grading/promotion. Use when optimizing the UltraHonk prover for this arena or preparing/validating a leaderboard submission.
---

# zk-prover-arena — the agent-operable submission loop

The arena measures one thing: a `bb prove` on the frozen 2^21 task, single-threaded, on the maintainer's canonical machine. Your job is to make that cheaper (time and/or peak RSS) by patching the prover source — nothing else is a variable. Full rules: [README.md](./README.md); submission format and acceptance rule: [submissions/SPEC.md](./submissions/SPEC.md).

## 0. One-time setup

```bash
# this repo
git clone <this-repo> prover-arena && cd prover-arena

# the prover source — pinned base is aztec-packages `next` @ 7e94c2c0e32820e25e20d39a426d546dae56a34f
git clone https://github.com/AztecProtocol/aztec-packages
git -C aztec-packages checkout 7e94c2c0e32820e25e20d39a426d546dae56a34f

# baseline bb (the reference binary the grader verifies against) — build the UNPATCHED base once:
cd aztec-packages/barretenberg/cpp
BREW_PREFIX=/opt/homebrew cmake --preset homebrew && cmake --build --preset homebrew --target bb   # macOS/homebrew clang
# (Linux / plain clang: cmake --preset default && cmake --build --preset default --target bb)
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

Iterate until you beat the current best (`LEADERBOARD.md`) by **more than the noise margin**: time by > max(0.5 s, 2·sigma of your runs), or peak RSS by > 75 MiB. Smaller wins will be rejected at promotion — don't submit them.

## 2. Package the submission

```bash
mkdir my-opt-submission
git -C aztec-packages diff 7e94c2c0e32820e25e20d39a426d546dae56a34f my-opt \
  -- barretenberg/cpp/src > my-opt-submission/changes.patch
```

`my-opt-submission/submission.json` (claims = your local `grade.mjs --runs=5` numbers):

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
BB_REPO=/abs/path/to/aztec-packages node intake.mjs my-opt-submission
```

## 3. Submit

- **Normal path (you are a contributor):** open a PR against this repo adding `submissions/<name>/` (the directory above). The maintainer's canonical box runs `node promote.mjs submissions/<name>` — build from source, 5 graded runs, acceptance rule, bot commit on accept.
- **You ARE the canonical machine (maintainer):** run it yourself:
  ```bash
  node promote.mjs <submission-dir>              # full pipeline + bot commit on accept
  node promote.mjs <submission-dir> --dry-run    # intake + apply + cmake configure only
  node promote.mjs --regrade-champion            # periodic baseline drift check (>10% warns)
  ```

`promote.mjs` prints exactly one JSON verdict on stdout (`accepted` / `rejected` / `failed` / `dry-run`); everything else streams to stderr.

## 4. Error → recovery

| verdict / failure | meaning | recovery |
|---|---|---|
| `rejected: missing/invalid <field>` | submission.json schema | fix the field; re-run `node intake.mjs` |
| `rejected: path outside editable tree` / cmake file touched | patch violates editablePaths | regenerate the diff with `-- barretenberg/cpp/src`; move any cmake/flag change out — it's not allowed on this track |
| `rejected: binary diffs are not allowed` | patch adds a binary | submissions are source-only; delete the binary, generate data at build time from source |
| `rejected: patch does not apply cleanly` | diffed against the wrong base | rebase your branch onto `7e94c2c0e3` and re-export the diff against exactly that commit |
| `rejected: claimed-score pre-filter` | claims don't even match the current best on either board | you're not claiming an improvement — keep optimizing, or re-measure with `--runs=5`; do NOT inflate claims (officials are re-measured anyway) |
| `failed: build` (stage configure/compile) | patched source doesn't build with the standard preset | reproduce locally: fresh worktree of the base, apply your patch, `cmake --preset homebrew && cmake --build --preset homebrew --target bb`; fix; resubmit |
| `rejected: gates` | proof invalid / wrong output / >1 thread / disk spill | your optimization broke correctness or violates the frozen config — run `node grade.mjs` locally and check each gate line; common causes: changed *what* is committed (VK mismatch), threading sneaking in, mmap/spill tricks |
| `rejected: noise-margin` | real but too-small improvement (or canonical machine disagrees with yours) | find more headroom; margins are in the verdict (`margins.timeS`, `margins.memMiB`). Hardware differs — only canonical numbers count |
| `failed: grade` with timeout | a run exceeded 600 s — process group killed | something pathological (deadlock, swap death); profile locally at 2^21 |

## 5. Ground rules (will get a submission rejected on review even if checks pass)

- No caching anything **witness-dependent** (the fresh-witness gate kills it anyway); witness-independent preprocessing is fair game (see README "Trust model").
- No build-time network fetches or other supply-chain tricks in the patch — builds run unsandboxed on the canonical box (documented limitation; patches are human-reviewed).
- One optimization theme per submission where practical — it keeps the audit log legible and results attributable.
