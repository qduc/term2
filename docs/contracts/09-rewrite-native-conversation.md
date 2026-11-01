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
   installed. A rejected preparation is disposed.
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
