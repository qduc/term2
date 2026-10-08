# Durable goal — outcome state separate from plan and execution

## Resume here

Milestones M1-M3 implement the bounded session-owned goal record, replay, launch
flags, interactive `/goal` controls, and fixed-suffix prompt context described
below. The existing goal
wording in compaction instructions and rollover handoffs remains separate; neither
is authoritative objective state. Continue with M4.

Update (2026-09-29): open decision 6(b) is implemented as a `propose_goal` tool
with a dedicated never-auto-approved approval class. The model may propose a goal
once per session — only at the discussion-to-implementation transition — and only
an explicit user approval appends the existing `goal_changed` event via the same
write path as `/goal set`. Never-auto-approval follows the `ask_user` precedent:
`shouldBypassToolApproval` exempts the tool from YOLO mode, and
`NonInteractiveApprovalPolicy` rejects it fail-closed; non-interactive and gateway
sessions never register the tool at all. Keep the goal record limited
to the desired outcome and how success is recognized. Do not put a plan, schedule,
execution status, or child-run topology in it. Persistence is plain session-log
events; there is no goal-specific database or autonomous retry behavior.

Update (2026-10-08): an active goal now gates the root turn's normal stop through
a working-model self-check (`goal_check`); see
[Active-goal stop check](#active-goal-stop-check). It continues the current turn
only; it never starts a turn and never writes goal status.

## Active-goal stop check

While the goal is `active`, a root turn may not end normally until the working
model has called `goal_check` by itself after its last work, reporting one of:

- `achieved` — evidence against the outcome, plus `criteriaEvidence` when the goal
  has success criteria. The turn ends. **Durable status is not changed**: the model
  judging its own work is not proof, so the record stays `active` until the user
  runs `/goal achieved` (option 6(c) remains unimplemented by design).
- `blocked` — the concrete user input or unavailable capability needed. The turn
  ends and control returns; the report is visible as the `goal_check` row and the
  model's final reply.
- `not_achieved` — what remains. The tool result tells the model to keep working,
  so the ordinary tool loop continues; stopping right after it is re-prompted.
- `deferred` — the latest user message asked for something else, asked to pause,
  or superseded the goal. The turn ends and the goal stays active. This is how
  unrelated questions and user pauses avoid being forced into goal work.

`decideGoalStop` (`services/conversation/durable-goal-stop-check.ts`) owns the
decision, reading only the current turn's history: a check counts only when it is
the latest tool activity after the latest user message, so a check made before
newer work, a newer steer, or alongside unseen results does not authorize a stop.
A missing or incomplete check queues a reminder through the run loop's existing
request-boundary notice lane and the same run continues. `ApplicationRunLoop`
consults the policy only at its normal-stop seam, so cancellation/Ctrl+C, errors,
approval and budget pauses, and critical wrap-up never reach it; every
continuation is an ordinary turn for the run budget and `maxTurns`.

Loop guard: two consecutive reminders without intervening tool work; the third
idle stop ends the turn with `terminalCause: 'goal_check_unresolved'`, a system
notice in the TUI, and a stderr line in non-interactive mode. Justification and
the guard contract are in the guard ledger's "Active-goal stop check" entry.

Scope: only root clients wire the policy (transient/subagent clients never do),
and it is inert when the agent lacks `goal_check`. The tool is excluded from
`run_code` so the call is always top-level history the policy can read.

## Gap measurement

What exists today:

- `source/prompts/context-compaction.ts` asks the summarizer to preserve “Current
  goal and success criteria,” but it is text in a generated summary, not
  authoritative session state.
- `source/tools/session-rollover/session-rollover-tool.ts` asks for the goal in an
  8,000-character handoff brief. The brief is written by the model and can be
  omitted or drift; it is not a typed objective attached to the successor session.
- `RestoredState` and the `ReplayState` projection in
  `source/services/conversation/conversation-replay.ts` restore the latest valid
  `goal_changed` event as an optional goal. Legacy logs without that event remain
  goal-less.
- The CLI's positional prompt enters `runNonInteractive()` (`source/cli.tsx`),
  while a launch without a positional prompt enters the interactive app. Both paths
  accept `--goal` and optional `--goal-criteria`, persisting an explicit launch
  goal before the first model request.
- `forkConversation()` in `source/services/conversation/conversation-persistence.ts`
  copies the source log and rewrites `session_init` identity/provenance, so goal
  events in the copied history replay as the fork's initial goal state.
- Subagent task input and oversight are separate concepts: `SubagentStartedLogEvent`
  stores a task string, and `docs/plans/subagent-oversight-goal.md` is a shipped
  feature plan about observability and control. Neither represents the parent
  session's durable objective.

The remaining milestones address model-context placement and lifecycle carry-
forward. Some *summary content* may survive compaction or rollover, but it is not
authoritative goal state. The implementation adds that value without introducing
a new planning or orchestration subsystem.

## Proposed contract

One optional goal belongs to a session. Absence is the default, so legacy sessions
continue to work unchanged. An existing goal is a compact, user-inspectable outcome
record:

```ts
type GoalStatus = 'active' | 'achieved' | 'abandoned';

interface DurableGoal {
  id: string;
  outcome: string;
  successCriteria?: string;
  status: GoalStatus;
}
```

Recommended bounds: `outcome` at most 2,000 characters and optional
`successCriteria` at most 2,000 characters. The record has no free-form metadata
bag. `id` identifies updates within one session and is generated when the user
sets/replaces a goal; it is not a cross-session task identity. The user or
launcher—not the model—is authoritative for durable state. A launch option is an
explicit launcher decision, not authority delegated to a model prompt.

The goal says **what must become true**. It does not contain:

- a plan, ordered steps, checklist, or decomposition;
- a deadline, schedule, retry rule, turn budget, or priority policy;
- a provider/model choice or execution strategy;
- subagent IDs, roles, assignments, topology, or progress;
- an autonomous trigger to continue work, retry, or start another turn.

Success criteria are a short, observable condition that helps determine whether the
outcome holds; they are not a plan. Keeping this schema intentionally small means
the execution system remains free to change its plan without rewriting the goal.

### Ownership and state transitions

The user or launcher is the authority for creating and replacing a durable goal;
the user is the authority for achieving or abandoning it. The interactive user can
use a `/goal` command family (for example, set/show/achieved/abandon). Both
interactive and positional non-interactive starts also accept `--goal <text>` and
optional `--goal-criteria <text>`. These flags are mutually validated and use the
same bounded schema and `goal_changed` event as `/goal set`. Persist the launch
goal after the session writer is initialized and before the first model request;
on resume, an explicit launch goal replaces the restored goal before work begins.
No flag means no change to a resumed goal. `show` is read-only. Model-originated
mutation remains an open decision below, not a current authority.

Allowed lifecycle:

```text
absent --user/launcher set--> active --user marks complete--> achieved
                                  \--user abandons----------> abandoned
active / achieved / abandoned --user/launcher set--> new active goal
```

Terminal statuses remain inspectable. They do not start work or imply that all
related tasks are complete. No automatic status inference or retry loop is added.

### Persistence and replay

Store goal changes in the existing JSONL session event stream as plain events, not
in a sidecar, database, prompt-only cache, or session-init metadata. Prefer one
versioned `goal_changed` event carrying the complete bounded record (or explicit
absence only if a future clear operation is approved). Replaying the latest valid
event produces the current optional goal; malformed/unknown events follow the
existing decoder's tolerant handling and must not invalidate the rest of a session.
Goal-changing events are critical user-authored state: include them in the writer's
fsync classification before reporting success to the command. Keep old event
versions and logs with no such event readable as “no goal.” Do not bump the whole
log-envelope version solely for this additive event.

The decoder, replay projection, and `RestoredState` own the in-memory projection;
the event log remains the source of truth. If status history is useful for audit,
the log already retains every change; the ordinary inspect surface presents only
the latest state. No snapshot schema extension is needed for the first milestone
unless code evidence shows a replay path that bypasses the event stream.

### Lifecycle behavior

- **Turns and resume:** the same active or terminal goal remains attached to the
  session across turns and process restarts. It does not imply automatic
  continuation after an assistant turn settles; the active-goal stop check acts
  only before the current turn settles.
- **Fork:** a fork copies the log and therefore starts with the source's goal state
  as of the fork point. Subsequent goal events in either session are independent;
  changing one must not mutate the other.
- **Rollover:** copy the current goal into the successor as a goal event during
  successor initialization, before its first model request. This transfer is a
  session-lifecycle responsibility, not an instruction to regenerate or infer the
  objective from the free-form rollover brief. Existing rollover provenance via
  `session_init.rolloverFrom` remains unchanged. Define failure behavior so a
  successor is not considered ready to accept work if its goal transfer failed.
  The model-written handoff still carries constraints and working state; the
  compact goal does not replace it.
- **Compaction:** preserve the authoritative goal outside the compacted transcript.
  Keep it out of the compaction summary's authoritative state; the summary may
  mention it as history, but cannot overwrite the replayed value. See prompt-cache
  placement below for its model-input position.
- **Session clear:** retain the goal. Clearing conversation history is not the
  same as abandoning the desired outcome; user intent to stop is expressed with
  the explicit abandon action. This distinction must be visible in command help.
- **Subagents:** do not broadcast the goal to every child automatically. The parent
  may include a read-only goal snapshot when it is relevant to a bounded delegation
  task. A child task remains the execution assignment, can be narrower than the
  session goal, and cannot change the parent's goal.

## Interface and presentation

Use the existing command routing / conversation-service ownership rather than add a
new goal manager. The command owns user intent and event emission; replay owns
rehydration; the existing prompt construction seam owns presentation to the model.
Keep the inspect output bounded and distinguish active from achieved/abandoned.
No new dashboard, goal history browser, or plan editor is needed.

### Launch and control surfaces

The CLI accepts `--goal <text>` and optional `--goal-criteria <text>` for both
startup modes: `term2 "<prompt>"` (the positional prompt selects
`runNonInteractive()` in `source/cli.tsx`) and an interactive launch with no
positional prompt. Both paths persist the same `goal_changed` event before their
first provider request. A resumed session with no explicit goal flags keeps its
replayed goal; explicit flags replace it. Invalid or over-bound flags fail before
the request rather than silently truncating the objective.

For an already-running interactive worker, the TUI control socket plan
(`docs/plans/tui-control-socket.md`, UC1) should expose a read-only `goal` get topic
in its later topic milestone. This is an inspection contract only: do not add
socket mutation or treat the topic as part of the initial socket milestone. The
launching orchestrator can set the goal with launch flags and read it back over
the socket. The socket plan is a separate workstream; this plan only names the
cross-plan contract.

### Prompt-cache placement

`buildPromptSpec()` in `source/prompts/prompt-constructor.ts` returns a base prompt,
ordered profile/mode fragment files, and inline sections; `source/agent.ts` resolves
and concatenates them in that order, then appends environment, project
`AGENTS.md`, and skill-catalog context to the final `instructions` string. The
constructor also deliberately keeps mode workflows out of the instruction prefix,
noting prompt-cache and chained-Responses-Lite sensitivity. The cache-economics research
(`docs/research/model-effort-step-down-cache-economics.md`) documents that changes
near the beginning of a prompt invalidate more cached prefix than changes at its
end; provider cache behavior differs, so do not claim that any provider can retain
bytes after the changed position.

Do not put goal text in the base prompt or profile fragment files. Append one
bounded, serialized goal block at a fixed suffix position in the final
`instructions`, after the current environment, project-instruction, and
skill-catalog sections. Its bytes must depend only on the current goal record—not the
turn number, event sequence, timestamp, or regenerated prose—so the suffix is
byte-identical for every request while the goal is unchanged. A goal change may
change that suffix; it must not reorder or rewrite the stable prefix. Keep compacted
history and ordinary conversation messages in their existing order after the
fixed instructions. Tests must compare final prompt bytes across separate builds/
turns with the same goal and assert equality; changing the goal should change only
the goal suffix. This is a cache-preservation contract, not a guarantee that all
providers cache the same amount.

Render only the current goal and optional success criteria, explicitly labeled as
user/launcher-authored session context—not permission to act, a plan, or an
instruction to keep working. The model may use it to interpret relevant requests
and report progress, but ordinary turn, approval, cancellation, provider-chaining,
and scheduling rules remain in force.

## Milestones

### M1 — Durable record and replay

Define the bounded schema and additive `goal_changed` event; validate it in the
decoder; project latest state through replay and `RestoredState`; classify event
durability. Old logs remain goal-less and readable. No prompt or UI behavior changes
in this milestone.

**Tests:** focused decoder/replay/writer tests for valid state, replacement and
status transitions, malformed event tolerance, fsync failure, old-log compatibility,
forked log replay, and event ordering. Run focused files, then `pnpm test:related`,
`pnpm test:changed`, and `pnpm typecheck` for the source change.

**Preservation:** no existing event meaning changes; legacy sessions project
`goal: undefined`; log-envelope version stays compatible. Touches Contract 08
(`docs/contracts/08-conversation-durability-and-recovery.md`) for additive event
validation, replay, and critical-write durability. Touches Contract 03 only if the
session projection is passed into subagent construction in a later milestone.

### M2 — Launch-time and interactive goal control

Add `--goal <text>` and `--goal-criteria <text>` to the existing CLI argv handling
for both interactive and positional non-interactive starts. After the session log
writer is initialized and before the first request, append the same `goal_changed`
event used by interactive `/goal` set/show/achieved/abandon operations. An explicit
flag on resume replaces the restored goal; omitted flags do not. Validate length
before launch proceeds and surface append failure instead of starting a request
without the requested goal. Keep all goal mutation user/launcher initiated for this
milestone. Provide no-goal inspection and document that `/clear` retains the goal.

**Tests:** argv/help tests for both launch modes and bounds; assert the identical
goal event is durable before the first model request in both modes; verify resume
with absent flags retains the old goal and explicit flags replace it; command tests
for terminal-state inspection, replacement, failure reporting, and no-goal
behavior. Run focused files then `pnpm test:related`, `pnpm test:changed`, and
`pnpm typecheck`.

**Preservation:** no effect on sessions that do not provide goal flags or invoke
`/goal`; parsing does not change the positional-prompt choice or start an extra
model turn. Contract 08 changes for the public mutation boundary and append failure
behavior.

### M3 — Model context and compaction

Surface the restored goal in a small dynamic prompt fragment on each applicable
model request, and ensure compaction cannot replace the authoritative state with
summary prose. Retain the existing compaction summary headings for historical
context, but label the injected goal as current state and untrusted as an authority
for user approval. Do not ask a summarizer to alter status.

**Tests:** prompt-construction tests pin presence/absence, exact bounds, terminal
status, escaping/serialization, and legacy behavior. A cache-specific test builds
the prompt more than once with an unchanged goal and asserts byte-for-byte equality;
with a changed goal it asserts the stable prefix is identical and only the goal
suffix differs. Compaction/replay tests prove a stale summary cannot overwrite the
goal. Run focused prompt and conversation tests, then `pnpm test:related`,
`pnpm test:changed`, and `pnpm typecheck`.

**Preservation:** goal context is additive and bounded; no change to provider input
continuity or compaction retention safety. Stable prompt-prefix bytes do not change
while the goal is unchanged. No provider black-box suite is needed unless
implementation changes provider request/run-loop behavior.

### M4 — Lifecycle carry-forward

Carry the current record through rollover before the successor accepts model input;
verify fork inheritance and independent subsequent mutation. Retain across
`session_cleared`. Pass a goal snapshot to a child only when the parent explicitly
includes it in that child's bounded task; the child remains read-only with respect
to the parent goal.

**Tests:** paired source/successor rollover tests for active and terminal goals,
transfer failure behavior, resume after rollover, fork inheritance and divergence,
clear retention, and subagent non-mutation. Run focused lifecycle/subagent tests,
`pnpm test:related`, `pnpm test:changed`, and `pnpm typecheck`. If run-loop or
provider behavior changes, also run `pnpm test:provider-black-box`.

**Preservation:** preserve the existing rollover briefing/provenance and approval,
cancellation, and child-run semantics. Goal transfer creates no work, retries, or
new child scheduling. Contract 08 changes for cross-session lifecycle persistence;
Contract 03 changes only if the implementation adds the optional read-only child
snapshot to the child-run interface.

## Cross-task contracts

- **T1 event-sourced session + provenance:** this design assumes the session JSONL
  event stream remains the persistence authority. Goal changes are ordinary,
  versioned session events with bounded payloads; no parallel storage or
  provenance subsystem is introduced. T1 must decide/enforce event identity and
  replay rules without moving goal state into a prompt-only projection. If T1's
  event interface differs, retain these semantic properties through its adapter.
- **T2 runtime capability seams:** the durable goal is session data, not an
  execution capability. M1/M2 need only event append and restored-state projection.
  Prompt assembly can read the projection; child execution receives a read-only
  snapshot only when explicitly delegated. T2 should not treat goal presence as
  authorization, scheduling policy, or a reason to retry.
- **TUI control socket:** the later UC1 `get` topic milestone in
  `docs/plans/tui-control-socket.md` should add a read-only `goal` topic returning
  the current bounded goal and status to the same-uid launcher/orchestrator. It is
  a projection, not a second store or mutation path; launch flags remain the
  authority for setting the goal. This plan does not change the socket's milestone
  sequencing.
- **Subagent contract 03:** a goal is not `SubagentStartedLogEvent.task` and does
  not alter child ownership or lifecycle. Any future child-facing goal snapshot is
  contextual/read-only and subordinate to the bounded task. Update the contract
  only if this data actually crosses the child-run seam.
- **Conversation durability Contract 08:** new goal events are validated,
  replay-tolerant, and durably written; old logs without them remain valid. Fork
  copies the event history, rollover emits a successor event, and clear does not
  imply goal abandonment.

## Open decisions

1. **Goal size bounds and optional criteria.** Recommendation: the 2,000-character
   limits above, with a single optional free-text success condition. Revisit only
   if real use demonstrates that a more structured criterion is necessary.
2. **Goal command syntax.** Recommendation: `/goal set`, `/goal show`,
   `/goal achieved`, `/goal abandon`; launchers use `--goal` and optional
   `--goal-criteria` in either CLI mode. Keep model-tool mutation out of M2.
3. **Replacement / clearing behavior.** Recommendation: `set` replaces the current
   goal; no separate clear operation in v1. Retain across `/clear`; use `abandon`
   when the user no longer wants the objective pursued.
4. **Rollover transfer settlement.** Recommendation: make successor goal persistence
   part of successor readiness; on failure, report rollover failure rather than
   silently starting without the objective. Confirm the exact writer/rotation
   transaction seam during implementation.
5. **Child context.** Recommendation: no automatic inheritance. Let the parent
   selectively include a read-only snapshot in the bounded child task when useful;
   measure context cost before adding a separate child prompt channel.
6. **Model-proposed goals and status changes.** Compare:
   (a) **No model mutation**—the model may discuss a goal in ordinary text, but
   only user/launcher interfaces change durable state. This is the smallest and
   clearest authority model, but requires the user to translate a useful proposal
   into `/goal set` or a later launch.
   (b) **`propose_goal` tool with mandatory user approval**—the model can submit a
   bounded proposal, but the approval path must never auto-approve it (including
   auto-approval modes, like the peer-send rule). Only an explicit user approval
   appends the same `goal_changed` event; rejection leaves state unchanged. This
   preserves user authority while making a model suggestion actionable, at the
   cost of a new tool, approval classification, and tests.
   (c) **Model may propose `achieved`, also requiring approval**—this can reduce
   user effort for completion bookkeeping, but adds a second proposed transition
   and risks presenting an uncertain model judgment as an outcome. It must never
   directly change status or be inferred from prose.

   **Recommendation: start with (a) for the first implementation.** Launch-time
   flags and explicit user commands cover orchestrated and interactive ownership
   without introducing an approval surface into core durable state. Revisit (b)
   only with observed need for model-suggested new objectives; if accepted, use a
   dedicated always-confirm approval class, never a generic auto-approvable tool.

   **Implemented (2026-09-29): (b), as `propose_goal`.** Timing is model judgment
   encoded in the tool description (propose only at the transition from discussion
   to implementation, at most once per session); the once-guard combines the
   goal-exists check with a proposal marker seeded from replayed transcript
   history. Approval reuses the existing approval surface and appends the same
   `goal_changed` event as `/goal set`; rejection changes nothing. Option (c)
   remains unimplemented.
   Do not add (c) unless users specifically want completion proposals; explicit
   `/goal achieved` keeps the terminal transition legible and under user control.

## Unverified claims / implementation checks

- This design verified `LogEvent`, `SessionInitEvent`, writer fsync classification,
  decoder validation, replay state, `RestoredState`, `forkConversation()`, current
  compaction prompt, and rollover tool wording by reading source in this worktree.
- The exact command-routing module and its help UX were not traced in this design;
  implementation must identify the existing public command seam before adding
  `/goal` rather than inventing a parallel command router. The CLI's positional
  prompt branch and `runNonInteractive()` entry were verified in `source/cli.tsx`;
  detailed flag parsing and writer readiness ordering still need implementation
  verification.
- The exact rollover successor writer ordering and how initialization failures are
  surfaced must be checked before implementing the proposed transfer invariant.
- `docs/plans/event-sourced-session.md` and
  `docs/plans/runtime-capability-seams.md` were not present in this worktree when
  inspected. Cross-task statements above are semantic assumptions from the shared
  assignment, not verified interfaces; reconcile them against T1/T2 when available.
