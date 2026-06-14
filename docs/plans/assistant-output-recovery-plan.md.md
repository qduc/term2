Refer to `docs/assistant-output-recovery-architecture.md` to understand the context of this task.

**Key Decisions**
- Reuse the existing JSONL conversation log as the physical journal instead of creating a second persistence file. The new journal is a logical extension of `LogEvent`, not a separate store.
- Keep `assistant_turn` as the finalized summary artifact during migration. It remains the authoritative transcript for completed turns until replay parity with the incremental journal is proven.
- Keep `ToolExecutionLedger` as the live source of truth during execution. Only replay becomes journal-aware first; ledger demotion comes later.
- Add explicit `turnId` plumbing to new journal events and to relevant existing operational events when available. Fall back to legacy user-turn ordering for old logs.
- Persist transcript in two layers:
  - provider-backed item entries when a raw run item exists
  - text/reasoning fragment entries for partial output that has not materialized into a raw item yet
- Use the current append-only log writer and add durability for critical recovery events. Do not fsync every text token.

**Files And Components**
- `source/services/logging/conversation-log-events.ts`
  - Add `AssistantJournalDeltaLogEvent` and `AssistantJournalItemLogEvent`.
  - Add optional `turnId` to `tool_started`, `tool_result`, `approval_required`, `approval_resolved`, and `assistant_turn`.
  - Keep backward compatibility in the union so old logs still parse.
- `source/services/logging/conversation-log-writer.ts`
  - Extend `FSYNC_EVENTS` to include the new critical recovery events.
  - Default: fsync `tool_started`, `tool_result`, `approval_required`, `assistant_journal_item`, and `assistant_turn`.
  - Leave `assistant_journal_delta` append-only without per-event fsync.
- `source/services/logging/assistant-turn-journal.ts` (new)
  - Own turn-scoped journal sequencing, normalization, and append decisions.
  - Public API should accept `recordTextDelta`, `recordReasoningDelta`, `recordRunItem`, `recordToolStarted`, `recordApprovalRequired`, `recordApprovalResolved`, `recordFinalTurn`, and `resetForNewTurn`.
- `source/services/tool-execution-ledger.ts`
  - Expose the current turn id with a read-only getter so journal and logs can tag entries consistently.
- `source/services/session/session-tool-tracker.ts`
  - Expose the current turn id via the ledger getter.
- `source/services/logging/conversation-logger.ts`
  - Inject the journal service and current-turn callback.
  - On `text_delta` and `reasoning_delta`, append journal delta events immediately.
  - On `tool_started`, `approval_required`, `approval_resolved`, and `final`, emit turn-tagged operational/journal events alongside current behavior.
- `source/services/stream-event-processor.ts`
  - Add a generic `onRunItem` hook in addition to the existing function-call/result hooks.
- `source/services/session/session-stream-processor.ts`
  - Feed every `run_item_stream_event.item` into the journal through `onRunItem`.
  - Continue sending function call/result items to the ledger exactly as today.
- `source/services/session/session-composition.ts`
  - Construct `AssistantTurnJournal` and wire it into `ConversationLogger` and `SessionStreamProcessor`.
- `source/services/conversation/conversation-replay.ts`
  - Add replay support for the new journal events.
  - Prefer finalized `assistant_turn` for completed turns.
  - Use journal entries to reconstruct interrupted turns, partial transcript, and tool lifecycle state when no finalized turn exists.
- `source/services/conversation/conversation-turn-items.ts`
  - Add a small helper if needed to build persisted items from a single raw run item so replay and journaling share normalization logic.

**Implementation Sequence**
1. Extend the log event schema in `conversation-log-events.ts` and add optional `turnId` support to relevant existing events.
2. Expose `currentTurnId` from `ToolExecutionLedger` and `SessionToolTracker` so the journal can consistently tag entries across initial run and approval continuation.
3. Introduce `AssistantTurnJournal` as a dedicated service under `source/services/logging/`. Make it append journal entries through the existing log sink, not by opening files itself.
4. Wire `ConversationLogger` to call the journal for transport-level events. Deltas should become `assistant_journal_delta` entries immediately; operational recovery events should carry `turnId`.
5. Extend `processStreamEvents()` with `onRunItem`, then wire `SessionStreamProcessor` to pass every raw run item into the journal. The journal should normalize those items with the same persisted item semantics already used by `buildPersistedAssistantTurnItems()`.
6. Keep `TurnItemAccumulator` and `assistant_turn` final logging intact. On `final`, the journal records a commit boundary for the turn, and `ConversationLogger` still emits the legacy `assistant_turn` event for compatibility.
7. Update `conversation-replay.ts` to build a per-turn replay model:
  - If a turn has `assistant_turn`, use it as the authoritative completed transcript.
  - If a turn lacks `assistant_turn`, synthesize transcript from journal item entries plus coalesced delta fallback.
  - Rebuild tool lifecycle from `tool_started`, `approval_required`, `approval_resolved`, `tool_result`, and journal tool items.
8. Add replay deduplication rules:
  - prefer provider-backed `assistant_journal_item` over fragment-only deltas for the same segment
  - prefer finalized `assistant_turn` over earlier journal transcript for the same completed turn
  - dedupe `command_message` output when a richer tool result already exists
9. Extend `conversation-persistence.ts` only if needed for version tagging or helper wiring. The file format remains JSONL envelopes; load should stay backward compatible.
10. After parity is proven, add a follow-up cleanup step to decide whether `assistant_turn` remains as a summary record or becomes derived from journal replay.

**Data Flow**
- User turn starts in `InitialTurnRunner`, which already advances the ledger turn. The journal uses the same `turnId`.
- Streaming deltas reach `ConversationLogger.dispatchEventToLog()` and are appended as `assistant_journal_delta` entries.
- Raw provider items reach `SessionStreamProcessor` through `processStreamEvents()` and are appended as `assistant_journal_item` entries when available.
- Tool lifecycle and approval events continue to flow through existing log events, now annotated with `turnId`.
- `assistant_turn` still gets written on `final` as the compact completed-turn summary.
- `replayEvents()` loads old logs exactly as today, but for new logs it can reconstruct incomplete turns from journal entries before falling back to legacy interruption handling.

**Edge Cases And Failure Modes**
- Partial assistant text or reasoning with no final run item must still replay as visible partial transcript.
- Approval pauses with no eventual tool result must restore open tool state and interruption warnings.
- Approval continuation must stay on the same `turnId`; it is not a new user turn.
- Duplicate raw items from resumed streams must not duplicate transcript or tool state.
- Provider-backed reasoning metadata such as `reasoning_details` must survive replay without being duplicated onto adjacent assistant/tool items.
- Older v3 logs with only `assistant_turn` and operational events must continue to replay unchanged.

**Tests**
- `source/services/logging/assistant-turn-journal.test.ts`
  - emits monotonic per-turn journal sequence numbers
  - records deltas immediately
  - normalizes raw run items into persisted transcript items
  - preserves same turn across approval continuation
- `source/services/logging/conversation-logger.test.ts`
  - logs journal deltas and turn-tagged operational events
  - still emits legacy `assistant_turn` on `final`
- `source/services/session/session-stream-processor.test.ts`
  - generic `onRunItem` path records provider-backed items
  - stale generation drops journal writes after invalidation
- `source/services/conversation/conversation-replay.test.ts`
  - interrupted turn with only deltas restores partial transcript
  - interrupted turn with journal tool items restores history and ledger
  - approval-required without final turn restores pending/open state
  - completed turn prefers `assistant_turn` over earlier journal fragments
  - duplicate journal and command-message tool output is deduped
- `source/services/conversation/conversation-persistence.test.ts`
  - writer/loadConversation round-trips mixed legacy and journal logs
  - old logs still load without journal entries
  - crash-after-tool-start and crash-after-partial-text scenarios replay correctly

**Acceptance Criteria**
- A crash after streamed reasoning/text but before `final` restores the partial assistant output on resume.
- A crash after `tool_started` or `approval_required` but before completion restores the interrupted state and tool recovery behavior already covered by current tests.
- Completed turns render the same messages, history, usage, and tool output as today.
- Existing saved conversations load unchanged.
- Journal replay and legacy replay produce equivalent state for completed turns in parity tests.

**Assumptions And Risks**
- Assumption: the existing JSONL log is acceptable as the journal storage medium.
- Assumption: process-crash recovery is the target; per-token fsync is not required.
- Risk: some providers may not emit raw assistant/reasoning items consistently across transports, so characterization tests may reveal provider-specific gaps.
- Risk: log volume will increase. If this becomes measurable, add batched compaction later rather than weakening the correctness model up front.
