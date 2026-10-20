# Reliability study working state

The experiment is complete; promotion was rejected. Canonical outcome:
[results.md](results.md), with raw evidence in `evidence/trials-v2/` and independent
verdict/triage in `post-trial-review.md`. No runtime, prompt, skill or canonical
workflow improvement was adopted.

Protocol/harness freeze: `2b86881e`. First launch failed before any provider
invocation; retained under `evidence/trials/`. Corrected pre-provider inventory
harness freeze: `071644af`, with byte-identical protocol and Sol acceptance.
See `harness-amendment.md`. No model observations replaced or criteria tuned.

All 24 actual provider trials completed. Errors 2 -> 0, exact answers 8/12 ->
10/12, calls 12 -> 12, latency ratio 1.13083. Two candidate answer regressions,
low baseline error floor, insufficient absolute reduction/workflow wins and
no DeepSeek stratum error improvement fail frozen gates. Fresh Sol post-trial
review accepted this conclusion. Parent raw-event/hash/fixture auditor passed
all 24; reviewer inspected but did not rerun checks.

Production source is restored and unchanged against base `24752ab3`. The
worktree's ignored dist still contains the experiment-only contained variant;
it is not an ordinary install and must not be released. Reproduction is in
README.md, and exact temporary adapter is `containment-block.txt`.

User authorization: codex/gpt-6-luna and
orca/deepseek/deepseek-v4.1-flash-1017 trials, codex/gpt-6.1-sol independent review.
No OpenRouter authorization. User prefers completed coding work committed.

Final actions: run scoped final checks, append EDD task ledger, commit retained
results, re-run consistency audit after commit hooks to detect evidence churn,
and integrate this worktree per docs/agent-context.md. No active jobs or agents.
