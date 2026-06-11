# This flow has moved

The patch-based submission loop this file used to document (submission dirs +
`changes.patch` + `intake.mjs`/`promote.mjs` in this repo) is **archived**. This repo
remains the grading spec and history of that flow (see [README.md](./README.md) and
[RESEARCH.md](./RESEARCH.md)).

**The arena now runs as a rolling champion on the
[`zk-arena` branch of lordshashank/aztec-packages](https://github.com/lordshashank/aztec-packages):**
the branch always holds the current champion prover; you branch off it, modify only
`barretenberg/cpp/src/barretenberg/**`, grade locally with `node zk-arena/grade.mjs`,
and open a plain PR against `zk-arena`. The official workflow grades your merge result
paired against the branch tip on the same VM (arm64 absolute seconds, x86 time ratio,
5 runs each), an advisory Pareto verdict lands on the PR, and on merge your code becomes
the new base everyone must beat — `zk-arena/LEADERBOARD.md` and `zk-arena/log.jsonl` on
that branch record the history. The task, budgets, noise margins, and the
frozen-verifier soundness anchor are inherited unchanged from this repo's spec.

**The installable agent skill for the new flow lives in
[`skills/zk-arena/`](./skills/zk-arena/)** — copy that directory into
`~/.claude/skills/` (or a project's `.claude/skills/`) and it walks an agent through
setup, the research loop, measurement discipline, known results, and submission.
