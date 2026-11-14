# Session public interface

Session owns a durable conversation and the Term2 policy around its portable
agent harness. `openConversation` in `conversation.ts` accepts conversation
facts and injected dependencies. Its public `Conversation`, `Turn`, request and
answer contracts live in `types.ts`; durable facts live in `facts.ts`.

The Session reader persists engine events before accepting their tokens. Replay,
queue admission, task/branch IDs, approvals, cancellation and completion delivery
stay Session-owned. `harness.ts` composes Term2 pricing and root-only child tool
policy above the portable package. `tool-context.ts` binds workspace/settings
and task capabilities to a physical execution.

`agent-runtime/` contains the existing Term2 model/agent resolution, permission
scopes and execution budgets consumed by Session and delegation. It does not
implement another turn loop or task lifecycle. `completion-verification/` and
`decision-shadow/` supply application stop/verification policy; `prompts/`
contains host prompt composition and notices. `conversation-message-projection.ts`
keeps host presentation separate from provider history.

These host modules moved from `engine/` in #224 with their behavior unchanged.
`src/engine` is now limited to compatibility surfaces for
`@qduc/agent-core`. Session may depend on engine, model, tools and pure
shared/config modules; it does not import delegation or app.

Cache creation counters survive accepted Usage facts, compaction request records,
replay aggregation and final/legacy JSON projection. Usage facts count all input
(including reads and writes); normalized cost/final records split creation into
`cache_creation_tokens`, with `cache_creation_1h_tokens` its TTL subset. UI input
formatting recombines creation once, while total tokens count each token once.
Old facts without optional creation counters remain readable.

## Background notices across reopen

A background notice (a child's or shell job's completion, a "moved to
background" or stop notice, a check-in, a question, a shell watch firing) is two
facts: `background_notice_enqueued`, then `background_notices_delivered`, which
either owns a silent turn whose input is the notice text or, with `injected`,
puts that text into a running turn at a request boundary (or, on reopen, ahead
of the turn about to start; see below). Replay places the message in history at
that position, like any other input.

**A resumed session replays history as the live session sent it.** Reopen once
rewrote it in three ways (legacy reload parity), each of which changed the
request prefix against the live session's, a prompt-cache miss from the first
changed message on:

- every notice message and `[Mode Notice]` reminder from an earlier process was
  dropped (and with them a finished child's findings);
- a tool call's `rawArguments` were re-serialized as compact JSON;
- a user message's request-notice decoration (`requestNotice` on its
  `turn_started`) applied only to turns of the current process.

None of that remains: `replay-fold.ts` returns items as recorded, and
`conversation-notice.ts` re-applies every recorded decoration. A call logged
without `rawArguments` (older logs) still renders from its parsed input, as
before. Headless to headless, the resumed request's prefix is byte-identical to
the live session's last request, system prompt included. What can still differ:
a resume in the other mode (TUI to headless or back) sends the other mode's
system prompt; a changed model, profile, tool set or settings changes the
request as it would in a live session; compaction and rollover replace history
by design; and a pending notice (below) or recovery notice is new content, not
a difference from the live session.

Replayed notices are not bounded or truncated. Only compaction bounds them: a
session with many background completions carries them on resume exactly as the
live session did (measured at roughly 800 tokens per 2.5 KB result).

What reopen adds, all through the log:

- **Pending notices.** A notice enqueued but not delivered when the process
  died stays pending. The TUI drains it on attach, as a silent turn before the
  user types, which is where the live session would have put it. A headless
  run has no such moment, so the first human turn of a resumed session delivers
  the notices enqueued before the reopen (`journal.reopenedAt`) *ahead of* its
  user message (`ConversationBackground.deliverReopened`, committed before the
  turn's admission, replayed as an `injected` delivery with no open turn). The
  new instruction therefore stays the last thing the model reads, and the
  notice costs no extra request. Notices of the live process are still drained
  after the turn, or injected at a request boundary in an interactive app.
- **Lost background tasks.** `recover()` already closed a task the process lost
  as `interrupted` / `outcome_unobserved`. It now enqueues a completion notice
  (`recoverDirectBackgroundNotices`). For a subagent it says the run was
  interrupted when the session ended, its outcome was not observed, no result is
  available and it should be started again if still needed; it omits the
  completion boilerplate that tells the model to assess an inlined result. A
  lost shell job is reported the same way. A foreground task is its parent's tool
  result and gets no notice, as live.

A log cut between `background_notices_delivered` and its silent `turn_started`
makes replay fail (`background notice delivery has no silent turn`). The two are
one buffer in one write, so only a torn write across lines (power loss, a full
disk) could split them; the writer does not.
