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
MODE="${1:?mode required: calibrate|baseline|submission|submission-grade-only|x86-submission|decide|regrade-champion}"
case "$MODE" in
  submission|submission-grade-only|x86-submission|decide) SUBMISSION="${2:-}"; RUNS="${3:-5}" ;;
  *) SUBMISSION=""; RUNS="${2:-5}" ;;
esac

export BASELINE_BB="$HOME/bb-baseline/bb"
export NARGO_BIN="$HOME/.nargo/bin/nargo"
export BB_REPO="$HOME/aztec-packages"
export BB_SPARSE="barretenberg/cpp"
export CCACHE_DIR="$HOME/.ccache" CCACHE_MAXSIZE=4G
export CMAKE_C_COMPILER_LAUNCHER=ccache CMAKE_CXX_COMPILER_LAUNCHER=ccache
export CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-4}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0   # candidate configures run the nodejs_module yarn probe
# Machine label, recorded in every board row (leaderboard transparency). On x86 the
# fleet mixes CPU models, so the label names the model this VM actually landed on.
if [ -z "${ZKARENA_MACHINE:-}" ]; then
  case "$(uname -m)" in
    aarch64|arm64) ZKARENA_MACHINE="gh-arm64/Cobalt-100" ;;
    x86_64)
      cpu=$(grep -m1 'model name' /proc/cpuinfo | grep -oE 'EPYC [0-9a-zA-Z]+|Platinum [0-9a-zA-Z]+|Xeon [0-9a-zA-Z]+' | head -1 | tr ' ' '-')
      ZKARENA_MACHINE="gh-x64/${cpu:-unknown-cpu}" ;;
    *) ZKARENA_MACHINE="gh/$(uname -m)" ;;
  esac
fi
export ZKARENA_MACHINE

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
  submission-grade-only)   # one environment's half of the dual-board pipeline (no commit)
    [ -n "$SUBMISSION" ] || { echo "submission name required" >&2; exit 2; }
    DIR="submissions/incoming/$SUBMISSION"
    [ -d "$DIR" ] || { echo "no such submission dir: $DIR" >&2; exit 2; }
    node promote.mjs "$DIR" --runs="$RUNS" --grade-only --grade-out="$OUT/grade.json" --transcript-out="$OUT/transcript.log" > "$OUT/verdict.json"
    rc=$?
    { echo "## Graded (arm64, no decision): \`$SUBMISSION\` on \`$ZKARENA_MACHINE\`"; echo; echo '```json'; cat "$OUT/verdict.json"; echo '```'; } >> "$SUMMARY"
    exit $rc
    ;;
  x86-submission)          # x86 half: baseline AND candidate on the SAME VM (ratio scoring)
    [ -n "$SUBMISSION" ] || { echo "submission name required" >&2; exit 2; }
    DIR="submissions/incoming/$SUBMISSION"
    [ -d "$DIR" ] || { echo "no such submission dir: $DIR" >&2; exit 2; }
    node grade.mjs --stack=baseline --runs="$RUNS" --boards="$OUT/scratch-boards" --json="$OUT/x86-base.json" 2>&1 | tee "$OUT/transcript.log"
    rc=${PIPESTATUS[0]}
    [ "$rc" = 0 ] || { echo "x86 baseline grading failed" >&2; exit $rc; }
    node promote.mjs "$DIR" --runs="$RUNS" --grade-only --grade-out="$OUT/x86-cand.json" --transcript-out="$OUT/cand-transcript.log" > "$OUT/verdict.json"
    rc=$?
    cat "$OUT/cand-transcript.log" >> "$OUT/transcript.log" 2>/dev/null || true
    { echo "## Graded (x86, no decision): \`$SUBMISSION\` on \`$ZKARENA_MACHINE\`"; echo; echo '```json'; cat "$OUT/verdict.json"; echo '```'; } >> "$SUMMARY"
    exit $rc
    ;;
  decide)                  # combine environment artifacts -> acceptance + bot commit
    [ -n "$SUBMISSION" ] || { echo "submission name required" >&2; exit 2; }
    node ci/decide.mjs --sub="submissions/incoming/$SUBMISSION" \
      --arm64="ci-in/arm64-grade/grade.json" --arm64-transcript="ci-in/arm64-grade/transcript.log" \
      --x86-base="ci-in/x86-grade/x86-base.json" --x86-cand="ci-in/x86-grade/x86-cand.json" --x86-transcript="ci-in/x86-grade/transcript.log" \
      > "$OUT/verdict.json"
    rc=$?
    { echo "## Decision: \`$SUBMISSION\`"; echo; echo '```json'; cat "$OUT/verdict.json"; echo '```'; } >> "$SUMMARY"
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
