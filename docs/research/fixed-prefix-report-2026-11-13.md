# Fixed request prefix snapshot (2026-11-13)

What the first model request carries before any conversation content: the
system prompt plus the tool definitions. Measured with
`scripts/token-prefix-report.mjs` (`pnpm prefix:report`) against the built CLI.

## Scope and how to read the numbers

- **Revision:** product source at the commit that adds this revision of the note
  (branch `prefix-round4`, parent `127f80c`), built with `pnpm build`. Earlier
  versions measured `0f3fa7f` (first snapshot), `prefix-round2` and round 3a; the
  sections after "Not captured" list what moved in each round.
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
| Headless root (`mock-alpha`, also `claude-sonnet-4-5`, `kimi-k2`) | 19,897 | 4,974 | 1,251 | 6 / 18,646 |
| Headless root, `--goal` | 23,412 | 5,853 | 2,789 | 7 / 20,623 |
| Headless root, `gpt-5.5` / `gpt-5.3-codex` | 19,173 | 4,793 | 1,163 | 5 / 18,010 |
| TUI root (`mock-alpha`, also sonnet, kimi) | 23,288 | 5,822 | 982 | 7 / 22,306 |
| TUI root, `gpt-5.5` / `gpt-5.3-codex` | 22,564 | 5,641 | 894 | 6 / 21,670 |
| Subagent `agent_spec` (no role) | 5,717 | 1,429 | 1,695 | 3 / 4,022 |
| Subagent explorer | 18,903 | 4,726 | 6,292 | 13 / 12,611 |
| Subagent worker | 19,361 | 4,840 | 6,988 | 13 / 12,373 |
| Subagent worker, `gpt-5.5` / codex | 19,139 | 4,785 | 6,987 | 12 / 12,152 |
| Subagent mentor | 2,357 | 589 | 2,357 | 0 / 0 |
| Subagent reviewer | 3,437 | 859 | 3,143 | 1 / 294 |
| Subagent librarian | 9,798 | 2,450 | 5,587 | 8 / 4,211 |

Explorer with a gpt, codex or sonnet model id differs from `mock-alpha` by under
20 characters (the subagent base prompt varies; the tools do not).

## Largest contributors

Tool sizes are the full definition; the description alone is in brackets.

- **Headless root:** `run_code` 7,715 [6,721], `run_subagent` 5,594 [2,081],
  `search_replace` 2,043 [1,131], `shell` 1,243, `read_file` 1,208, `create_file` 843.
  The system prompt is 1,251 in total. Tools are 94% of the prefix.
- **`--goal`:** adds `goal_check` 1,977 [854] and a 1,536-character goal section.
- **TUI root:** `run_code` 7,847, `run_subagent` 5,594, `shell` 2,430 (background and
  monitor options appear only with a background job registry), `session_rollover`
  2,341 [1,685, TUI only], `search_replace` 2,043. The TUI has no "Unattended mode"
  paragraph, so its system prompt is smaller than headless.
- **Explorer:** `web_search` 1,840, `shell` 1,729, `grep` 1,456, `glob` 1,405;
  prompt sections Approach 1,190, Persistent memory 1,118, Worktree Hygiene 812.
- **Worker:** `search_replace` 1,998 (or `apply_patch` 2,564 for gpt), `shell` 1,729,
  `grep`, `glob`; prompt sections Final Report 1,531, Persistent memory 1,118.
- **Librarian:** prompt section History retrieval 1,380 is the largest; Memory
  librarian is 290 (it was 1,236 before round 4). The largest tool is `memory_update` 870.

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

## Round 2: changes since the first snapshot

Lossless deletions only: text repeated elsewhere in the same request with no
narrower meaning, or addressed to a tool the recipient was not offered. Only a
tool's absence is proof; being offered a tool is not (an editor can be offered
with an empty write scope). Only Term2-authored text is edited: parent- or
user-written text (an `agent_spec`'s constraints, completion criterion and
context, project instructions) is sent exactly as written. Every change below was
checked as a pure character deletion against a `--dump` of the parent build.

- **Subagents, from the offered tool names** (`buildInstructions` in
  `src/delegation/subagents/role-loader.ts`): a child that cannot write files (no
  editor, `shell`, `run_code` or `run_subagent`) drops both Worktree Hygiene
  "Worker roles" lines and the "or editing" of its `read_file` guidance; one that
  also has no memory writer drops "When an in-scope edit is already authorized,
  perform it with the editing tool without asking again." A child without
  `ask_orchestrator` (a foreground child, such as the reviewer's explorer, 553
  characters smaller) drops its role file's "Asking the orchestrator" section; an
  `agent_spec` child's parent-written instructions are never searched for it.
  Explorers keep everything: their `shell` is read-only by policy, which the tool
  list does not show. Every child keeps the "Read-only roles" line.
- **Repeated sentences:** the foreground `shell` `timeout_ms` advice (explorer and
  worker, 132); `run_subagent`'s `worktree` "create it first" sentence (every root,
  94); `run_explorer`'s parallel and breadth-or-depth sentences, which `reviewer.md`
  states; four `LIBRARIAN_GUIDANCE` sentences that `librarian.md` states.
  `run_subagent`'s `task` explorer sentence is kept: the description's Task
  Requirements are narrower than "recommendations, or the parent task itself".
- Roots 94 smaller, mentor 313, reviewer 389, librarian 408, `agent_spec` 324,
  worker 132, explorer 132.

## Observations (not acted on)

These need rewording or a product decision, so they are outside lossless deletion.

- **Librarian** (resolved in round 3b, `9137818`): `librarian.md` said "Inside
  `run_code`, you have" and named `tools.memory_*(...)`, but the librarian is offered
  the memory tools directly and no `run_code`.
- **Mentor** (resolved in round 3b, `3ada6f8`): its base prompt said "use the
  available tools deliberately", and it has no tools.
- **`run_subagent`** repeats the child tool enum in `agent_spec.tools` and
  `agent_spec.permissions.tools` (a schema matter, left alone). Its three background
  sentences were merged into one paragraph in round 3b (`1ae29e5`). It mentions
  `get_subagent_result`, which both measured roots reach as a `run_code` script tool.
- **`--goal`:** the goal section and the `goal_check` description share about 400
  characters ("Reporting achieved proposes completion ...").
- **`run_code`'s "Agent capability"** section (1,725 characters of the headless description) is worded
  "when present"; a scripted probe in the headless root found the `agent` global
  present, so it is not advertised-but-missing there.

## Round 3a: run_code and read_file rewording

The product owner approved non-lossless rewording for these two tools: the
wording may change, every instruction, limit and failure rule must stay. Measured
with `pnpm prefix:report` on the parent build and on the round's build.

- **`run_code`** (description, parameters, catalogue, Agent capability): 8,616 to
  7,639 characters in the headless root (-977, 11.3%); 8,748 to 7,771 in the TUI;
  8,157 to 7,325 for `gpt-5.5` / codex. The largest single cut is the catalogue no
  longer repeating a clipped description for essential tools that are also offered
  directly (`read_file`, `create_file`, `search_replace`, `apply_patch`); see
  `docs/plans/tools/run-code/run-code-authoring-friction.md`.
- **`read_file`**: the line-range advice is stated once instead of on both
  `start_line` and `end_line` (-53 in every request that offers `read_file`), and its
  scripted return guidance no longer repeats field types.

| Scenario | Before | After |
| --- | ---: | ---: |
| Headless root (`mock-alpha`, sonnet, kimi) | 21,223 | 20,193 |
| Headless root, `--goal` | 24,738 | 23,708 |
| Headless root, `gpt-5.5` / codex | 20,354 | 19,469 |
| TUI root (`mock-alpha`, sonnet, kimi) | 24,614 | 23,584 |
| TUI root, `gpt-5.5` / codex | 23,745 | 22,860 |
| Subagents offered `read_file` (generic, explorer, worker, all model ids) | | 53 smaller each |
| Mentor, reviewer, librarian | | unchanged |

The 25% target for `run_code` was not reached: most of its remaining text is
distinct instructions (each mapped in the round's handoff), and the rest is the
generated signatures and return types, which must stay exact.

The round 3a "After" figures were measured before `1e30223`, which restored four
sentences whose meaning the rewording had shifted (the `start_line` range advice,
`Promise.allSettled` for independent reads, large artifacts beyond saved output,
and tools that reject without an approval prompt). At `45c3264` plus that fix the
headless root measured 20,356, not 20,193.

## Round 3b: subagent prompts and `run_subagent`

Measured with `pnpm prefix:report` at `45c3264` (round 3a, including `1e30223`'s
restorations) and at `894d720`.

- `1ae29e5`: `run_subagent`'s three background sentences and the `execution` note
  merged into one paragraph, the `task` parameter's explorer limits moved into Task
  Requirements, and repeated field lists dropped (every root, -543 at that commit).
- `f35a14f`: a child without `ask_orchestrator` keeps "Do not contact the user
  directly." where the deleted "Asking the orchestrator" section was.
- `9137818`: `librarian.md` names the memory and session tools as offered, not as
  `tools.*(...)` inside `run_code`.
- `115f00e`: the skills-pause rule is stated for delegated readers only (only
  subagents receive that fragment).
- `3ada6f8`: a child offered no tools (the mentor) loses "use the available tools
  deliberately" or "careful tool use" from its base prompt.
- `e3dd7aa`: the "Registered tools" line no longer lists the tool names the request
  already carries.
- `225b91a` was **reverted** by `894d720`. It treated a subagent whose only
  possibly-writing tool was the wrapped read-only shell as unable to write files,
  and dropped its worker hygiene lines and editing guidance. The premise is false:
  the read-only shell admits commands that write files (`sort -o`, `uniq` with an
  output file, `sed`'s `w`, `git --output=`), and the marker was also set on the
  writable worker's shell. A wrapped shell is not proof that a child cannot write,
  so `shell` stays outside the non-writing tool set.

| Scenario | Round 3a | `894d720` |
| --- | ---: | ---: |
| Headless root (`mock-alpha`, sonnet, kimi) | 20,356 | 19,897 |
| Headless root, `--goal` | 23,871 | 23,412 |
| Headless root, `gpt-5.5` / codex | 19,632 | 19,173 |
| TUI root (`mock-alpha`, sonnet, kimi) | 23,747 | 23,288 |
| TUI root, `gpt-5.5` / codex | 23,023 | 22,564 |
| Subagent `agent_spec` | 5,849 | 5,767 |
| Subagent explorer | 19,150 | 18,903 |
| Subagent worker | 19,614 | 19,361 |
| Subagent mentor | 2,586 | 2,357 |
| Subagent reviewer | 3,788 | 3,713 |
| Subagent librarian | 11,467 | 10,945 |

## Round 4: same-request duplication in librarian, reviewer and `agent_spec` children

Same rule as round 2, with meaning-preserving rewording allowed: every instruction a
recipient received must still be in the same request, no narrower and no broader;
only Term2-authored text changes; tool schemas (names, types, enums,
required-ness) are unchanged. Each deletion was checked against a `--dump` of
`894d720`.

- **`LIBRARIAN_GUIDANCE`** (`src/tools/memory/memory-capabilities.ts`, -946). Its
  only audience is a librarian child: `buildInstructions` is the only caller that
  builds memory capability for a subagent, an `agent_spec` child has role `agent`
  and no memory, and every librarian definition comes from `librarian.md`. So the
  guidance is always sent beside that role file. Dropped: the identity line, the
  general and per-task procedures, mutation-only-on-request and the citation rule
  (all in `librarian.md`), and the write tools' `scope` parameter (required in their
  schemas). Kept: the shared public memory API, that read tools span both scopes
  (`memory_get`'s description does not say so), and presenting the reviewable
  proposal before any mutation.
- **`librarian.md`** (-151): the history-retrieval and maintenance summaries no
  longer repeat their own numbered steps (discard irrelevant material, flag
  contradictions or staleness; recommend create, update, merge, retain or delete).
- **`run_explorer`** (reviewer, -226): only the reviewer is offered it, always beside
  `reviewer.md`, whose Capabilities and Approach sections state what the description
  and `task` parameter said. The description keeps "Start a read-only explorer
  subagent." and the parameter "Self-contained evidence request."
- **"Code-context tools are not available in this run."** (`buildInstructions`,
  -50 for every child offered some tools but neither code-context tool; measured on
  `agent_spec`, reviewer and librarian): the section's first line already says that
  a tool not offered is not available. A child with no tools (the mentor) never got
  the line.

| Scenario | `894d720` | Round 4 |
| --- | ---: | ---: |
| Subagent `agent_spec` | 5,767 | 5,717 |
| Subagent reviewer | 3,713 | 3,437 |
| Subagent librarian | 10,945 | 9,798 |
| Roots, explorer, worker, mentor | | unchanged |

Not applied (proposals; each needs rewording or a product decision):

- The "Available Tool Guidance" line "No dedicated workspace search tool is
  available. Use provided context where possible." overlaps the reviewer's "You
  cannot read files, search, ..." and the librarian's "You have no filesystem, shell,
  or web access", but adds "use provided context", so it stays.
- `reviewer.md`'s "Do not modify anything." and the Worktree Hygiene "Read-only
  roles ... never modify files" overlap; the role line is broader (anything, not
  files) and the hygiene line adds "treat dirty files as the current source of
  truth", so neither is a pure duplicate.
- `librarian.md`'s "Cite every claim" principle and its brief's "A source for every
  claim" overlap; the principle also covers maintenance reports.
