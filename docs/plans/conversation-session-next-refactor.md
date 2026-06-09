# Conversation Session Next Refactor Plan

## Summary

`source/services/conversation-session.ts` has already been decomposed into several focused collaborators, but it still acts as the central composition root and public API surface for conversation behavior. This plan reduces `ConversationSession` from a god coordinator into a smaller session boundary by moving construction, terminal collection, runtime settings mutation, and persistence-facing state access into dedicated components.

The target shape is:

- `ConversationSession` owns session identity and delegates event-stream operations.
- A session composition factory wires collaborators.
- A terminal adapter handles `sendMessage` and approval decision result collection.
- A runtime controller handles model/provider/runtime changes.
- A state facade handles snapshots, import/export, undo, shell context, and mode notices.
- `ConversationService` remains the backward-compatible CLI facade during migration.

## Current Problems

- `ConversationSession` constructs nearly the entire conversation subsystem itself.
- `ConversationSession` exposes too many unrelated public methods.
- Terminal-oriented collection logic is mixed with event-stream primitives.
- Provider/model mutation is mixed with conversation execution.
- Persistence snapshot behavior is mixed with UI/session operations.
- Tests instantiate `ConversationSession` directly, making the broad surface sticky.

## Goals

- Keep behavior unchanged for CLI callers and non-interactive mode.
- Reduce `ConversationSession` responsibilities without a large risky rewrite.
- Make each extracted object testable through observable behavior.
- Keep `ConversationService` as the compatibility boundary while internals move.
- Preserve approval, retry, chaining, traffic context, tool ledger, and usage accounting behavior.

## Non-Goals

- Do not change provider APIs.
- Do not redesign event types or terminal result contracts.
- Do not remove `ConversationService` in this refactor.
- Do not rewrite the existing stream/retry/approval runners unless required by the extraction.
- Do not change persisted state format unless a test proves a compatibility-preserving adapter is needed.

## Phase 0: Baseline And Characterization

### Files To Inspect

- `source/services/conversation-session.ts`
- `source/services/conversation-service.ts`
- `source/non-interactive.ts`
- `source/hooks/use-conversation.ts`
- `source/services/conversation-session*.test.ts`
- `source/services/session-input-planner.ts`
- `source/services/session-state-controller.ts`
- `source/services/conversation-turn-runner.ts`
- `source/services/approval-continuation-runner.ts`
- `source/services/session-stream-processor.ts`

### Baseline Tests

Run focused session tests before changes:

```bash
npm run test:verbose -- source/services/conversation-session.test.ts source/services/conversation-session.isolation.test.ts source/services/conversation-session.input-surge.test.ts
```

If any of those filenames do not exist in the current checkout, replace them with the matching `source/services/conversation-session*.test.ts` files reported by `fd 'conversation-session.*test' source/services`.

Run broader conversation-facing tests when phases touch `ConversationService`, `use-conversation`, or non-interactive mode:

```bash
npm run test:verbose -- source/services/conversation-service.test.ts source/hooks/use-conversation.test.tsx source/non-interactive.test.ts
```

If a listed test file does not exist, use the nearest existing focused test and document the substitution in the change summary.

### Characterization Coverage To Add First

Add or confirm tests for these behaviors before extraction:

- `sendMessage` wraps events with log dispatch and clears `setSubagentEventSink` in `finally`.
- `handleApprovalDecision` returns `null` when no approval is pending.
- `handleApprovalDecision` sets ask-user approval answers by call ID only for accepted approvals.
- `abort` records an aborted approval tool ledger entry only when an approval was pending and aborted.
- `getCurrentSnapshot` reconciles history with tool ledger and includes provider/model when available.
- Provider/model/temperature/reasoning changes call `afterProviderChanged` before mutating the agent client.
- Auto-approved tool continuations preserve cumulative usage and command messages.
- Traffic context includes session ID, started-at timestamp, first user message preview, mode, and trace ID.

## Phase 1: Extract Session Composition

### New Files

- `source/services/conversation-session-composition.ts`

### Modified Files

- `source/services/conversation-session.ts`
- Relevant session tests that construct `ConversationSession`

### New Types

Create a composition result type:

```typescript
export type ConversationSessionComposition = {
  conversationStore: ConversationStore;
  approvalState: ApprovalState;
  toolTracker: SessionToolTracker;
  shellAutoApproval: ShellAutoApprovalResolver;
  approvalFlow: ApprovalFlowCoordinator;
  retryOrchestrator: SessionRetryOrchestrator;
  inputPlanner: SessionInputPlanner;
  state: SessionStateController;
  conversationLogger: ConversationLogger;
  streamProcessor: SessionStreamProcessor;
  continuationRunner: ApprovalContinuationRunner;
  turnRunner: ConversationTurnRunner;
};
```

Create a factory function:

```typescript
export function createConversationSessionComposition(options: {
  sessionId: string;
  agentClient: ConversationAgentClient;
  deps: {
    logger: ILoggingService;
    settingsService?: ISettingsService;
    sessionContextService: ISessionContextService;
  };
  retryOptions?: ConversationSessionRetryOptions;
  callbacks: {
    breakChaining: () => void;
    buildAndResolve: BuildAndResolveFn;
    restartTurn: RestartTurnFn;
    isCurrentGeneration: (generation: number) => boolean;
    getAssistantTurnState: () => {
      previousResponseId: string | null;
      provider?: string;
      model?: string;
    };
  };
}): ConversationSessionComposition;
```

### Data Flow

- `ConversationSession` constructor stores primitive session metadata and dependencies.
- The constructor calls `createConversationSessionComposition` once.
- The factory constructs existing collaborators in the same order currently used by `ConversationSession`.
- Callbacks keep cyclic behavior explicit without letting the factory own session methods.

### Acceptance Criteria

- `ConversationSession` no longer manually constructs every collaborator inline.
- No behavior changes for event streaming, approval continuation, retry, or logging.
- Existing direct `ConversationSession` tests pass without needing broad rewrites.

### Edge Cases

- Preserve `retryOptions.allowFreshStartRetries` default of `true`.
- Preserve `agentClient.onDowngrade` registration behavior in `ConversationSession`, not the factory, because it mutates session chaining state.
- Avoid exposing mutable composition internals outside the session package unless needed for tests.

## Phase 2: Extract Terminal Adapter

### New Files

- `source/services/conversation-terminal-adapter.ts`

### Modified Files

- `source/services/conversation-session.ts`
- `source/services/conversation-service.ts` only if method forwarding types need adjustment
- `source/non-interactive.ts` only if it imports `ConversationSession['sendMessage']` types directly

### New Class

```typescript
export class ConversationTerminalAdapter {
  sendMessage(input: string | UserTurn, options?: SendMessageOptions): Promise<ConversationTerminal>;

  handleApprovalDecision(
    answer: string,
    rejectionReason?: string,
    options?: HandleApprovalDecisionOptions,
  ): Promise<ConversationTerminal | null>;
}
```

### New Option Types

Move callback option shapes out of `ConversationSession`:

```typescript
export type SendMessageOptions = {
  onTextChunk?: (fullText: string, chunk: string) => void;
  onReasoningChunk?: (fullText: string, chunk: string) => void;
  onCommandMessage?: (message: CommandMessage) => void;
  onEvent?: (event: ConversationEvent) => void;
  hallucinationRetryCount?: number;
};

export type HandleApprovalDecisionOptions = {
  onTextChunk?: (fullText: string, chunk: string) => void;
  onReasoningChunk?: (fullText: string, chunk: string) => void;
  onCommandMessage?: (message: CommandMessage) => void;
  onEvent?: (event: ConversationEvent) => void;
  approvalAnswer?: string;
};
```

### Adapter Dependencies

The adapter receives explicit dependencies instead of reaching through `ConversationSession` internals:

- `sessionId`
- `startedAt`
- `agentClient`
- `logger`
- `settingsService`
- `sessionContextService`
- `conversationStore`
- `conversationLogger`
- `approvalFlow`
- `run(input, options)` callback
- `continueAfterApproval(options)` callback

### Data Flow

- `ConversationService.sendMessage` continues to call the session compatibility method initially.
- `ConversationSession.sendMessage` delegates to `terminalAdapter.sendMessage`.
- The adapter creates traffic context, installs the subagent event sink, calls `collectTerminalResult`, and clears the sink in `finally`.
- The adapter owns `#withTrafficContext`, `#getTrafficMode`, and first-user-message preview logic.

### Acceptance Criteria

- `ConversationSession` no longer imports `collectTerminalResult`.
- `ConversationSession` no longer owns traffic context helper methods.
- `sendMessage` and `handleApprovalDecision` behavior remains unchanged.
- Subagent event sink cleanup is covered by tests.

### Edge Cases

- If `collectTerminalResult` throws, `setSubagentEventSink(null)` must still run.
- Approval-required terminal results must still include `rawInterruption` from `approvalFlow.getPendingInterruption()`.
- `hallucinationRetryCount` must still flow into `run` as `retries.hallucinationRetryCount`.

## Phase 3: Extract Runtime Controller

### New Files

- `source/services/session-runtime-controller.ts`

### Modified Files

- `source/services/conversation-session.ts`
- `source/services/conversation-service.ts` if it should forward directly to the runtime controller later

### New Class

```typescript
export class SessionRuntimeController {
  setModel(model: string): void;
  setReasoningEffort(effort: ReasoningEffortSetting): void;
  setTemperature(temperature?: number): void;
  setProvider(provider: string): void;
  switchProvider(provider: string): void;
  setRetryCallback(callback: () => void): void;
}
```

### Dependencies

- `agentClient`
- `state`

### Data Flow

- Runtime controller calls `state.afterProviderChanged()` before any provider/model mutation.
- Runtime controller uses `getMethod` for optional agent-client capabilities, preserving current behavior.
- `ConversationSession` keeps compatibility methods that delegate to the runtime controller.

### Acceptance Criteria

- `ConversationSession` no longer directly mutates provider/model/temperature/reasoning settings.
- The order `afterProviderChanged` then agent-client mutation is verified by tests.
- Optional agent-client methods remain optional and no-op when unavailable.

### Edge Cases

- `setModel` currently calls `agentClient.setModel` directly; preserve any thrown errors.
- `switchProvider` remains an alias for `setProvider`.
- `setRetryCallback` must not throw if unsupported.

## Phase 4: Extract State Facade

### New Files

- `source/services/session-state-facade.ts`

### Modified Files

- `source/services/conversation-session.ts`
- `source/services/conversation-service.ts` if forwarding types need adjustment

### New Class

```typescript
export class SessionStateFacade {
  reset(): void;
  undoLastUserTurn(): { text: string; images?: UserTurn['images'] } | null;
  undoNUserTurns(n: number): { text: string; images?: UserTurn['images'] } | null;
  listUserTurns(): { index: number; text: string; imageCount: number }[];
  getCurrentSnapshot(): StateSnapshot;
  exportState(): { history: unknown[]; previousResponseId: string | null; toolLedger: SavedToolExecution[] };
  importState(state: {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger?: SavedToolExecution[];
    updatedAt?: string;
  }): void;
  addShellContext(historyText: string): void;
  queueModeNotice(text: string): void;
}
```

### Dependencies

- `conversationStore`
- `toolTracker`
- `state`
- `conversationLogger`
- `agentClient`
- `settingsService`
- `sessionId`

### Data Flow

- Undo methods mutate `ConversationStore`, then call `state.afterUndo()`, then log an undo event with the current snapshot.
- Snapshot uses `reconcileHistoryWithToolLedger` and includes `previousResponseId`, `toolLedger`, and optional provider/model.
- Export/import delegate to `SessionStateController`.
- Shell context remains a store mutation.
- Mode notice remains `state.pendingModeNotice` mutation.

### Acceptance Criteria

- `ConversationSession` no longer imports `reconcileHistoryWithToolLedger` or `AgentInputItem` for snapshots.
- Undo, import/export, shell context, and mode notice behavior remains unchanged.
- Existing persistence/resume tests pass.

### Edge Cases

- `undoLastUserTurn` and `undoNUserTurns` must return `null` without logging if no user turn is removed.
- Snapshot provider fallback must preserve current `agentClient.getProvider` then settings lookup behavior.
- Importing state with missing `toolLedger` remains supported.

## Phase 5: Move Auto-Approval Continuation Out Of ConversationSession

### New Files

- `source/services/auto-approval-continuation-resolver.ts`

### Modified Files

- `source/services/conversation-session.ts`
- `source/services/conversation-session-composition.ts`
- `source/services/conversation-result-builder.ts` only if a cleaner return type is needed

### New Class

```typescript
export class AutoApprovalContinuationResolver {
  buildAndResolve(
    result: AgentStream,
    finalOutputOverride: string | undefined,
    reasoningOutputOverride: string | undefined,
    emittedCommandIds: Set<string> | undefined,
    usage: NormalizedUsage | undefined,
  ): AsyncGenerator<ConversationEvent, ConversationTerminal, void>;
}
```

### Dependencies

- `approvalFlow`
- `shellAutoApproval`
- `logger`
- `sessionId`
- `toolTracker`
- `turnAccumulator`
- `continuationRunner` or a continuation callback

### Data Flow

- Resolver calls `buildConversationResult`.
- If result is not `auto_approve`, it returns the terminal result unchanged.
- If result is `auto_approve`, it continues approval with answer `y` against the current generation.
- It yields intermediate events, patches cumulative usage onto nested `approval_required` events, and returns the final terminal result.

### Acceptance Criteria

- `ConversationSession` no longer owns the `#buildAndResolve` implementation body.
- Usage merging behavior remains unchanged for auto-approved continuations.
- Command messages and continuation turn items are preserved.

### Edge Cases

- If continuation emits another `approval_required`, return an `approval_required` terminal result with `rawInterruption` attached.
- If continuation emits no final text, preserve current fallback `finalText: 'Done.'`.
- If final continuation usage is absent, preserve first-turn usage fallback.

## Phase 6: Narrow ConversationSession Public Surface

### Modified Files

- `source/services/conversation-session.ts`
- `source/services/conversation-service.ts`
- `source/non-interactive.ts`
- `source/hooks/use-conversation.ts`
- Tests importing `ConversationSession` method types

### Target Public API

Keep these methods on `ConversationSession`:

- `run`
- `continueAfterApproval`
- `abort`
- `reset`
- `id`
- `startedAt`

Keep compatibility delegation methods temporarily if callers still use them:

- `sendMessage`
- `handleApprovalDecision`
- `getCurrentSnapshot`
- `undoLastUserTurn`
- `undoNUserTurns`
- `listUserTurns`
- `exportState`
- `importState`
- runtime setting methods

Mark temporary compatibility methods with comments that identify the owning collaborator and migration target.

### Migration Path

- `ConversationService` should own the stable broad CLI-facing API.
- `ConversationService` delegates terminal methods to `ConversationTerminalAdapter` where possible.
- `ConversationService` delegates runtime methods to `SessionRuntimeController` where possible.
- `ConversationService` delegates state methods to `SessionStateFacade` where possible.
- Direct non-test callers should stop depending on `ConversationSession['sendMessage']` and import explicit option/result types instead.

### Acceptance Criteria

- New production code does not need to call broad compatibility methods on `ConversationSession`.
- Type aliases in `source/non-interactive.ts` no longer depend on `ConversationSession['sendMessage']` or `ConversationSession['handleApprovalDecision']` if explicit exported types are available.
- Tests prefer collaborators for focused behavior and reserve `ConversationSession` tests for integration behavior.

## Test Plan

### Unit Tests

- `conversation-session-composition.test.ts`
  - Builds collaborators with shared store, tracker, state, logger, and retry orchestrator.
  - Preserves `allowFreshStartRetries` default and override behavior.

- `conversation-terminal-adapter.test.ts`
  - Dispatches events to conversation logs before forwarding to caller callbacks.
  - Installs and clears subagent event sink around `sendMessage`.
  - Clears subagent event sink when terminal collection throws.
  - Returns `null` for approval decision when no approval is pending.
  - Sets ask-user approval answers only for accepted approvals with call IDs.
  - Preserves traffic context fields.

- `session-runtime-controller.test.ts`
  - Calls `afterProviderChanged` before setting provider/model/temperature/reasoning effort.
  - No-ops optional methods when unavailable.
  - Keeps `switchProvider` as an alias.

- `session-state-facade.test.ts`
  - Undo methods log only when turns are removed.
  - Snapshot reconciles history with tool ledger.
  - Snapshot includes provider/model when available.
  - Import/export delegates to `SessionStateController`.
  - Shell context and mode notice mutations are preserved.

- `auto-approval-continuation-resolver.test.ts`
  - Non-auto-approval result returns unchanged.
  - Auto-approved continuation returns final response with cumulative usage.
  - Nested approval-required result includes raw interruption and merged usage.
  - Command messages and turn items survive continuation.

### Integration Tests

- Existing `conversation-session*.test.ts` files should continue passing after each phase.
- Existing `use-conversation` tests should continue passing after terminal adapter extraction.
- Existing non-interactive tests should continue passing after explicit terminal option types are introduced.

### Verification Commands

Run focused tests after each phase:

```bash
npm run test:verbose -- source/services/conversation-session.test.ts source/services/conversation-session.isolation.test.ts source/services/conversation-session.input-surge.test.ts
```

Run new collaborator tests after adding each collaborator:

```bash
npm run test:verbose -- source/services/conversation-terminal-adapter.test.ts source/services/session-runtime-controller.test.ts source/services/session-state-facade.test.ts source/services/auto-approval-continuation-resolver.test.ts
```

Run broader tests before merging the full refactor:

```bash
npm test
```

Run formatting for changed files:

```bash
npx prettier --check source/services/conversation-session.ts source/services/conversation-session-composition.ts source/services/conversation-terminal-adapter.ts source/services/session-runtime-controller.ts source/services/session-state-facade.ts source/services/auto-approval-continuation-resolver.ts docs/plans/conversation-session-next-refactor.md
```

## Implementation Order

1. Add characterization tests for current `ConversationSession` behavior.
2. Extract `conversation-session-composition.ts` while keeping all public methods unchanged.
3. Extract `ConversationTerminalAdapter` and delegate `sendMessage` and `handleApprovalDecision` through it.
4. Extract `SessionRuntimeController` and delegate provider/model/runtime methods through it.
5. Extract `SessionStateFacade` and delegate state, persistence, undo, shell context, and mode notice methods through it.
6. Extract `AutoApprovalContinuationResolver` and replace `#buildAndResolve` with a delegate.
7. Update production callers to depend on explicit exported types instead of `ConversationSession` method type queries.
8. Mark remaining compatibility methods on `ConversationSession` and document their owning collaborators.
9. Run focused tests after every phase and full tests at the end.

## Acceptance Criteria

- `ConversationSession` is primarily an event-stream session boundary.
- `ConversationSession` constructor is short and delegates subsystem wiring to `createConversationSessionComposition`.
- `ConversationSession` no longer contains terminal collection logic, traffic context logic, runtime setting mutation logic, snapshot assembly, or auto-approval continuation result assembly.
- `ConversationService` remains backward-compatible for CLI and hook callers.
- Public terminal option/result types are exported from stable modules instead of inferred from `ConversationSession` methods.
- Existing behavior for approvals, auto-approvals, retries, provider changes, traffic context, persistence, undo, and tool ledger reconciliation is covered by tests.
- Focused tests and the full test suite pass.

## Risks

- The current collaborator graph has cycles through callbacks; moving composition too aggressively can obscure ownership. Keep callbacks explicit and typed.
- Auto-approval continuation has subtle usage accumulation behavior. Treat it as high-risk and move it only after characterization tests are in place.
- Direct test construction of `ConversationSession` may hide production wiring assumptions. Prefer factory-based test helpers after Phase 1.
- Changing type exports can create noisy downstream updates. Introduce explicit types first, then migrate callers incrementally.

## Assumptions

- Current persisted state shape remains valid.
- Existing thin `ConversationService` remains the external compatibility facade.
- `ConversationSession` can keep temporary delegation methods during migration.
- The immediate objective is reducing responsibility concentration, not reducing total line count at any cost.

