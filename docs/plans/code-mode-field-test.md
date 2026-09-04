# Field test: `run_code` as the primary tool path

> **Status 2026-09-04: the title is inaccurate.** `isDirectlyCallable` keeps
> every approval-gated tool directly callable, so the whole file-editing loop
> never goes through `run_code`; only web, memory and session-browser tools
> became script-only. Measured surface reduction is **27 → 9** tools, not the
> 14 → 9 stated below. Session state, corrections and open questions:
> `.coord/field-test/HANDOFF.md`. Improvements and experiments:
> `docs/plans/code-mode-improvements.md`.

Status: **Merged to `main` (`2ab57206`, 2026-09-04). Never exercised by a real
model.** Everything verified so far is structural — tests prove no tool was
deleted and no prompt contradicts the code. Nothing proves a model can *work*
this way.

You are picking this up cold. Read this before designing the test, and treat
each concern below as a hypothesis to confirm or kill, not a warning to respect.

## What changed, in one paragraph

The model's direct tool list went from 39 definitions to 14. A tool is directly
callable only if a script structurally cannot reach it (`shell`, `bash`,
`ask_user`, `run_subagent`, `run_agent_workflow`, `session_rollover`,
`ask_mentor`, `run_code`) or if its approval depends on its parameters
(`read_file`, `grep`, `glob`, `create_file`, `search_replace`,
`read_code_outline`, `code_context_search`, `apply_patch` on gpt-5 models) — that
second group is reachable both ways. The other 25 are reachable *only* as
`tools.<name>(params)` inside a `run_code` script. Separately, a script's
**return value** is now the result the model receives; `console.log` became a
debug trace, suppressed on success unless `include_console: true`, included on
failure.

Read `source/tools/system/run-code/run-code.ts` and
`source/lib/agent-factory.ts` (the `isDirectlyCallable` filter at the end of
`buildAgentTools`) before testing. `docs/plans/sandboxed-code-host.md` covers the
host underneath.

## How to observe

Use the `provider-traffic` skill to read what was actually sent and returned;
the model-facing tool list and every `run_code` argument are in those artifacts.
`debugging-logs` locates them. Do not infer behaviour from the rendered
conversation alone — the interesting failures are in what the model *tried* to
call.

## Concerns, most likely to bite first

### 1. The model does not return a value

**The single highest risk.** Every model has years of prior exposure to
"print your results", and we just inverted that. If it writes a script ending in
`console.log(result)` with no `return`, it gets back:

> `Script returned no result. Return a value from the script to send it to the model.`

and has to retry, having spent a full script execution.

Measure the rate of that message across a real session. A low rate means the
description works. A high rate means the description is losing to the model's
prior, and the fix is prompt wording, not code. Check whether it self-corrects
on the second attempt or repeats the mistake — a model that never learns from
that message is a much worse result than one that recovers.

### 2. Script-only tools are never discovered

25 tools appear in the header as **names only**. The model must either infer the
parameters or call `tools.describe(name)` for the schema.

Three distinct failure modes, and they need distinguishing:
- It calls `describe` and proceeds — working as designed.
- It guesses parameters and gets a Zod validation error — costs a round trip but
  is self-correcting. Count how often the guess is right.
- It never uses those tools at all, and silently does without memory, session
  search, or web search because it cannot see how to call them. **This is the
  dangerous one**, because nothing errors. Compare against a baseline session on
  the pre-change surface: if memory and session tools stop being used, the
  namespace is not discoverable enough.

### 3. It calls tools that are no longer in the payload

Prompts were rewritten and a guard test now fails if a fragment names a
script-only tool directly, but the model's own prior may still produce e.g. a
bare `web_search` call. Look for tool calls the provider rejects or that arrive
as hallucinated names. Any occurrence points at a prompt fragment we missed or
at a model prior strong enough to need explicit correction.

### 4. Over-scripting trivial work

Reading one file is now `run_code` with a worker spawn, a vm context, and a
script the model had to write — versus one direct `read_file` call. Note that
`read_file` is *also* still direct, so the model has a choice; the question is
which it picks. Measure latency and token cost for single-tool turns against the
baseline. If it wraps every one-shot read in a script, we have made the common
case worse to improve the rare one.

### 5. Under-scripting — the loop advantage is never taken

The mirror image, and the one that would make this change pointless. The
justification for the whole design is fan-out: read 50 files, grep across a tree,
aggregate without putting intermediates in context. If the model keeps issuing
serial direct `read_file` calls because that is what it has always done, we paid
the discovery cost for nothing. Count multi-call scripts versus serial direct
calls on tasks that obviously want a loop.

### 6. Approval dead-ends and whether it recovers

A gated call inside a script (`create_file` outside the workspace, say) is
refused with advice to call it directly. That advice is now conditional on the
tool actually being directly callable. Verify the model follows it rather than
retrying the same script, and that the refusal text is comprehensible enough to
act on. A retry loop here burns a script execution per attempt.

### 7. Failure diagnosis with the trace

On failure the model gets the error plus the console trace. Check that this is
enough to fix a broken script: does it debug from the trace, or rewrite blindly?
This is the case where suppressing console on success has a cost — a script that
succeeds but does the *wrong thing* returns a clean value with no evidence of how
it got there. Watch for silently wrong results, not just errors.

### 8. Truncation of large returns

The final result is clipped at 30,000 characters, with the answer assembled
before any trace so noise cannot displace it. A 50-file fan-out returning full
contents will still hit the cap. Does the model return concise aggregates, or
does it return everything and lose the tail? There is no spooling or retrieval
path for a large return value — if this bites often, that absence is the finding.

### 9. JavaScript competence inside the sandbox

No timers (`setTimeout` is absent — this surprised the implementer, so it will
surprise a model), no `require`, no `eval`, no filesystem, no network. Only
`tools.*` and `console`. Watch for scripts that reach for any of those. Also
watch for genuine JS errors: this is now the model's primary interface, so its
ability to write correct async JavaScript on the first try is load-bearing in a
way it was not before.

### 10. Parallelism

`Promise.all` over `tools.*` calls works, bounded at 8 concurrent, but only for
tools declaring `parallelSafe`; others take a serial lane of one. Does the model
use concurrency at all? Does it try, and get serialized without understanding
why? The call budget is 200 per script.

### 11. Provider prompt-cache behaviour

The tool list is part of the request, so it changed shape. Confirm tool ordering
and identity are stable turn-to-turn — any per-turn variation invalidates the
cache on every request and would show up as a cost regression rather than a
correctness one. This is worth checking early because it is cheap to check and
expensive to miss.

## What would justify reverting

Be willing to conclude this was wrong. Concrete triggers:

- Tasks that succeeded on the old surface now fail, and the cause is the surface
  rather than an incidental bug.
- Capability silently disappears — script-only tools stop being used and the
  model does not notice it is missing them (concern 2).
- Cost or latency gets worse on ordinary single-tool turns without a
  corresponding win on fan-out.

The change is one merge commit (`2ab57206`) plus the host merge before it
(`ab5938cb`), so reverting the surface reduction without losing the shared host
is straightforward.

## Deliberately open, not defects

- `canRequireApproval` is hand-maintained metadata on tool definitions. A new
  parameter-dependent tool that forgets the flag is refused inside scripts and
  absent from the direct set. A test catches the class today; a future tool
  could still slip if the test's assumptions drift.
- Profiles without `run_code` (any profile without the `shell` capability) skip
  the filter entirely and keep the full 38-tool direct surface. Intended: the
  reduced surface is only offered when the script path exists. Test at least one
  no-shell profile to confirm it still behaves.
- The vm context is a realm-isolation seam, **not** an OS boundary. Do not treat
  a passing field test as evidence about hostile code.

---

## Round 1 results (2026-09-04)

**Bottom line: no revert trigger fired.** 12 non-interactive runs (6 tasks x 2
model lanes) on a build of the merge commit, all exit 0, all answers verified
correct against ground truth. Raw outputs in `.coord/field-test/`; traffic under
`~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-04/`.

Lanes: `codex` / `gpt-5.6-luna` (default) and `openrouter` /
`anthropic/claude-sonnet-5`. Tasks: trivial read, file fan-out, web search
(script-only tool), per-file aggregation, write outside the workspace, memory
search (script-only tool).

### Concerns settled

- **1 — no return value: not observed.** `Script returned no result` appears
  zero times across all 21 session dirs from the run. Both models returned
  values from scripts on the first attempt.
- **2 — script-only tools undiscovered: not observed, both mechanisms worked.**
  Luna called `tools.describe` before using a script-only tool; Sonnet called
  `memory_search` and web search inside a script without describing first, and
  got the parameters right. Zero Zod/validation errors anywhere. The dangerous
  silent-omission mode did not occur: on both memory and web tasks the model
  reached for the script-only tool rather than doing without.
- **3 — calls to absent tools: none.** No hallucinated or rejected tool names.
- **4 — over-scripting: not observed.** Both lanes used direct `shell` /
  `read_file` for the trivial read and for ordinary file work, reserving
  `run_code` for tasks needing script-only tools. That is the intended split.
- **6 — approval dead-end: not exercised.** Writing to `/tmp` succeeded on both
  lanes (Sonnet went direct via `create_file`), so the refusal path never
  triggered. Needs a task that actually gets refused.
- **9 — JS competence: clean.** No `is not defined`, no `not a function`, no
  reach for `require`/`setTimeout`.
- **11 — prompt-cache stability: clean.** The tool list is byte-identical across
  every request within a session (1 distinct list per session, all lanes).

### Open after round 1

- **5 (loop advantage) and 10 (parallelism) were not tested.** Both models
  solved the fan-out and aggregation tasks with a single `shell` pipeline
  instead of either a script loop or serial reads — efficient, but it means the
  fan-out justification is still unmeasured. A task that `shell` cannot solve in
  one pipeline is needed.
- **7 (silently wrong results) and 8 (truncation) untested** — no script failed
  and no return approached 30,000 chars.

### Discrepancy found: the direct tool list is smaller than documented

The plan says 14 directly callable tools. Observed:

- `openrouter` / `claude-sonnet-5` — **9**: `shell`, `read_file`, `grep`,
  `glob`, `create_file`, `search_replace`, `ask_mentor`, `run_subagent`,
  `run_code`.
- `codex` / `gpt-5.6-luna` — **6**: `shell`, `read_file`, `apply_patch`,
  `ask_mentor`, `run_subagent`, `run_code`.

Neither lane carries `bash`, `ask_user`, `run_agent_workflow`,
`session_rollover`, `read_code_outline`, or `code_context_search`. This is
probably conditional registration rather than a defect, but the plan's "14"
is not what a real request contains, and the codex lane in particular is
narrower than the openrouter one. Confirm against `buildAgentTools` before
citing 14 anywhere else.

### Method note

Runs are reproducible via `.coord/field-test/run.sh <label> [term2 args]`
against a build in `.worktrees/field-test`. Each task runs in its own
non-interactive session, so one session dir maps to one task.

## Round 1.5 results (2026-09-04) — one real task, interactive

Round 1 used synthetic tasks. This round ran a single real task to completion
on `codex` / `gpt-5.6-luna`, interactively, with approvals live: *audit
`canRequireApproval` across `source/tools`*. It produced commit `9d3c321d` on
branch `codemode-task` — 14 files, 595 tests passing, typecheck clean — so the
task succeeded. The interest is in how it got there.

Tool mix: **10 `run_code`, 38 `shell`, 30 direct reads, 1 subagent, 13 tool
failures.** ~$0.35, 215k context.

### Concern 6 — approval dead-ends: recovers, but not on the first try

Refused in-script approval did not strand the run, so the dead-end hypothesis
is dead. Recovery was indirect: `describe` → a `python3 -c` shell
string-replace (which failed) → a direct `apply_patch` that worked. It reaches
for the shell before it reaches for the tool the harness intends.

### Concerns 5 and 8 together — the size cap eats the design's main benefit

The sharpest finding of the round. A 19-file fan-out — exactly the shape
`run_code` exists to make cheap — died on:

```
Script output must be JSON-safe and within the configured size limit
```

and the model fell back to **19 serial direct reads**. So the one case where
scripting clearly beats direct calls is the case the cap rejects, which
converts the design's headline benefit into its baseline. Two things make this
worse than a tuning problem:

- The error names **no size and no offending field**, so the model cannot tell
  whether to shrink the payload, drop a field, or chunk the fan-out. It has no
  gradient to follow, and it abandoned scripting entirely rather than retry
  smaller.
- Concerns 5 and 8 are not independent. Under-scripting (5) is partly *caused*
  by truncation (8): the model learns within a session that big scripts fail.

This is the most actionable finding so far. Fixes worth considering: put the
limit and the actual size in the message, name the field that blew the budget,
and suggest chunking.

### Unprompted scope expansion

Two behaviours worth noting because neither was asked for: it silently
rewrote the `isDirectlyCallable` doc comment to **broaden the stated
invariant**, and it committed without being asked. The doc edit is the
concerning one — a model widening a written invariant to match what it just
did will make the next reader's job harder.

## Round 2 results (2026-09-04) — three tasks x three models

Nine non-interactive runs on `opencode`: `deepseek-v4-flash`,
`muse-spark-1.3-contributor`, `glm-5.3-flash`. Tasks: **A** the
`canRequireApproval` audit (same task as round 1.5, for a cross-model read),
**B** a seeded off-by-one in `output-trim.ts` presented only as a symptom,
**C** a pure refactor extracting shell approval logic. Briefs in
`.coord/field-test/r2/`, runner `run.sh`, log analysis `analyze.sh`.

All nine runs exited 0.

### The headline: `run_code` is not the primary path

| task | model | reqs | `run_code` | what it used instead |
| --- | --- | --- | --- | --- |
| A | deepseek | 18 | 1 | read_file 13, grep 8, shell 3 |
| A | muse | 57 | 2 | shell 34, read_file 26 |
| A | glm | 25 | 0 | shell 31, grep 3 |
| B | deepseek | 14 | 0 | shell 9, read_file 3, grep 3 |
| B | muse | 17 | 0 | shell 9, search_replace 4, read_file 3 |
| B | glm | 9 | 0 | read_file 4, grep 3, search_replace 2 |
| C | deepseek | 56 | 0 | shell 20, read_file 17, grep 14 |
| C | muse | 21 | 0 | shell 7, grep 6, read_file 5 |
| C | glm | 24 | 0 | shell 21, search_replace 4 |

**Three `run_code` calls across nine runs and 241 requests.** Tasks B and C
produced none at all. The models reach for `shell`, `read_file`, and
`grep`; `not directly callable` fires 1–8 times per run, so they hit the
restriction and respond by switching to `shell` rather than by scripting.

This is the round's most important result and it is consistent across three
models, three task shapes, and both wire formats. It does not by itself
trigger the revert criteria — every task still completed — but the change did
not achieve what it was for.

### Task quality was good, independent of tool choice

- **A:** all three found the same real defect — `memory_update` /
  `memory_delete` missing `canRequireApproval` — matching round 1.5's luna
  run. All three correctly identified the repo's pre-existing test failures
  and verified them against a clean tree before dismissing them.
- **B:** all three found the seeded off-by-one, and all three regression
  tests genuinely fail against the seed and pass with the fix (verified by
  re-seeding each worktree and running them: deepseek 1 test, glm 2, muse 1).
- **C:** all three extracted `source/tools/system/shell-approval.ts` —
  same filename, unprompted — and all three left `shell.test.ts` unmodified
  with 79/79 passing, as the brief required.

### muse reported a commit it never made

On task A, muse's final output ends "Committing the fix per your standing
preference". `main..HEAD` is empty and the changes sit unstaged. Real, but a
self-report reliability problem rather than a code-mode one.

### Method corrections for anyone repeating this

Three traps, each of which produced wrong data before being caught:

- **Round 1's method note is wrong that "one session dir maps to one task".**
  Parallel runs starting in the same second **share** one session directory:
  three task-A runs all landed in `06-21-17_non-i`. Aggregate by
  `sent.sessionId`, never by directory.
- **`index.jsonl` lags and its `latestModel` reflects only whichever session
  wrote last** — it labelled that three-model directory `glm-5.3-flash`.
  `sent.model` on the individual request is authoritative.
- **Two wire shapes are in play.** muse uses Responses
  (`body.input[].type == "function_call"`); deepseek and glm use Chat
  Completions (`body.messages[].tool_calls[]`). A grep-based counter that
  knows only one shape silently reports zero for the other.

A fourth trap cost a wasted launch and is worth stating plainly: **zsh does
not word-split an unquoted variable**, so `set -- $spec` passes the whole
string as `$1`. Pass run.sh its three arguments explicitly.

### A flaw in task B's design

The seeded bug was left as an **uncommitted working-tree edit**, so a model
could "fix" it by restoring the file to HEAD. deepseek and muse did exactly
that, and deepseek's commit — messaged `fix(output-trim): preserve first
character of trimmed tail` — contains **only a test, no source change**. Only
glm actually edited the line. Diff-based scoring is therefore invalid for
task B; the seed-versus-test check reported above is the trustworthy measure.
Commit the seed next time.

### Environment note

Two runs were killed mid-flight by the harness's background-task memory
guard, not by the kernel — `dmesg` records zero OOM events on a 12 GB host
with ~6 GB available and no cgroup cap. The guard measures whole-host
pressure created by other agent sessions sharing the box, so long runs are
exposed to it regardless of this test's own parallelism. glm's task-B timing
is truncated for this reason; its diff was preserved.

## Concern 7 is confirmed, and it is the important one (2026-09-04)

Round 1 recorded concern 7 (silently wrong results) as untested. It is not
untested any more — it fired twice, in two different tools, and in both cases
a model produced a confident wrong answer from a silently shortened result.

The pattern is the same both times: **a cap that exists to protect model
context was applied to a value that never reaches model context.** A scripted
result goes to the script, which reduces it; only the script's return value
is seen by the model, and that is capped separately. Applying the context cap
one layer deeper truncates the script's input instead of its output — and
does it politely, in prose, where only a human reader would notice.

- **`read_file`** bounded a scripted read to `DEFAULT_TOOL_RESULT_MAX_BYTES`
  (40,000). A 58,885-byte file arrived as 39,976 bytes with a header still
  reading `(1393 lines) [lines 1-1393]`. muse computed 878 lines for a
  1,393-line file and caught it only by cross-checking `wc -l`.
- **`glob`** returned 50 of 86 matches with the cap appended as a sentence:
  `Note: Results limited to 50 files. Found 86 total matches.` A script
  splitting on newlines reads that sentence as another path. muse therefore
  examined 33 files and missed `source/tools/system/shell.ts` — the longest
  file, and the answer to the question it was asked.

Both are fixed by a `scripted` marker on `ToolInvocationContext`, set by
`run_code` on nested dispatch (`9c406684`, and branch `e2-glob`). The general
rule this establishes, worth applying to any tool that grows a cap: **a limit
that protects context does not belong on a value the model never sees.**

### One reported defect that turned out not to exist

A run claimed `create_file` corrupts payloads over ~34KB, replacing newlines
with commas. It does not: 60KB of multi-line content round-trips
byte-for-byte. The comma signature is `Array.prototype.toString()`, and an
array passed where a string is required is rejected by schema validation
before execute. Model reports from these runs are leads, not findings — a
second run also claimed `read_file` returns "a char-indexed object", which is
also false. Both took minutes to disprove and would have been wrong in this
document forever.
