# Unified subagent live UI

Status: implemented in `.worktrees/unified-subagent-ui`. Awaiting merge.

Sibling of [liveness-ui.md](liveness-ui.md), not a replacement.

## Resume here

Foreground and background subagents already share a public tool name
(`run_subagent`) and a status alphabet (`▶` / `✔` / `✖`). They still look like
two products because they use different hosts and different data.

The transfer path is the defect that forces this work. A nested run starts a
`SubagentActivityMessage` with `status: 'running'`. Adoption emits a second
`subagent_started` with `async: true` to the background sink and never tells
the transcript card. Later tools and `subagent_completed` follow that
`agentId` to the background sink only. The chat row stays `running` forever
and keeps `splitStaticHistory` in the live region.

Do not dump background lifecycle back into `MessageList`. Native async
launches stay ordinary command messages. This plan unifies the live card and
settles the transferred transcript row.

## Outcome

Every live subagent or transferable shell answers the same three questions in
the same words: what is it, where does it run, what was last observed.

```text
• [Explorer · foreground] audit provider fixtures
  Running · 18s

• [Explorer] audit provider fixtures
  Waiting for provider · last activity 18s ago
```

The transcript card is the in-turn narrative. After a truthful move it freezes
as moved-to-background and becomes static history. The compact strip and
Ctrl+G manager share one row model; placement is a tag, not a second
component. Native background launches still appear only as `Delegated async`.

## Decisions

- **Unify the card, not the owners.** `NestedSubagentRunner` stays the
  foreground lease owner. `SubagentAsyncRegistry` stays the background
  lifecycle owner. Ink receives projections from
  `BackgroundTaskControl`, never a registry.
- **Placement is explicit.** Unadopted work must not flow through
  `listDetails()` or the notification-store snapshot. Those APIs remain
  background-only so [MAP.md](MAP.md) transfer truthfulness stays intact:
  foreground work is never represented as background until the same
  execution is adopted.
- **The compact strip may show unadopted work** when it is tagged
  `foreground`. That is a shared *tasks* surface, not a claim that the
  work is background-owned. Rename the header from `Background tasks` to
  `Tasks` so the panel does not lie when it includes a live nested run.
- **Transcript settlement is a logged event.** Add
  `subagent_transferred` with no `async` flag. Emit it from
  `adoptForegroundLease` *before* the async `subagent_started`, so the
  bridge still routes it to the turn sink (`#backgroundRunIds` is empty
  for that `agentId` until the async start pins it). Do not settle the
  card by leaking later async lifecycle into the handler.
- **New message status `backgrounded`.** Do not reuse `completed` or
  `cancelled` — the run is still alive. `splitStaticHistory` treats
  `backgrounded` as static. Later `subagent_completed` must not rewrite
  that card.
- **Foreground panel rows stay identity-thin.** The transcript already
  carries the nested tool timeline. The first delivery adds `startedAt`
  to `ForegroundSubagentCandidate` so elapsed time works; it does not
  build a second progress pipeline for unadopted leases. After adoption,
  the existing control-details row is the live view.
- **Liveness stays the sibling plan.** Do not implement
  `lastObservation` / independent quiet here. Introduce the shared
  formatter so [liveness-ui.md](liveness-ui.md) can replace
  `formatLiveStatus` instead of inventing a third vocabulary.
- **Copy tells the same story as the card.** Manager confirmation, the
  user-facing control notification, and the model-only move header must
  name a subagent as a subagent. Today the manager says “this shell”,
  `CommandMessage` falls through to `Background task control updated`,
  and the orchestrator header always says “shell(s)”.

## Contract

### Transfer event

```ts
type SubagentTransferredEvent = {
  type: 'subagent_transferred';
  agentId: string;
  runId: string;
  role: string;
};
```

`agentId` matches the existing `SubagentActivityMessage`. `runId` is the
adopted lease id (the root tool-call id on the live path). The event is
observational for the transcript and the log. The model still learns
about the move only through the existing `user_control` notification.

### Transcript message

```ts
status: 'running' | 'completed' | 'failed' | 'cancelled' | 'backgrounded';
```

`SubagentActivityMessage` suffix for `backgrounded`: `— moved to background`.
Keep the last three completed tools as the frozen peek. Do not swap in
`finalText`; the run has not finished.

### Live row projection (Ink-owned merge)

Keep the two control-port methods. Merge them in a small presentation
helper next to the panel, not in the session port:

```ts
type LiveTaskPlacement = 'foreground' | 'background';

type LiveTaskRow = {
  key: string;
  placement: LiveTaskPlacement;
  task: BackgroundTaskControlDetails | ForegroundTransferCandidate;
};
```

Wording lives in the helper (`[role · foreground]`, `Running · 18s`).
Facts stay on the existing control types. Add `startedAt` to
`ForegroundSubagentCandidate` at lease creation.

A new `listLiveTasks()` on the control port fails the deletion test: it
would only concatenate two already-public lists and invite callers to
treat unadopted work as `listDetails()`.

### Event-union sites that must learn `subagent_transferred`

- `source/services/conversation/conversation-events.ts`
- `source/utils/conversation/conversation-event-handler.ts`
- `source/services/conversation/conversation-replay.ts`
- `source/services/conversation/conversation-decoder.ts`
- `source/services/logging/conversation-logger.ts`
- `source/services/logging/conversation-log-events.ts`

`non-interactive.ts` and other `default: return` switches can ignore it.

## Implementation slices

Implement in `.worktrees/unified-subagent-ui`. TDD each slice. The new
event travels through the bridge, so run
`pnpm test:provider-black-box` after slice 1, not only at the end.

### 1. Settle the transcript on a truthful move

Write red tests first:

- `adoptForegroundLease` emits `subagent_transferred` (no `async`) and
  then `subagent_started` with `async: true`.
- `SubagentBridge` delivers the transfer event to the turn sink and the
  async start to the background sink.
- The conversation handler marks the existing card `backgrounded` and
  does not append a second `sender: 'subagent'` message.
- A later `subagent_completed` with `async: true` does not change that
  card when it is somehow delivered; production routing still keeps it
  off the handler.
- `splitStaticHistory` treats `backgrounded` as static.
- Replay of `subagent_started` + `subagent_transferred` restores
  `backgrounded`. Replay must not append a duplicate card when a later
  async `subagent_started` for the same `agentId` is also in the log.
- `SubagentActivityMessage` renders `— moved to background` and keeps
  the frozen tool peek.

Then add the event, emit it before the async start in
`subagent-async-registry.ts`, persist it, handle it, and extend the
message status union.

Do not notify the main agent from this event. The control port already
enqueues `user_control`.

### 2. One compact row for every live task

The panel renders unadopted work as `[Role · foreground]` and adopted
work without that tag. Header becomes `Tasks · N active · Ctrl+G manage`.
The 1s tick also runs when only foreground candidates exist.

### 3. One manager list and truthful move copy

Manager rows use the same placement tag. Confirmation and notification
copy name a subagent or a shell, not “this shell” for both.

### 4. Integrate

Cross-link from [MAP.md](MAP.md) and [liveness-ui.md](liveness-ui.md).
Keep AGENTS.md current. Run typecheck, build, full unit suite, and
provider black-box.

## Non-goals

- Routing async lifecycle back into `SubagentActivityMessage`.
- A second live tool timeline for unadopted foreground leases.
- Implementing the liveness observation union from liveness-ui.
- Changing stop, adoption, approval-queue, or notification-lane
  semantics.
- Renaming `BackgroundTaskControl` or folding
  `listForegroundTransferCandidates` into `listDetails()`.

## Acceptance criteria

- After a move, the original transcript card says it moved to
  background, becomes static history, and does not keep the rest of
  the transcript dynamic.
- The same live execution is never drawn as background until
  `adoptForegroundLease` succeeds.
- The compact strip and manager list show unadopted work with a
  foreground tag and adopted work without one.
- Native `execution: 'background'` / `run_subagent_async` launches
  still produce no live `sender: 'subagent'` message.
- Existing stop, transfer confirmation, Ctrl+G ownership, and
  completion-notification tests stay green.
- Move notifications name the executor that actually moved.
