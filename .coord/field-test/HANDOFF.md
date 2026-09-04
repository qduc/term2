# Handoff: `run_code` / code-mode field test and improvements

**Written 2026-09-04.** Everything below is on disk; nothing important lives
only in session context. Read this before touching `run_code`, the scripted
tool boundary, or the field-test harness.

## The one idea that matters

**A cap that protects model context must not apply to a value the model never
sees.** A scripted (`run_code`) tool result goes to the script, which reduces
it; only the script's *return* value reaches context, and that is capped
separately. Applying a context cap one layer deeper truncates the script's
*input*, and does it politely — in prose — so the script computes a
confidently wrong answer with no error.

This class was found **four** times: `read_file` byte cap, `glob` result cap,
`code_context_search` result cap, and `trimToolOutput`'s `String()` coercion.
It was then found a **fifth** time: `grep`'s 50-match cap (branch `e6-grep`,
see below). Enforcement lives in `isScriptedToolCall` /
`resolveResultMaxBytesForCall` (`source/utils/output/bound-tool-result.ts`),
with the marker set by `run_code` at nested dispatch. A full sweep of the
remaining script-reachable tools found no sixth instance, but the class has
now been wrong five times — **check any new cap against it.**

## Merged to main

| commit | what |
| --- | --- |
| `6a968d69` | E1 — `read_file` scripted byte cap; `scripted` marker on `ToolInvocationContext`; split the sandbox size error to report actual bytes vs limit |
| `cdc9719f` | E2 — `glob` scripted result cap (50 → 5,000) |
| `201e61d4` | E3 — cap audit: `web_fetch`, `code_context_search`; shared predicate |

`memory-tools` and `session-browser-tools` were **deliberately left alone**:
they fail loudly with `{"error":{"code":"output_budget_exceeded"}}` rather than
returning a plausible partial. A machine-readable failure is correct.

## Not merged (both ready; held only for E5)

Both branches below are validated and merge-ready. They are held because
`e5/run.sh` resets each cell worktree to `main` before running, so merging
either one mid-E5 would change the baseline under the remaining cells.
**Merge both once the E5 grid is complete.**

- **`e4-shape` (`6fa27d36`)** — structured scripted returns for `glob`,
  `read_file`, `code_context_search`, plus `scriptedReturnShape` in the tools
  header, plus the `trimToolOutput` scripted bypass.
  **Unblocked 2026-09-04:** the clean re-run landed. Requests per run
  (shape-discovery proxy) went **7/5/12 (before) -> 2/3/3 (after)** for
  ds/muse/glm; the broken build had been 13/46/18. All three models returned
  the same correct table and cited the structured fields directly. Full
  write-up and session ids: `.coord/field-test/e4/RESULTS.md`. The
  quarantined `*-broken.out` cells predate the fixed 16:37 dist.

- **`e6-grep` (`e70794ad`)** — the fifth cap instance. `grep`'s `execute` did
  not accept `context` at all, so it could not see the scripted marker;
  every call got the flat 50. Scripts also received two layers of *prose*
  inside the match list (`trimOutput`'s mid-list "[N lines trimmed]" and the
  trailing "Note: N lines exceed...") that a script splitting on newlines
  reads as data — so the fix lifts the character cap for scripted calls too,
  not just the line count. Regression test drives the real
  `run_code` -> sandboxed-host -> `grep.execute()` path in
  `scripted-e2e.test.ts`. 28/28 pass, typecheck clean, verified independently.

  Surfaced while fixing: **`trimOutput` keeps 40% head + 40% tail, so the
  "50-line limit" actually delivered 40 lines.** Pre-existing behavior, not
  introduced by the fix, but the tool description has been overstating it.

  Audit of remaining script-reachable tools found **no sixth instance**.
  `web_search`, `worktree`, `create_file`, `search_replace`,
  `session_rollover` carry no result caps; `memory` / `session-browser` fail
  loudly and are correct as-is. One deferred: `apply-patch.ts:705,779`
  (`slice(0, 3)` / `slice(0, 5)` in diagnostic prose) is self-announcing and
  advisory — not this class unless a script ever parses apply_patch
  diagnostics for correctness.

## In flight (leave running)

**E5 — paired codemode vs no-codemode.** herdr pane `w13:pH`, tab `e5-bcd`.
Answers: *does codemode improve quality, speed, or cost?*

- Baseline build: `.worktrees/e5-nocodemode` (detached at `ab5938cb` =
  `2ab57206^1`, the pre-change main that already contains the sandboxed host,
  so the comparison isolates the surface reduction).
- Codemode build: `.worktrees/e4-shape/dist`.
- 18 cells: tasks D (web), B (seeded bug), C (refactor) x 3 models x 2 arms.
- Harness: `.coord/field-test/e5/{run,reset,report,tokens}.sh`. `run.sh` resets
  the cell worktree to main and re-seeds task B's bug per run, then records the
  traffic session id to `out/sessions.tsv`.
- Read results with `.coord/field-test/e5/report.sh`.

**Task A was dropped** from E5: it took 1627s for deepseek in round 2 and timed
out at 1500s here, so six A cells would burn hours to re-confirm what round 2
already showed. If reinstated, use a timeout above 2400s.

## Findings that are settled

1. **Cost: codemode saves 2,932 prompt tokens per request (−15.8%)** on
   identical input — 18,602 (27 tools) vs 15,670 (9 tools). The real surface
   reduction is **27 → 9**, not the 14 → 9 the plan docs claim.
2. **The coding loop never goes through `run_code`, by design.** Every file
   tool has `canRequireApproval: true` and so stays directly callable. Only
   web / memory / session-browser tools became script-only. Verified against
   `isDirectlyCallable`.
3. **Models use `run_code` exactly when they need it.** E3: given a task
   requiring a script-only tool (web), 3/3 models called `run_code`
   immediately, first call, no shell attempt. Given ordinary file work, 3/3
   used direct tools. Round 2's near-zero usage was task selection (A/B/C are
   all file work), not a defect. **Do not "fix" this with prompt changes.**
4. **Concern 7 (silently wrong results) is confirmed**, twice — see the class
   above.
5. **Round 2 quality was good in both arms**: all three models found the same
   real `canRequireApproval` defect, found task B's seeded off-by-one with
   regression tests that genuinely fail without the fix, and did task C with
   `shell.test.ts` untouched and 79/79 passing.

## Claims that were WRONG — do not reintroduce

- **"`not directly callable` fires 1–8 times per run, so models hit the
  restriction and switch to `shell`."** False. My analyzer matched that string
  in *tool results containing the source of `run-code.ts`*, because task A
  audits `source/tools`. Corrected count: **zero** refusals. Six of nine round-2
  runs made no `run_code` call at all and could not have seen it.
- **"`create_file` corrupts payloads over ~34KB, newlines → commas."** False.
  60KB round-trips byte-for-byte; the comma signature is
  `Array.prototype.toString()`, and an array where a string is required is
  rejected by schema validation first.
- **"in-script `read_file` returns a char-indexed object."** False; it returns
  a string.
- Two of three model-reported "defects" were fabrications. **Model reports are
  leads, not findings.**

## Traps that cost real time

- **`pgrep`/`pkill -f "<pattern>"` matches your own monitor and shell.** It
  killed two monitors and a wait loop. Match on something narrower.
- **zsh does not word-split an unquoted `$spec`** — `set -- $spec` passes the
  whole string as `$1`. Pass runner args explicitly.
- **Parallel runs starting in the same second share one provider-traffic
  directory.** Group by `sent.sessionId`. `index.jsonl` lags and its
  `latestModel` reflects only whichever session wrote last.
- **Two wire shapes:** muse uses Responses (`body.input[].type ==
  "function_call"`), deepseek/glm use Chat Completions
  (`body.messages[].tool_calls[]`).
- **A worktree's `.git` is a file, not a directory** — `[ -d "$w/.git" ]` fails.
- **`pnpm test:lane` does not typecheck.** A type error reached main this way.
- **Do not put live repo-wide searches in a lane-manifest test file**; it
  destabilises unrelated tests' timing. Use a temp fixture.
- **The harness's background-task memory guard** kills long runs based on
  whole-host pressure from other agents; the kernel OOM killer never fired.
  Run long jobs in herdr panes instead.
- **A unit test that calls `tool.execute` directly bypasses the agent-factory
  wrapper**, where real coercion/trimming lives. Two bugs this session passed
  unit tests for that reason and were caught only by real runs.

## Outside review

Three opinions in `.coord/field-test/panel/OPINION-{claude,grok,codex}.md`
(brief: `panel/BRIEF.md`). `codex -m sol` is unavailable on this account
("not supported when using Codex with a ChatGPT account") — there is no
fourth opinion. All three said: do not revert, finish the cap audit first,
do not touch prompts until a task actually requires a script-only tool.

## Open questions

- **Fan-out amortisation has never been demonstrated.** No task in any round
  required scripting to win. E5 can show "no regression", not "the design pays
  off". This is the justification the change was merged on.
- Part of the 2,932-token saving is spent back by `run_code`'s description,
  which carries the 25-name tools header on every request. Not separated.
- Prompt caching is prefix-dependent, so cached-token counts are not comparable
  across arms. Report raw input tokens as primary.
- `"primary tool path"` is the wrong label and should be corrected in the plan
  docs. Accurate: auto-approved tools are script-only; approval-gated and
  structurally unreachable tools stay direct.

## Cleanup owed

~33 worktrees under `.worktrees/`: `r2-*` (9), `e1-*` (4), `e5-*` (13),
`e2-glob`, `e3-caps`, `e4-shape`, `field-test`, `codemode-task`. Branches
match. `main` is clean and carries only the three merges above.
