---
title: Background explorer looked hung; Luna was dripping nameless tool-argument deltas
date: 2026-09-02
type: incident diagnosis
status: analysis complete; 60-second signature containment implemented in follow-up
---

# Background explorer looked hung; Luna was dripping nameless tool-argument deltas

## Question

Why did background explorer `cardinal-tor-206` stay `running` with
`waiting (provider), quiet` for ~9 minutes after its last `read_file`, until
the parent cancelled it?

## What it is not

- Not a stuck `ask_orchestrator`. The question
  (`5da7bbb1-9fd6-46be-9319-5b164c30c2c8`) was asked at 09:04:32Z and the next
  explorer tool (`shell`) ran at 09:05:31Z after `send_message` `delivery:
  answered`.
- Not explorer shell policy. Blocking `node` (and `/tmp` redirection) is the
  documented YELLOW/RED explorer rule; the child asked the parent to run the
  analyzer, which is the intended blocker path.
- Not a silent socket. The last Codex request kept emitting frames.
- Not a `GenerationGuard` miss of the 100k tool-argument cap. Recorded
  argument-delta growth was 43,157 characters.

## Evidence

Parent session `8713abd8-ddf9-492e-b4a9-8a8567e76b86` (Grok 4.6). Child run
`cardinal-tor-206`, role `explorer`, model `codex/gpt-5.6-luna` via
`OpenAIResponsesWSModel`.

Persisted conversation events for that run (no `subagent_streaming_text`,
`subagent_streaming_tool`, `subagent_text_turn`, or `retry`):

| t | event |
| --- | --- |
| 09:04:09Z | first child Codex request |
| 09:04:12Z–09:04:32Z | `read_file` ×2, `shell` ×2, then `ask_orchestrator` |
| 09:05:31Z–09:07:38Z | 22 more tools; last is `read_file` |
| 09:16:47Z | `subagent_completed` `cancelled` / `This operation was aborted` |

Parent `get_subagent_status` at 09:16:31Z (request
`09-16-31.336Z_798a2.json`) reported:

```text
liveness: waiting (provider), quiet; last observed 8m 58s ago
lastTool: read_file
tools: read_file(14), shell(12), ask_orchestrator(1)
pending: read_file(14), shell(12), ask_orchestrator(1)
```

No `streamingTool:` line. `pendingToolCounts` matched lifetime `toolCounts`
because `SubagentAsyncRegistry` only clears pending counts on
`subagent_text_turn`, and this run never emitted one.

The child's last provider request is the aborted envelope:

```text
~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-02/09-02-22_8713a/09-07-38.560Z_03ccb.json
```

Re-read:

```bash
jq '{sentAt:.sent.timestamp, recvAt:.received.timestamp, modelClass:.sent.modelClass,
     errorKind:.received.error.errorKind, message:.received.error.message,
     phase:.received.error.phase, receiveTiming:.received.error.receiveTiming,
     diagnostics:.received.error.diagnostics}' \
  ~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-02/09-02-22_8713a/09-07-38.560Z_03ccb.json
```

Observed:

| field | value |
| --- | --- |
| sent / recv | 09:07:38.560Z / 09:16:47.767Z |
| `errorKind` | `cancelled` |
| `phase` | `request` |
| `durationMs` | 549,205 |
| `eventCount` | 29,957 |
| `firstEventMs` | 2,480 |
| `maxGapMs` / `maxInterFrameMs` | 3,874 |
| `progressCategoryCounts` | text 0, reasoning 8, tool 29,942, usage 2, heartbeat_or_unknown 5 |
| `toolArgumentDeltaFrames` | 29,942 |
| `toolArgumentDeltaCharacters` | 43,157 |
| `toolCallStartFrames` | 1 |
| `summary` | `null` (no assembled payload; abort before terminal event) |
| `sent.body.previous_response_id` | `resp_0f1d799e79f316bf016a97e757a8d887d0b63ffd17c978f550` |

Mean delta size is 43,157 / 29,942 ≈ 1.44 characters per argument-delta frame.
The stream was active; the inactivity watchdog (`maxStreamIdleMs` 600,000 and
Codex inter-frame 600,000) correctly did not fire.

## Why status said "quiet provider wait"

After each completed tool, `SubagentAsyncRegistry.handleSubagentEvent` treats
a finished `subagent_command_message` as `waiting` / `provider`. The next
request then has to prove life via `subagent_streaming_text` or
`subagent_streaming_tool`.

`ExecutionSubagentRunner` only forwards `tool_call_streaming_delta` when
`event.toolName` is set (`if (!event.toolName) break`).
`convertCodexRawStream` in `codex-responses-model.ts` copies the name from
`response.output_item.added` into a `toolNamesByIndex` map and omits
`toolName` on argument deltas when that map has no entry. The aborted
envelope has one `toolCallStartFrames` count and 29,942 argument deltas, and
the live status snapshot had no `streamingTool`. The name therefore did not
reach the runner for this request — every delta was dropped, so
`lastObservation` stayed on the 09:07:38Z `read_file` completion for nine
minutes.

That liveness hole is specific to this runner + optional-`toolName` delta
shape. Root-session UI that listens to `tool_call_streaming_delta` without
requiring a name would not necessarily go quiet.

`pending:` on `get_subagent_status` is also easy to misread: it is tools since
the last assistant text turn, not currently executing tools.

## This is a repeated Luna WebSocket class, not a first sighting

A scan of local `provider-traffic/` for aborted Codex envelopes with long
active tool-category streams found **eight** `gpt-5.6-luna`
`OpenAIResponsesWSModel` requests in 26 hours. All have `text: 0`, one
function-call start (when the counter exists), max inter-frame gap ≤ 5.5s,
and no assembled payload. They end either by client `cancelled` or by WS
`1006` before a terminal event.

| when | session | file | duration | tool frames | arg chars | end |
| --- | --- | --- | ---: | ---: | ---: | --- |
| 2026-09-01 07:38Z | `9bff1663` | `07-38-25.017Z_73e65.json` | 455s | 25,165† | (pre-counter) | cancelled |
| 2026-09-01 07:49Z | `9bff1663` | `07-49-14.191Z_64fff.json` | 786s | 43,503† | (pre-counter) | cancelled |
| 2026-09-01 18:14Z | `72a7c0c2` | `18-14-04.333Z_71080.json` | 850s | 47,155 | 83,447 | 1006 |
| 2026-09-01 19:23Z | `a6632777` | `19-23-06.784Z_5cee4.json` | 742s | 40,898 | 82,294 | 1006 |
| 2026-09-01 20:26Z | `8cea3578` | `20-26-45.793Z_582f4.json` | 123s | 6,007 | 8,034 | 1006 |
| 2026-09-01 20:29Z | `8cea3578` | `20-29-34.071Z_20b23.json` | 166s | 8,694 | 22,507 | 1006 |
| 2026-09-01 20:33Z | `8cea3578` | `20-33-11.005Z_b6544.json` | 1,078s | 58,078 | 60,615 | 1006 |
| 2026-09-02 09:07Z | `8713abd8` / explorer `cardinal-tor-206` | `09-07-38.560Z_03ccb.json` | 549s | 29,942 | 43,157 | cancelled |

† Pre-`AbortedStreamRecorder` argument counters: the 07:38Z / 07:49Z rows are
the original guard-ledger pair (`73e65e60`, `64fff2f8`); `tool` category count
is the only growth signal those envelopes retained.

`8cea3578` dripped **three times in 25 minutes**. `72a7c0c2` / `a6632777` /
`8cea3578` are DeepSeek-parent sessions whose Codex/Luna requests are nested
under the parent `sessionId` the same way today's explorer is nested under
Grok. The generator is Luna-on-WS, not a particular parent model.

Highest recorded `toolArgumentDeltaCharacters` in this set is 83,447 — still
under the 100,000-character `maxToolArgumentCharacters` /
`maxCumulativeToolArgumentCharacters` caps in `DEFAULT_GENERATION_GUARD_OPTIONS`.
Containment therefore still does not fire. A total request deadline remains
rejected for the same reason as 2026-09-01: none of these streams were idle.

What is new in the 2026-09-02 row is packaging: the parent's only mid-run API
(`get_subagent_status` / check-in liveness) reported a quiet wait while the
child's 29,942 argument frames were in flight. The 2026-09-01 rows were
visible as long Codex requests on the root (or as 1006 recoveries), not as a
false "provider stall" on a background explorer.

## What the openai/codex client does about this

Inspected `https://github.com/openai/codex` at `bdfd769640927a627dd48ab3fcc1ae8bc08bdd0a` (clone in `/tmp/openai-codex`, not in this repo). The official Codex client does **not** detect or stop this drip.

1. **Idle timeout only, re-armed on every frame.** `DEFAULT_STREAM_IDLE_TIMEOUT_MS` is 300_000 (5 minutes) in `model-provider-info`. SSE (`codex-client/src/sse.rs`) and Responses WebSocket (`ResponsesWebsocketConnection::run_websocket_response_stream`) both `timeout(idle_timeout, next_frame)`. Any `function_call_arguments.delta` resets the clock. Our captures have max gaps of 1.4–5.5s, so Codex's 5-minute idle window would not fire either. Term2's Codex inter-frame / `maxStreamIdleMs` window is 600s — same class, looser.
2. **Argument deltas are ignored.** `process_responses_event` in `codex-api/src/sse/responses.rs` lists `response.function_call_arguments.delta` and `.done` as unhandled (`trace!` only). The websocket path uses the same parser. Codex waits for a complete `output_item` / `response.completed`. There is no running character count on the stream, so a call that never `done`s is invisible except as “still receiving frames.”
3. **8 KiB truncate is post-hoc history, not a stream abort.** `MAX_EXECUTED_TOOL_CALL_ARGUMENT_BYTES = 8 * 1024` in `protocol/src/models/executed_tool_calls.rs` truncates the *recorded* `ExecutedToolCall` after a complete `ToolCall` exists. It does not cancel the provider request. If `output_item.done` never arrives, this code never runs.
4. **No analogue of `GenerationGuard` tool-argument caps.** `max_output_tokens` in this tree is a code-mode / `exec` / shell *result* budget (default 10k tokens for JS exec), not a model-generation cap on tool-call arguments. Guardian is an approval reviewer (`guardian-v2`), not a stream containment budget. `SafetyBuffering` is a server moderation-delay signal, not a runaway detector.

So OpenAI's client would sit on the same Luna WS drip until 5 minutes of *silence*, a 1006, or the user cancels — same endings we already see. They do not have a method we can copy to abort an *active* fine-grained argument stream.

## Harm

- A background explorer can spend ~9 minutes of Codex time after its last
  completed tool, with no transcript text and no status that a tool is
  streaming, until a human/parent `cancel_run`.
- Check-ins and `waiting (provider), quiet` look like a stalled provider.
  They are indistinguishable from a true hang without opening the aborted
  traffic envelope.
- The 100k character cap does not bound this drip. Local captures reach
  83k characters over ~14 minutes at ~1.4–1.8 chars/frame and still never
  trip it. Eight Luna WS envelopes in 26 hours ended only by cancel or 1006.

## What this report alone did not authorize

- Do not add a wall-clock request deadline. The 2026-09-01 ledger entry
  rejected that because long *active* Luna work is legitimate; this
  recurrence is still active (max gap 3.9s).
- Do not lower the 100k tool-argument cap from these numbers. The largest
  local capture is 83,447 characters and still did not cross it.
- Do not treat explorer `node` blocking or `ask_orchestrator` as the defect.

## Follow-up disposition

Nine captured recurrences ultimately established a narrow runtime cluster: one
chained Luna Responses-Lite tool call, zero text, 48.8–55.5 argument deltas per
second, 1.04–2.59 characters per delta, and no terminal call. Successful sampled
Luna `apply_patch` calls completed within 54.7 seconds. The user subsequently
selected a 60-second cost-containment policy, accepting that an unusually long
valid call may be cancelled. `ToolArgumentRunawayGuard` now applies only to that
chained Luna request shape and requires the observed rate, delta size, and active
gap signature before aborting. The full contract and verification record live in
the Luna row of `docs/plans/guard-ledger.md`.

## Candidate repairs (not implemented)

1. **Liveness:** `ExecutionSubagentRunner` should observe
   `tool_call_streaming_delta` even when `toolName` is missing (use a
   placeholder label, or the last known name). `get_subagent_status` would
   then show `streamingTool` and `tool_input_received` instead of a quiet
   provider wait. This is the smallest status-truth fix.
2. **Name map:** `convertCodexRawStream` should keep emitting argument
   progress when `output_item.added` has no name; the optional `toolName` is
   already on the event type.
3. **Containment:** implemented later through `ToolArgumentRunawayGuard` after
   nine recurrences established the rate/delta cluster and the user selected the
   60-second tradeoff. This original report did not itself authorize that change.

## Replay

Traffic file and jq recipe are above; both were run 2026-09-02. Conversation
JSONL for the parent session is local user state and is not committed.
