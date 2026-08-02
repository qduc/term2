# Architecture Overview

Terminal AI assistant: React (Ink) UI + OpenAI Agents SDK + TypeScript/Node.
Chats with an agent that can run shell commands / edit files, gated by approval prompts.

## Entry points

```
cli.tsx  ───assembles the app
  ├── app.tsx            interactive Ink UI
  └── non-interactive.ts same conversation system, no UI
```

## Turn lifecycle (user message → rendered response)

> Verified against source on 2026-08-02. A large refactor moved turn/session
> internals out of `services/conversation/` into a new `services/session/`
> module and added a `ConversationOrchestrator` UI-side layer — this
> supersedes the architecture skill's `runtime-path.md`, which still points
> at the old locations (`session-composition.ts`, `turn-coordinator.ts` in
> `services/conversation/`). Worth fixing that skill doc.

```
app.tsx (user types)
  │
  ▼
use-conversation.ts
  │  owns a ConversationOrchestrator instance   [services/conversation/conversation-orchestrator.ts]
  │  (turns ConversationEvents into UI message-list state: streaming, approvals, etc.)
  ▼
ConversationService.sendMessage()   [services/conversation/conversation-service.ts]
  │  public facade — holds a ConversationAdapter built by
  │  createConversationRuntime() [conversation-runtime-factory.ts]
  │  which calls createSessionRuntime() [services/session/session-composition.ts]
  │  — the actual composition root for turn/session internals
  ▼
ConversationAdapter [services/conversation/conversation-adapter.ts]
  │  sets up logging/traffic context, routes via QueueController
  │  [services/queue/queue-controller.ts] (turn admission)
  ▼
TurnCoordinator.start()   [services/session/turn-coordinator.ts]
  │  guards admission (TurnStatusMachine), checks stale/aborted approvals
  │  (ApprovalFlowCoordinator [services/approval/approval-flow-coordinator.ts])
  ▼
TurnWorkflow.executeInitial()   [services/session/turn-workflow.ts]
  │  preps input (InitialInputPreparer, SessionInputPlanner — both in services/session/)
  │  drives agent client → provider registry → streams response
  │  feeds events to SessionStreamProcessor [services/session/session-stream-processor.ts]
  ▼
Tool call requested?
  │
  ├─ yes → ApprovalFlowCoordinator validates → TurnStatusMachine → "awaiting_approval"
  │           user approves/rejects
  │           ConversationAdapter → TurnCoordinator.continueAfterApproval()
  │           → TurnWorkflow.executeContinuation()
  │           → response | approval_required | fresh_start_required | stale
  │
  └─ no  → ConversationAdapter collects terminal result → ConversationOrchestrator
             → renders in message list
```

Errors are classified/recovered by `services/retry/`. `fresh_start_required` makes
`TurnWorkflow` re-drive initial execution from history.

`services/agent-runtime/` is a **parallel** path for agent (subagent) workflows —
resolution, budgeting, structured output. Not the same pipeline as above.

## Directory map

```
source/
├── cli.tsx, app.tsx, non-interactive.ts   entry points
├── agent.ts                 defines the agent, registers tools (new tools go here)
├── prompts/                 system prompt assembly (product behavior, not docs!)
│   ├── prompt-constructor.ts   base profile + conditional fragments
│   ├── prompt-profiles.ts      maps models → base prompt
│   ├── fragments/, subagents/
├── providers/                provider transports (register new providers via registry)
│   ├── registry.ts
│   ├── common/, fetch/, web-search/
├── services/
│   ├── conversation/          conversation-service.ts (facade), conversation-orchestrator.ts
│   │                           (UI-side event→message-list layer), conversation-adapter.ts,
│   │                           conversation-store.ts, replay/persistence/decoder helpers
│   ├── session/                turn/session internals (moved out of conversation/ in a
│   │                           recent refactor): session-composition.ts (composition root),
│   │                           turn-coordinator.ts, turn-workflow.ts, session-stream-processor.ts,
│   │                           turn-status-machine.ts, input planners, continuation handlers
│   ├── agent-runtime/          parallel subagent execution path
│   ├── subagents/               subagent-manager.ts = compat facade only
│   │                             (real logic: mentor-runner / execution-runner / nested-runner)
│   ├── approval/               approval decision policy
│   ├── retry/                  retry classification & recovery
│   ├── queue/                  turn admission (QueueController)
│   ├── session/, settings/, memory/, skills/, logging/
├── tools/                    agent-callable tools (file, system, web, memory, languages, agent)
├── components/                Ink UI components
├── hooks/                     e.g. use-conversation.ts
├── contracts/, types/, lib/, utils/
```

## Key ownership rules (from `architecture` skill)

| Concern | Owner |
| --- | --- |
| Approval decisions | `services/approval/` |
| Retry/recovery policy | `services/retry/` |
| Provider transport | `providers/` or `lib/` |
| Role/prompt/env/tool-guidance | `role-loader.ts` |
| Capability & write/shell safety policy | `tool-policy.ts` |
| Subagent wiring, nested role-tool cache | `runtime.ts` |
| Session composition | `session-composition.ts` (single composition root) |

Don't add a new Runner/Driver/Coordinator/Manager just to shorten a file — only when
it owns a stable concept or hides real decisions ("deletion test").

New providers → must go through `providers/registry.ts`.
New tools → must be registered in `agent.ts`.

## Testing

- Regular tests: `pnpm test`
- Provider black-box suite (streaming/tool-call/history/reasoning/error-path regressions
  for provider, bridge, run-loop, registry, non-interactive changes):
  `pnpm test:provider-black-box` — builds `dist/`, runs isolated child-process CLI tests.
  See `scripts/provider-black-box/` and `docs/plans/integration-test-improvement.md`.

## For deeper dives

- `architecture` skill (this repo's `.claude/skills/architecture/`) — module-design judgement,
  full runtime-path reference.
- `testing` skill — test scope/standards.
