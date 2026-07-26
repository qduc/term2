# Runtime path: user input to rendered response

The foreground turn lifecycle. Useful when locating *where* a failure occurs; not needed for routine feature work.

1. User types a message — `app.tsx` captures it.
2. `use-conversation.ts` calls `ConversationService.sendMessage()`.
3. `ConversationService` delegates terminal execution to the `ConversationAdapter` created by `session-composition.ts`.
4. `ConversationAdapter` establishes logging/traffic context, collects terminal events, and routes through `QueueController` to manage turn admission.
5. `TurnCoordinator.start()` guards turn admission with `TurnStatusMachine`, checks stale/aborted approval state through `ApprovalFlowCoordinator`, and delegates to `TurnWorkflow.executeInitial()`.
6. `TurnWorkflow` prepares input through `InitialInputPreparer` and `SessionInputPlanner`, drives the agent client, feeds events to `SessionStreamProcessor`, and returns a turn outcome.
7. The agent client selects a provider through the provider registry and streams the response.
8. Tool requests are validated by `ApprovalFlowCoordinator` and paused for user approval; `TurnStatusMachine` transitions to `awaiting_approval`.
9. Approval/rejection follows the same facade and adapter path, then `ConversationAdapter` calls `TurnCoordinator.continueAfterApproval()` directly.
10. `TurnCoordinator` delegates approved continuation to `TurnWorkflow.executeContinuation()`, which applies the decision, streams tool/model work, and returns `response`, `approval_required`, `fresh_start_required`, or `stale`.
11. `services/retry/` classifies errors and handles recovery. `fresh_start_required` lets `TurnWorkflow` re-drive initial execution from history.
12. `ConversationAdapter` collects the terminal result and it renders in the message list.

`source/services/agent-runtime/` provides a parallel runtime path for agent workflows, with resolution, budgeting, and structured output.

`non-interactive.ts` runs this same conversation system without the Ink UI.
