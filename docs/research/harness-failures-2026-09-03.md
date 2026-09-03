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

## 7. Root cause: wire-side model degeneration, not harness accumulation

Key question was whether the runaway exists on the wire or only in our
buffer. Evidence puts it on the wire. No fix shipped (deliberately).

Primary artifact (all paths relative to
`~/.local/state/term2-nodejs/logs/`):
`provider-traffic/2026-09-02/16-51-27_8b49b/17-23-29.028Z_ed40e.json`
(aborted, requestId `ed40ed7e-…`, session `8b49b1ea`, `codex/gpt-5.6-luna`,
chained single-`function_call_output` + `previous_response_id`). The same
session directory holds 8 more aborted Luna artifacts with the same shape
(`17-44-42`, `17-51-20`, `17-56-15`, `18-17-24`, `18-18-40`, `18-19-48`,
`18-50-36`, `18-51-41`); the 3 `network`/`1006` error artifacts
(`18-16-43`, `18-17-53`, `18-22-17`) are the server-closed siblings.

Byte counts that prove it (primary artifact):

- 54,836 `response.function_call_arguments.delta` frames; `sequence_number`
  37→54872 strictly +1 contiguous — no gaps, no duplicates, no replay.
- Exactly one `(item_id, output_index)` pair across all deltas — single
  accumulation slot, so index-vs-id mis-keying cannot explain growth.
- Joined raw `delta` strings = exactly 100,000 chars = the guard trip point.
  Sum of raw wire bytes == accumulated buffer. There is no harness-side
  inflation to find.
- Content: coherent `create_file …/approval-m3.yaml` JSON head → degeneration
  at char ~55,892 into multilingual word salad with `to=functions.*`
  chain-of-thought leakage → 40,593-char whitespace tail. 6 of the 9 aborted
  artifacts show the same `to=functions` leakage; the other two cut off inside
  still-coherent JSON; `18-50-36` is a brace collapse (1 `{`, 48,863 `}`).

Code checks (read, not recalled):

1. **No output cap on this path.** Sampled Luna sent bodies have no
   `max_output_tokens` key (`buildResponsesCreateRequest` omits it when
   `request.maxTokens` is undefined; the explorer role defines no `maxTokens`
   and `nested-runner` only forwards it when set). The DeepSeek SSE analog
   sends `max_tokens: 32000`. Luna Responses-Lite chained requests are the
   only path with no output cap plus server-held chain state and
   `reasoning: {effort high}`.
2. **Merge is correct.** `convertCodexRawStream` (`codex-responses-model.ts`)
   keys `toolArgumentLengthsByIndex` on `output_index` else `item_id` and adds
   `delta.length`. One slot, contiguous sequence numbers — each chunk applied
   exactly once.
3. **No retry replays into the same buffer.** `GenerationGuard` is constructed
   per request; in-loop retry of a chained delta is refused
   (`chained_delta_not_self_contained`) and recovery rebuilds full history as
   a new request.
4. **Asymmetry confirmed.** Luna goes through Responses-Lite WebSocket +
   `previous_response_id` chaining (modelClass `OpenAIResponsesWSModel` /
   `CodexResponsesWSModel`); DeepSeek/Qwen go through SSE/chat_completions
   with explicit token caps. Only the Luna path drips.

Corroborating signal: even *successful* Luna `apply_patch` calls carry stray
multilingual garbage *inside* the diff string (e.g. `18-18-35.913Z_7882a.json`
arg tail `…End Patch\\n}ҳәараjson? Do correct.} 白小姐?…`), so the stray-token
behavior is continuous with the drip, not a separate mode.

Context-before-drip does not finger a single trigger: the three 1006 drips
answer ordinary `read_file` results (3.6k/9.6k/2k chars, clean file text);
the Sep-2 cancelled drip answers a 38k-char shell result. Prior tool
(`read_file` vs `apply_patch` vs `shell`) and result size vary.

Verdict: model-side degeneration on uncapped chained Luna requests. The
60 s runaway guard (§2) contains the duration; nothing in the harness
manufactures the bytes.
