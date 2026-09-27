# Executed prompt A/B: GPT-6 Sol follow-up

2026-09-27. Extension of [the Luna/DeepSeek grid](GRID-RESULT.md) to
`codex/gpt-6-sol`. **Decision:** Do not extend the Luna rollout recommendation
to Sol yet. The simple base produced safer credential-picker workspaces and
one completed, semantic-pass turn, but 11/12 Sol turns timed out at the
original grid caps. Keep Sol's current `gpt.md` routing until a longer-cap
replication can measure completed tasks. No production routing changed.

## Method and outcome

The same three pinned tasks, two repetitions, medium effort, standard profile,
tool surface, and task-specific 180/240/360-second caps were used. Each pair
varied only the effective base prompt: `simple_v4.md` (`e6f043d4`) or `gpt.md`
(`6718831c`, SHA-256 prefixes). Order reversed in repetition 2. The built
runtime copied into candidates came from the main checkout's `dist` on this
machine, rather than a fresh build in the isolated worktree; its GPT base
matched the source prompt hash. The candidate sources were archived from the
same commits as the preceding grid: `358fd042`, `e80b3f36`, `2a13d14f`.
The official typecheck and hidden test ran on every candidate workspace;
all twelve typechecked. The credential semantic evaluator from the preceding
grid ran separately; its outcome does not replace the strict official result.

| Task (two repetitions) | Sol simple | Sol GPT |
| --- | --- | --- |
| Approval tri-state | 0/2 completed; 2/2 partial official PASS | 0/2 completed; 1/2 partial official PASS |
| Credential picker | 1/2 completed, semantic PASS; both semantic PASS | 0/2 completed; both semantic FAIL (secret visible) |
| Retry cancellation | 0/2 completed; both official FAIL | 0/2 completed; both official FAIL |

Both credential arms failed the **strict official** evaluator in both
repetitions. Simple used a safe configured indicator rather than the required
literal `********`, passing the semantic check in both workspaces; GPT left
the full test credential visible in both. Only the simple arm's first
credential turn actually finished, so its second semantic PASS is a partial
workspace outcome. All four approval turns timed out despite three partial
workspace passes. The retry evaluator failed for all four partial workspaces.

| Arm (six turns) | Completed turns | Completed official passes | Completed user-contract passes | Wall seconds incl. caps | Provider input tokens (cached) | Output tokens | Catalog cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Sol simple | 1 | 0 | 1 | 1,552 | 5,572,115 (5,195,520) | 25,650 | $2.048795 |
| Sol GPT | 0 | 0 | 0 | 1,561 | 8,090,171 (7,659,776) | 31,777 | $2.710512 |

Cost totals sum `cost_update` request records only; cached tokens are part of
input totals. A timed-out partial evaluator pass is not a completed pass.
Filtered transcripts, evaluator outputs, and candidate diffs are retained
locally in the isolated worktree at
`.worktrees/sol-prompt-grid/.coord/generic-prompt-sol-grid/` (ignored by git).
From the main checkout, reproduce the metrics with
`GRID_MODEL=sol node eval/generic-prompt/summarize-grid.mjs
.worktrees/sol-prompt-grid/.coord/generic-prompt-sol-grid`.

The safety signal favors the simple base on this task, but the mostly timed-out
grid cannot establish a reliable Sol completion advantage or justify a prompt
route change. Caps sized for Luna were evidently too short for these Sol
turns. A next comparison should predefine longer Sol caps, preserve paired
order reversal, and retain both strict and semantic credential scores. The
prior grid's isolation caveat still applies: git history was locally reset,
but candidates were not filesystem-sandboxed from sibling control files; no
such access was observed. This experiment did not test Sol Pro or GPT-5.6 Sol.
