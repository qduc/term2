# Bug: background-shell monitor firing rows render below the final reply

- **Reported:** 2026-09-02
- **Session:** `9e6e503d-e116-4719-b171-f22cfed23632` (2026-09-02 15:05–15:34 UTC)
- **Model:** `gpt-5.6-luna` via `codex`; app mode: standard (orchestrator/lite/plan/mentor all off)
- **Component:** background shell monitor → `Background shell output: …` transcript rows
- **Status:** fixed (commit `8cb89eba`, merged to `main`)

## Symptom

A user watching the CI-monitor background job sees a pile of near-identical
rows — `Background shell output: <entire shell one-liner> (25 lines)`,
`(1 line)`, `(10 lines)` — rendered **below** the last real assistant message,
which was the final "Fixed and verified…" reply. The rows look like they
arrived *after* the assistant finished, and they dominate the tail of the
transcript.

The rows are not inert transcript entries: each one is a **wake notification**
that opens a hidden turn and makes the model reply. They are doing their job
(waking the model) — the problem is purely where they render.

## Expected vs. actual

- **Expected (correct):** each firing row sits at the position it actually
  fired, i.e. **above** the final reply, interleaved with its own wake turn's
  reply.
- **Actual (observed in UI):** the rows are appended after the final reply, so
  the last thing the user sees is a wall of `Background shell output: …`.

## Confirmed evidence (durable transcript, sorted by global `seq`)

The session's authoritative render order is the journal at
`~/.local/share/term2-nodejs/conversations/9e6e503d-e116-4719-b171-f22cfed23632.jsonl`.
Every event carries a monotonically increasing `seq`; that is the order
`conversation-replay` reconstructs. The tail is:

```
seq 1743  15:33:05  background_shell_output  firing seq 9 (10 lines)
seq 1787  15:34:26  background_shell_completed  job e81bfc11
seq 1928  15:34:37  assistant_journal_item  "Fixed and verified. …"
```

Verify with a self-contained `jq` recipe (run from the conversations dir):

```bash
F=9e6e503d-e116-4719-b171-f22cfed23632.jsonl
echo "LAST firing:";  jq -r 'select(.event.type=="background_shell_output") | [.seq, .ts] | @tsv' "$F" | tail -1
echo "LAST assistant text:"; jq -r 'select(.event.type=="assistant_journal_item") | select((.event.item.text // "") | length>0) | .seq' "$F" | tail -1
echo "firings after that seq:"; J=$(jq -r 'select(.event.type=="assistant_journal_item") | select((.event.item.text // "") | length>0) | .seq' "$F" | tail -1); jq -r --argjson j "$J" 'select(.event.type=="background_shell_output") | select(.seq > $j) | .seq' "$F" | wc -l
```

This prints `LAST firing: 1743`, `LAST assistant text: 1928`, and `firings after that seq: 0`. The provider
traffic log for the same session (`provider-traffic/2026-09-02/15-05-39_9e6e5/`)
independently confirms the chronology: the last firing is 15:33:05, the job
settles at 15:34:26, and the "Fixed and verified" reply is the last request at
15:34:27. So the rows genuinely fired **before** the final reply; replay orders
them correctly.

## Root-cause hypothesis (code-grounded)

The durable journal already records the rows at their true position. The
**live** announce path is what misplaces them. The relevant pieces:

- `#announceBackgroundSubagentNotifications` in `conversation-orchestrator.ts`
  calls `#appendAboveStreamingTail`, which calls `insertBeforeStreamingTail`
  in `source/utils/conversation/message-buffer.ts`.
- `insertBeforeStreamingTail` splices additions **above** the trailing run of
  live streaming slots, but **only while a live bot/reasoning slot exists**.
  `streamingTailStart` walks back from the end and stops at the first settled
  message; when it returns `existing.length` (nothing streaming), the function
  falls through to `appendMessagesCapped` and appends the row to the **bottom
  of the list** (`message-buffer.ts:51`).
- Each firing is a separate wake turn. When firing *N+1* is announced, the wake
  turn for firing *N* has typically already **finalized** (replies are a couple
  of seconds; firings are ~10 s apart), so no streaming slot is live at announce
  time and the row lands at the bottom instead of at its chronological spot.

This is a **live-render vs. durable-replay divergence**: replay pins the rows
above the settle because `appendReplayedBackgroundShellJobs` in
`conversation-replay.ts` replays firings ahead of the terminal row explicitly,
but the live buffer does not get that same stable ordering when no stream is
active.

## Why the prior fix does not cover this

`58000612` "fix message order around background notifications" changed only
`source/components/message/MessageList.tsx` and its test. It addressed a
render-layer ordering/sorting path, not the live announce/insert path in
`conversation-orchestrator.ts` / `message-buffer.ts`. So it did not stop the
live buffer from appending a settled firing row at the bottom when no streaming
slot was live. (CHANGELOG 0.20.0 lists "Fixed message ordering around background
notifications," which is easy to read as covering this case — it does not.)

## Scope of the claim

- **Confirmed from data:** the rows fired before the final reply, and the
  durable replay order places them above it.
- **Hypothesis, not separately proven:** the exact live-message-buffer state at
  each announce (specifically that no streaming slot was live) — the live buffer
  from that run is gone, so this is inferred from the code path and the ~10 s
  firing cadence.

## Suggested fix direction

Make the live announce path order by firing time instead of by "is anything
streaming": when appending a settled background row during an idle/no-tail
buffer, splice it above the last settled row that precedes it in firing order
(e.g. keyed by `seq`), rather than appending to the end. A smaller alternative
is to coalesce the burst: collapse consecutive near-identical firing rows into a
single row carrying `×N` / a `seq` range, which trims the tail and removes most
of the visual noise even when ordering is imperfect.
