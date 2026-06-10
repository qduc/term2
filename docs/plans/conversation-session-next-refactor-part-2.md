# Conversation Session Refactor Part 2: SDK-First Simplification

## Summary

Part 1 exposed too many collaborators and callback cycles around
`ConversationSession`. Part 2 should simplify the subsystem by reusing
`@openai/agents` before introducing new application state machines.

The installed SDK already provides important run primitives:

- `RunState` for resumable run state.
- `RunResult` and `StreamedRunResult` for history, output, interruptions, usage, and
  response IDs.
- `RunState.approve()` and `RunState.reject()` for tool approval decisions.
- Resumption by passing the same `RunState` back to `run()` or `Runner.run()`.
- `AbortSignal` and stream cancellation.
- The `Session` interface for conversation-history persistence.
- Model request retry settings and `retryPolicies`, subject to provider and failure
  category compatibility.

Term2 should coordinate these capabilities, not reproduce them. Application code
still owns UI events, command admission, provider fallback, persistence compatibility,
undo, the tool ledger, and product-specific retry behavior.

## Required SDK Verification Gate

Before removing a class, state field, retry path, persistence path, or workaround,
dispatch a read-only `gpt-5.4-mini` subagent to audit that exact change.

The subagent must inspect:

- The installed `@openai/agents` version and declarations under `node_modules`.
- Relevant SDK implementation where declarations are insufficient.
- Current Term2 behavior and tests.
- Provider-specific implementations used by Term2.

The audit must classify the proposed change as one of:

1. **Full SDK replacement**: the SDK preserves all required observable behavior.
2. **Minimal adapter required**: the SDK owns the core behavior, but Term2 must
   translate types, events, persistence, logging, or product policy.
3. **Application-specific keep**: the SDK does not provide equivalent behavior.

The audit report must cite concrete SDK and Term2 files and answer:

- Does the SDK preserve the same behavior for streaming and non-streaming runs?
- Does it work for OpenAI and every custom `Runner` used by the provider registry?
- Does it preserve nested subagent approval behavior?
- Does it preserve cancellation, cleanup, and late-event behavior?
- Does it preserve the current persisted format and undo semantics?
- Does it preserve cumulative usage and command-message deduplication?
- Does it preserve transport downgrade and retry behavior?

No removal proceeds from documentation or type similarity alone. Add or update a
focused characterization test first, then make the minimum change supported by the
audit.

Store each audit as a short section in the implementing PR description or commit
notes. Do not add permanent audit documents unless the result changes an architectural
decision that future maintainers need to understand.

## Target Architecture

```text
UI / non-interactive caller
        |
        v
ConversationService
        |
        v
ConversationSession
        |
        v
TurnCoordinator ------> AgentGateway ------> @openai/agents
        |                    |
        |                    +--> RunState / StreamedRunResult
        |
        +--> ConversationStore
        +--> ToolExecutionLedger
        +--> ApplicationSessionState
```

The SDK is authoritative for state inside an agent run. Term2 is authoritative for
application behavior around runs.

### SDK-Owned Run State

- Current agent-run step and generated run items.
- Approval decisions recorded in `RunState`.
- Resumable continuation state.
- Run-cumulative usage inside one SDK `RunState`.
- Run history exposed by `RunResult`.
- Run-internal previous response and conversation identifiers.
- Stream completion and cancellation state.
- Model-request retries that are explicitly proven to flow through SDK retry policy.

### Term2-Owned State

- Whether the application accepts a new foreground command.
- Active Term2 logical turn identity and stale-generation protection.
- Pending UI approval descriptor and reference to the SDK interruption.
- The current SDK `RunState` reference while approval is pending.
- Cross-segment usage normalization and UI/subagent accounting.
- Provider/model runtime configuration.
- Transport downgrade state across runs.
- Existing persisted transcript format, undo behavior, and shell context.
- Tool execution ledger and crash recovery.
- Command-event deduplication needed by the UI.
- Input-surge and large-input guard baselines.
- Hallucination, service-tier, and whole-run retry policy.
- Log sink, traffic context, and session replacement resources.

Term2 must not copy SDK run history, usage, approval decisions, or continuation data
into independently mutable representations.

## Primary Components

### ConversationService

- Remains the stable application-facing API.
- Creates, replaces, and disposes sessions through one factory.
- Preserves cross-session configuration such as the log sink.
- Delegates turn execution to `ConversationSession`.
- Delegates persistence, undo, and runtime workflows to focused owners.

### ConversationSession

- Owns `id` and `startedAt`.
- Exposes `run`, `continueAfterApproval`, and `abort`.
- Delegates execution to `TurnCoordinator`.
- Does not construct its dependency graph.
- Does not expose compatibility methods after callers migrate.

### TurnCoordinator

`TurnCoordinator` is an application coordinator, not a second agent runner.

It owns:

- Synchronous admission of one foreground Term2 turn.
- Translation from SDK stream events to `ConversationEvent`.
- Holding the active `StreamedRunResult` and pending SDK `RunState`.
- Invoking SDK-native approval and resumption.
- Product-specific retries that cannot be delegated to SDK retry policy.
- Coordination of transcript, ledger, UI-event, and cleanup updates.

It does not own:

- A duplicate approval state machine.
- A duplicate run history.
- A duplicate SDK usage accumulator. Term2 may retain normalized cross-segment and UI
  accounting derived from SDK usage.
- Request retries already handled by SDK retry settings.
- A custom continuation payload derived from SDK internals.

Representative API:

```typescript
export interface TurnCoordinator {
  start(
    turn: UserTurn,
    options?: ConversationRunOptions,
  ): AsyncIterable<ConversationEvent>;

  continueAfterApproval(
    command: ApprovalCommand,
  ): AsyncIterable<ConversationEvent>;

  abort(): void;
}
```

`start()` and `continueAfterApproval()` reserve application admission synchronously
before returning an iterable. This is Term2 concurrency policy and is not delegated to
the SDK.

### ApplicationSessionState

Keep this object small. It owns only application coordination state:

- `idle`, `streaming`, `awaiting_approval`, or `continuing`.
- Active logical turn ID and generation.
- Pending mode notice.
- Provider continuity and transport downgrade state not represented across SDK runs.
- A pending approval reference containing the SDK `RunState`, interruption, and
  Term2 UI metadata.

It must not mirror `RunState` fields or own canonical history, generated SDK items,
or retry counters that belong to one execution attempt. Term2-specific display
metadata and normalized accounting remain outside this state object.

### AgentGateway

Use SDK types at this boundary instead of broad `unknown` shapes:

```typescript
export interface AgentGateway {
  startStream(
    input: string | AgentInputItem[],
    options: AgentGatewayRunOptions,
  ): Promise<StreamedRunResult<any, Agent<any, any>>>;

  resumeStream(
    state: RunState<any, Agent<any, any>>,
    options: AgentGatewayRunOptions,
  ): Promise<StreamedRunResult<any, Agent<any, any>>>;

  abort(): void;
  configure(settings: AgentRuntimeSettings): void;
  onTransportDowngrade(callback: () => void): () => void;
}
```

Prefer a small type alias around SDK generics if direct types become unreadable. Do
not replace SDK state with an opaque branded object merely to hide available public
methods.

The gateway may adapt provider configuration, tracing, input filtering, and transport
fallback. It must not reinterpret SDK approval or run-state semantics.

### ConversationStore

Keep `ConversationStore` until a mini-agent audit and focused tests prove that an SDK
`Session` adapter can preserve:

- The current persisted state shape.
- Undo and rewind behavior.
- Tool-ledger reconciliation.
- Shell-history insertion.
- Input-surge inspection.
- Provider downgrade resynchronization.
- Existing UI and logging expectations.

The preferred end state is for `ConversationStore` to implement or adapt to the SDK
`Session` interface so the SDK and Term2 use one canonical history store. Do not run
two independent persistence systems.

## Provisional Capability Matrix

Every row requires the SDK verification gate before implementation.

| Current Term2 behavior | Expected decision | Planned direction |
| --- | --- | --- |
| Approval decision mutation | Full SDK replacement | Call SDK `approve()` or `reject()` on the retained `RunState`. |
| Rejection interceptor used to inject a reason | Full replacement or minimal adapter | Prefer `state.reject(interruption, { message })`; retain an adapter only if a provider or nested-run test fails. |
| Pending/aborted approval lifecycle | Application-specific keep | Keep cross-command pending and aborted state, but store direct SDK references instead of copying SDK-owned fields. |
| `ApprovalContinuationRunner` | Minimal adapter | Fold event translation and Term2 bookkeeping into `TurnCoordinator`; SDK performs continuation. |
| SDK run usage source | Full SDK replacement | Read cumulative usage from `RunState.usage` instead of re-summing SDK requests. |
| Cross-segment, UI, and subagent usage accounting | Application-specific keep | Normalize and expose SDK usage according to existing Term2 contracts. |
| `AgentStream` with `unknown` fields | Full SDK replacement | Use `StreamedRunResult` or a typed structural alias. |
| Request-level transient retries | Minimal adapter, pending per-provider proof | Use `ModelSettings.retry` only for failure categories proven to reach SDK policy with equivalent streaming behavior. |
| Transport downgrade, service-tier, hallucination, whole-run retries | Application-specific keep | Retain focused Term2 policy around SDK runs. |
| Stream cancellation | Minimal adapter | Use `AbortSignal`/SDK cancellation; retain Term2 admission and exactly-once cleanup. |
| Previous response ID inside a resumed run | Full SDK replacement | Read SDK result/state. |
| Previous response continuity across separate Term2 turns and provider downgrade | Minimal adapter | Keep only state required to start the next run when SDK `Session` cannot own it. |
| Transcript persistence | Minimal adapter, pending proof | Keep Term2 persistence; optionally adapt `ConversationStore` to SDK `Session` only if interrupted runs, undo, and reconciliation remain correct. |
| Tool execution ledger and crash recovery | Application-specific keep | Continue as a focused Term2 data owner. |
| UI command deduplication and tool argument display | Application-specific keep | Derive from SDK events/items but retain Term2 presentation state. |
| Foreground command concurrency | Application-specific keep | Enforce synchronous admission in `TurnCoordinator`. |
| Stale generation protection after reset/provider change | Application-specific keep | Retain at the application boundary. |

## Behavioral Contract

The application lifecycle remains:

```text
idle
  |
  | start
  v
streaming
  |
  | SDK interruption
  v
awaiting_approval
  |
  | approve/reject SDK RunState and resume
  v
continuing
  |
  +--> idle on completion, failure, or abort
```

This lifecycle describes Term2 command admission. It must not duplicate the SDK's
internal run steps.

Required behavior:

- A second `start()` is rejected while a foreground turn is active.
- Duplicate approval continuation is rejected synchronously.
- Approval applies only to the retained SDK state and matching logical turn.
- Reset, provider change, and session replacement invalidate stale events.
- `abort()` cancels the SDK stream and performs Term2 cleanup exactly once.
- Early iterator `return()` cancels active work and releases admission.
- Pending approval abort preserves current Term2 behavior for the next user input.
- A completed, failed, or aborted iterable permits a new turn.

## Implementation Phases

### Phase 0: Characterize Current Behavior

Add or confirm tests before structural changes:

- Approval and rejection with a custom reason.
- Nested subagent approval.
- Auto-approval followed by another interruption.
- Cumulative usage across continuation.
- Abort during streaming and continuation.
- Abort while approval is pending.
- Early iterator return.
- Concurrent start and duplicate continuation.
- Provider downgrade and previous-response invalidation.
- Retry behavior by retry category.
- Persistence, import, reset, undo, and ledger reconciliation.
- Session replacement and listener disposal.

Run the existing focused suites:

```bash
npm run test:verbose -- source/services/conversation-session.stream.test.ts source/services/conversation-session.isolation.test.ts source/services/conversation-session.auto-approval.test.ts source/services/conversation-session.input-surge.test.ts
```

```bash
npm run test:verbose -- source/services/conversation-service.test.ts source/non-interactive.test.ts source/services/subagents/subagent-manager.test.ts
```

### Phase 1: Type the SDK Boundary

Before deleting `AgentStream` or changing continuation types:

1. Dispatch the mini-agent SDK audit.
2. Add compile-time or focused runtime tests for all provider runners.
3. Replace `unknown`/`any` stream and state fields with SDK types.
4. Keep a minimal adapter only for provider-specific configuration.

Acceptance criteria:

- `RunState`, interruptions, and streamed results are no longer reflected as unrelated
  `unknown` objects.
- No code reaches into private SDK fields such as `_context`.
- The OpenAI path and custom `Runner` paths satisfy the same gateway contract.

### Phase 2: Use SDK-Native Approval

Handle approval through public SDK APIs:

```typescript
if (command.approved) {
  state.approve(interruption);
} else {
  state.reject(interruption, { message: command.reason });
}

const stream = await gateway.resumeStream(state, options);
```

Before removing the rejection interceptor or `ApprovalState` fields:

1. Dispatch a mini-agent audit specifically for rejection messages, nested subagents,
   and custom providers.
2. Add regression tests for those paths.
3. Remove only the behavior proven redundant.

Term2 retains the pending UI approval descriptor, logical turn identity, generation,
ledger updates, and event translation.

Acceptance criteria:

- Approval decisions use public SDK methods.
- The same SDK `RunState` is resumed.
- SDK-run cumulative usage comes from SDK state and Term2 normalization remains
  behaviorally unchanged.
- No independent mutable copy of SDK-owned approval decisions or continuation
  internals remains.
- Term2 still owns pending, aborted, duplicate-claim, and stale-generation approval
  behavior.

### Phase 3: Evaluate Request Retries Against SDK Policy

Inventory each current retry category separately.

For each category:

1. Dispatch a mini-agent audit.
2. Determine whether SDK `ModelSettings.retry` sees the same failure and supports the
   required streaming/provider behavior.
3. Add a focused test proving retry count, delay policy, cancellation, and emitted UI
   events.
4. Move only supported request retries into SDK policy. The default outcome is to
   retain the Term2 retry until equivalence is proven.

Keep Term2 orchestration for:

- WebSocket-to-HTTP downgrade that changes chaining behavior.
- Service-tier fallback that changes runtime configuration.
- Hallucination recovery that restarts a logical turn.
- Retry paths that restore ledger or transcript state.
- Any provider whose errors do not reach SDK retry policy consistently.

Do not maintain both an SDK retry and a Term2 retry for the same failure category.

### Phase 4: Evaluate SDK Session Integration

Do not replace `ConversationStore` immediately.

First dispatch a mini-agent audit comparing `ConversationStore` with the SDK `Session`
contract: `getSessionId`, `getItems`, `addItems`, `popItem`, and `clearSession`.

Build a narrow adapter experiment and tests for:

- Normal multi-turn history.
- Interrupted and resumed runs.
- Undo.
- Import and resume.
- Tool-ledger recovery.
- Provider downgrade and full-history resynchronization.

If all behavior matches, make `ConversationStore` the SDK session implementation and
remove duplicate manual history append logic. If behavior does not match, retain
`ConversationStore` and document the minimum adapter boundary.

Acceptance criteria:

- Exactly one canonical transcript exists.
- SDK persistence and Term2 persistence never append the same item twice.
- The persisted external format remains unchanged.

### Phase 5: Introduce TurnCoordinator And Small Application State

Merge `ConversationTurnRunner`, `ApprovalContinuationRunner`, and
`AutoApprovalContinuationResolver` only after their SDK-owned behavior has been
removed or delegated.

`TurnCoordinator` should contain only:

- Command admission.
- SDK run start/resume calls.
- Event translation.
- App-specific retry and fallback coordination.
- Store, ledger, logging, and cleanup coordination.

Do not migrate old algorithms unchanged into a larger replacement class.

Acceptance criteria:

- No callback points back through `ConversationSession`.
- SDK `RunState` remains authoritative during continuation.
- Application state contains no duplicate SDK history or SDK usage accumulator.
- Term2 retains normalized usage and UI/subagent accounting where required.
- Helpers remain focused on parsing, policy, normalization, or persistence.

### Phase 6: Move Composition Out Of ConversationSession

Create one production factory that returns the session plus private resources required
by `ConversationService`.

Disposal must:

- Abort active SDK work.
- Invalidate the active Term2 generation.
- Unsubscribe downgrade listeners.
- Clear pending approval references and per-turn UI state.
- Be idempotent.

Interactive, non-interactive, and subagent paths use the same factory with scoped
profiles.

### Phase 7: Remove Compatibility Surface

For each compatibility method or obsolete class:

1. Confirm no production caller remains.
2. Dispatch a mini-agent audit for any behavior being removed with it.
3. Add or retain a behavior-level test at the new owner.
4. Delete the method or class.

Candidate compatibility methods:

- `previewLargeUncachedInput`
- `reset`
- `undoLastUserTurn`
- `listUserTurns`
- `undoNUserTurns`
- Runtime model/provider setters
- `setRetryCallback`
- `setLogSink`
- Snapshot import/export methods
- `addShellContext`
- `queueModeNotice`
- `sendMessage`
- `handleApprovalDecision`

Keep on `ConversationSession`:

- `id`
- `startedAt`
- `run`
- `continueAfterApproval`
- `abort`

## Test Strategy

Follow TDD for every implementation slice:

1. Add or update a characterization test.
2. Run it against current behavior.
3. Dispatch the required mini-agent audit.
4. Implement the minimum SDK-backed change.
5. Run the focused tests.
6. Run the full suite at approval, retry, persistence, and construction milestones.

Prefer behavior-oriented tests:

- `conversation-turn.test.ts`
- `conversation-approval.test.ts`
- `conversation-retry.test.ts`
- `conversation-chaining.test.ts`
- `conversation-persistence.test.ts`
- `conversation-session-factory.test.ts`

Run before merging:

```bash
npm test
```

Format changed files:

```bash
npx prettier --write docs/plans/conversation-session-next-refactor-part-2.md <changed-source-files>
```

## Final Acceptance Criteria

- Term2 uses public SDK `RunState` approval and resumption APIs.
- SDK streamed-result and run-state types replace broad local `unknown` mirrors.
- SDK state is authoritative for SDK run history, approval decisions, continuation,
  and usage within one run.
- Term2 remains authoritative for pending/aborted approval lifecycle, command
  admission, and normalized cross-segment/UI usage.
- Supported request retries use SDK retry policy without duplicate Term2 retries.
- Unsupported product retries remain explicit and focused.
- There is one canonical conversation transcript.
- `TurnCoordinator` coordinates application behavior without reimplementing the SDK
  runner.
- Application state contains only command admission, generation, pending UI approval,
  mode notice, and cross-run provider continuity.
- Tool ledger, undo, persistence compatibility, provider fallback, logging, and UI
  event behavior remain intact.
- Every removed behavior has a mini-agent audit and a focused regression test.
- Composition has no callbacks into a partially constructed session.
- Replaced sessions dispose listeners and cannot mutate replacement state.
- Focused tests and the full suite pass.

## Risks And Controls

- **SDK API resemblance without behavioral equivalence:** Require the mini-agent audit
  and a focused test before removal.
- **Provider differences:** Verify every provider registry `Runner`, not only OpenAI.
- **Nested approval differences:** Test nested subagents before deleting interceptors
  or special handling.
- **Double persistence:** Introduce SDK `Session` only through one canonical store.
- **Duplicate retries:** Assign each failure category to exactly one retry owner.
- **Cancellation mismatch:** Keep Term2 admission and cleanup even when SDK performs
  transport cancellation.
- **SDK private-field coupling:** Use public `RunState`, result, and session APIs only.
- **Coordinator growth:** Do not move SDK-owned algorithms unchanged into
  `TurnCoordinator`.

## Deferred Follow-Up

After this refactor:

- Evaluate whether `ConversationSession` still provides value beyond identity and
  delegation.
- Evaluate splitting `OpenAIAgentClient` into runtime configuration,
  provider/transport execution, and tool/subagent integration.

Do not combine either decision with the SDK adoption work.
