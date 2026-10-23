# Conversation Store History Duplication After Interrupted Tool Batches

## TL;DR

`ConversationStore.updateFromResult()` doubled history when a parallel tool batch
was interrupted (approval pause) and then resumed via `continueRunStream`. The
continuation returns a **full transcript replay** with the new tool call spliced
**inside** the previously-paused batch (between `fc_X` and `fcr_X`), which breaks
the store's positional `#isPrefixMatch` / `#findSuffixPrefixOverlap` and falls
through to a concatenation fallback. Result: every prior `function_call` /
`function_call_result` pair appears twice; on the next user turn the
`InputSurgeGuard` blocks the request.

The fix in `source/services/conversation-store.ts` adds a final
`repairConversationHistory(...)` pass to every `updateFromResult` call, which
deduplicates content-by-`callId` regardless of position.

## Repro / Evidence

Session: `~/.local/state/term2-nodejs/conversations/18dbe2c1-...jsonl`
Traffic: `~/.local/state/term2-nodejs/logs/provider-traffic/2026-05-26/14-41-41_18dbe/`

User turn 1: "Review the change in commit ebf22ff5" — agent makes 30 shell tool
calls; an interruption (approval pause) splits the run at the 29th call.

After both `updateFromResult` calls, the `assistant_final` snapshot at seq=65
shows:

- `historyLen = 158` (= 77 + 81)
- 59 `function_call` + 59 `function_call_result` + 13 `message` + 27 `reasoning`
- 29 call_ids appear **twice** as `function_call` and twice as
  `function_call_result`
- 1 call_id (`call_uqf11ucKeNayvKYc5F7XgwmQ`) appears once each — the new 30th call

Layout in the final snapshot:

```
0..76    first copy (first stream's history, ending fcr_aGJw4 at 76)
77..157  full replay from continuation stream (81 items)

77   user "Review the change in commit ebf22ff5"   ← replayed user msg
78   reasoning  rs_3252f08191                       ← same SDK id as pos 1
...                                                 (full replay)
152  function_call         call_aGJw4
153  function_call         call_uqf11   ← NEW, inserted mid-batch
154  function_call_result  call_aGJw4
155  function_call_result  call_uqf11   ← NEW
156  reasoning             (new)
157  message               (new final assistant text)
```

User turn 2 ("can this change affect normal flow…") triggers the surge guard:

> Detected replayed tool call/result pairs: 29 duplicated pairs, max repetition 2.
> Request blocked to prevent runaway context growth.

## Why the merge failed

`#isPrefixMatch(existing, next)` walks index-by-index using `#signature`. For
tool items the signature is `call:${callId}:${type}`.

- `existing[76]` = `function_call_result` `call_aGJw4`
- `next[76]`     = `function_call` `call_uqf11`  ← MISMATCH

`#findSuffixPrefixOverlap` then checks if `existing`'s tail matches `next`'s
head. `existing`'s tail is `[fc_aGJw4, fcr_aGJw4]`; `next`'s head is
`[user_msg, reasoning, message, ...]`. No overlap. Falls through to:

```ts
this.#history = [...this.#history, ...next];   // 77 + 81 = 158
```

## Where the blame actually lies

The SDK is **not** doing anything wrong. The full-transcript replay (including
mid-batch insertion) is faithful to the Responses-API model of a parallel tool
batch:

1. `startStream` paused at the interruption, so the first stream's `.history`
   ended at `fcr_aGJw4` without the still-pending `fc_uqf11`.
2. `continueRunStream` returned the **full** history (same SDK ids replayed)
   with the now-complete batch laid out as
   `[fc_aGJw4, fc_uqf11, fcr_aGJw4, fcr_uqf11]`.

The bug was that `ConversationStore` assumed two things the SDK doesn't
guarantee across an interruption:

- New content always *appends* (false — interruption-resume can splice items
  into a prior position within the same response batch).
- Continuation history is a strict prefix-extension of stored history (false —
  it's a full replay).

Once those assumptions break, the positional merge can't recover and the
concatenation fallback produces the doubled state.

## The applied fix

`source/services/conversation-store.ts`:

```ts
updateFromResult(result: any): void {
  const incoming = result?.history;
  if (!Array.isArray(incoming) || incoming.length === 0) return;

  const next = this.#collapseReplayedHistoryPrefixes(
    this.#cloneHistory(incoming as AgentInputItem[])
  );

  if (this.#history.length === 0) {
    this.#history = next;
  } else if (next.length >= this.#history.length && this.#isPrefixMatch(this.#history, next)) {
    this.#history = next;
  } else {
    const overlap = this.#findSuffixPrefixOverlap(this.#history, next);
    if (overlap > 0) {
      const mergedExisting = this.#cloneHistory(this.#history);
      for (let i = 0; i < overlap; i++) {
        const existingIndex = mergedExisting.length - overlap + i;
        mergedExisting[existingIndex] = this.#preferIncomingItem(mergedExisting[existingIndex], next[i]);
      }
      this.#history = [...mergedExisting, ...next.slice(overlap)];
    } else {
      this.#history = [...this.#history, ...next];
    }
  }

  // Repair: dedup any SDK-interleaved replay or doubled tool pairs.
  this.#history = repairConversationHistory(this.#history).history as AgentInputItem[];
}
```

`repairConversationHistory` already existed in
`source/services/conversation-history-repair.ts` (callId-based dedup of tool
pairs + full-history-replay collapse) but was previously only called from
`conversation-replay.ts` during resume. The fix runs it after every live
`updateFromResult`, so the invariant "no duplicate tool pairs" holds at all
times rather than only after replay.

## Alternatives we considered

### 1. Defer the store update until a parallel batch is fully resolved

> "If we encounter a batch, hold off updating the store until all results are in,
> then merge once."

**Verdict: not better.**

- Doesn't eliminate the merge problem. Even on a clean (non-interrupted) turn,
  `continueRunStream` returns a full transcript replay. You still need merge
  logic for "I'm being shown content I already have," and once you have that,
  the mid-batch case is just a subcase.
- Other subsystems can't defer. Tool ledger, approval flow, UI rendering,
  persistence/log events, and `previousResponseId` need the call info **now**.
  Deferring only the store creates a split-brain (ledger says yes, store says
  no), with worse crash-recovery properties than "store may have duplicates
  briefly, then dedupes."
- "Batch complete" isn't a clean signal from the SDK. You'd be inferring it
  from absence of expected results — which is the same content-key check as
  the repair pass, just relocated.

Where it *could* help: as a perf optimization on top of content dedup, if
profiling shows the repair pass is a hotspot on long sessions. Then a "skip
update while interruption is pending and we expect more items" gate can
short-circuit one merge per batch. Not a replacement for content dedup.

### 2. Use the Agents SDK's `Session` interface as the single source of truth

> "Drop our own `ConversationStore`, implement `Session`, let the SDK be the
> source of truth."

**Verdict: possible and architecturally correct — but a real refactor, not a
drop-in.** Best treated as a separate scoped project.

#### What the SDK offers

`@openai/agents-core/dist/memory/session.d.ts`:

```ts
interface Session {
  getSessionId(): Promise<string>
  getItems(limit?): Promise<AgentInputItem[]>
  addItems(items): Promise<void>        // delta-only
  popItem(): Promise<AgentInputItem | undefined>
  clearSession(): Promise<void>
  prepareHistoryItemForModelInput?(item)
  preserveReasoningItemIdsForPersistence?(): boolean
  applyHistoryMutations?({mutations})   // today: only replace_function_call
}
```

The runner already tracks `state._currentTurnPersistedItemCount` and calls
`addItems(newItems.slice(alreadyPersisted))` — that is, the SDK does
**delta persistence with a watermark internally**. This is exactly the
invariant our store has to reconstruct after the fact. With a Session attached,
mid-batch continuation is handled inside the runner; we'd never see "full
replay" because the runner only hands us new items.

Plug-in point: `RunConfig.session` on `run()` / `runStream()` (see
`@openai/agents-core/dist/runner/sessionPersistence.mjs` line 217:
`await session.addItems(sanitizedInput);`).

#### Mapping our current operations to Session

| Current op | Session equivalent |
|---|---|
| `addUserMessage`, `addImportedItem` | `addItems` |
| `getHistory` | `getItems` |
| `clear` | `clearSession` |
| `removeLastUserMessage` (hallucination retry) | `popItem` loop |
| `removeLastUserTurn` / `removeNLastUserTurns` (`/undo`) | `popItem` loop + iterate |
| `listUserTurns` (undo UI) | iterate `getItems()` |
| `addShellContext` w/ `SHELL_CONTEXT_PREFIX` | `addItems` + filter on read |
| `addModeNotice` (append-only system msg) | `addItems` |
| `addErrorContext` (system role) | `addItems` |

All expressible as a `TermSession implements Session` wrapper around the
existing JSONL persistence + log events. Session is the protocol, not the
storage — we'd still own persistence.

#### Wins

- Mid-batch / full-replay merge problem **goes away** structurally.
- `applyHistoryMutations` is a clean hook for tool-call rewrites.
- `prepareHistoryItemForModelInput` is the right place to strip reasoning IDs
  per provider.
- One source of truth inside the SDK's view of the conversation.

#### Risks and costs

- **Provider parity.** `Session` integration runs through the SDK's runner. Our
  custom `Runner`s for codex / openrouter must honor the same persistence
  calls; if any short-circuits them, items silently disappear.
- **`continueRunStream` semantics.** The Session must update correctly across
  pause — `_currentTurnPersistedItemCount` has to survive `RunState`
  serialization.
- **Mutation vocabulary is small.** Only `replace_function_call` today.
  Anything else needs roll-your-own.
- **Backwards compatibility with stored sessions.** Existing JSONL files were
  written by the current store. `repairConversationHistory` would still be
  needed on resume for legacy data; it just stops being needed for live
  updates.
- **Migration blast radius.** `ConversationStore` is used by replay, undo,
  snapshot capture, surge guard, large-uncached-input guard, subagents,
  persistence, and many tests. Each adapter needs review.

#### Suggested first step (cheap experiment)

Without committing to the full refactor, attach a `MemorySession` to runs as a
**shadow observer**: pass it via `RunConfig.session` and log what the SDK
persists vs. what our store has after each turn. If they agree, that's
evidence migration is safe. If they diverge, the divergences are the edge
cases to design the migration around.

## State of play

| Item | Status |
|---|---|
| Bug diagnosed | ✓ (this doc) |
| Logs verify mechanism (incl. exact mid-batch splice) | ✓ |
| Fix: `repairConversationHistory` in `updateFromResult` | ✓ |
| Test updates in `conversation-store.test.ts` | ✓ |
| Decide on Session-based refactor | open |
| Shadow `MemorySession` experiment | open |

## Files referenced

- `source/services/conversation-store.ts` — `updateFromResult` (line 100),
  `#isPrefixMatch` (486), `#findSuffixPrefixOverlap` (500), `#signature` (447)
- `source/services/conversation-history-repair.ts` — `repairDuplicatedToolPairs`
  (204), `repairConversationHistory` (276)
- `source/services/conversation-replay.ts` — calls `repairConversationHistory`
  (312) during resume
- `source/services/conversation-session.ts` — `#buildOutgoingInput` (222),
  `assistant_final` snapshot capture (457), `startStream` flow (746),
  `continueRunStream` flow (969), abort-resolution flow (610)
- `source/services/input-surge-guard.ts` — `InputSurgeGuard` (163)
- `node_modules/@openai/agents-core/dist/memory/session.d.ts` — Session interface
- `node_modules/@openai/agents-core/dist/runner/sessionPersistence.mjs` —
  runner-side persistence flow
