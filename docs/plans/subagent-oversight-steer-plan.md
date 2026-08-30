# Subagent Oversight — Plan 3: Steer

Status: **shipped.** Implemented as `sendMessage` / `cancelRun` on
`SubagentAsyncRegistry` (`source/services/subagents/subagent-async-registry.ts`).
Retained for rationale, not as pending work.

## Known deferred bug

**User steering is misrouted to the root agent.** A steering message entered by the
user while a subagent is the intended target is currently delivered to the root
agent instead of that subagent. The later fix must preserve ordinary root-agent
steering while routing explicitly subagent-directed user steering to the addressed
live subagent. Reproduce and characterize the input-to-target selection path before
changing delivery; no fix is included in this note.

Parent: `docs/plans/subagent-oversight-goal.md` (feature 3). Research basis:
`docs/plans/subagent-oversight-steer-research.md`. This plan supersedes the research
document's unverified execution assumptions where they conflict with the decisions
below.

## Why

Peek tells the orchestrator what an async run is doing, and Results makes a settled
report verifiable. Neither can correct a live run or let it wait at a real blocker.
Today an async run is one invocation of the registry `run` dependency
(`source/services/subagents/subagent-async-registry.ts:45-53,329-356`), and its only
live control is an abort signal. `abortRun` immediately fabricates and resolves an
empty cancelled result (`:256-284`), throwing away the evidence the executor may have
already gathered. The completion-notification path is similarly one-way: it queues
only `subagent_completed` events (`subagent-notification-store.ts:153-176`) and gives
the parent a system turn only when idle (`conversation-orchestrator.ts:560-630`).

Steer closes both gaps without creating a subagent-to-user path:

- an orchestrator can redirect a named live execution while preserving its session and
  accumulated evidence;
- an execution subagent can ask the orchestrator and suspend at that tool call until
  the orchestrator answers; and
- the orchestrator can cancel a run honestly, including its partial write/tool/diff/
  validation evidence, without touching its worktree.

## What we are building

Two new non-blocking parent control tools, a modified async launch tool, and one execution-subagent tool:

| Tool | Direction | Contract |
| --- | --- | --- |
| `send_message` | orchestrator → live run | Resolve a queued `ask_orchestrator` question when given its `reply_to` message id; otherwise queue a steering instruction for the addressed active run. Returns an acknowledgement; never waits for a result. |
| `cancel_run` | orchestrator → live run | Begin cancellation of the addressed active run. Returns once cancellation is requested; the real cancelled result arrives through the normal completion path. |
| `run_subagent_async(name?)` | launch/addressing | Add a constrained optional active-run name alongside the canonical `runId`. |
| `ask_orchestrator` | execution subagent → orchestrator | Queue a question and await only that tool call's answer promise. It never contacts the user and never terminates/relaunches the logical run. |

One stable **logical async run** may execute several interruptible **execution
segments**. It retains one canonical `runId`, optional active name, `SubagentSession`,
evidence accumulator, result promise, and logical lifecycle across all segments. A
segment is one call to a runner with one abort controller and one new user turn. The
registry owns the loop that chooses and starts the next segment; runners execute a
single segment and return its terminal/partial evidence.

## Research corrections and binding design decisions

### D1. The execution `for await` is an event stream, not an injectable SDK-turn loop

The research's Option A described checking an inbox “between iterations” of
`runtime.turns.start`. That is incorrect. `ExecutionSubagentRunner` consumes
`ConversationEvent`s from **one** call to `runtime.turns.start` at
`execution-runner.ts:192-243`; events include `tool_started`, `final`, `usage_update`,
and `error`. They are observations of one already-started foreground turn, not
injectable SDK turns or safe harness delivery boundaries. `TurnCoordinator.start`
also rejects a concurrent turn while it is non-idle (`turn-coordinator.ts:32-53`).

There is no ordinary Runner/RunState input-injection API in the installed SDK. Therefore
we choose **queued abort-and-new-turn segments**, not a faux live inbox and not direct
mutation of private SDK state:

1. `send_message` queues steering text on the logical run.
2. If no subagent tool is active, its run control aborts the current segment's model
   stream immediately. If a tool is active, it marks an interrupt pending and aborts
   as soon as the final active tool completes.
3. The segment runner exports its normal session state and returns partial evidence.
4. The registry folds that evidence into the logical accumulator, coalesces all queued
   steering text into one bounded new user-turn input, and starts the next segment in
   the same `SubagentSession`.

This necessarily discards only in-flight model generation. Completed tool work,
persisted session history, and captured evidence survive.

### D2. Session export/import is continuity of harness history, not SDK `RunState`

`ExecutionSubagentRunner` imports `session.exportState()` into a freshly created
runtime before the turn (`execution-runner.ts:166-182`) and exports it in `finally`
(`:254-273`). `SubagentSessionState` contains history, `previousResponseId`, and the
tool ledger (`subagent-session.ts:11-16,60-78`); it does **not** retain the same SDK
`RunState`. Every steering continuation is a fresh `runtime.turns.start` user turn,
not `Runner.run(agent, priorRunState)` and not approval continuation.

Consequences:

- Do not claim SDK RunState, current-turn, or token-turn continuity.
- Each segment gets the role definition's normal `maxTurns` independently.
- Bound the extension explicitly with `MAX_STEER_CONTINUATION_SEGMENTS = 3` per
  logical run. A run can therefore consume at most four segment budgets
  (`4 × definition.maxTurns`) through steering, even if many messages arrive. Extra
  messages after the cap return a typed `steer_limit_reached` acknowledgement and do
  not interrupt a productive segment. The constant is deliberately local in this
  first release; promote it to a setting only if observed use warrants policy tuning.

### D3. The registry owns lifecycle, addressing, and the segment/restart loop

Keep `SubagentAsyncRegistry` the sole owner of async-run identity and settlement rather
than putting a restart loop in `ExecutionSubagentRunner`. Replace its current
single-controller `StoredRun` shape (`subagent-async-registry.ts:25-43`) with logical
run state: name, lifecycle, session, accumulator, promise resolver, segment count,
and a `SubagentRunControl`. The registry must be the only module that:

- resolves a name or canonical runId to an active logical run;
- starts/restarts segments, consumes/coalesces its mailbox, and selects their input;
- removes active-name ownership and settles the one result promise exactly once; and
- emits exactly one `subagent_started` and one `subagent_completed` event for the
  logical run, rather than one completion per interrupted segment.

Introduce a cohesive internal `SubagentRunControl` abstraction (a new
`source/services/subagents/subagent-run-control.ts`, not a growing public registry
surface). It encapsulates the per-logical-run mutable coordination that neither runner
nor tool policy should reimplement:

- bounded/coalesced steering mailbox and continuation-cap accounting;
- the current segment `AbortController` and its abort reason (`steer` versus
  `cancel`);
- active tool count and `interruptWhenToolsIdle` flag;
- one pending `{messageId, question, resolve, reject}` answer waiter; and
- cancellation requested state.

Its explicit callbacks are `beginSegment`, `endSegment`, `onToolStart`,
`onToolComplete`, `enqueueSteering`, `ask`, `answer`, and `requestCancellation`.
`ExecutionSubagentRunner` receives the small control callback interface for one
segment; it cannot resolve names, settle the logical promise, or restart itself.
`SubagentToolFactory.buildAgentTools` already calls `onToolComplete` only after the
underlying tool resolves (`tool-policy.ts:929-979`), which is the safe hook to release
a deferred steering interrupt. Wire both start and completion callbacks from
`ExecutionSubagentRunner` where it currently builds tools (`execution-runner.ts:107-129`).

### D4. Evidence is logical-run evidence, and cancellation is two-phase

Each finished segment returns the same structured result shape already assembled by
`ExecutionSubagentRunner` (`execution-runner.ts:275-303`). The registry folds it into
logical evidence after **every** segment, including an aborting one:

- union `filesChanged` in first-seen order;
- sum tool counts by tool name;
- merge per-file `diffStat` deltas;
- retain the latest `validation` evidence;
- accumulate usage where the normalized usage shape permits it; and
- retain the final segment's `finalText` only for a completed logical run.

`cancel_run`, parent abort, reset, and dispose move a run from `running` or
`waiting_for_answer` to **`cancelling`** and signal the active segment. They do not
resolve its promise or emit `subagent_completed`. The runner returns a cancelled
segment result (including partial evidence); only then does the registry fold evidence,
settle the logical run as `cancelled`, remove its name, and emit the one completion.
This replaces the fabricated empty result in `#cancelRun` (`subagent-async-registry.ts:
265-284`) and retains the existing “late executor result cannot win” guarantee
(`:347-355`) at logical settlement.

Cancellation never invokes cleanup, `git restore`, worktree removal, or any other
filesystem repair. The result must say that partial work may remain in the worktree;
the orchestrator decides whether and how to inspect/revert it. This is required both
for honesty and for protection of pre-existing user work.

### D5. Names are optional ergonomic aliases, never identity

Add `name?: string` to the async-launch schema, request, handle, and status snapshot.
Accept only `/^[a-z][a-z0-9_-]{0,31}$/`; reject invalid names with typed
`invalid_name`. Maintain a registry `activeNameToRunId` map:

- `runId` is canonical and always wins if a target text matches both a runId and a
  name.
- Names are unique only among active logical runs; a collision returns `name_in_use`.
- Remove the mapping on every terminal settlement (completed, failed, cancelled), so
  the name is immediately reusable even though the terminal record stays available by
  `runId` through TTL/eviction.
- A continuation may assign a name only when it becomes active and passes the same
  uniqueness check. The existing worker post-completion continuation ban remains
  unchanged (`subagent-async-registry.ts:116-121`): mid-run steering is not a loophole
  for relaunching a settled worker.

`get_subagent_status` includes the name when present and its all-runs formatter displays
`name (runId)`; completion/question notifications include both. `send_message` and
`cancel_run` accept a `target` that resolves to an active name or runId. A settled,
missing, or evicted target yields structured feedback, never an accidental new run.

### D6. Questions generalize the notification queue and preserve the idle gate

Generalize `BackgroundSubagentNotification` and its port into a message-id-keyed
`SubagentNotification` queue with `kind: 'completion' | 'question'`. Preserve the
existing `drain`/`retain` delivery acknowledgement and bounded dedup semantics, but
key pending/seen entries by `messageId`, not implicitly by `runId`. Completion uses a
stable `completion:${runId}` message id; each question gets a generated message id and
can be delivered exactly once even while that run remains live.

`ask_orchestrator({ question })` is provisioned only for an async execution segment.
Its execution calls `runControl.ask(question)` and awaits that promise. The control
emits a new async `subagent_question` conversation event carrying `messageId`, `runId`,
optional name, role, and bounded question text. The conversation-scoped background sink
already owns event logging and queue wake-up (`session-composition.ts:304-332`); extend
it to record/enqueue this event. Extend the existing formatter/delivery method in
`ConversationOrchestrator` (`conversation-orchestrator.ts:39-71,560-630`) to batch
questions and completions into one idle-gated, system-initiated parent turn.

The question notification tells the orchestrator to decide, investigate, or escalate to
the user and to answer with
`send_message({ target, reply_to: messageId, message })`. `send_message` resolves only
the matching pending waiter. The answer resumes only the waiting tool invocation; it
does not abort/restart the segment, create a new parent turn, or give the subagent a
user channel. Duplicate/stale/wrong-run answers return typed `question_not_pending` or
`question_mismatch` without changing the run. Only one question can wait per logical
run, and question text is capped at 1,200 characters.

### D7. Explicit state machine and races

Expose `waiting_for_answer` and `cancelling` in `SubagentRunStatus` in addition to the
current terminal states. Internally, maintain these legal transitions:

```text
start → running
running → waiting_for_answer       (ask_orchestrator tool begins waiting)
waiting_for_answer → running       (matching send_message answer resolves)
running | waiting_for_answer → cancelling  (cancel/parent abort/reset/dispose)
running → running                  (steer: segment aborts, evidence folds, next segment starts)
running → completed | failed       (final non-steer segment result)
cancelling → cancelled             (runner returns cancelled segment result)
```

Terminal states are absorbing; terminal settlement clears the active name and rejects a
pending question waiter. A steering request received after segment completion but before
logical settlement is serialized by the registry: it either becomes the next segment's
coalesced input while the run is still active, or receives `not_active` after settlement
— never starts a second concurrent segment. A cancellation wins over queued steering,
queued restart, and a late segment success. Steering received while `ask_orchestrator`
waits is queued but does not abort the waiting tool; the answer resumes it, then the
post-tool `onToolComplete` boundary triggers the queued restart. This avoids abandoning
an unanswered blocker.

### D8. SDK approval interruption is handled explicitly, not made steerable

Normal execution-subagent write/shell tools deliberately do not request SDK approval;
the worker policy auto-evaluates or blocks commands instead (`tool-policy.ts:350-398`),
so this is rare. If an approval-capable nested/provider path nevertheless interrupts a
segment, classify it as an `sdk_approval_interrupted` segment outcome, preserve evidence,
and settle the logical run with a typed failed/unsupported result. Do **not** restart it
with queued steering, fabricate a RunState continuation, or surface an approval to the
user through this feature. Supporting async subagent SDK approvals and their resume
state is an explicit follow-up non-goal.

### D9. Mentor is deliberately a narrower control surface

`MentorRunner` is not an `ExecutionSubagentRunner` variant: it calls `runWithProvider`
directly with an agent that has no tool list (`mentor-runner.ts:91-158`). It has neither
the session runtime event loop nor `SubagentToolFactory.buildAgentTools`/
`onToolComplete`; therefore it cannot safely host a mailbox boundary or
`ask_orchestrator` tool.

**Scoped decision:** this release supports steering and inbound questions only for the
execution-runner async roles (`explorer`, `worker`, `researcher`, `librarian`). A mentor
can still have a name, status, and two-phase cancellation; its runner must translate an
abort into its ordinary empty-but-accurate cancelled segment result. `send_message` to
an active mentor returns `unsupported_control` and never secretly aborts/relaunches it.
Do not retrofit mentor tools, streaming, or question delivery in this plan.

## Context and resource bounds

The feature is on-demand and bounded at every new parent-context edge:

- Launch names add at most 32 characters to an existing handle/status line.
- `send_message` accepts 1–2,000 characters. Its acknowledgement is a compact
  `{runId, status, delivery}` payload (about 50–100 tokens), not the subagent result.
- Coalescing retains at most four queued steering messages and at most 4,000 characters
  (about 1k tokens) in the next subagent user turn. Newest instructions replace the
  oldest overflow with an explicit truncation marker; no unbounded mailbox enters the
  session history.
- A question is at most 1,200 characters (about 300 tokens). There is one waiter per
  run and one notification entry per message id. The idle-gated parent notification
  batches pending questions/completions; it does not poll or inject into an active turn.
- `cancel_run` is similarly a short acknowledgement. Partial evidence remains on the
  normal `get_subagent_result` path, not in control-tool responses.
- The three-restart cap in D2 bounds additional model-turn budget and prevents a noisy
  controller from turning steering into an unbounded fresh-turn loop.

These limits retain the goal's async discipline: neither outbound tool awaits the
result promise, and `ask_orchestrator` blocks only its subagent tool invocation—not the
orchestrator's turn.

## File-level change map

1. `source/services/subagents/types.ts` — add optional name to request/handle/status;
   add `waiting_for_answer`/`cancelling` status; define segment outcome/control-facing
   types as needed without exposing registry internals publicly.

2. `source/services/subagents/subagent-run-control.ts` **(new)** — implement the
   internal mailbox, active-tool gate, current-segment controller, question waiter,
   cancellation, bounded coalescing, and deterministic cleanup callbacks described in
   D3/D7.

3. `source/services/subagents/subagent-async-registry.ts` — make `StoredRun` a logical
   run; add active-name lookup, target resolution, evidence accumulation, two-phase
   settlement, and the serialized segment/restart loop. Change the injected runner
   contract from “run a whole async job” to “run one segment with control callbacks and
   input.” Expose non-blocking `sendMessage`, `cancelRun`, and answer dispatch APIs.

4. `source/services/subagents/execution-runner.ts` — refactor `runInSession` into one
   segment execution with supplied input/controller/control callbacks. Keep the
   `for await` as event consumption, export/import session state in its `finally`, wire
   `onToolStart`/existing `onToolComplete`, and return partial evidence on abort rather
   than owning a restart loop.

5. `source/services/subagents/tool-policy.ts` — allow an optional internal async-run
   control dependency when building definitions; add `ask_orchestrator` only for an
   eligible async execution segment; retain the existing shell/write approval policy.

6. `source/tools/agent/ask-orchestrator.ts` **(new)** — define and format the bounded
   subagent-only question tool. Its `execute` awaits the supplied answer promise.

7. `source/services/subagents/runtime.ts` — adapt the registry segment callback to
   `ExecutionSubagentRunner` for eligible roles, retain mentor's separate cancellation
   path, and route the new question event through the existing shared event fan-out.

8. `source/services/subagents/mentor-runner.ts` — minimal cancellation normalization so
   an aborted mentor returns a runner-produced cancelled result; no mailbox, restart,
   or subagent tool additions.

9. `source/services/subagents/subagent-manager.ts` and
   `source/lib/subagent-bridge.ts` — expose target-addressed send/cancel/answer
   operations and carry optional launch names without leaking controls to transient
   clients.

10. `source/tools/agent/run-subagent-async.ts` — add name schema/output/formatting;
    add `send_message` and `cancel_run` schemas, compact acknowledgements, and typed
    errors. Preserve the warning that `get_subagent_result` blocks.

11. `source/agent.ts` — inject/register the new orchestrator control tools alongside
    async launch/result/status in orchestrator mode and normal non-lite registration;
    do not register `ask_orchestrator` on the parent.

12. `source/services/conversation/conversation-events.ts` — add the async
    `subagent_question` event with `messageId`, run identity/name, role, and question.

13. `source/services/subagents/subagent-notification-store.ts` — generalize completion
    records/port to the message-id-keyed `completion | question` queue while preserving
    task lifecycle projection and drain/retain semantics.

14. `source/services/session/session-composition.ts` and
    `source/services/conversation/conversation-orchestrator.ts` — forward question
    events into that queue; render/deliver question and completion batches through the
    same existing idle gate and background observer.

15. `source/prompts/async-subagent-delegation.ts`,
    `source/prompts/orchestrator.md`, `source/prompts/subagents/worker.md`, and
    `source/prompts/subagents/researcher.md` — describe names, non-blocking steering/
    cancellation, when to use `ask_orchestrator`, question-answer routing, limits, and
    the no-user-channel invariant. Do not imply an SDK live inbox or mentor support.

16. Tests colocated with the above: `subagent-run-control.test.ts` (new),
    `subagent-async-registry.test.ts`, `execution-runner.test.ts` (or its existing
    closest focused test), `tool-policy.test.ts` (or focused tool tests),
    `run-subagent-async.test.ts`, `subagent-notification-store.test.ts`,
    `conversation-orchestrator.subagent-notifications.test.ts`, `subagent-bridge.test.ts`,
    `agent.test.ts`, `prompt-constructor.test.ts`, and `orchestrator-prompt.test.ts`.
    Add a focused prompt test for worker/researcher guidance if none exists.

## TDD implementation slices

### Slice 1 — control primitive, logical identity, and names

Write deterministic control/registry tests first using deferred segment promises and an
injected clock/UUID where needed:

- constrained names are returned in launch/status, are unique only while active, and
  become reusable on each terminal settlement; raw runId remains canonical;
- target resolution distinguishes missing/settled/evicted/non-active aliases without
  launching work;
- control tracks current segment, active tool count, one waiter, mailbox bounds, and
  terminal cleanup without exposing mutable maps; and
- one logical run emits one start/completion and owns one promise/session across a
  normal multi-segment sequence.

Then add types, control module, and registry shape/name APIs. Run the focused control
and registry tests.

### Slice 2 — honest two-phase cancellation and accumulated evidence

First test that cancellation changes status to `cancelling` but leaves the result promise
unsettled until the deferred runner returns; assert a partial cancelled segment's files,
tool counts, diff stat, validation, and usage appear in the final result. Cover parent
abort/reset/dispose, late successful segment result losing to cancellation, unanswered
question rejection, and no automatic worktree cleanup. Add a mentor cancellation test
that proves its limited, empty evidence result is runner-produced rather than fabricated
by the registry.

Implement accumulator/settlement changes and runner abort normalization. Run focused
registry/execution/mentor tests.

### Slice 3 — outbound steering and fresh-turn semantics

First test with a fake segment runner that:

- a message while model streaming aborts the current segment immediately, folds partial
  evidence, and starts exactly one fresh same-session segment with coalesced input;
- a message while one or more tools are active does not abort until the final existing
  `onToolComplete`, including an `ask_orchestrator` tool that remains pending;
- several arrivals coalesce into one bounded next input; segment cap rejects later
  steering without interruption; and
- finish-versus-message, cancel-versus-restart, and duplicate completion races cannot
  create concurrent segments or double-settle.

Add execution-runner callback wiring and registry restart loop only after those tests.
Pin that each continuation calls new user-turn input in the same `SubagentSession`; do
not mock or assert nonexistent SDK RunState reuse. Run focused registry/runner/tool
policy tests.

### Slice 4 — inbound questions and idle-gated parent delivery

First test `ask_orchestrator` pending behavior: it enqueues exactly one message-id-keyed
question and only its tool promise waits; matching `send_message(reply_to)` returns the
answer, stale/duplicate replies do not, and cancel rejects the waiter. Test the store's
question/completion dedup, retain/retry, and batching independently.

Extend the existing conversation-orchestrator notification harness to prove questions
wait behind an active parent turn or pending approval, then arrive as a system turn when
idle; prove the parent receives `messageId`/target/reply instruction and no user-facing
subagent channel. Run focused tool/store/orchestrator/session-composition tests.

### Slice 5 — tool/prompt registration and integration guardrails

First pin schemas/descriptions and registration:

- `send_message`/`cancel_run` never need approval and never await a result;
- optional launch name validates and UI command formatting shows it;
- only execution-runner roles expose `ask_orchestrator`; `send_message` to mentor
  reports `unsupported_control`; cancellation remains available;
- prompts say to steer/cancel by name or runId, answer questions with `reply_to`, keep
  the orchestrator as single contact, do not poll/get results immediately, and do not
  promise SDK live delivery; and
- worker/researcher prompts say to ask only for a genuine blocker, include the decision
  needed, and continue once answered rather than contacting the user.

Wire bridge/manager/agent/prompt construction only after the tests are red. Run the
focused tool/agent/bridge/prompt suites, then `pnpm test` before enabling the rollout
flag.

## Success criteria

- A named eligible live run can be redirected without a new logical runId, duplicated
  completion notification, lost session history, or lost accumulated evidence.
- A steering message interrupts model streaming promptly, never interrupts an active
  tool, coalesces safely, and starts at most three bounded fresh continuation segments.
- A genuine blocker suspends only `ask_orchestrator`; it is delivered once through the
  existing parent idle gate and only the orchestrator decides/escalates/responds.
- `cancel_run` is non-blocking, visibly enters `cancelling`, and eventually returns a
  runner-produced cancelled result with truthful partial evidence and no worktree
  cleanup.
- `runId` remains canonical; active names are constrained/unique and safely reusable
  after settlement.
- Normal async discipline remains intact: new control tools do not await
  `get_subagent_result`, completion retrieval remains the rich-result path, and no
  subagent is given a path to the user.
- Rare SDK approval interruption is explicit, evidence-preserving, and non-steerable;
  it is not silently misrepresented as RunState continuity.

## Non-goals

- Streaming subagent tokens, raw tool output, or an unbounded mailbox into parent
  context.
- Direct injection into an ordinary SDK `Runner`/`RunState`, mutation of private SDK
  fields, or claiming that session export/import serializes a RunState.
- Unlimited fresh-turn budget extension, post-completion worker continuation, or
  steering a settled run.
- An async SDK approval UI/resume protocol.
- Making the mentor runner tool-capable, steerable, or able to ask questions.
- Automatic rollback, cleanup, or deletion of partial work after cancellation.

## Rollout, observability, and fallback

Register the complete feature normally only after Slices 1–5 pass their focused tests,
the Slice 1–4 regression suites, typecheck, and targeted lint/format checks. Do not add
a registration setting or a default-false gate. Log bounded structured lifecycle
diagnostics (runId, name, segment number, reason, mailbox count, state transition; never
steering/question contents) to measure restart rates, cap rejections, cancellation
latency, and unsupported approvals/mentor requests.

If the feature misbehaves, roll back the feature code to the prior async launch/result/
status implementation. Existing logical runs must remain cancellable and settle through
the normal completion path; do not strand a waiter. The operational fallback for an
individual failed steer is to leave the current segment running, cancel it explicitly if
necessary, and launch a fresh ordinary async run with the corrected task—never attempt
an undocumented SDK RunState resume.

## Sequencing

This is Plan 3 and depends on Peek's live status/event routing and Results' diff/
validation evidence (`docs/plans/subagent-oversight-peek-plan.md`,
`docs/plans/subagent-oversight-results-plan.md`). The changes deliberately retain
Peek's poll-only observation boundary and Results' result-only evidence boundary while
adding a separate, bounded control channel. Ship the five TDD slices in order; do not
register the public tools before slices 1–4 establish their state, cancellation, race,
and notification invariants.
