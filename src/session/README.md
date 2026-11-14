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
puts that text into a running turn at a request boundary. Replay places the
message in history at that position, like any other input.

A resumed session replays them unchanged. Reopen once dropped every notice
message and every `[Mode Notice]` reminder an earlier process wrote (a legacy
reload rule), which hid a finished child's findings from the model and changed
the request prefix against the live session's, a prompt-cache miss. Only a tool
call's arguments are still re-serialized as compact JSON for items older than
`openedAt` (`resumedItem` in `replay-fold.ts`); that is separate and unchanged.

What reopen adds, all through the log:

- **Pending notices.** A notice enqueued but not delivered when the process
  died stays pending. The TUI drains it on attach, as a silent turn before the
  user types, which is where the live session would have put it. A headless
  run has no such moment, so `ConversationBackground.inject` also hands the
  first turn of a resumed session the notices enqueued before the reopen
  (`journal.reopenedAt`); they follow that turn's user message and cost no
  extra request. Notices of the live process are still drained after the turn.
- **Lost background tasks.** `recover()` already closed a task the process lost
  as `interrupted` / `outcome_unobserved`. It now enqueues the same completion
  notice a live finish would (`recoverDirectBackgroundNotices`), so the model
  is told the run's outcome was not observed; no result is invented. A
  foreground task is its parent's tool result and gets no notice, as live.
