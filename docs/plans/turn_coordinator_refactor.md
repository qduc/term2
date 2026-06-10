## Refactor Plan

### 1. Lock Observable Behavior

Add characterization tests before production changes.

Cover exact emitted event sequences for:

- Plain successful turn.
- Approval then approval.
- Approval then rejection.
- Auto-approved continuation.
- Multiple sequential interruptions.
- Transient retry before stream creation.
- Transient retry during stream iteration.
- Aborted approval resolved by new user input.
- Unrecoverable failure with tool-ledger reconciliation.
- Stale completion after generation changes.

Assert ordered structured events rather than broad snapshots where possible.

Run:

```bash
npm run test:verbose -- source/services/conversation-session.characterization.test.ts
npm run test:verbose -- source/services/conversation-session.stream.test.ts
npm run test:verbose -- source/services/conversation-session.auto-approval.test.ts
```

### 2. Introduce `TurnStatusMachine`

This is a transition validator, not a cleanup service.

API:

```ts
beginTurn(): void
requestApproval(): void
beginContinuation(): void
complete(): void
abort(): void
```

Legal transitions:

```text
idle -> streaming
streaming -> awaiting_approval | idle
awaiting_approval -> continuing | idle
continuing -> awaiting_approval | idle
```

There will be no `completeUnlessAwaitingApproval()`. The use case explicitly chooses the correct transition.

Only `TurnStatusMachine` may mutate turn status. Resource cleanup remains with the use case that acquired the resource.

### 3. Introduce `ProviderContinuity`

Own both happy-path and failure-path provider continuity:

- Current `previousResponseId`.
- Updating it after successful stream finalization.
- Clearing it after provider changes, retries, undo, resume, and transport downgrade.
- Determining whether delta chaining is available.
- Coordinating the corresponding input-planner continuity state.

This removes duplicated updates to `SessionLifecycle.previousResponseId` and `SessionInputPlanner.previousResponseId`.

Invariant: provider response chaining has one source of truth.

### 4. Introduce `GenerationGuard`

Own generation and stale-attempt protection:

```ts
capture(): GenerationToken
isCurrent(token): boolean
invalidate(): void
runIfCurrent(token, mutation): boolean
```

Any mutation derived from asynchronous provider work must be guarded through this abstraction.

`TurnAttempt` may hold a token, but it does not decide whether mutation is legal.

Invariant: stale attempts cannot mutate conversation, ledger, continuity, or status state.

### 5. Define the Retry and Recovery Contract

Before extracting implementation, define explicit contracts:

```ts
type ClassifiedFailure =
  | { kind: 'transient'; attempt: number; delayMs: number }
  | { kind: 'service_tier_fallback' }
  | { kind: 'transport_downgrade' }
  | { kind: 'model_retry'; errorContext?: string }
  | { kind: 'unrecoverable' };

type RecoveryPlan =
  | { kind: 'resume_stream'; state: RunState; previousResponseId: string | null }
  | { kind: 'replay_turn'; inputMode: 'full_history'; rollbackUserMessage: boolean }
  | { kind: 'retry_fresh'; inputMode: 'delta' | 'full_history' }
  | { kind: 'terminate'; events: ConversationEvent[] };
```

Responsibilities:

- `RetryClassifier`: turns an error and attempt facts into `ClassifiedFailure`.
- `ConversationRecoveryPolicy`: turns `ClassifiedFailure` and a state snapshot into `RecoveryPlan`.
- `RecoveryExecutor`: atomically applies the plan and returns the next execution instruction.

`TurnCoordinator` forwards the executor’s instruction. It does not interpret ledger restoration or history reconciliation rules.

Evaluate `RetryHandler` and `SessionRetryOrchestrator` during this step. Keep them only if each retains a distinct responsibility; otherwise replace them with the three contracts above.

### 6. Introduce One `ContinuationDriver`

Do not create overlapping `ApprovalContinuation` and `TurnOutcomeResolver` classes.

`ContinuationDriver` owns progressing from an interruption to the next terminal boundary:

- Manual approval.
- Manual rejection.
- Automatic approval policy.
- Applying the approval decision.
- Emitting and deduplicating `tool_started`.
- Resuming the provider stream.
- Handling subsequent interruptions.
- Repeating automatically approved continuations.
- Merging usage, reasoning, command messages, and turn items.
- Producing either `approval_required` or a final response.
- Recording and logging the approval boundary exactly once.

Manual versus automatic approval is supplied as policy:

```ts
interface ApprovalDecisionPolicy {
  decide(context: ApprovalContext): Promise<'approve' | 'reject' | 'prompt'>;
}
```

Invariant: all continuation paths use the same driver and preserve the same event ordering.

### 7. Extract `ConversationRecoveryPolicy` and `RecoveryExecutor`

Develop test-first around state snapshots and explicit plans.

`ConversationRecoveryPolicy` owns decisions about:

- Ledger restoration.
- User-message rollback.
- Approved-result recovery.
- Failed-stream reconciliation.
- Chaining reset.
- Full-history replay.
- Recovery event contents.

`RecoveryExecutor` owns mutations:

- Applying ledger snapshots.
- Reconciling conversation history.
- Updating `ProviderContinuity`.
- Recovering approved tool results.
- Producing the next run request.

Invariant: recovery either establishes a consistent replay/resume state or terminates without partial mutation.

### 8. Introduce `TurnAttempt` After Flows Stabilize

Defer this until the continuation and recovery contracts reveal its real shape.

Prefer immutable construction plus named transitions:

```ts
attempt.markUserMessageAdded()
attempt.attachStream(stream)
attempt.advanceRetry(classification)
attempt.close()
```

Do not expose writable fields.

Likely owned state:

- Normalized turn.
- Generation token.
- Retry counters.
- Initial ledger snapshot.
- Current stream reference.
- User-message-added state.
- Abort subscription lifecycle.

Mutation rules:

- Only `TurnAttempt` modifies its local lifecycle state.
- `RecoveryExecutor` requests retry transitions through named methods.
- Conversation and ledger state never live inside `TurnAttempt`.
- `close()` removes its abort listener exactly once.

### 9. Simplify Stream Finalization

Update `SessionStreamProcessor` so finalization delegates:

- Staleness checks to `GenerationGuard`.
- Response ID updates to `ProviderContinuity`.
- Conversation mutations through guarded operations.

It may still own stream parsing and replay-history selection, but not generation or continuity state.

### 10. Reduce `TurnCoordinator`

Its final responsibility is application-level sequencing:

```text
validate start
create attempt
execute initial stream
delegate interruptions to ContinuationDriver
delegate failures to RecoveryExecutor
forward events
close attempt
transition status explicitly
```

Target dependencies:

- `TurnStatusMachine`
- `GenerationGuard`
- `InitialTurnRunner`
- `ContinuationDriver`
- `RecoveryExecutor`
- `TurnAttemptFactory`

It must not know how to:

- Restore ledgers.
- Reconcile history.
- Update response IDs.
- Aggregate continuation results.
- Classify failures.
- Construct approval boundaries.

### 11. Clean Composition and Remove Superseded Types

Update `conversation-session-composition.ts`.

Remove:

- Unused `conversationLogger` dependency.
- Direct status assignments.
- Duplicate generation counters.
- Duplicate `previousResponseId` storage.
- Coordinator access to ledger internals.
- Superseded retry classes.
- Unused `TurnState` fields.

Do not preserve obsolete abstractions merely to reduce diff size.

### 12. Verification Gates

After each stage:

1. Run focused tests for the new owner.
2. Run affected event-sequence characterization tests.
3. Run stream, approval, auto-approval, and input-surge tests.
4. Format changed files.

Final verification:

```bash
npm test
npx prettier --write <changed-files>
```

## Completion Criteria

- Every mutable invariant has one named owner.
- Manual and automatic continuations share one driver.
- Recovery plans have a named executor.
- Retry classification, recovery planning, and recovery mutation have explicit contracts.
- Stale asynchronous work cannot mutate state.
- Provider continuity has one source of truth.
- `TurnAttempt` exposes no generally writable state.
- Turn status is mutated only by `TurnStatusMachine`.
- `TurnCoordinator` has 4–6 use-case-level dependencies.
- Key event sequences remain exactly characterized.
- No extracted class is merely a renamed block of coordinator logic.
