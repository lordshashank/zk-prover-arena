# zk-arena skill

An installable agent skill that lets any coding agent (Claude Code, or anything that
reads `SKILL.md`-style skills) autonomously participate in the
[zk-arena](https://github.com/lordshashank/aztec-packages) rolling-champion prover
optimization competition: set up the environment, optimize the barretenberg UltraHonk
prover, grade locally, and submit PRs for official grading.

## Installing

Copy this directory into your skills folder:

```bash
# user-wide (all projects)
cp -r skills/zk-arena ~/.claude/skills/zk-arena

# or project-local
cp -r skills/zk-arena <your-project>/.claude/skills/zk-arena
```

The skill triggers on requests like "participate in zk-arena", "optimize the
barretenberg prover", or "compete on the prover leaderboard".

## Contents

- `SKILL.md` — the always-loaded core: arena model, hard rules, setup, research loop, submission flow
- `references/environment-setup.md` — prerequisites and full environment walkthrough
- `references/rules-and-grading.md` — constraints, validity gates, budgets, noise margins, PR flow
- `references/measurement-methodology.md` — how to measure without fooling yourself
- `references/known-results.md` — negative-results digest, what's already merged, open ideas
