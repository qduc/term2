# Harness failures 2026-09-03 — audit

Date: 2026-09-03 (log day UTC; local +07).
Scope: `~/.local/state/term2-nodejs/logs/term2-2026-09-03.log*` (13 segments)
plus provider-traffic `2026-09-02/16-51-27_8b49b` (3023 requests, session
`8b49b1ea-9cbe-4615-8b7f-71a0422e1f26`, test-audit calibration on DeepSeek root
+ Codex `gpt-5.6-luna` subagents).
Status: diagnosis complete; bulk-arg diagnostic fix merged on branch
`tool-arg-runaway` (see §5); two budget calls await the user (§6).

## 1. Counts

30 error, 81 warn, 0 fatal.

| n | error |
|---|---|
| 18 | `GenerationGuardError: tool argument payload exceeded its limit` — 9 `stream.failed` + 9 paired `provider.response.failed`, 00:40–02:05 local, all `subagent-*` sessions |
| 6 | `WebSocket closed before terminal response (code=1006)` — 01:37/01:44/01:46 local, `codex/gpt-5.6-luna`, recovered via WS-to-HTTP downgrade |
| 2 | `Cannot update missing file` — `runtime-b-m3.yaml` in `.worktrees/test-audit-calibration` |
| 1 | `Patch operation failed: EISDIR, open '.worktrees/test-audit-calibration'` (dir passed as file) |
| 1 | `tool_call.parse_failed` — `search_replace` on `graph.yaml`, `arguments must be valid JSON`, session `62b1a56a` |
| 2 | `This operation was aborted` — paired failure 02:53, looks like user abort |

Warns: ~54× `Local context compaction blocked: no_complete_cold_turn`
(DeepSeek main session, benign — long single turn has no cold boundary);
10× `codex response closed`; 3× each `closed_early` / `retry.connection_interrupted` /
`conversation.chaining_broken`; 1× `hooks_disabled`.

## 2. Why the shipped runaway fix didn't bite

`ToolArgumentRunawayGuard` (merge `3a5fcb1e`, Sep 2 17:39 local) aborts chained
`codex/gpt-5.6-luna` single-`tool_result` requests that drip tiny argument
deltas (≥45 frames/s, ≤2.8 chars/frame, 60 s, no text, one unfinished call).
The 3 Sep-3 1006 drops (`18-16-43`, `18-17-53`, `18-22-17` UTC artifacts:
67–87k tool frames, ~1.1 chars/frame, zero text, 20–26 min) match that
signature almost exactly — a guard-enabled runtime aborts them at 60 s.
`dist/` was rebuilt Sep 3 **05:37 local**, after all failures (00:40–02:05 and
01:37–01:46 local). The long-running app process served every failing request
from the pre-fix build. Stale process, not a guard miss. `tool_argument_runaway`
never appears as a live trip in any log (only in the Sep-2 design session
`65dbeb3c` and incident watch `19fd0ac9`).

## 3. The remaining gap: single oversized tool argument

The 9 bulk trips are a mode the drip guard intentionally excludes: one giant
`search_replace`/`apply_patch` argument crossing the 100k single-call cap
mid-stream, in seconds — long before any 60 s drip evaluation. Largest
*completed* Luna tool arg in-window was ~25k; tripped requests died past 100k
with no success artifact. Parent session already diagnosed one correctly
(17:40 UTC DeepSeek payload: reviewer did 39 `read_file` + 19 outlines, died
mid-artifact-write) and worked around it by re-dispatching with chunked-write
instructions. Failure message carried no size/limit numbers, so the parent had
to infer them.

Fix (§5): `tool_argument_characters` failures now report observed size, limit,
and progress counters — the same survive-the-subagent-boundary pattern as the
deadline messages. Cap value and dispatch policy unchanged.

## 4. Evidence commands

```bash
LOGDIR=~/.local/state/term2-nodejs/logs
cat "$LOGDIR"/term2-2026-09-03.log* | jq -r '.level // "NOLEVEL"' | sort | uniq -c | sort -rn
cat "$LOGDIR"/term2-2026-09-03.log* | jq -r 'select(.level=="error") | (.errorMessage // .error // "" | tostring | .[0:160])' | sort | uniq -c | sort -rn
cat "$LOGDIR"/term2-2026-09-03.log* | jq -r 'select(.level=="warn" and ((.message//"")|test("compaction blocked"))) | [.reason, (.provider//"?"), (.model//"?")] | @tsv' | sort | uniq -c
# max completed Luna tool-arg per request, 17:35–19:10 local Sep 2:
D=$LOGDIR/provider-traffic/2026-09-02/16-51-27_8b49b
for F in $(ls "$D" | awk '$0 >= "17-35" && $0 < "19-10"'); do
  R=$(jq -r '[(.received.summary.payload.choices[]? | .delta.tool_calls[]? | .function.arguments | length)] | max // 0' "$D/$F")
  [ "$R" != 0 ] && echo "$R $F"
done | sort -rn | head
# error artifacts (drips): 18-16-43.020Z_24443.json, 18-17-53.235Z_e360e.json, 18-22-17.195Z_f6aee.json
jq '.received.error.diagnostics | {durationMs, eventCount, toolArgumentDeltaFrames, toolArgumentDeltaCharacters, progressCategoryCounts}' "$D/18-22-17.195Z_f6aee.json"
python3 -c "import json; a=json.load(open('/home/qduc/.local/state/term2-nodejs/settings.json'))['agent']; print({k: a.get(k) for k in ['cheapModel','cheapProvider','maxStreamOutputChars','maxModelStreamIdleMs','maxModelRequestDurationMs']})"
stat -c '%y %n' dist/services/agent-runtime/generation-guard.js dist/services/agent-runtime/application-run-loop.js
```

## 5. Fix record (branch `tool-arg-runaway`)

- Commit: `6a5098aa` on branch `tool-arg-runaway` (worktree `.worktrees/tool-arg-runaway`, NOT merged to main).
- Change: `GenerationGuard` single-argument failures (`observeToolArgumentProgress`,
  `observeToolCall`, terminal `observeCompletion`) include observed characters,
  configured limit, and cumulative progress in the message. No behavior change
  besides message text; classification (`tool_argument_characters`,
  `AmbiguousModelOutcomeError`) untouched.
- Regression test: `generation-guard.test.ts` — oversized streaming progress
  throws with size + limit in the message; fails on the old static string.
- Gates (all run in the worktree, exit 0): focused `generation-guard` + `application-run-loop` 2 files/112 tests pass; `pnpm typecheck` clean; `pnpm test:provider-black-box` 19 files/176 passed + 1 skipped. The 2 new regression tests were verified red on unpatched code (static message contains no digits) before the fix.

## 6. Decisions awaiting the user (do NOT act without explicit approval)

1. **Bulk-write budget:** `agent.maxStreamOutputChars` stays 100_000; chunked-write
   re-dispatch guidance stays a manual parent-session workaround. Raising the cap
   or automating retry-with-smaller-scope is a budget call for the user.
2. **Restart the app** to pick up the 05:37 build (runaway guard + §5 fix go live
   only in a new process). Look for `tool_argument_runaway` trips and absence of
   >60 s drips after restart. If a drip recurs post-restart, pull that request's
   `isLunaChainedRequest` inputs — that means gate mismatch, not staleness.
