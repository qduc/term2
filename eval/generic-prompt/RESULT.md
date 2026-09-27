# Generic model base prompt: bounded A/B probe

2026-09-27. Compared the original generic `simple_v4.md` (byte-identical to
`b37dba44:source/prompts/simple_v4.md`) against `gpt.md` on
`zai/glm-5.3-flash` and `DeepSeek/deepseek-flash`. The provider/model, medium
reasoning effort, tool schemas, five synthetic cases, and all non-base prompt
fragments were fixed within each pair. Two trials per case reversed arm order.
The tools were advertised but **never executed**. Valid cell summaries are in
[`results.jsonl`](results.jsonl); the reproducible probe is [`compare.ts`](compare.ts).

| Model | `simple_v4.md` | `gpt.md` | Input tokens per cell (simple -> GPT, approx.) |
| --- | ---: | ---: | ---: |
| GLM 5.3 Flash | 10/10 | 9/10 | 1,722 -> 2,872 |
| DeepSeek Flash | 8/10 | 4/10 | 1,929 -> 3,086 |

Scoring is *next action*, not task completion: three edit-intent cases require
the first call to be `run_code` with an apparent write method
(`tools.apply_patch`, `tools.search_replace`, or `tools.create_file`); the
read-only case requires a text response without tools; the post-edit case
requires `pnpm lint` in a `shell` call. GLM's GPT miss was one inspection detour
on an indirect edit, passing on repetition. DeepSeek's GPT arm more often
inspected instead of attempting the edit and once used a tool on an explicitly
read-only case. Both arms passed both post-edit cases once the fixture was
corrected.

**Limitations:** Apparent write calls may have invalid arguments, invalid patch
syntax, or fail when executed. Reading first can be prudent despite this
first-action rubric, and the artificial tool history lacks the fidelity of a
real agent turn. Five short cases in two trials cannot establish end-to-end
solve rate or general superiority. Tokens compare prompt length, not total
task cost. The initial DeepSeek run failed because synthetic tool history lacked
native `reasoning_content`; it was excluded and the fixture corrected. The
post-edit DeepSeek cells needed an additional reasoning item for the synthetic
assistant message and were rerun separately. Neither 400 error counts as a
prompt miss.

**Decision:** This does not justify replacing the simpler generic fallback.
Keep `simple_v4.md` for non-GPT generic models while GPT-5.x/6 retain `gpt.md`;
use real executed coding tasks before claiming an overall quality winner.
