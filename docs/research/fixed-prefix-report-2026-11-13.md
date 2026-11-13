# Fixed request prefix snapshot (2026-11-13)

What the first model request carries before any conversation content: the
system prompt plus the tool definitions. Measured with
`scripts/token-prefix-report.mjs` (`pnpm prefix:report`) against the built CLI.

## Scope and how to read the numbers

- **Revision:** product source at the commit that adds this revision of the note
  (branch `prefix-round2`, parent `b83994f`), built with `pnpm build`. The first
  version of this note measured `0f3fa7f`; the section "Changes since the first
  snapshot" lists what moved.
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

Cross-check (at `0f3fa7f`): an independent capture of the headless root with a separate
fake-provider script, counted in Python, gave the same 6 tools and 20,390 tool
characters; its system prompt was 1,245 characters against 1,251 here, the
6-character difference being the two longer temporary paths in the environment line.

## Totals

| Scenario | Prefix chars | ~tok | System | Tools (count / chars) |
| --- | ---: | ---: | ---: | ---: |
| Headless root (`mock-alpha`, also `claude-sonnet-4-5`, `kimi-k2`) | 21,223 | 5,306 | 1,251 | 6 / 19,972 |
| Headless root, `--goal` | 24,738 | 6,185 | 2,789 | 7 / 21,949 |
| Headless root, `gpt-5.5` / `gpt-5.3-codex` | 20,354 | 5,089 | 1,163 | 5 / 19,191 |
| TUI root (`mock-alpha`, also sonnet, kimi) | 24,614 | 6,154 | 982 | 7 / 23,632 |
| TUI root, `gpt-5.5` / `gpt-5.3-codex` | 23,745 | 5,936 | 894 | 6 / 22,851 |
| Subagent `agent_spec` (no role) | 5,902 | 1,476 | 1,833 | 3 / 4,069 |
| Subagent explorer | 19,203 | 4,801 | 6,545 | 13 / 12,658 |
| Subagent worker | 19,576 | 4,894 | 7,156 | 13 / 12,420 |
| Subagent worker, `gpt-5.5` / codex | 19,336 | 4,834 | 7,137 | 12 / 12,199 |
| Subagent mentor | 2,586 | 647 | 2,586 | 0 / 0 |
| Subagent reviewer | 3,788 | 947 | 3,268 | 1 / 520 |
| Subagent librarian | 11,467 | 2,867 | 7,256 | 8 / 4,211 |

Explorer with a gpt, codex or sonnet model id differs from `mock-alpha` by under
20 characters (the subagent base prompt varies; the tools do not).

## Largest contributors

Tool sizes are the full definition; the description alone is in brackets.

- **Headless root:** `run_code` 8,616 [7,573], `run_subagent` 5,972 [2,280],
  `search_replace` 2,043 [1,131], `read_file` 1,255, `shell` 1,243, `create_file` 843.
  The system prompt is 1,251 in total. Tools are 94% of the prefix.
- **`--goal`:** adds `goal_check` 1,977 [854] and a 1,536-character goal section.
- **TUI root:** `run_code` 8,748, `run_subagent` 5,972, `shell` 2,430 (background and
  monitor options appear only with a background job registry), `session_rollover`
  2,341 [1,685, TUI only], `search_replace` 2,043. The TUI has no "Unattended mode"
  paragraph, so its system prompt is smaller than headless.
- **Explorer:** `web_search` 1,840, `shell` 1,729, `grep` 1,456, `glob` 1,405;
  prompt sections Approach 1,190, Persistent memory 1,118, Available Tool Guidance 970.
- **Worker:** `search_replace` 1,998 (or `apply_patch` 2,564 for gpt), `shell` 1,729,
  `grep`, `glob`; prompt sections Final Report 1,531, Persistent memory 1,118.
- **Librarian:** prompt sections History retrieval 1,488 and Memory librarian 1,236
  dominate; the largest tool is `memory_update` 870.

Prompt sections are split at Markdown headings and lone XML-style tags, a heuristic:
a role body without its own heading is counted in the section before it (the
mentor's 1,027-character "Worktree Hygiene" section is mostly the mentor role text).

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

## Changes since the first snapshot

Lossless deletions only: text repeated elsewhere in the same request, or addressed
to a tool the recipient's offered tool list lacks. Every change below was checked
as a pure character deletion against a `--dump` of the parent build.

- **Subagents, from the offered tool names** (`buildInstructions` in
  `src/delegation/subagents/role-loader.ts`): a child with a file editor drops the
  Worktree Hygiene "Read-only roles" line; a child that cannot write files (no
  editor, `shell`, `run_code` or `run_subagent`) drops both "Worker roles" lines and
  the "or editing" of its `read_file` guidance; one that also has no memory writer
  drops "When an in-scope edit is already authorized, perform it with the editing
  tool without asking again." A child without `ask_orchestrator` (a foreground
  child, such as the reviewer's explorer, 553 characters smaller) drops its role's
  "Asking the orchestrator" section. Explorers keep everything: their `shell` is
  read-only by policy, which the tool list does not show.
- **Repeated sentences:** the foreground `shell` `timeout_ms` advice (explorer and
  worker, 132); `run_subagent`'s `task` explorer sentence and `worktree` "create it
  first" sentence (every root, 257); `run_explorer`'s parallel and breadth-or-depth
  sentences, which `reviewer.md` states; four `LIBRARIAN_GUIDANCE` sentences that
  `librarian.md` states.
- Mentor 313 smaller, reviewer 389, librarian 408, `agent_spec` 324, worker 223.

## Observations (not acted on)

These need rewording or a product decision, so they are outside lossless deletion.

- **Librarian:** `librarian.md` says "Inside `run_code`, you have" and names
  `tools.memory_*(...)`, but the librarian is offered the memory tools directly and
  no `run_code`.
- **Mentor:** its base prompt says "use the available tools deliberately", and it has
  no tools.
- **`run_subagent`** repeats the child tool enum in `agent_spec.tools` and
  `agent_spec.permissions.tools`. Its three background sentences overlap, but each
  carries something the others lack ("running handle", "do not duplicate them",
  "end the turn"). It mentions `get_subagent_result`, which both measured roots reach
  as a `run_code` script tool.
- **`--goal`:** the goal section and the `goal_check` description share about 400
  characters ("Reporting achieved proposes completion ...").
- **`run_code`'s "Agent capability"** section (1,725 characters of the headless description) is worded
  "when present"; a scripted probe in the headless root found the `agent` global
  present, so it is not advertised-but-missing there.
