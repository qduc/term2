# Benchmark dashboard patterns for the local model index

Research checked against the benchmark sites' own pages on 2026-09-28. This
is design evidence, not an assertion that our small dataset supports their
ranking methods.

## Useful patterns

- [SWE-bench Verified](https://www.swebench.com/verified) separates a mixed
  systems leaderboard from a same-agent, bash-only model comparison. It says
  different mini-SWE-agent major releases are not necessarily comparable.
  **Application:** compare candidates from the same run/task/agent configuration
  first; do not pool heterogeneous run IDs into an apparent global winner.
- [SWE-bench Results Viewer](https://www.swebench.com/viewer.html) lets users
  select a split and model, then inspect solved/total and breakdowns with logs.
  **Application:** show the denominator and preserve a candidate-level table
  beneath any summary.
- [Aider LLM Leaderboards](https://aider.chat/docs/leaderboards/) places percent
  correct next to cost and model effort; expanded rows include test-case count,
  timeouts, tokens, reasoning effort, and command/version details. **Application:**
  show evaluator outcome beside cost and duration, with model/effort and run
  identity visible rather than rolling all configurations into one model name.
- [LMArena text leaderboard](https://lmarena.ai/leaderboard/text) has category
  and adjustment controls, vote counts, score uncertainty (the ± value), and
  rank spread. **Application:** missing judge coverage and sample count must
  be explicit; a single judged candidate is not a reliable overall ranking.
- [Artificial Analysis model leaderboard](https://artificialanalysis.ai/leaderboards/models)
  displays intelligence, cost per task, speed, and latency as separate axes.
  **Application:** avoid combining quality, dollars, and runtime into one
  unexplainable score.

## Scope for this repo

The committed index initially held only 24 prepared runs, 61 candidates, 49
evaluator results, and 6 in-run judge scores. Display a **same-run comparison**
selected by task and run, with run status, evaluator, judge samples, cost, and
duration. Use an explicit inconclusive state when outcomes or scores are
missing; never claim an overall winner from a single task. Future cross-task
rankings need a controlled matched task set and more repetitions.
