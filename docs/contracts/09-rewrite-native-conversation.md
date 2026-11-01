# Contract 09 — Rewrite native conversation session

Status: **implementation-owned refactor boundary (2026-11-01).**

The rewrite session is a durable, single-writer conversation boundary. Its public
surface is `createConversation` and `openConversation` in
`rewrite/src/session/conversation.ts`; callers do not receive the writer or an
engine acceptance token.

## Ownership

- `conversation-journal.ts` owns facts after they have been accepted: projection
  validation, append-before-publication, recovered command/task materialization,
  and the permanent write-failure latch.
- `conversation-turn.ts` is the sole reader of a foreground engine handle. It
  appends an event before accepting its engine token, appends an answer before
  releasing it, and drains physical cleanup after cancellation or a consumer
  returns early.
- `conversation-generation.ts` owns the live runtime generation, continuity and
  one-shot profile notice. It validates a prepared configuration before durable
  acceptance, installs only after acceptance, and builds read-only input previews.
- `conversation-commands.ts` owns synchronous command reservation, keyed receipts,
  revision checks and history mutation. `conversation-rollover.ts` owns the
  prepare/validate/atomic rotation transaction, including priority handoff seeding.
  Both use foreground admission capabilities, not a writable shared state bag.
- `conversation-background.ts` owns task notices/check-ins, nested branch handles
  and the subagent surface. Each nested root captures its admitting generation;
  a later configuration change cannot replace detached work's runtime.
- `conversation.ts` assembles these owners and owns foreground admission, queue dispatch and completion-boundary release. It must not publish a fact, independently consume an engine
  handle, or install a generation ahead of its durable record.

## Required invariants

1. A projected fact batch is appended before it updates in-memory projections
   or is published to hooks.
2. A failed append latches the Session, cancels live engine/branch work and
   prevents later acceptance.
3. Command IDs are idempotent receipts. A repeated ID can replay its original
   outcome but never repeats model work, a history mutation, or physical
   rollover.
4. Rollover records its rotation, optional priority handoff admission, and
   command completion in one accepted batch before its prepared generation is
   installed. A rejected preparation is disposed. A model-requested rollover is
   consumed by the held root's own reserved command: that command's
   `command_started` receipt does not make its accepted request look foreign to
   the foreground veto, while any other command, running turn or pending
   decision still vetoes.
5. Queue steering remains FIFO and completion is held until the settled root's
   boundary policy has released it. Child/background completion releases its
   parent through the engine boundary, not by bypassing the journal.

## Focused verification boundary

Use an isolated persisted session with a local `ConversationLog` to exercise
queue admission, repeated command receipts, reopen recovery, append failure,
and close cleanup. Typechecking is necessary but does not demonstrate these
durable ordering claims. Provider or actual-CLI checks require the repository's
loopback namespace, explicit resolver mock, and isolated settings.

## Replay ownership

`replay.ts` projects root provider history and validates its lifecycle. The
active-turn owner pairs physical tool occurrences and builds missing-outcome
repairs. `replay-background.ts` retains task/branch streams and immutable physical
request ancestry across transcript replacements and rotations; recursive branch
projection receives the same explicit live/reopen recovery policy as before.
`replay-rotation.ts` validates command-correlated rotations and priority handoffs.
Only the root projector clears provider slots after a validated rotation; queue,
background tasks, costs, goals and notices remain accepted audit state.

## Native completion verification task budgets

`createDirectGoalVerifier` identifies a verification task by logical Session ID
and durable goal ID, not goal generation or workspace revision. The first accepted
`completion_verification_started` fact pins the existing three native count
limits. App assembly reads `agent.verificationMaxRepairs` for that new task (0–10,
default 3); the gate and verification ceilings remain 4 each. Larger repair
settings are upper bounds, not a promise to bypass those ceilings.

Replay treats started facts without `limits` as the historical 3/4/4 budget.
Later attempts must retain the first task pin, including across restart, setting
changes, goal reopening with the same ID, and runtime reconfiguration. A fresh
goal ID creates a new task. Generation remains a stale-callback fence, not a
budget reset. No verification database or migration is involved in this native
path; the source completion boundary retains its separate persisted-record owner.

Only an accepted FAIL can admit a repair, and only while the accepted repair
count is below the pinned maximum. Exhaustion returns the existing typed blocked
completion result; it neither achieves the goal nor deletes partial work,
context, reports or facts. PASS, inconclusive/error and cancellation keep their
existing settlement paths. An unfinished attempt is not redispatched on reopen.
Recovery uses existing explicit goal/recovery actions, not a setting increase on
the same task. Rolling back this wiring loses custom-budget enforcement on older
binaries; it does not remove accepted work.

The defect was possible because app assembly omitted the already-declared limit
capability while the native attempt projection retained counts but no budget.
Keeping the pin in the existing validated started fact prevents live settings
from silently rewriting a task's policy and makes conflicting replay pins fail
at the same append-before-publication boundary as other context transitions.

## Human receipt timing

`direct-time-gap.ts` derives model-only timing from accepted queue `receivedAt`
and structured human origin at `turn_started` and `queue_steered`. One pure
projection serves live input and replay. The context clock retains the latest
arrival (not dispatch time), so priority steers cannot move it backwards.
Automatic, reaction, control, retry, maintenance and silent input do not advance
it. A start without queue receipt evidence is unknown; no timestamp is guessed.
Missing human receipt metadata resets a known baseline to unknown, so a gap
is never asserted across that unknown arrival; later valid human input can
reestablish the clock. Automatic memory notices are not human admissions. A noncanonical receipt timestamp poisons timing rather than
inventing a gap; the poisoned clock remains across provider-context rotation.
New submissions always stamp the receipt at acceptance; the optional persisted
field is clock metadata, never queue identity or execution authority.

Physical rotation already replays the complete native predecessor lineage, so
there is no separate human-clock checkpoint. Legacy optional-checkpoint fixture
mutations do not describe native storage. Native missing/invalid-receipt
companions exercise disposable real CLI logs instead.

Timing belongs to its user Item as model-only metadata, not an independent
provider-history Item. Provider serialization expands the system notice directly
before the unchanged human content. This prevents rewind, retry and compaction
from orphaning a standalone timing notice when its user input is removed. Raw
`turn_started.input`, queue bodies, and transcript observations stay unchanged.
The native and adopted model serializers share the expansion function.
