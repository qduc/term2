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
