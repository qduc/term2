## Refactoring Plan

### Problem

`ContinuationState.currentCallIds` is populated by `getContinuationCallIds()`, which reconstructs the set of in-flight tool call IDs by:
1. Scanning SDK interruption objects
2. Walking `RunState.generatedItems` and pattern-matching on `TOOL_RESULT_ITEM_TYPES`

This is fragile — it depends on SDK-internal field names, item types, and nesting, all of which can break across provider or SDK changes. Meanwhile, the `ToolExecutionLedger` already tracks every tool call the moment it arrives, with authoritative call IDs, turn scope, and completion status.

### Strategy

Add an `activeCallIdsForTurn()` method to `ToolExecutionLedger` (and expose it via `SessionToolTracker`), then replace every site that populates or derives `currentCallIds` with a call to the ledger. Remove `getContinuationCallIds()` entirely and all the heuristic scavenging it does.

### Resolved blocking concerns

**Concern 1 (aborted exclusion):** Confirmed. The old code includes aborted/rejected call IDs in `currentCallIds` — there is no status filter. After `state.reject()`, the SDK produces a synthetic `RunToolCallOutputItem` for the rejected call, which lands in `generatedItems`. The filter then includes this output because the call ID is still in `toolResultCallIds`. Provider APIs require all tool calls to have corresponding outputs. **The ledger method must NOT exclude `'aborted'` entries. The correct filter is: include all entries for the current turn, unconditionally.**

**Concern 2 (interruption path ledger completeness):** Confirmed safe. The SDK emits `function_call` items for all parallel calls **synchronously** before tool execution begins (`run.mjs:812` before `run.mjs:814`). `onFunctionCallItem` → `recordFunctionCall` fires during stream iteration in `InitialStreamCycle`, which completes before `ContinuationDriver.drive()` runs. `recordPendingApproval` is a redundant re-recording (idempotent). **A test should be added to lock this invariant, but no design change is needed.**

**Concern 3 (criterion #3 contradiction):** The new approach produces a **superset** that includes call IDs from all prior continuation cycles within the same turn. This is not a regression — it matches what `getContinuationCallIds` does (it re-scans `generatedItems` every cycle and includes all tool result IDs). **Criterion #3 should be rewritten.**

**Concern 4 (delta-mode duplication):** The superset is **safe**. `filterChainedModelInput` only keeps items from `modelData.input` whose call IDs match `toolResultCallIds`. If `toolResultCallIds` includes a previously-completed call ID, and that output is still in `modelData.input`, it gets re-included — but this is harmless because the provider API with `previousResponseId` already has it and treats re-sent outputs as idempotent. If the output is NOT in `modelData.input` (because the SDK didn't replay it), the call ID simply has no effect. **This should be verified with a test.**

---

### Step 1: Add `activeCallIdsForTurn()` to `ToolExecutionLedger`

**File:** `source/services/tool-execution-ledger.ts`

Add:

```ts
/**
 * Returns call IDs for every tool call recorded in the given (or current) turn.
 * The chained-input filter needs the complete set — including aborted/rejected
 * calls, because the provider API requires a tool output for every tool call
 * in an assistant turn, and the SDK produces a synthetic output for rejections.
 */
activeCallIdsForTurn(turnId?: string): string[] {
  const target = turnId ?? this.#currentTurnId;
  return this.#entries
    .filter(e => e.turnId === target)
    .map(e => e.callId);
}
```

**No status filtering.** The set must be complete because:
- `'completed'` entries have real outputs that must be sent
- `'aborted'` entries have synthetic outputs (from `recordAbortedApproval`) that must be sent
- `'started'`/`'approval_required'` entries are pending — their outputs will be produced by the continuation stream

**Tests** to add:
- Empty ledger returns `[]`
- Only entries matching the given turn
- All statuses included (`'started'`, `'completed'`, `'aborted'`, `'approval_required'`, `'failed'`)
- Defaults to `#currentTurnId` when no argument given
- Mixed-turn scenario: entries from other turns excluded
- **Regression test:** aborted entry's call ID is included (the concern-1 test)

### Step 2: Expose via `SessionToolTracker`

**File:** `source/services/session/session-tool-tracker.ts`

```ts
activeCallIdsForCurrentTurn(): string[] {
  return this.toolLedger.activeCallIdsForTurn();
}
```

### Step 3: Refactor `ContinuationState` — pass `currentCallIds` into methods

**Design change (per review recommendation #5):** Instead of leaving `currentCallIds` unset after `initializeFrom`/`advanceFromPlan`, pass it as a parameter. The caller still owns the ledger read, but the invariant ("after this method, the field is correct") is preserved.

**File:** `source/services/session/continuation-state.ts`

```ts
initializeFrom(prepared: PreparedContinuation, currentCallIds: string[]): void {
  this.currentState = prepared.state;
  this.currentCallIds = currentCallIds;
  this.source = prepared.source;
  this.previouslyEmittedIds = prepared.previouslyEmittedCommandIds;
  this.inputMode = prepared.inputMode ?? 'delta';
  this.cumulativeUsage = prepared.cumulativeUsage;
  this.cumulativeCommandMessages = prepared.cumulativeCommandMessages ? [...prepared.cumulativeCommandMessages] : [];
  this.cumulativeTurnItems = prepared.cumulativeTurnItems;
  this.token = prepared.token ?? this.token;
}

advanceFromPlan(
  nextState: RunState<any, any>,
  nextInterruption: unknown,
  nextInputMode: 'delta' | 'full_history' | undefined,
  mergedEmittedIds: Set<string>,
  ledgerSnapshot: SavedToolExecution[],
  currentCallIds: string[],
): void {
  this.currentState = nextState;
  this.currentCallIds = currentCallIds;
  this.source = 'continueRunStream';
  this.previouslyEmittedIds = mergedEmittedIds;
  this.ledgerSnapshot = ledgerSnapshot;
  this.inputMode = nextInputMode ?? this.inputMode;
}
```

Delete `getContinuationCallIds()` and the following now-unused imports: `TOOL_RESULT_ITEM_TYPES` from `chained-input-filter.js`, `asRecord` from `interruption-info.js`.

**Tests:** Update all test cases that call `initializeFrom` / `advanceFromPlan` to pass `currentCallIds` explicitly. Tests that previously asserted that `initializeFrom` populated `currentCallIds` from interruptions/generatedItems now verify it uses the passed-in parameter.

### Step 4: Add `toolTracker` to `ContinuationDriverDeps`

**Files:** `source/services/session/continuation-driver.ts`, `source/services/session/session-composition.ts`

```ts
export type ContinuationDriverDeps = {
  // ... existing deps ...
  toolTracker: SessionToolTracker;  // NEW
};
```

Wire in `session-composition.ts`.

### Step 5: Drive `currentCallIds` from the ledger in `ContinuationDriver`

**File:** `source/services/session/continuation-driver.ts`

**5a. In `drive()`:** After `state.initializeFrom(prepared, ...)`, pass ledger-derived IDs:

```ts
const prepared = this.deps.planApplier.prepareInit(init);
const state = new ContinuationState(init.generation);
state.initializeFrom(prepared, this.deps.toolTracker.activeCallIdsForCurrentTurn());
```

**5b. Replace `#stagePendingParallelApprovals` manual Set merging:**

```ts
// Remove:
//   const parallelCallIds = new Set(state.currentCallIds);
//   ...
//   for (const callId of state.currentCallIds) { parallelCallIds.add(callId); }
//   state.currentCallIds = [...parallelCallIds];

// After each applyNextPlan call, re-derive from ledger:
state.currentCallIds = this.deps.toolTracker.activeCallIdsForCurrentTurn();
```

This is semantically equivalent because:
- `applyNextPlan` calls `recordAbortedApproval` if rejected, updating the ledger
- The ledger is cumulative — it retains all entries from the turn, including previously-completed and newly-aborted ones
- A fresh read captures the complete set

**5c. In `applyNextPlan` call site:** Update the `continuation-plan-applier.ts` call to also pass the new `currentCallIds` parameter through `advanceFromPlan`. The plan applier already has `toolTracker`:

```ts
// continuation-plan-applier.ts
state.advanceFromPlan(
  nextPlan.pendingApprovalContext.state,
  nextPlan.pendingApprovalContext.interruption,
  nextPlan.pendingApprovalContext.inputMode,
  mergedEmittedIds,
  this.deps.toolTracker.export(),
  this.deps.toolTracker.activeCallIdsForCurrentTurn(),  // NEW
);
```

**Tests in `continuation-driver.test.ts`:** All existing test helpers that create a `ContinuationState` or call `initializeFrom` need to pass `currentCallIds`. Tests using mock `planApplier` / `streamCycle` (which don't update a real ledger) should explicitly pass the expected call IDs, matching the test scenario.

Add **regression test** for concern 2: create a test where `recordFunctionCall` has been called for tool calls before the driver reads the ledger, then verify `activeCallIdsForCurrentTurn()` includes them.

### Step 6: Update `ContinuationRecoveryHandler`

**File:** `source/services/session/continuation-recovery-handler.ts`

Add `toolTracker` to deps. Replace the `currentCallIds = []` reset with a re-derivation:

```ts
export type ContinuationRecoveryHandlerDeps = {
  // ... existing deps ...
  toolTracker: SessionToolTracker;  // NEW
};

// In handle(), after resume recovery:
// Before:
state.currentCallIds = [];
// After:
state.currentCallIds = this.deps.toolTracker.activeCallIdsForCurrentTurn();
```

Wire `toolTracker` in `session-composition.ts`.

**File:** `source/services/retry/recovery-executor.ts` — this reads `RecoveryState.toolResultCallIds` and passes it to `toolTracker.recoverApprovedResultsFromState`. No change needed; the `toolResultCallIds` value comes from `state.currentCallIds` which is now ledger-derived.

### Step 7: Add delta-mode safety test

**File:** `source/lib/chained-input-filter.test.ts`

Add a test for the multi-cycle scenario (concern 4):

```ts
test('filterChainedModelInput with toolResultCallIds containing a previously-sent call ID only includes what exists in input', (t) => {
  const modelData = {
    input: [
      // cycle-2's modelData.input only has call-B's output (call-A was already sent)
      { type: 'function_call_output', callId: 'call-B', output: 'result-B' },
    ],
  };
  // toolResultCallIds includes call-A (from prior cycle) and call-B (current)
  const result = filterChainedModelInput(modelData, { toolResultCallIds: ['call-A', 'call-B'] });
  // call-A has no matching item in input, so it's silently ignored — no duplication
  t.deepEqual(result.input, [
    { type: 'function_call_output', callId: 'call-B', output: 'result-B' },
  ]);
});
```

### Step 8: Clean up dead code

- Delete `getContinuationCallIds()` from `continuation-state.ts`
- Remove import of `TOOL_RESULT_ITEM_TYPES` from `chained-input-filter.js`
- Remove import of `asRecord` from `interruption-info.js` (verify no other usage in the file)
- Remove the `#stagePendingParallelApprovals` manual `Set` merge code

---

### Revised acceptance criteria

1. `getContinuationCallIds()` no longer exists in the codebase
2. `continuation-state.ts` has no imports from `chained-input-filter.js`
3. Every read of `state.currentCallIds` returns a **superset** of what the old approach would return for the same ledger state — at minimum the same call IDs, possibly more from prior cycles (this is correct and safe per concern-4 analysis)
4. Aborted/rejected call IDs are **included** in `activeCallIdsForTurn()` — provider APIs require every tool call to have a corresponding output
5. The parallel-approval test passes with ledger-derived call IDs
6. The interruption-path ledger completeness invariant is covered by a regression test
7. Delta-mode safety test passes
8. `pnpm test` passes with no regressions

### Clarified definition of "active"

Per review concern #6, "active" in `activeCallIdsForTurn` means **every tool call recorded in the turn**, regardless of status. The docstring should say this explicitly:

> Returns call IDs for every tool call recorded in the given (or current) turn, regardless of status. The chained-input filter requires the complete set because the provider API requires a tool output for every tool call in an assistant turn — including rejected calls, for which the SDK produces a synthetic output.

### Implementation sequence

| Step | File(s) | Depends on | Risk |
|------|---------|------------|------|
| 1 | `tool-execution-ledger.ts` + tests | None | Low — additive |
| 2 | `session-tool-tracker.ts` + tests | Step 1 | Low — thin delegation |
| 3 | `continuation-state.ts` + tests | Step 2 | Medium — API change (new param) |
| 4 | `continuation-driver.ts` deps + composition | Step 3 | Low — adds a dep |
| 5 | `continuation-driver.ts` + `continuation-plan-applier.ts` logic + tests | Steps 2, 4 | Medium — replaces heuristic |
| 6 | `continuation-recovery-handler.ts` + composition | Step 2 | Low — adds dep, minor logic |
| 7 | `chained-input-filter.test.ts` — delta safety test | None | Low — additive test |
| 8 | `continuation-state.ts` cleanup | Step 3 | Low — removing dead code |