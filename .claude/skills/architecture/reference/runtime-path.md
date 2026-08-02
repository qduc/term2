# Runtime path: user input to rendered response

The foreground turn lifecycle. Useful when locating *where* a failure occurs; not needed for routine feature work.

Note: a refactor moved turn/session internals out of `services/conversation/`
into `services/session/`, and added `ConversationOrchestrator` as a UI-side
layer. File paths below reflect the current locations.

1. User types a message — `app.tsx` captures it.
2. `use-conversation.ts` owns a `ConversationOrchestrator` (`services/conversation/conversation-orchestrator.ts`), which turns `ConversationEvent`s into UI message-list state, and calls `ConversationService.sendMessage()` (`services/conversation/conversation-service.ts`).
3. `ConversationService` delegates terminal execution to the `ConversationAdapter` (`services/conversation/conversation-adapter.ts`), built via `createConversationRuntime()` (`conversation-runtime-factory.ts`), which calls `createSessionRuntime()` — the composition root in `services/session/session-composition.ts`.
4. `ConversationAdapter` establishes logging/traffic context, collects terminal events, and routes through `QueueController` (`services/queue/queue-controller.ts`) to manage turn admission.
5. `TurnCoordinator.start()` (`services/session/turn-coordinator.ts`) guards turn admission with `TurnStatusMachine`, checks stale/aborted approval state through `ApprovalFlowCoordinator` (`services/approval/approval-flow-coordinator.ts`), and delegates to `TurnWorkflow.executeInitial()`.
6. `TurnWorkflow` (`services/session/turn-workflow.ts`) prepares input through `InitialInputPreparer` and `SessionInputPlanner`, drives the agent client, feeds events to `SessionStreamProcessor` (`services/session/session-stream-processor.ts`), and returns a turn outcome.
7. The agent client selects a provider through the provider registry and streams the response.
8. Tool requests are validated by `ApprovalFlowCoordinator` and paused for user approval; `TurnStatusMachine` transitions to `awaiting_approval`.
9. Approval/rejection follows the same facade and adapter path, then `ConversationAdapter` calls `TurnCoordinator.continueAfterApproval()` directly.
10. `TurnCoordinator` delegates approved continuation to `TurnWorkflow.executeContinuation()`, which applies the decision, streams tool/model work, and returns `response`, `approval_required`, `fresh_start_required`, or `stale`.
11. `services/retry/` classifies errors and handles recovery. `fresh_start_required` lets `TurnWorkflow` re-drive initial execution from history.
12. `ConversationAdapter` collects the terminal result, `ConversationOrchestrator` applies it, and it renders in the message list.

`source/services/agent-runtime/` is not a parallel path — it is the shared engine. `ApplicationRunLoop` (`application-run-loop.ts`) does the actual model streaming and tool dispatch for *every* caller: step 7 above reaches it via `AgentClient`, and the mentor/nested subagent runners construct it directly. The directory also owns agent/model/tool/skill resolution, execution budgeting, and structured output.

`non-interactive.ts` runs this same conversation system without the Ink UI.
