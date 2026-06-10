# Conversation Session Next Refactor Plan: Part 2

## Summary

Part 1 reduced `ConversationSession` by extracting the main behavior-heavy collaborators. The remaining problem is not that `ConversationSession` contains large algorithms. It is that it still acts as a broad compatibility facade, owns too much collaborator topology, and exposes methods from several unrelated domains.

Part 2 should narrow `ConversationSession` into an event-stream session boundary and move the broad CLI-facing API to explicit ports owned by `ConversationService` or a session bundle. The target is interface segregation, cleaner composition ownership, and fewer callback cycles.

## Current Shape After Part 1

- `source/services/conversation-session.ts` delegates most behavior to collaborators.
- `source/services/conversation-session-composition.ts` creates the core subsystem graph.
- `ConversationTerminalAdapter` owns terminal result collection and traffic context.
- `SessionRuntimeController` owns provider/model/runtime mutation.
- `SessionStateFacade` owns snapshots, import/export, undo, shell context, and mode notices.
- `AutoApprovalContinuationResolver` owns automatic approval continuation result assembly.
- `ConversationSession` still exposes all of those operations as compatibility methods.

## Remaining Problems

- `ConversationSession` still has a broad public API that mixes streaming, terminal collection, runtime settings, state access, approval continuation, and test helpers.
- `ConversationSession` still stores references to nearly every collaborator, even when it only delegates to them.
- `ConversationService` is also a pass-through facade, so there are two broad facades with overlapping responsibilities.
- `conversation-session-composition.ts` still wires callback cycles back into `ConversationSession` for restart, generation checks, chaining breaks, and auto-approval finalization.
- Tests continue to instantiate `ConversationSession` directly, preserving pressure to keep its wide API.

## Goals

- Make `ConversationSession` primarily responsible for session identity plus event-stream operations.
- Move broad caller-facing methods to explicit ports with small interfaces.
- Keep `ConversationService` as the stable CLI/application facade.
- Reduce callback cycles in `conversation-session-composition.ts`.
- Make production callers depend on narrow interfaces rather than the concrete `ConversationSession` class.
- Keep behavior unchanged for approval, retry, chaining, traffic context, persistence, undo, and runtime setting changes.

## Non-Goals

- Do not remove `ConversationService`.
- Do not change `ConversationEvent` or `ConversationTerminal` contracts.
- Do not change persisted state shape.
- Do not rewrite stream processing, retry policy, approval flow, or tool ledger logic.
- Do not remove compatibility methods until all production callers and focused tests have a replacement.

## Phase 0: Re-Baseline Current Architecture

### Files To Inspect

- `source/services/conversation-session.ts`
- `source/services/conversation-service.ts`
- `source/services/conversation-session-composition.ts`
- `source/services/conversation-terminal-adapter.ts`
- `source/services/session-runtime-controller.ts`
- `source/services/session-state-facade.ts`
- `source/services/approval-continuation-runner.ts`
- `source/services/conversation-turn-runner.ts`
- `source/services/auto-approval-continuation-resolver.ts`
- `source/non-interactive.ts`
- `source/hooks/use-conversation.ts`
- `source/services/subagents/subagent-manager.ts`

### Baseline Commands

Run focused tests before making Part 2 changes:

```bash
npm run test:verbose -- source/services/conversation-session.stream.test.ts source/services/conversation-session.isolation.test.ts source/services/conversation-session.auto-approval.test.ts source/services/conversation-session.input-surge.test.ts
```

Run broader caller-facing tests before changing service wiring:

```bash
npm run test:verbose -- source/non-interactive.test.ts source/hooks/use-conversation.test.tsx source/services/subagents/subagent-manager.test.ts
```

If a listed test file does not exist in the checkout, substitute the closest existing focused test and record the substitution in the final change summary.

### Characterization To Add Or Confirm

- `ConversationService` forwards terminal operations without depending on `ConversationSession` method type queries.
- `ConversationService.resetWithNewId` preserves log sink behavior.
- Runtime methods call `SessionRuntimeController` behavior exactly once per service call.
- State methods call `SessionStateFacade` behavior exactly once per service call.
- `ConversationSession.run` and `continueAfterApproval` remain usable as event-stream primitives.
- Subagent sessions can still be constructed and run without terminal adapter methods.

## Phase 1: Introduce Narrow Session Ports

### New Files

- `source/services/conversation-session-ports.ts`

### Modified Files

- `source/services/conversation-service.ts`
- `source/services/conversation-session.ts`
- `source/non-interactive.ts`
- `source/hooks/use-conversation.ts`
- `source/services/subagents/subagent-manager.ts`

### New Interfaces

Define explicit ports for each domain currently exposed through `ConversationSession`:

```typescript
export interface ConversationEventSession {
  readonly id: string;
  readonly startedAt: string;

  run(input: string | UserTurn, options?: ConversationRunOptions): AsyncIterable<ConversationEvent>;
  continueAfterApproval(options: ContinueAfterApprovalOptions): AsyncIterable<ConversationEvent>;
  abort(): void;
}

export interface ConversationTerminalPort {
  sendMessage(input: string | UserTurn, options?: SendMessageOptions): Promise<ConversationTerminal>;
  handleApprovalDecision(
    answer: string,
    rejectionReason?: string,
    options?: HandleApprovalDecisionOptions,
  ): Promise<ConversationTerminal | null>;
}

export interface ConversationRuntimePort {
  setModel(model: string): void;
  setReasoningEffort(effort: ReasoningEffortSetting): void;
  setTemperature(temperature?: number): void;
  setProvider(provider: string): void;
  switchProvider(provider: string): void;
  setRetryCallback(callback: () => void): void;
}

export interface ConversationStatePort {
  getCurrentSnapshot(): StateSnapshot;
  reset(): void;
  undoLastUserTurn(): { text: string; images?: UserTurn['images'] } | null;
  listUserTurns(): { index: number; text: string; imageCount: number }[];
  undoNUserTurns(n: number): { text: string; images?: UserTurn['images'] } | null;
  exportState(): { history: unknown[]; previousResponseId: string | null; toolLedger: SavedToolExecution[] };
  importState(state: ImportedConversationState): void;
  addShellContext(historyText: string): void;
  queueModeNotice(text: string): void;
}

export interface ConversationInputGuardPort {
  previewLargeUncachedInput(input: string | UserTurn, now?: number): LargeUncachedInputDecision;
}
```

Also export option types instead of deriving them from concrete class methods:

```typescript
export type ConversationRunOptions = {
  skipUserMessage?: boolean;
  retries?: RetryState;
  maxModelRetries?: number;
  signal?: AbortSignal;
  resumeState?: unknown;
};

export type ContinueAfterApprovalOptions = {
  answer: string;
  rejectionReason?: string;
};

export type ImportedConversationState = {
  history: unknown[];
  previousResponseId: string | null;
  toolLedger?: SavedToolExecution[];
  updatedAt?: string;
};
```

### Data Flow

- `ConversationSession` implements only `ConversationEventSession` directly.
- `ConversationTerminalAdapter` implements `ConversationTerminalPort`.
- `SessionRuntimeController` implements `ConversationRuntimePort`.
- `SessionStateFacade` implements `ConversationStatePort`.
- `SessionInputPlanner` or a thin adapter implements `ConversationInputGuardPort`.
- `ConversationService` receives or builds these ports and exposes the existing broad compatibility API to CLI callers.

### Acceptance Criteria

- Production callers can type against ports instead of `ConversationSession`.
- `source/non-interactive.ts` uses `ConversationTerminalPort` for `ConversationSessionLike` or replaces its local interface with the exported port.
- `source/services/subagents/subagent-manager.ts` depends only on `ConversationEventSession` unless it truly needs terminal methods.
- No behavior changes are required in this phase.

## Phase 2: Create A Session Bundle For Composition Output

### New Files

- `source/services/conversation-session-bundle.ts`

### Modified Files

- `source/services/conversation-session-composition.ts`
- `source/services/conversation-service.ts`
- `source/services/conversation-session.ts`

### New Type

Create a bundle that separates event-session identity from broad ports:

```typescript
export type ConversationSessionBundle = {
  eventSession: ConversationEventSession;
  terminal: ConversationTerminalPort;
  runtime: ConversationRuntimePort;
  state: ConversationStatePort;
  inputGuard: ConversationInputGuardPort;
  logSink: { setLogSink(sink: ((event: LogEvent) => void) | null): void };
};
```

### Factory Shape

Replace direct broad session ownership in `ConversationService` with a bundle factory:

```typescript
export function createConversationSessionBundle(options: {
  sessionId: string;
  sessionStartedAt?: string;
  agentClient: ConversationAgentClient;
  deps: ConversationSessionDeps;
  retryOptions?: ConversationSessionRetryOptions;
}): ConversationSessionBundle;
```

### Data Flow

- The bundle factory creates `ConversationSession` for event streaming.
- The bundle factory creates or receives the composition object.
- The bundle exposes terminal/runtime/state/input guard ports directly.
- `ConversationService` stores the bundle instead of storing `ConversationSession` alone.

### Acceptance Criteria

- `ConversationService` no longer needs to call `this.#session.setModel`, `this.#session.exportState`, or other compatibility delegates.
- `ConversationService` calls `bundle.runtime`, `bundle.state`, `bundle.terminal`, and `bundle.inputGuard` directly.
- `ConversationSession` compatibility methods may remain temporarily, but production service code no longer relies on them.

### Edge Cases

- `ConversationService.resetWithNewId` must preserve the previous log sink when replacing the bundle.
- The new bundle must preserve `sessionStartedAt` for traffic context and logs.
- `retryOptions.allowFreshStartRetries` default behavior must remain unchanged.

## Phase 3: Move Composition Ownership Out Of ConversationSession

### Modified Files

- `source/services/conversation-session.ts`
- `source/services/conversation-session-composition.ts`
- `source/services/conversation-session-bundle.ts`

### Target Constructor

Change `ConversationSession` from constructing the subsystem graph to receiving only its event-stream dependencies:

```typescript
export class ConversationSession implements ConversationEventSession {
  constructor(args: {
    id: string;
    startedAt: string;
    turnRunner: ConversationTurnRunner;
    continuationRunner: ApprovalContinuationRunner;
    approvalFlow: ApprovalFlowCoordinator;
    toolTracker: SessionToolTracker;
    retryOrchestrator: SessionRetryOrchestrator;
    onBreakChaining: () => void;
  });
}
```

This exact dependency list can be narrowed during implementation. The rule is that `ConversationSession` should receive already-built collaborators rather than build them.

### Data Flow

- `createConversationSessionBundle` owns construction order.
- `createConversationSessionComposition` owns low-level collaborator wiring.
- `ConversationSession` owns event primitive methods only: `run`, `continueAfterApproval`, and `abort`.
- Downgrade handling remains registered at bundle/composition level but invokes an event-session callback or a chaining controller, not a private session method that mutates multiple collaborators directly.

### Acceptance Criteria

- `ConversationSession` no longer imports `createConversationSessionComposition`.
- `ConversationSession` constructor no longer accepts raw `deps` or `agentClient`.
- `ConversationSession` does not instantiate `AutoApprovalContinuationResolver`, `ConversationTerminalAdapter`, `SessionRuntimeController`, or `SessionStateFacade`.
- The bundle factory is the only production place that assembles the full conversation session graph.

### Edge Cases

- Tests that construct `ConversationSession` directly should switch to a focused event-session test helper or the bundle factory.
- Avoid creating hidden service locators. The bundle should be explicit, not a generic map of collaborators.

## Phase 4: Remove Callback Cycles From Composition

### Modified Files

- `source/services/conversation-session-composition.ts`
- `source/services/conversation-turn-runner.ts`
- `source/services/approval-continuation-runner.ts`
- `source/services/auto-approval-continuation-resolver.ts`
- `source/services/session-state-controller.ts`

### Current Callback Cycles To Reduce

- `breakChaining: () => this.#breakChaining()`
- `buildAndResolve: (...) => this.#buildAndResolve(...)`
- `restartTurn: (turn, options) => this.run(turn, options)`
- `isCurrentGeneration: (gen) => this.#isCurrentGeneration(gen)`

### Replacement Collaborators

Introduce narrow shared collaborators where callbacks currently bounce through `ConversationSession`:

```typescript
export interface ChainingController {
  breakChaining(): void;
}

export interface TurnRestartRunner {
  restartTurn(turn: { text: string; images?: UserTurn['images'] }, options: RestartTurnOptions): AsyncIterable<ConversationEvent>;
}

export interface GenerationGate {
  isCurrentGeneration(generation: number): boolean;
}
```

`AutoApprovalContinuationResolver` should be passed as an object dependency instead of reached through `ConversationSession.#buildAndResolve`.

### Data Flow

- `SessionRetryOrchestrator` can implement `GenerationGate` directly or expose a small adapter.
- `ConversationTurnRunner` can implement `TurnRestartRunner` if restart is just another run with specific options.
- A dedicated chaining controller coordinates `retryOrchestrator.breakChaining`, `state.previousResponseId = null`, `inputPlanner.previousResponseId = null`, and logging.

### Acceptance Criteria

- `createConversationSessionComposition` no longer requires callbacks into `ConversationSession`.
- Restart and generation checks are represented by named dependencies.
- Chaining break behavior remains covered by downgrade tests.

### Edge Cases

- Avoid recursive construction where `ConversationTurnRunner` needs a restart runner that needs `ConversationTurnRunner`. If necessary, introduce a late-bound `TurnRestartRunnerRef` with a single `setRunner` method and keep it private to composition.
- Preserve logging metadata for `conversation.chaining_broken`.

## Phase 5: Demote Or Remove ConversationSession Compatibility Methods

### Modified Files

- `source/services/conversation-session.ts`
- `source/services/conversation-service.ts`
- `source/non-interactive.ts`
- `source/hooks/use-conversation.ts`
- `source/services/subagents/subagent-manager.ts`
- Session tests that call compatibility delegates directly

### Migration Steps

1. Move all production callers to ports or `ConversationService`.
2. Update tests for runtime/state/terminal behavior to instantiate the focused collaborator or bundle instead of `ConversationSession`.
3. Keep only event-session methods on `ConversationSession`.
4. Delete compatibility delegates once no production code or focused tests require them.

### Methods To Remove From ConversationSession

- `previewLargeUncachedInput`
- `reset`
- `undoLastUserTurn`
- `listUserTurns`
- `undoNUserTurns`
- `setModel`
- `setReasoningEffort`
- `setTemperature`
- `setProvider`
- `switchProvider`
- `setRetryCallback`
- `setLogSink`
- `getCurrentSnapshot`
- `exportState`
- `importState`
- `addShellContext`
- `queueModeNotice`
- `sendMessage`
- `handleApprovalDecision`

### Methods To Keep On ConversationSession

- `id`
- `startedAt`
- `run`
- `continueAfterApproval`
- `abort`

### Acceptance Criteria

- `ConversationSession` no longer has a broad facade API.
- CLI-facing breadth is isolated in `ConversationService`.
- Tests for terminal collection, state facade, runtime controller, and input guard do not require `ConversationSession`.

## Phase 6: Add Focused Factory Test Coverage

### New Or Modified Tests

- `source/services/conversation-session-bundle.test.ts`
- `source/services/conversation-session-ports.test.ts` only if compile-time or runtime interface guarantees need explicit fixtures
- Existing `conversation-service` tests
- Existing `conversation-session` tests narrowed to event-stream behavior

### Test Cases

- Bundle creates ports that share the same store, tool tracker, approval flow, logger, and state controller.
- `ConversationService.sendMessage` uses the terminal port.
- `ConversationService.setModel` uses the runtime port.
- `ConversationService.exportState` uses the state port.
- `ConversationService.previewLargeUncachedInput` uses the input guard port.
- Replacing a service session with `resetWithNewId` creates a new bundle and reapplies the log sink.
- Downgrade handling still breaks chaining and switches to full-history mode.
- Subagent construction uses event-session behavior without terminal/runtime/state compatibility methods.

### Verification Commands

Run new focused tests:

```bash
npm run test:verbose -- source/services/conversation-session-bundle.test.ts source/services/conversation-service.test.ts
```

Run existing focused session tests:

```bash
npm run test:verbose -- source/services/conversation-session.stream.test.ts source/services/conversation-session.isolation.test.ts source/services/conversation-session.auto-approval.test.ts
```

Run caller-facing tests:

```bash
npm run test:verbose -- source/non-interactive.test.ts source/hooks/use-conversation.test.tsx source/services/subagents/subagent-manager.test.ts
```

Run full tests before merging:

```bash
npm test
```

Run formatting for changed files:

```bash
npx prettier --check source/services/conversation-session.ts source/services/conversation-session-ports.ts source/services/conversation-session-bundle.ts source/services/conversation-session-composition.ts source/services/conversation-service.ts source/non-interactive.ts docs/plans/conversation-session-next-refactor.md
```

## Implementation Order

1. Add `conversation-session-ports.ts` with narrow interfaces and exported option/state types.
2. Update non-mutating type references in callers to use the new ports without changing behavior.
3. Add `conversation-session-bundle.ts` and make `ConversationService` store a bundle.
4. Route `ConversationService` methods through the matching port instead of through `ConversationSession` compatibility delegates.
5. Move full composition ownership out of `ConversationSession` and into the bundle/factory layer.
6. Replace callback cycles in composition with named dependencies: chaining controller, generation gate, restart runner, and auto-approval resolver.
7. Move production callers and tests off `ConversationSession` compatibility methods.
8. Delete compatibility delegates from `ConversationSession` once unused.
9. Run focused tests after each phase and `npm test` before merge.

## Acceptance Criteria

- `ConversationSession` is an event-stream session boundary, not a broad facade.
- `ConversationSession` no longer constructs the whole collaborator graph.
- `ConversationService` owns the broad CLI/application API and delegates to explicit ports.
- Production code depends on `ConversationEventSession`, `ConversationTerminalPort`, `ConversationRuntimePort`, `ConversationStatePort`, or `ConversationInputGuardPort` as appropriate.
- `conversation-session-composition.ts` no longer needs callbacks into a concrete `ConversationSession` instance.
- Existing approval, retry, chaining, traffic context, persistence, undo, runtime mutation, auto-approval, and subagent behavior remains unchanged.
- Focused tests and the full test suite pass.

## Risks

- Removing compatibility methods too early will create noisy test churn. Migrate production callers and focused tests first, then delete delegates.
- A session bundle can become another god object if callers receive the whole bundle unnecessarily. Pass only the narrow port each caller needs.
- Callback-cycle removal can introduce construction-order bugs. Keep replacement collaborators explicit and add factory tests for shared-instance wiring.
- Chaining downgrade behavior mutates multiple collaborators. Do not split it until there is direct regression coverage for previous response ID, input planner state, retry orchestrator state, and logging.

## Assumptions

- Part 1 collaborator extractions are present in the current branch.
- `ConversationService` remains the stable application-facing facade.
- It is acceptable for tests to use a bundle factory when they need integration wiring.
- The final public `ConversationSession` API can be narrower than the current compatibility API as long as `ConversationService` preserves caller behavior.``
