# Reverse probe: simple generic base on GPT models

2026-09-27. Compared `simple_v4.md` against the current `gpt.md` base on
`codex/gpt-5.6-luna` and `codex/gpt-6-luna`, both at medium effort. Same
non-base prompt fragments, tool schemas, five synthetic cases, and model
within each pair; two trials per case with reversed arm order. Codex-compatible
fixtures omit the DeepSeek-only native reasoning-history markers. Tool calls
were **not executed**. Per-cell results: [`gpt-results.jsonl`](gpt-results.jsonl).
Harness: [`compare.ts`](compare.ts) with `PROMPT_AB_GROUP=gpt`.

| Model | Simple base | GPT base | Input tokens per cell (simple -> GPT, approx.) |
| --- | ---: | ---: | ---: |
| GPT-5.6 Luna | 10/10 | 10/10 | 1,618 -> 2,758 |
| GPT-6 Luna | 4/10 | 4/10 | 1,536 -> 2,676 |

This is a strict *first next action* rubric: an edit-intent case counts only
when the first call contains an apparent write, not when it first reads the
file. On GPT-6 Luna, both bases chose `run_code` to read the file in all six
edit-intent cells; neither declined the task, but the unevaluated continuation
might or might not complete it. Both bases passed both read-only and both
post-edit-check cells on each model. GPT-5.6 Luna attempted the edit immediately
in all six edit-intent cells on both bases. Calling an apparent write method
does not prove a valid patch, actual file modification, or eventual completion.

**Conclusion:** Neither base demonstrated a behavioral advantage on these
synthetic next actions. The simple base used about 1,140 fewer input tokens per
cell, but this is not total task cost. Keep GPT-5.x/6 on `gpt.md` pending
executed, representative coding tasks that measure completion and tool use.
Do not compare these scores directly to the earlier 12-case GPT-6 report: its
case mix and scoring differ.
