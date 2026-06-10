#!/usr/bin/env bash
# zk-prover-arena CI — run one official grading action on the canonical runner.
#
#   ci/grade.sh calibrate            [runs]   grade baseline -> artifact only (no boards/commit);
#                                             used once per environment change to set budgets
#   ci/grade.sh baseline             [runs]   baseline reference run -> canonical boards + commit
#   ci/grade.sh submission <name>    [runs]   full promote pipeline on submissions/incoming/<name>;
#                                             on acceptance promote.mjs makes the bot commit
#   ci/grade.sh regrade-champion     [runs]   baseline drift watch (exit 1 on >10% drift)
#
# Everything interesting lands in ci-out/ (uploaded as the run artifact) and in
# $GITHUB_STEP_SUMMARY. Commits are made here; the workflow pushes them.
set -uo pipefail

ARENA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:?mode required: calibrate|baseline|submission|regrade-champion}"
SUBMISSION="${2:-}"
RUNS="${3:-5}"
if [ "$MODE" != "submission" ]; then RUNS="${2:-5}"; fi

export BASELINE_BB="$HOME/bb-baseline/bb"
export NARGO_BIN="$HOME/.nargo/bin/nargo"
export BB_REPO="$HOME/aztec-packages"
export BB_SPARSE="barretenberg/cpp"
export CCACHE_DIR="$HOME/.ccache" CCACHE_MAXSIZE=4G
export CMAKE_C_COMPILER_LAUNCHER=ccache CMAKE_CXX_COMPILER_LAUNCHER=ccache
export CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-4}"
export ZKARENA_MACHINE="${ZKARENA_MACHINE:-github/ubuntu-24.04-arm (Azure Cobalt 100, 4 vCPU, 16GiB)}"

OUT="$ARENA_DIR/ci-out"
mkdir -p "$OUT"
cd "$ARENA_DIR"
SUMMARY="${GITHUB_STEP_SUMMARY:-$OUT/summary.md}"

summarize_grade_json() { # $1 = grade.json, $2 = heading
  jq -r --arg h "$2" '"## \($h)\n\n" +
    "machine: `\(.machine)`\n\n" +
    "| median prove (s) | peak RSS (MiB) | time board | memory board |\n|---|---|---|---|\n" +
    "| \(.medianS) | \(.peakMiB) | \(if .timeBoardValid then "VALID" else "invalid" end) | \(if .memBoardValid then "VALID" else "invalid" end) |\n\n" +
    "runs: \([.runs[].proveS] | map(tostring) | join(", ")) s\n\n" +
    "gates: \(.gates)\n"' "$1" >> "$SUMMARY"
}

case "$MODE" in
  calibrate)
    node grade.mjs --stack=baseline --runs="$RUNS" --boards="$OUT/boards" --json="$OUT/grade.json"
    rc=$?
    [ -f "$OUT/grade.json" ] && summarize_grade_json "$OUT/grade.json" "Calibration: baseline on official environment"
    echo "Calibration artifact only — no boards were touched. Apply budgets + seed boards from ci-out/." >> "$SUMMARY"
    exit $rc
    ;;
  baseline)
    node grade.mjs --stack=baseline --runs="$RUNS" --json="$OUT/grade.json"
    rc=$?
    [ $rc -eq 0 ] || exit $rc
    summarize_grade_json "$OUT/grade.json" "Baseline reference run"
    node board.mjs --md
    git add boards/time.tsv boards/memory.tsv LEADERBOARD.md
    git commit -m "Baseline reference run (official env): $(jq -r '"\(.medianS)s / \(.peakMiB)MiB"' "$OUT/grade.json")"
    ;;
  submission)
    [ -n "$SUBMISSION" ] || { echo "submission name required" >&2; exit 2; }
    DIR="submissions/incoming/$SUBMISSION"
    [ -d "$DIR" ] || { echo "no such submission dir: $DIR" >&2; exit 2; }
    node promote.mjs "$DIR" --runs="$RUNS" > "$OUT/verdict.json"
    rc=$?
    {
      echo "## Official grading: \`$SUBMISSION\`"
      echo
      echo '```json'
      cat "$OUT/verdict.json"
      echo '```'
    } >> "$SUMMARY"
    exit $rc
    ;;
  regrade-champion)
    node promote.mjs --regrade-champion --runs="$RUNS" > "$OUT/verdict.json"
    rc=$?
    { echo "## Baseline drift watch"; echo; echo '```json'; cat "$OUT/verdict.json"; echo '```'; } >> "$SUMMARY"
    # The drift watch appends baseline rows to the canonical boards either way — record them.
    if ! git diff --quiet -- boards LEADERBOARD.md; then
      git add boards/time.tsv boards/memory.tsv LEADERBOARD.md
      git commit -m "Baseline drift watch: $(jq -r '"\(.medianS // "n/a")s, drift \(.driftPct // "n/a")%"' "$OUT/verdict.json")"
    fi
    exit $rc
    ;;
  *)
    echo "unknown mode: $MODE" >&2; exit 2 ;;
esac
