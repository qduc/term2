---
title: Background explorer looked hung; Luna was dripping nameless tool-argument deltas
date: 2026-09-02
type: incident diagnosis (no code changed)
status: analysis complete, fix not implemented
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

## Relation to the 2026-09-01 Luna incidents

This is the recurrence `docs/plans/guard-ledger.md` asked for under "Luna
streamed tool-argument runaway: evidence gap, observability only".

Those two root requests (`73e65e60`, `64fff2f8`) ran 454s and 785s with 25,165
and 43,503 tool-category frames, max gaps ~2s, and ended only on client
cancel. They lacked `toolArgumentDeltaCharacters`. This request supplies it:
43,157 characters, under the existing 100,000-character
`maxToolArgumentCharacters` / `maxCumulativeToolArgumentCharacters` caps in
`DEFAULT_GENERATION_GUARD_OPTIONS`. Containment behaved as designed. A total
request deadline remains rejected for the same reason as 2026-09-01: the
stream was not idle.

What is new is the *background-subagent* packaging: the parent’s only
mid-run API (`get_subagent_status` / check-in liveness) reported a quiet
wait while 29,942 argument frames were in flight.

## Harm

- A background explorer can spend ~9 minutes of Codex time after its last
  completed tool, with no transcript text and no status that a tool is
  streaming, until a human/parent `cancel_run`.
- Check-ins and `waiting (provider), quiet` look like a stalled provider.
  They are indistinguishable from a true hang without opening the aborted
  traffic envelope.
- The 100k character cap does not bound this drip: 43k characters at ~1.4
  chars/frame can run for many minutes without tripping it.

## What not to change from this report alone

- Do not add a wall-clock request deadline. The 2026-09-01 ledger entry
  rejected that because long *active* Luna work is legitimate; this
  recurrence is still active (max gap 3.9s).
- Do not lower the 100k tool-argument cap from these numbers. 43,157 did not
  cross it.
- Do not treat explorer `node` blocking or `ask_orchestrator` as the defect.

## Candidate repairs (not implemented)

1. **Liveness:** `ExecutionSubagentRunner` should observe
   `tool_call_streaming_delta` even when `toolName` is missing (use a
   placeholder label, or the last known name). `get_subagent_status` would
   then show `streamingTool` and `tool_input_received` instead of a quiet
   provider wait. This is the smallest status-truth fix.
2. **Name map:** `convertCodexRawStream` should keep emitting argument
   progress when `output_item.added` has no name; the optional `toolName` is
   already on the event type.
3. **Containment:** still needs a red replay of this frame shape through
   `convertCodexRawStream` + `ApplicationRunLoop` before any new abort. The
   ledger’s bar (cross 100k without settlement) was not met. A *rate* or
   *incomplete-call duration* guard would be a new class and needs its own
   incident-backed design; this report does not authorize it.

## Replay

Traffic file and jq recipe are above; both were run 2026-09-02. Conversation
JSONL for the parent session is local user state and is not committed.
