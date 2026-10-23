# Assistant Output Recovery Architecture

## Problem Statement

The current recovery mechanism is centered on `source/services/tool-execution-ledger.ts`, which stores tool call/result pairs so interrupted turns can be reconstructed after a failure. That solves one narrow class of recovery: tool execution that started but did not finish cleanly.

The requirement has expanded. Recovery and resume should preserve everything the assistant produced during a turn, not just tool calls. That includes:

- assistant text
- reasoning text
- encrypted reasoning or other opaque provider reasoning payloads
- tool calls and tool results

The key design question is whether to expand the existing tool ledger into a generic assistant-output store or to introduce a separate structure and share it between crash recovery and disk resume.

## Current Architecture

The current system is split across several layers:

- `source/services/tool-execution-ledger.ts` tracks tool lifecycle state. It stores `SavedToolExecution` entries with `started`, `completed`, `failed`, `approval_required`, and `aborted` statuses, plus `historyItems` for recovery.
- `source/services/session/session-tool-tracker.ts` owns the ledger inside the live session and uses it to reconcile stream state and restore completed tool entries.
- `source/services/session/session-stream-processor.ts` records function calls and results as the model streams, and emits tool result log events from the ledger.
- `source/services/logging/conversation-logger.ts` persists assistant turns as `assistant_turn` events using `TurnItemAccumulator`.
- `source/services/session/turn-item-accumulator.ts` buffers streamed assistant text and reasoning, then persists them as `PersistedAssistantTurnItem` values.
- `source/services/conversation/conversation-turn-items.ts` reconstructs history from persisted assistant turn items.
- `source/services/conversation/conversation-replay.ts` rebuilds state from log envelopes during resume and also reconstructs a tool ledger from persisted assistant turns.

This means the codebase already has two partially overlapping persistence shapes:

- a tool-specific recovery ledger
- an assistant-turn transcript format that already knows about reasoning, assistant text, and tool items

The problem is not that assistant output is untracked. It is tracked, but in a different structure and at a different granularity than the tool ledger.

## Why Change Is Needed

The current split is workable for live execution, but it creates a mismatch between the recovery requirements and the storage model:

- Tool recovery only captures tool call/result pairs.
- Assistant text and reasoning are buffered and logged separately, but not represented as a durable recovery journal for mid-turn failure.
- Resume-from-disk reconstructs state from persisted logs and assistant turns, while live crash recovery relies on the tool ledger plus replay logic.
- If we want “resume” and “crash recovery” to behave the same way, they should consume the same durable turn record.

Keeping separate structures for “assistant output” and “tool recovery” makes the behavior harder to reason about and easier to drift over time.

## Decision

Use a single append-only assistant turn journal as the durable storage shape for assistant-produced output and recovery state, and keep the tool ledger as a narrow compatibility/projection layer until the journal can fully reproduce current interrupted-turn behavior.

In practical terms:

- The durable record should reuse the semantics of `PersistedAssistantTurn` / `PersistedAssistantTurnItem`, but it cannot be only that array shape. It also needs operational entries for recovery.
- The journal should contain all assistant-produced transcript items in order:
  - reasoning items
  - assistant text items
  - tool call items
  - tool result items
  - opaque provider metadata needed to round-trip encrypted reasoning or provider-specific payloads
- The journal should also contain operational lifecycle entries needed to recover interrupted turns:
  - tool-started markers
  - approval-required markers
  - approval-resolution markers when relevant to resume behavior
  - interruption or abort markers when the session terminates mid-turn
- `ToolExecutionLedger` should remain focused on tool state and become a derived projection or compatibility index over that journal, not the primary storage model, but only after the journal can reconstruct `started`, `approval_required`, `completed`, `failed`, and `aborted` tool states.

## Why This Decision

This is the simplest design that satisfies both recovery and resume:

- One storage shape serves both crash recovery and loading old conversations from disk.
- The assistant turn journal already matches the mental model of “what the assistant produced during a turn.”
- The current tool ledger is too specialized to become a general assistant-output store without turning recovery logic into a mixed transcript system.
- Encrypted reasoning is safer when it is stored as opaque provider data in the same journal that already owns assistant output, rather than being forced through a tool-specific schema.
- Recovery still needs operational state, not just transcript state, so the journal must be strong enough to rebuild interrupted tool execution and approval state.

The alternative, expanding `ToolExecutionLedger` into a full assistant-output ledger, would create a name/shape mismatch and make the recovery code harder to maintain. It would also blur two responsibilities:

- execution recovery
- transcript persistence

Those are related, but not the same.

## Proposed Architecture

### 1. Durable turn journal

Introduce a durable journal that stores append-only turn entries during streaming, not only at turn finalization. This can reuse the existing persisted turn item semantics, but it needs a journal entry envelope that distinguishes transcript items from operational recovery markers.

The journal should support:

- ordered append of streamed items
- ordered append of recovery markers such as tool start and approval pause
- replay after interruption
- serialization to disk
- restoration into live session state
- preservation of opaque provider payloads

At minimum, the journal needs two categories of entries:

- transcript entries
  - reasoning item
  - assistant text item
  - tool call item
  - tool result item
- operational entries
  - tool started
  - approval required
  - approval resolved
  - interrupted or aborted

This avoids overloading `PersistedAssistantTurnItem` with execution-state concerns while still keeping a single durable journal.

### 2. Tool ledger as a projection

Keep `ToolExecutionLedger` as the tool-specific view over the journal.

Its responsibilities remain:

- track tool call start/completion/abort state
- support recovery of in-flight tool calls
- reconcile tool history with current conversation state

It should not become the owner of assistant text or reasoning storage.

During migration, `ToolExecutionLedger` remains first-class for safety. It can only become a fully derived projection once journal replay can reconstruct all tool lifecycle states that current recovery depends on.

### 3. Shared replay/resume path

Both replay and live resume should read from the same durable journal:

- live streaming appends to the journal as events and items arrive
- crash recovery replays the journal to restore session state
- disk resume loads the same journal and reconstructs history

This avoids building two separate persistence systems for the same purpose.

The current `assistant_turn` log event is not sufficient by itself for this role because it is finalized after buffering in memory. The hardened design therefore needs a streaming write path that persists entries before `final`.

## Data Flow

1. The model streams assistant output in deltas.
2. The stream processor emits two kinds of durable data as early as they are available:
   - transcript data such as reasoning deltas, assistant text fragments, completed tool call items, and completed tool result items
   - operational data such as tool-started and approval-required markers
3. A journal writer appends those entries immediately instead of waiting for `final`.
4. Where provider-specific metadata is only available from raw run items rather than transport-friendly deltas, the stream pipeline must persist the raw item at the first point it becomes available.
5. The tool ledger derives tool state from journal entries during replay or live restoration.
6. On crash or resume, journal replay rebuilds both:
   - conversation history and assistant transcript items
   - in-flight tool and approval state
7. The conversation store remains the canonical in-memory transcript, not the durable recovery source.

## Edge Cases To Account For

- Streaming assistant text can arrive in fragments and must be buffered before becoming a stable persisted item.
- Reasoning may be split across multiple events and may include provider metadata that must not be normalized away.
- Encrypted reasoning may be opaque and should be stored without interpretation.
- Tool calls can be interrupted mid-batch and later resumed with the same call IDs.
- Tool lifecycle recovery requires `started` and `approval_required` state even when no matching tool result was ever produced.
- Some provider metadata is only available on completed raw items rather than incremental deltas; the journal boundary must capture it at the earliest available point.
- Resume-from-disk must not duplicate items already reconstructed in the live transcript.
- Replaying transcript items alone is not enough for interrupted-turn recovery; replay must also rebuild approval and in-flight tool state.
- Any migration path must preserve existing history files and not break current session replay.

## What Should Not Change

- Do not replace `ConversationStore` with the new journal. The store is the live transcript, not the recovery source.
- Do not broaden `ToolExecutionLedger` into a generic assistant-output dump.
- Do not depend on `assistant_turn` logs alone as the authoritative recovery store. Logs are useful for replay, but they are not the same thing as an append-only operational journal unless they gain an incremental streaming write path.

## Migration Strategy

Recommended sequence:

1. Introduce a journal entry envelope and persistence boundary that can represent both transcript items and operational recovery markers.
2. Add an incremental write path in the stream pipeline so entries are durably appended during streaming, not only on `final` or `error`.
3. Persist raw provider items or provider-specific metadata at the earliest point they are available so encrypted reasoning and opaque payloads survive interruption.
4. Keep `ToolExecutionLedger` in place as the source of truth for live recovery while the new journal is being validated.
5. Update replay and resume to prefer the journal when present, while falling back to existing `assistant_turn` and tool-ledger reconstruction for older sessions.
6. Once journal replay can reconstruct all existing lifecycle states and passes parity tests, demote `ToolExecutionLedger` to a derived projection.
7. Only then reduce or remove redundant tool-specific persistence if it no longer adds value.

## Open Questions For Expert Review

- Should the new journal be a dedicated service, or should it be an extension of the existing persisted assistant turn log format?
- Should encrypted reasoning be stored inline in the journal, or in a provider-specific sidecar field referenced by the journal?
- What migration guarantees are required for existing saved sessions and log files?
- Should the tool ledger eventually become fully derived, or remain a first-class compatibility structure indefinitely?
- Should transcript fragments be journaled as raw deltas, normalized items, or both?
- What is the exact flush boundary for assistant text and reasoning so crash-safe persistence does not create duplicate or unstable items on replay?

## Bottom Line

The cleanest architecture is a shared append-only assistant turn journal for all assistant-produced output and recovery markers, with `ToolExecutionLedger` retained as a compatibility projection until journal replay can fully reproduce current interrupted-turn behavior. That gives crash recovery and disk resume the same storage model, preserves the current replay behavior, and avoids turning the tool ledger into a second transcript system while still keeping execution-state recovery explicit.

