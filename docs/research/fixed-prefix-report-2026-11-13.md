# Fixed request prefix snapshot (2026-11-13)

What the first model request carries before any conversation content: the
system prompt plus the tool definitions. Measured with
`scripts/token-prefix-report.mjs` (`pnpm prefix:report`) against the built CLI.

## Scope and how to read the numbers

- **Revision:** product source at `0f3fa7f` (branch `claude/fervent-mendel-yusdtw`),
  built with `pnpm build`. The commit that adds this note changes no file under `src/`.
- **Estimate, not a tokenizer count.** `~tok` is characters / 4. Tool size is the
  length of each tool definition's JSON exactly as sent, so it includes the schema,
  not only the description.
- **Wire shape:** an `openai-compatible` provider (chat completions). Tool selection
  is model-keyed (`gpt-5.5` gets `apply_patch` instead of `search_replace` +
  `create_file`), so the model id matters. Native Anthropic, Responses and Codex
  transports were not measured; their envelopes differ.
- **Minimal environment:** empty workspace (no `AGENTS.md`, no skills, no memory,
  no MCP servers), sandbox disabled, isolated `HOME`. A real session adds project
  instructions, the skills catalog and memory context to the prompt, so these are
  floors. The environment line contains the temporary cwd and home paths, so the
  system prompt size varies by a few characters with path length; `SHELL` is not
  passed, so the prompt says `shell: unknown`.
- Subagent figures are the child's first request after a scripted `run_subagent`
  background launch from a headless `mock-alpha` root.

Regenerate: `pnpm build && pnpm prefix:report` (add `--json` for machine-readable
output, `--dump <dir>` to keep each captured request body, `--list` for scenario ids).
The whole run took about 20 s here. It exits non-zero if a scenario was not captured
or an expected refusal started succeeding.

Cross-check: an independent capture of the headless root with a separate
fake-provider script, counted in Python, gave the same 6 tools and 20,390 tool
characters; its system prompt was 1,245 characters against 1,251 here, the
6-character difference being the two longer temporary paths in the environment line.

## Totals

| Scenario | Prefix chars | ~tok | System | Tools (count / chars) |
| --- | ---: | ---: | ---: | ---: |
| Headless root (`mock-alpha`, also `claude-sonnet-4-5`, `kimi-k2`) | 21,641 | 5,410 | 1,251 | 6 / 20,390 |
| Headless root, `--goal` | 25,156 | 6,289 | 2,789 | 7 / 22,367 |
| Headless root, `gpt-5.5` / `gpt-5.3-codex` | 20,772 | 5,193 | 1,163 | 5 / 19,609 |
| TUI root (`mock-alpha`, also sonnet, kimi) | 25,032 | 6,258 | 982 | 7 / 24,050 |
| TUI root, `gpt-5.5` / `gpt-5.3-codex` | 24,163 | 6,041 | 894 | 6 / 23,269 |
| Subagent `agent_spec` (no role) | 6,486 | 1,622 | 2,157 | 3 / 4,329 |
| Subagent explorer | 19,946 | 4,987 | 6,661 | 13 / 13,285 |
| Subagent worker | 20,408 | 5,102 | 7,363 | 13 / 13,045 |
| Subagent worker, `gpt-5.5` / codex | 20,067 | 5,017 | 7,344 | 12 / 12,723 |
| Subagent mentor | 2,915 | 729 | 2,915 | 0 / 0 |
| Subagent reviewer | 4,193 | 1,048 | 3,597 | 1 / 596 |
| Subagent librarian | 11,891 | 2,973 | 7,680 | 8 / 4,211 |

Explorer with a gpt, codex or sonnet model id differs from `mock-alpha` by under
20 characters (the subagent base prompt varies; the tools do not).

## Largest contributors

Tool sizes are the full definition; the description alone is in brackets.

- **Headless root:** `run_code` 8,777 [7,667], `run_subagent` 6,229 [2,280],
  `search_replace` 2,043 [1,131], `read_file` 1,255, `shell` 1,243, `create_file` 843.
  The system prompt is 1,251 in total. Tools are 94% of the prefix.
- **`--goal`:** adds `goal_check` 1,977 [854] and a 1,536-character goal section.
- **TUI root:** `run_code` 8,909, `run_subagent` 6,229, `shell` 2,430 (background and
  monitor options appear only with a background job registry), `session_rollover`
  2,341 [1,685, TUI only], `search_replace` 2,043. The TUI has no "Unattended mode"
  paragraph, so its system prompt is smaller than headless.
- **Explorer:** `web_search` 1,891, `shell` 1,889, `grep` 1,577, `glob` 1,497,
  `read_file` 1,255, `web_fetch` 1,235, `code_context_search` 1,170; prompt sections
  Approach 1,190, Persistent memory 1,118, Available Tool Guidance 970.
- **Worker:** `search_replace` 2,043 (or `apply_patch` 2,564 for gpt), `shell` 1,889,
  `grep`, `glob`; prompt sections Final Report 1,531, Persistent memory 1,118.
- **Librarian:** prompt sections History retrieval 1,488 and Memory librarian 1,431
  dominate; the largest tool is `memory_update` 870.

Prompt sections are split at Markdown headings and lone XML-style tags, a heuristic:
a role body without its own heading is counted in the section before it (the
mentor's 1,240-character "Worktree Hygiene" section is mostly the mentor role text).

## Not captured

The model-family base prompts (`gpt.md` 7,289 characters, `anthropic.md` 3,736,
`kimi.md` 4,786, `simple_v4.md` 1,461, per `wc -m` on the source files) are not in
any request this build can make. `selectPromptProfile` is used only when the
profile identity is `model-family-base`, which only the `plan`, `pair`, `mentor`
and `orchestrator` profiles declare, and `isDroppedProfile()` in
`src/app/dropped-profiles.ts` refuses or replaces all four with Bare (#149). The
interactive TUI therefore uses the Bare prompt for every model id, as headless runs
do. The report keeps the four `--profile` launches as expected refusals so it fails
loudly if one becomes reachable. The same applies to the workflow texts those profiles
would add (`orchestrator.md` 11,187, `plan-mode-info.md` 3,633, `mentor-addon.md`
4,465, `pair-mode.md` 2,725) and to the mode stubs.

## Observations (not acted on)

- **Mentor subagent:** registered tools are none, yet its prompt says "Use
  `read_file` and provided context where possible".
- **Read-only subagents** (mentor, reviewer, librarian, explorer) all carry the
  "Skills and instruction conflicts" section (855 characters), which tells the model
  to "perform it with the editing tool", and the Worktree Hygiene section, whose worker
  lines do not apply to them. None of these roles has an editing tool; mentor has no
  tool at all to load a skill with.
- **`run_subagent`** repeats the child tool enum in `agent_spec.tools` and
  `agent_spec.permissions.tools`, and states the background "return immediately; wait
  for the notification" rule twice. It mentions `get_subagent_result`, which the root
  reaches only as a `run_code` script tool, not on its direct surface.
- **`run_code`'s "Agent capability"** section (1,725 characters of the headless description) is worded
  "when present"; a scripted probe in the headless root found the `agent` global
  present, so it is not advertised-but-missing there.
- `docs/profiles/README.md` says "Root sessions also expose `goal_check`"; in this
  build a root without a goal sends no `goal_check` (it appears only with `--goal`).
