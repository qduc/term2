# Subagent Oversight — Steer: Research Findings

Status: research notes. This is the gathered intelligence that makes a Steer plan
writable, not the plan itself. The plan should be written from these findings.

Parent: `docs/plans/subagent-oversight-goal.md` (feature 3, Steer).
Sequencing context: Peek (plan 1) and Results (plan 2) are shipped and committed.
This document captures what we learned while preparing to write the Steer plan.

## Why this document exists instead of a plan

The user explicitly scoped the two-round effort to Peek + Results. Steer's entire
design hinges on whether mid-run delivery is possible — and the SDK mechanism was
unconfirmed. A plan written against an unconfirmed mechanism either hedges every
decision into uselessness or commits to an assumption that may collapse. So the
round produced a bounded empirical spike on message delivery instead of a plan.
The spike is now complete; these are its findings plus the codebase research that
frames the design space.

## 1. SDK finding: no in-progress message delivery primitive in 0.11.4

**The honest primitive is a delivery channel, not an SDK call.** The goal doc's
prior-art note (Claude Code's `SendMessage`/`TaskStop`) correctly identifies the
mechanism, but our SDK does not provide it as a primitive.

### What was checked

`@openai/agents` / `@openai/agents-core` **0.11.4** (installed, confirmed via
`node_modules/@openai/agents/package.json`). Investigated `Runner`, `RunResult`,
`StreamedRunResult`, `RunState`, `Session`, turn preparation, streaming, and
approval resume. Searched declarations/implementation for `appendMessage`,
`injectMessage`, `sendMessage`, `addMessage`, `addInput`, `enqueue`.

### What exists

The ordinary API is strictly start/resume:

```ts
Runner.run(
  agent,
  input: string | AgentInputItem[] | RunState<TContext, TAgent>,
  options?: StreamRunOptions | NonStreamRunOptions,
)
```
Source: `node_modules/@openai/agents-core/dist/run.d.ts:242-243`.

The stream exposes observation/control surfaces, not input delivery:
`currentAgent`, `currentTurn`, `maxTurns`, `cancelled`, `completed`, `error`,
`toStream()`, `toTextStream()` — no send/append/inbox method.
Source: `node_modules/@openai/agents-core/dist/result.d.ts:166-216`.

`Session.addItems(items)` is persistent-history storage, not a live-turn inbox.
When `Runner.run()` receives a `RunState` to resume, it skips
`prepareInputItemsWithSession`. Source: `node_modules/@openai/agents-core/dist/run.js:176-200`.
So appending to a `Session` would not inject an item into an already-created/resumed
`RunState` loop.

`RunState._originalInput` is a publicly writable underscore-prefixed field, but the
SDK explicitly warns it is not meant for direct use and has no defined concurrency
or delivery semantics. Source: `node_modules/@openai/agents-core/dist/runState.d.ts:2625-2632`.

### What does not exist

**No public API that appends or injects a user message into an already-running
ordinary `Runner.run()` loop.** No `appendMessage`, `injectMessage`, `sendMessage`,
`addMessage`, `addInput`, or queue method on `Runner`, `RunResult`, or
`StreamedRunResult`.

A separate `realtime` namespace has `RealtimeSession.sendMessage`, but it is a
realtime-session API, not an ordinary `Runner`/`RunState` path, and this repo has
no Realtime SDK usage.

### Repository-specific consequence

`runtime.turns.start(...)` (`source/services/session/session-composition.ts:191-198`)
is this repo's wrapper, not an SDK API. It likewise provides no send/append/inbox.
`TurnCoordinator.start()` rejects a concurrent foreground start:
`if (!this.deps.statusMachine.is('idle')) throw new Error('Another foreground turn is already active.')`
(`source/services/session/turn-coordinator.ts:32-35`).

**Design implication:** a `SendMessage`-equivalent for subagents cannot be
implemented by calling an SDK primitive. It requires **harness-owned loop
restructuring** — an inbox checked at an explicit boundary, or abort/restart/resume
orchestration with a newly constructed input.

## 2. maxTurns: persistent budget, resume is same logical turn

Since injection is not supported, there is no SDK-defined "message injection
extends/consumes turn budget" behavior. For the supported resume path:

- A new `RunState` receives the configured limit at construction:
  `new RunState(..., options.maxTurns === undefined ? DEFAULT_MAX_TURNS : options.maxTurns)`.
  Sources: `run.js:301-308`, `:953-960`.

- On resume, the state retains its existing limit **unless the caller explicitly
  supplies `options.maxTurns`**:
  `if (isResumedState) { ... if (options.maxTurns !== undefined) state._maxTurns = options.maxTurns; }`.
  Sources: `run.js:309-314`, `:961-965`.

- Enforcement: `if (state._maxTurns !== null && state._currentTurn > state._maxTurns) throw new MaxTurnsExceededError(...)`.
  Source: `node_modules/@openai/agents-core/dist/runner/turnPreparation.js:22-27`.

- Approval continuation is **the same logical turn** — `resumeInterruptedTurn()`
  does not increment. Source: `turnPreparation.js:97-113`, `runLoop.js:34-55`.

**Implication for Steer:** guidance revision delivered as a resume would preserve the
existing `maxTurns` budget. The caller can explicitly override it, so the plan can
extend the budget by a bounded number of turns if desired.

## 3. Approval pending: no concurrent message queue

A tool approval pauses/ends the current run/stream. Only `approve`/`reject` + a new
`run(agent, state)` is defined. There is no SDK-defined message queue, delivery,
error, or drop behavior for a concurrent user message while an approval is pending.
Source: `runState.d.ts:2813-2849`.

**Repository-specific caveat:** `ExecutionSubagentRunner` deliberately configures
write/shell tools with `needsApproval: () => false` (`tool-policy.ts:596-602`,
`:363-383`) and worker shell policy blocks/auto-evaluates unsafe commands itself
(`tool-policy.ts:242-267`). So a pending SDK approval is primarily relevant to
nested approval-capable paths, not the normal standalone subagent execution at
`execution-runner.ts:187-190`. If such an interruption does occur, the generic SDK
behavior above applies.

## 4. Inbound delivery: we own half this machinery, pointed the wrong way

The goal doc's question — "how much of the existing notification path generalizes?"
— has a concrete answer.

### Existing inbound path (completion → parent turn)

`SubagentNotificationStore` (`source/services/subagents/subagent-notification-store.ts`)
queues `BackgroundSubagentNotification` records when an async `subagent_completed`
event arrives. `ConversationOrchestrator.#deliverBackgroundSubagentNotifications()`
(`source/services/conversation/conversation-orchestrator.ts:560-631`) drains the
store and injects a system-initiated turn into the parent via
`conversationService.sendMessage`. The turn is admitted only when the conversation is
idle (`#activeTurns === 0 && !pendingApproval && !queueActive`); otherwise the store
retains the notifications for the next opportunity.

### What generalizes

- The store and the drain/retain + idle-gate delivery pattern are directly reusable
  for inbound `ask_orchestrator` messages from a subagent. The notification is just
  one shape of message; a blocker question is another shape, same queue, same idle
  gate, same `sendMessage` injection.
- `BackgroundSubagentNotification` already carries `{runId, role, status, preview,
  error, completedAt}`. An inbound question adds a `kind: 'question'` discriminator
  and a `question` field.
- The `enqueue`/`drain`/`retain` protocol and the at-most-once delivery invariant
  (dedup via `#seen`) already solve the hard part for inbound messages too.

### What does not generalize (the genuinely new piece)

Outbound delivery into a live subagent's turn loop. The existing path flows one way:
subagent → parent. There is no harness-owned mechanism today that delivers a message
from the parent into a running subagent. That is the primary new work.

## 5. Outbound delivery: the design space, narrowed by the SDK finding

Since the SDK provides no in-progress injection, outbound delivery has two viable
harness-owned shapes:

### Option A: inbox checked at turn boundaries

Restructure the subagent execution loop so that between SDK turns (between iterations
of the `for await ... of runtime.turns.start(...)` loop, `execution-runner.ts:192-237`)
the loop checks an inbox on the stored run. If a steering message is present, it is
folded into the next turn's input. This is the closest harness equivalent to the SDK's
push semantics. It requires breaking the single `turns.start()` call into a per-turn
loop, which today is a single async iterable consumed to completion.

### Option B: abort, reconstruct input, resume

When a steering message arrives, abort the current turn (via the existing
`abortController` on `StoredRun`, `subagent-async-registry.ts:134`), reconstruct the
input as the original task + the steering message, and resume the `RunState` via a new
`turns.start()` call. This preserves `maxTurns` continuity (the same `RunState` is
resumed) and is closer to the SDK's own approve/reject + resume pattern, but it
discards in-flight model work and incurs a new model round-trip.

### Open question the plan must resolve

Both options require the plan to decide:
- **Check granularity.** Option A checks only at SDK turn boundaries (between tool
  calls and model responses). Option B can interrupt any point. A worker mid-tool-call
  is unreachable by either until the tool completes, but A surfaces the message at the
  next turn boundary; B aborts the turn and restarts with the new instruction.
- **`maxTurns` budget.** The SDK preserves the existing limit on resume and allows an
  explicit override. The plan should decide whether steering extends the budget by a
  bounded number of turns or consumes the original; the user's earlier steer thinking
  leaned toward "extends by a bounded number, not consumes the original."
- **Signal vs message.** The existing `abortController.abort()` (`:134`) is a signal,
  not a payload channel. The plan must add a payload — the steering instruction text —
  that the loop reads and folds into the next turn or the reconstructed input.

## 6. Cancel: existing machinery and the partial-work honesty gap

`abortRun(runId)` exists (`subagent-async-registry.ts:188-195`) and is wired only to
the user's stop action today. `#cancelRun` (`:197-216`) is the implementation:

```ts
#cancelRun(run: StoredRun): void {
  if (run.status !== 'running') return;
  run.abortController.abort();
  const result: SubagentResult = {
    agentId: run.runId, role: run.role, status: 'cancelled',
    finalText: '', filesChanged: [], toolsUsed: [],
    error: 'The subagent run was aborted.',
  };
  run.status = 'cancelled'; run.result = result; ...
}
```

**Gap the goal doc names:** on abort, `#cancelRun` emits **empty** `filesChanged` and
`toolsUsed`, even if the executor accumulated partial work. This is dishonest — the
partial work vanishes from the result. Steer should fix this so a cancelled result
preserves the `filesChanged`/`toolsUsed` (and now `diffStat`/`validation`) captured so
far, reporting partial work honestly and noting the dirty worktree state.

The `#execute` finish path (`:284-312`) already accumulates the real `SubagentResult`
from the executor, but `#cancelRun` short-circuits before that path. The fix is to
preserve the accumulated `filesChanged`/`toolsUsed`/`diffDeltas`/`lastValidation` from
the run's execution context and fold them into the cancelled result.

## 7. Addressing: names as a prerequisite, not a cosmetic addition

The goal doc's question — "naming lands here or earlier?" — has a clear answer now.
Peek already ships an all-runs listing disambiguated by `role` + `taskPreview`, which
makes names non-load-bearing for observation. But steering (`send_message`,
`cancel_run`) addresses a specific run, and opaque `runId`s (UUIDs) are poor
ergonomics for a model running several at once. **Naming is a prerequisite for Steer.**

Design space:
- Add an optional `name` to `run_subagent_async` (already pairs with the registry's
  existing `runId` as canonical stable reference).
- Registry adds a `name → runId` map (names unique within the live conversation,
  fall back to `runId` when omitted or ambiguous).
- Peek's all-runs listing should be updated to show names alongside runIds.

## 8. The worker-continuation block: load-bearing, stays

`subagent-async-registry.ts:113-114` blocks worker continuation:

```ts
if (role === 'worker')
  throw new SubagentRegistryError('worker_blocked', 'Worker runs cannot be continued asynchronously');
```

Steer is **mid-run delivery**, not post-completion resume. So the `worker_blocked`
policy survives — its rationale becomes load-bearing rather than incidental: it exists
because steering mid-run is the honest primitive, not resume-after-completion. The
goal doc flags this: "Steering makes that policy load-bearing rather than incidental —
does it survive?" Answer: yes, and the plan should document the rationale.

## 9. Single point of contact: how the invariant constrains Steer

The goal doc's non-goal: **no subagent path to the user.** Inbound messages address the
orchestrator, which then decides or escalates. This is exactly what makes a
bidirectional channel safe:

- **Inbound (`ask_orchestrator`):** a worker subagent that hits a blocker posts a
  question to the notification store and suspends (aborts its turn, waits for a resume
  with the orchestrator's answer). The orchestrator's idle-gated delivery path
  surfaces the question; the orchestrator decides or escalates to the user.
- **Outbound (`send_message` / `cancel_run`):** the orchestrator addresses a live run
  by name. The message never reaches the user directly.

The plan must verify no feature gives a subagent a path to the user, or gives the user
a reason to route around the orchestrator.

## 10. Constraints inherited from the goal (all three features share these)

- **Context budget.** The Steer plan must state the parent-context cost of each new
  tool (`send_message`, `cancel_run`, `ask_orchestrator`) and justify it. Steering
  messages are short by design; the cost is bounded and on-demand.
- **Prompt text is product behavior.** Tool descriptions for the new tools and
  orchestrator.md guidance ship with prompt tests, per `AGENTS.md` and the
  `search-via-shell.test.ts` / `orchestrator-prompt.test.ts` pattern.
- **TDD.** Tests first, per the `testing` skill. The registry's inbox/cancel paths,
  the notification store's `ask_orchestrator` shape, and the prompt guidance all need
  test coverage.
- **Do not regress async discipline.** The "don't call `get_subagent_result` right after
  launching" rule is load-bearing and repeated in three places. The new tools must be
  checked against that failure mode — `send_message` and `cancel_run` must be
  non-blocking; `ask_orchestrator` must not become a blocking wait for the subagent.
- **Single point of contact is the invariant.** No feature gives a subagent a path to
  the user.

## 11. Proposed feature surface (for the plan to refine)

Based on the above research, the Steer feature set is shaping toward:

| Tool | Direction | Owner | Blocking? |
|---|---|---|---|
| `send_message` | orchestrator → live subagent | new outbound path | non-blocking (enqueue, checked at next boundary) |
| `cancel_run` | orchestrator → live subagent | thin wrapper over `abortRun` | non-blocking |
| `ask_orchestrator` | live subagent → orchestrator | generalize `SubagentNotificationStore` + `#deliverBackgroundSubagentNotifications` | suspends the subagent, does not block the parent |

Plus:
- Naming on `run_subagent_async` (optional `name` field + registry name→runId map).
- Fix `#cancelRun` partial-work honesty (preserve accumulated evidence in the cancelled result).
- Prompt updates: orchestrator.md steering guidance; a new subagent-side `ask_orchestrator` tool description and the worker/researcher prompts describing when to ask vs when to terminate.
- Prompt tests pinning the non-obvious parts.

## 12. Open questions the plan still needs to answer

These are explicitly deferred to the plan document, not resolved here:

1. **Outbound delivery shape:** Option A (inbox at turn boundaries) vs Option B
   (abort + reconstruct + resume). The SDK finding makes A more faithful to push
   semantics but requires loop restructuring; B is closer to existing resume patterns
   but discards in-flight work. The plan should decide, with a fallback.
2. **`maxTurns` on steering:** extend by a bounded number, or consume the original
   budget. The SDK allows an explicit override; the plan should pick a policy.
3. **Message arrival during a tool call:** both options wait until the tool completes
   (A) or abort the turn (B). The plan should state what the subagent sees.
4. **Worktree state on cancellation:** is the worktree left dirty, and who reports
   that? The `#cancelRun` partial-work fix should address this in the result, but the
   plan should decide whether the orchestrator or the harness cleans up.
5. **Naming collision and lifecycle:** what happens when a name is reused after its
   run settles or is evicted? The registry's TTL and session-cap already bound this,
   but the plan should pin the dedup policy.
6. **`ask_orchestrator` suspension:** does the subagent block waiting for an answer
   (and how is that surfaced in `get_subagent_status`?), or does it terminate and the
   orchestrator relaunches with the answer? The goal's success criterion says "ask
   rather than terminate," which leans toward suspend, but the suspension mechanism is
   not free — it ties up the session.

## 13. What Peek and Results pre-staged for Steer

- **Peek** (commit `af147c6`): the registry's per-run progress state and the all-runs
  listing. The listing already disambiguates runs by `role` + `taskPreview`; Steer adds
  names to it. The `handleSubagentEvent` routing in `runtime.ts` is the seam where an
  outbound message could be injected.
- **Results** (commit `425db15`): the `diffDeltas`/`lastValidation` capture on
  `SubagentRunContext` and the execution-runner's result assembly. The `#cancelRun`
  partial-work honesty fix will fold this same evidence into cancelled results, so the
  worker's partial work doesn't vanish on steer-cancel.

## References (anchored files)

- Goal: `docs/plans/subagent-oversight-goal.md:103-177`
- Peek plan (shipped): `docs/plans/subagent-oversight-peek-plan.md`
- Results plan (shipped): `docs/plans/subagent-oversight-results-plan.md`
- SubagentResult types: `source/services/subagents/types.ts`
- Async registry (cancel, stored run, peek): `source/services/subagents/subagent-async-registry.ts`
- Execution runner (result assembly, turn loop): `source/services/subagents/execution-runner.ts`
- Tool policy (write/shell wrappers, run context): `source/services/subagents/tool-policy.ts`
- Notification store (inbound precedent): `source/services/subagents/subagent-notification-store.ts`
- Conversation orchestrator (delivery path): `source/services/conversation/conversation-orchestrator.ts:560-631`
- Turn coordinator (idle gate): `source/services/session/turn-coordinator.ts:32-35`
- Session runtime interface: `source/services/session/session-composition.ts:191-198`
- SDK source: `@openai/agents-core` 0.11.4, `dist/run.js`, `dist/result.d.ts`, `dist/runState.d.ts`, `dist/runner/turnPreparation.js`