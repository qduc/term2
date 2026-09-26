# Discovery-extra main pilot (D2–D6)

Run: `jev-fit-20260919`. Worker: `discovery-extra`. Authoring model: **Grok 4.6**.

**Frozen for scoring.** Dataset and prompts are pinned; this worker is not cycling further fixture edits. A fresh independent blind reviewer and the coordinator own acceptance and scored calls.

Pinned SHA-256:

- `dataset.json`: `11a6475a001b7cbdf41b6987bb5bdc7c9f9ec5c005630d2f6db12307a2961d83`
- `prompts.json`: `1d10a3203357fb77099418c2515e8c7dca95044df00e08bc3fbc10eeba564b74`
- rejected v1: `a24ddd2a975867d53eeb8eb075ddd7f6ec03d22992ba300c5eb8f45c79e4cb19`

This directory is the main-pilot Choice set for tool/MCP discovery, memory retrieval, session retrieval, code/search ranking, and output selection. It does **not** own D1 (skill selection); that remains with the discovery worker (GLM). Challenge80 under `jev-experiments/challenge/` is an independent probe and was not read or reused.

## Contract

- Primitive: Choice, including best-candidate selection. Do not report ranking metrics from these top-1 labels.
- Per task: 24 `dev` + 24 `holdout`, IDs `jev-fit-20260919-DX-{task}-{split}-{nn}`.
- Every criteria map includes `none`.
- State has no answers. Labels frozen before any provider call.
- Prompts: `minimal` / `rubric` / `scoped`, universal per task.
- Cases are handcrafted/synthetic, repository-flavored, not production reliability evidence.

Provider bodies are `{model, state, questions}` with `state`, prompt instructions, and `criteria` only. Case id, split, expected, baseline, rationale, tags, and provenance are not payload fields.

## Catalogs

D2 uses a fixed term2-shaped tool catalog (`read_file`, `grep`, `glob`, `search_replace`, `apply_patch`, `create_file`, `shell`, `web_search`, `web_fetch`, `memory_search`, `session_search`, `ask_user`, `run_code`, `run_subagent`, plus optional MCP entries). Eligibility flags are part of evidence. Absent capabilities must land on `none`. D2 is unchanged from v1.

D3–D5 use per-case candidate lists with close alternatives (caller vs definition, lexical overlap vs subject match, local vs web, grep vs glob). D6 chooses which output section to retain.

Dev and holdout differ in requested work, not in renamed filenames of the same story.

A pre-experiment blind review rejected the first D3–D6 construction (`dataset-v1-rejected.json`): expected was usually first, and many distractors were one-word stubs. Queries, labels, and prompts were kept. Candidate plus criteria order rotate from SHA-256 of the case id (not from the gold label). Thin stubs are replaced from authored maps (`stubs_prose.py`, `stubs_code.py`, `stubs_logs.py`) with topic-specific facts, real code, or real logs. Meta-padding about “competing cards” was removed. Already-substantive sentences pass through.

## Baseline

`baseline.py` scores token overlap between query-like fields and option labels, criteria, and candidate bodies. It ignores `injected` / `noise` when a query field exists. Stored `baseline` is that heuristic, not a second gold label. It disagrees with gold on 115 of 240 cases.

## Remaining limitations (explicit, not queued repairs)

- Choice top-1 only; no ranking metrics from these labels.
- Synthetic fixtures, not production reliability evidence.
- Prompts are unselected until the coordinator’s shared runner freeze on dev.
- Lexical baseline is not an oracle.
- `jev-fit-20260919-DX-D6-holdout-13`: the rationale text “from/cursor mix is the error” also appears in the `sec_id` log/criteria string. That is synthetic explanatory-log ambiguity inside evidence, not an answer-key field in the provider payload. The case is left as pinned.
- Empty/whitespace D6 sections remain empty for missing-evidence cases.

## Out of scope

Provider calls from this worker, D1, `discovery/`, `challenge/`, production source, credentials, children, Herdr panes, further fixture churn after this pin.
