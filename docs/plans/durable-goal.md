# Durable goal — outcome state separate from plan and execution

Status: **design proposal; no implementation is included in this phase.**

## Resume here

The repository does not yet have a first-class durable session goal. The existing
goal wording appears in compaction instructions and rollover handoffs, and a
completed plan named “Subagent Oversight — Goal” uses goal in its ordinary product
planning sense; neither is session-owned, replayable objective state. Start with
Milestone 1 below. Keep the goal record limited to the desired outcome and how
success is recognized. Do not put a plan, schedule, execution status, or child-run
topology in it. Persistence is plain session-log events; there is no goal-specific
database or autonomous retry behavior.

## Gap measurement

What exists today:

- `source/prompts/context-compaction.ts` asks the summarizer to preserve “Current
  goal and success criteria,” but it is text in a generated summary, not
  authoritative session state.
- `source/tools/session-rollover/session-rollover-tool.ts` asks for the goal in an
  8,000-character handoff brief. The brief is written by the model and can be
  omitted or drift; it is not a typed objective attached to the successor session.
- `RestoredState` and the `ReplayState` projection in
  `source/services/conversation/conversation-replay.ts` restore messages, provider
  history, settings, usage, and session lineage, but have no goal field. Existing
  `session_init` and `LogEvent` in
  `source/services/logging/conversation-log-events.ts` have no goal event.
- `forkConversation()` in `source/services/conversation/conversation-persistence.ts`
  copies the source log and rewrites `session_init` identity/provenance. It would
  naturally copy goal events once they exist, but currently copies no goal state.
- Subagent task input and oversight are separate concepts: `SubagentStartedLogEvent`
  stores a task string, and `docs/plans/subagent-oversight-goal.md` is a shipped
  feature plan about observability and control. Neither represents the parent
  session's durable objective.

Therefore the request is not already met. Some *summary content* may survive
compaction or rollover, but there is no small typed value that can be inspected,
replayed, or carried forward independently of that prose. The plan adds that value
and its lifecycle, not a new planning or orchestration subsystem.

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
sets/replaces a goal; it is not a cross-session task identity.

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

The user is the authority for creating, replacing, achieving, and abandoning a
durable goal. Expose those actions through a user-facing `/goal` command family
(for example, set/show/achieved/abandon). A model tool that can mutate the goal is
not part of this design: the model may report that criteria appear met, but only a
user action changes the durable status. `show` reports current state without
changing it. Setting a new goal explicitly replaces the current one with a new ID.

Allowed lifecycle:

```text
absent --user set--> active --user marks complete--> achieved
                         \--user abandons----------> abandoned
active / achieved / abandoned --user set--> new active goal
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
  continuation after an assistant turn settles.
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
  Add it as a bounded, clearly labeled current-state section in the model input
  after compaction, instead of relying on the summarizer to reproduce it. The
  summary may mention the goal as history, but cannot overwrite the replayed value.
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

For model context, render only the current goal and optional success criteria as a
small prompt fragment, explicitly stating that it is user-authored session context,
not permission to act, a plan, or an instruction to keep working. The model should
use it to interpret relevant requests and report progress, but ordinary turn,
approval, cancellation, provider-chaining, and scheduling rules remain in force.

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

### M2 — Explicit user control and bounded inspection

Add user-only `/goal` set/show/achieved/abandon operations at the existing command
boundary. Validate length and state transition before append; acknowledge the
mutation only after durable append succeeds. Replacing a goal creates a new ID.
Provide an informative no-goal response and document that `/clear` retains the goal.

**Tests:** command tests for parser/help, length bounds, terminal-state inspection,
replacement, failure reporting, and no-goal behavior; persistence assertion that a
successful command survives resume. Run focused files then `pnpm test:related`,
`pnpm test:changed`, and `pnpm typecheck`.

**Preservation:** no effect on sessions that never invoke `/goal`; commands do not
start a model turn or alter tool approval. Contract 08 changes for the public
mutation boundary and append failure behavior.

### M3 — Model context and compaction

Surface the restored goal in a small dynamic prompt fragment on each applicable
model request, and ensure compaction cannot replace the authoritative state with
summary prose. Retain the existing compaction summary headings for historical
context, but label the injected goal as current state and untrusted as an authority
for user approval. Do not ask a summarizer to alter status.

**Tests:** prompt-construction tests pin presence/absence, exact bounds, terminal
status, escaping/serialization, and legacy behavior; compaction/replay tests prove a
stale summary cannot overwrite the goal. Run focused prompt and conversation tests,
then `pnpm test:related`, `pnpm test:changed`, and `pnpm typecheck`.

**Preservation:** goal context is additive and bounded; no change to provider input
continuity or compaction retention safety. No provider black-box suite is needed
unless implementation changes provider request/run-loop behavior.

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
   `/goal achieved`, `/goal abandon`. Keep status changes explicitly user initiated;
   do not add model-tool mutation pending a separate authority decision.
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

## Unverified claims / implementation checks

- This design verified `LogEvent`, `SessionInitEvent`, writer fsync classification,
  decoder validation, replay state, `RestoredState`, `forkConversation()`, current
  compaction prompt, and rollover tool wording by reading source in this worktree.
- The exact command-routing module and its help UX were not traced in this design;
  implementation must identify the existing public command seam before adding
  `/goal` rather than inventing a parallel command router.
- The exact rollover successor writer ordering and how initialization failures are
  surfaced must be checked before implementing the proposed transfer invariant.
- `docs/plans/event-sourced-session.md` and
  `docs/plans/runtime-capability-seams.md` were not present in this worktree when
  inspected. Cross-task statements above are semantic assumptions from the shared
  assignment, not verified interfaces; reconcile them against T1/T2 when available.
