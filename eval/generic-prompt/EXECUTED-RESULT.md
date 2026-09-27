# Executed prompt A/B: first coding-task pilot

2026-09-27. Follow-up to [RESULT.md](RESULT.md) and [GPT-RESULT.md](GPT-RESULT.md).
This time term2 executed real tools in four separate copies of the
`c11-d5-batch-denial-tristate` benchmark task. The task's hidden regression
test failed on **all four untouched baselines** before model execution. Every
arm used the same built runtime (`358fd042`), task archive, standard profile,
non-base prompt fragments, auto-approved tool surface, and medium effort. Only
the effective base prompt bytes changed within a model: `simple_v4.md`
(`e6f043d4`) or `gpt.md` (`6718831c`), SHA-256 prefixes. The task archive did
not contain the hidden evaluator or the candidate-visible boundary test.

| Model | Base | CLI exit | Seconds | Typecheck + hidden test | Model requests | Input tokens (cached) | Output tokens |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: |
| DeepSeek Flash | simple | 0, final answer | 138 | PASS | 37 | 1,642,837 (1,597,824) | 17,366 |
| DeepSeek Flash | GPT | 124, 180s cap | 180 | PASS, partial run | 37 | 1,880,281 (1,823,744) | 18,156 |
| GPT-6 Luna | GPT | 0, final answer | 79 | PASS | 9 | 230,442 (193,536) | 1,440 |
| GPT-6 Luna | simple | 0, final answer | 61 | PASS | 9 | 249,263 (211,968) | 1,192 |

All four changed only the coordinator and its existing test file. Each fixed
`false -> rejected` without changing `true -> approved` or the undefined
fall-through. The DeepSeek arms added three tests for those cases; the GPT-6
arms added a denial regression test. Candidate diffs were inspected against
the archive, and the hidden evaluator was run **after** model execution. The
DeepSeek/GPT arm passed the evaluator but did not finish the user-facing turn
before the cap: report it as a timed-out completion, not as a correctness
failure or a successful completed run. Its trace shows it ran tests and
typecheck but was still inspecting edited code when terminated.

Input/output totals are the sum of per-request `cost_update` records, not a
sum of potentially repeated `usage_update` events. Cached tokens are included
in input totals, not additional tokens. The local catalog priced GPT-6 at
about $0.00635 (GPT base) and $0.00645 (simple base); DeepSeek's records were
unpriced (`unknown_provider`), so no comparable dollar total is available.
These are provider-reported counts, not uncached prompt sizes. Neither model
showed an accuracy difference on this one task. GPT-6's simple arm took 18
fewer seconds but used more input tokens, so this single unreplicated pair
does not establish a speed or cost advantage.

**Limitations and incident:** The initial, harder `r-retry-abort-backoff` pilot
was abandoned after the first DeepSeek/simple arm reached its 240s cap while
still editing (96 tool starts, 58 usage records). `--json` emitted the full
cumulative reasoning text on every delta, producing a 1.6 GB log. Its bounded
projection was kept locally, the raw redundant log removed, and
[`filter-events.mjs`](filter-events.mjs) now drops reasoning deltas and caps
the retained fields. This first attempt is **not** a task outcome. In the
completed tri-state pilot, candidate directories sat under an enclosing git
worktree; `git status` climbed into that parent and exposed unrelated
untracked experiment scripts to the models. The hidden evaluator also lived
in a sibling `control/` directory: no access to it was observed, but the
filesystem layout did not enforce that boundary. This is an isolation
confound. [`run-executed.sh`](run-executed.sh) now prevents **git** traversal
from new candidate directories; it does not prevent filesystem traversal to
siblings and was **not** in place for the reported run. A stronger isolation
boundary is needed before using this setup for a high-stakes benchmark.
The arms ran in a single order (simple before GPT for DeepSeek, GPT before
simple for Luna), with no repetitions. No quality winner or routing change is
justified.

To replicate: build once with `pnpm exec tsc --project tsconfig.build.json &&
pnpm post-build`, prepare fresh task workspaces using the model-benchmark
skill's `prepare-benchmark.sh` and the four arm names in
[`run-executed.sh`](run-executed.sh), execute that script, then run the skill's
`run-evaluator.sh` and [`summarize-pilot.mjs`](summarize-pilot.mjs). The locally
generated, ignored `.coord/prompt-ab-tristate/control/` holds the original
filtered event logs, candidate diffs, and evaluator outputs until this
worktree is removed. **Pin the next task archive to `358fd042` rather than
`HEAD`: this report itself describes the answer and must not enter a future
candidate workspace.** Next run should reverse arm order and use at least one
additional task shape before reconsidering the prompt routing.
