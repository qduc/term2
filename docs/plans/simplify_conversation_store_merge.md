# Simplify conversation-store merge logic

## Context

`ConversationStore.updateFromResult` currently carries a lot of merge machinery:
signature-based suffix/prefix overlap detection, replayed-prefix collapsing,
ordered-replay supersets, `historyKind` (`delta` / `partial_replay` /
`full_snapshot`) plus an `authoritative` flag, and a "suspicious merge" reject
path. This complexity exists because:

1. The SDK's `result.history` always echoes the input items, so even a
   "delta input" produces a `history` that overlaps the store.
2. On tool-approval interruptions, `continueRunStream` reuses the same
   `RunState` and `state._generatedItems` accumulates across the whole run.
   The store was being written once after the first stream and again after each
   continuation, so the second write had to dedupe against the first.

Reading the SDK source (`@openai/agents-core/dist/result.js` and
`runner/items.js`) clarifies the contract:

- `result.history` = `[...originalInput, ...output(newItems)]`
- `result.output`  = `output(newItems)` — generated items only, in
  `AgentInputItem` shape, with approval placeholders stripped and orphan tool
  calls dropped (`dropOrphanToolCalls`).
- `result.newItems` = raw `RunItem[]` (richer wrappers; not input-shaped).

With those guarantees we can collapse merging to two operations and write the
store exactly once per logical run.

## Goal

Replace `updateFromResult` with two explicit operations:

- `appendOutput(items)` — concat newly generated items onto the store.
- `replaceHistory(items)` — overwrite the store with a full transcript.

Callers choose based on what they sent to the SDK (already known locally via
`inputSurgeKind`). The store stops trying to reconcile shapes it can't tell
apart.

## Design

### Store API

In `source/services/conversation-store.ts`:

- Remove `updateFromResult`, `#mergeWithIncoming`,
  `#collapseReplayedHistoryPrefixes`, `#collectCallSignatures`,
  `#preferIncomingItem`, `#signature`, `#isPrefixMatch`,
  `#isOrderedReplayOfExisting`, `#containsAllExistingItems`,
  `#findSuffixPrefixOverlap`, `#isSameConversation`,
  `#listUserTurnsForHistory`, `#areUserTurnsEqual`, `#hashString`, the
  `HistoryKind` / `UpdateFromResultOptions` types, and the
  `crypto` / `repairConversationHistory` imports if no longer used.
- Add:

  ```ts
  appendOutput(items: AgentInputItem[]): void {
    if (!Array.isArray(items) || items.length === 0) return;
    this.#history.push(...this.#cloneHistory(items));
  }

  replaceHistory(items: AgentInputItem[]): void {
    if (!Array.isArray(items) || items.length === 0) return;
    this.#history = this.#cloneHistory(items);
  }
  ```

- Keep: `#history`, `#cloneHistory`, `addUserTurn` / `addUserMessage` /
  `addImportedItem` / `addShellContext` / `addModeNotice` / `addErrorContext`,
  `getHistory`, `getLastUserMessage`, `clear`,
  `removeLastUserMessage` / `removeLastUserTurn` / `removeNLastUserTurns`,
  `listUserTurns`, and the static `#extract*` helpers used by those.

`repairConversationHistory` is no longer needed inside the store — the SDK's
own `dropOrphanToolCalls` (applied inside `getTurnInput` for both `output` and
`history`) covers orphan tool-call/result pruning for SDK-produced items. If
any caller still needs repair for imported (resumed) histories, invoke it
explicitly there, not inside every write.

### Call sites in `source/services/conversation-session.ts`

There are three current `updateFromResult` calls. Replace them with this rule,
keyed off "did this stream terminate without pending interruptions":

```ts
const terminal = !stream.interruptions || stream.interruptions.length === 0;
if (terminal) {
  if (inputSurgeKind === 'delta') {
    this.conversationStore.appendOutput(stream.output);
  } else {
    this.conversationStore.replaceHistory(stream.history);
  }
}
```

- **Line 778 (initial stream completion):** wrap in the `terminal` gate. If
  the first stream ended in an interruption, do not touch the store; the
  continuation will write once it finishes cleanly. `previousResponseId`
  assignment stays unconditional.
- **Line 1018 (continuation completion):** same gate, same operation. Drop
  `historyKind: 'partial_replay'`.
- **Line 655 (abort-resolution continuation):** same gate. Drop the
  `partial_replay` historyKind.

`inputSurgeKind` is captured before the first `startStream` call and is the
same logical run throughout, so continuations should reuse the captured value
(thread it through `#resolveInterruptions` / `#buildAndResolve` if needed
rather than recomputing).

This terminal gate is a correctness requirement, not just an optimization.
`appendOutput(stream.output)` is safe only if interrupted streams do not write
to the store. During approval flows the continuation reuses the same
`RunState`, so `stream.output` is cumulative for the logical run; writing the
initial interrupted stream and then writing the completed continuation would
reintroduce the duplicate-history problem this refactor removes. Keep
`previousResponseId` updates independent of the gate.

### Why dropping pending-approval items in the store is safe

A tool call without its result is exactly the
"approval pending" state. The SDK's `output` getter already runs
`dropOrphanToolCalls` (`runner/items.js:148`) which removes
`function_call` / `computer_call` / `shell_call` / `apply_patch_call` items
whose paired result is missing. So if a session is killed mid-approval and
later resumed, the recovered history will not contain the unresolved tool
call. That is the desired behavior: there is nothing to "continue" without
the user's approval decision.

### Other callers

- `source/services/subagents/subagent-session.ts:94` —
  `updateFromResult(result)` becomes `appendOutput(result.output)`. Subagent
  runs always send delta input, so concat is correct.
- `source/services/subagents/subagent-manager.ts:457` — delegated to the
  session method above; no change beyond renaming.

### Tests

- Drop / rewrite tests in `source/services/conversation-store*.test.ts` that
  assert merge behavior (overlap detection, replay collapsing, suspicious
  merge rejection). Replace with focused tests:
  - `appendOutput` appends to existing history.
  - `replaceHistory` overwrites.
  - Empty / non-array input is a no-op.
  - `getHistory` returns a deep clone.
- Add or adapt an integration-level test in `conversation-session.test.ts`
  (or whichever covers approval flow) verifying that an
  interrupted-then-resumed run produces a history with no duplicated
  tool-call/result pairs and no duplicated assistant message.
- Add a regression assertion for the terminal-write gate: after the first
  interrupted stream, the store must not contain the pending tool call/output;
  only the completed continuation may write the cumulative `stream.output`.
- Existing tool-ledger and persistence tests should keep passing — neither
  depends on the merge machinery.

## Critical files

- `source/services/conversation-store.ts` — slim down to ~150 lines.
- `source/services/conversation-session.ts` — update three call sites
  (lines 655, 778, 1018) and thread `inputSurgeKind` through the
  continuation paths.
- `source/services/subagents/subagent-session.ts` — adapt to new API.
- `source/services/conversation-store*.test.ts` — replace merge tests.
- `source/services/conversation-history-repair.ts` — likely now only used by
  resume/import paths; leave in place but verify imports.

## Verification

1. `npm run build` and `npm test` clean.
2. Targeted: `npm run test:verbose -- source/services/conversation-store*.test.ts`
   and any approval-flow tests.
3. Manual: in `npm run dev`,
   - Run a non-tool conversation (delta path): history grows by exactly one
     assistant turn per user turn.
   - Run a tool that triggers approval; approve it: final history contains
     one tool-call + one tool-result, no duplicates.
   - Run the same and *reject* approval: history reflects the fake-execution
     resolution path without duplicated items.
   - With an OpenRouter provider (full-snapshot path): multi-turn
     conversation produces a coherent history with no missing or duplicated
     items.
4. `--resume` a saved session that was interrupted mid-approval: confirm the
   resumed history has no orphaned tool call and the next turn proceeds
   normally.
