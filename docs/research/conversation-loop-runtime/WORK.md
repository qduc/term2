# Production conversation loop implementation

The loop-centered design is implemented in the production runtime. The central
entry point is `ApplicationRunLoop.#runTurn`: prepare a request, ask the model,
record its response, execute its tools, repeat or finish. This is the shared
runtime used by root and nested callers, not the historical fake v2 actor.

The implementation has three related cuts:

- Model retry, streaming and wire handling stay inside `#askModel`; ordered tool
  settlement stays inside `#executeTools`. Approval and budget decisions reconnect
  event views to the same suspended operation.
- `TurnWorkflow.#runConversationTurn` owns the root operation across manual
  approval and post-execute decisions. `ContinuationState` retains projection,
  accounting and recovery facts while its continuation frame stays alive.
- `ConversationAdapter.#submissions` owns mutable input and its stage. Queue and
  mailbox entries are projections; the UI calls `submitMessage` once. Edits,
  retractions and released-steer fallback retain the original submission identity.

Baseline: `da69cca99efa094d138af6c28517cbbb5d7379ad`. No provider protocol,
prompt, queue capacity, timeout or execution-stop policy was redesigned. Existing
execution/background owners and durable queue projections remain. No release.

## Acceptance evidence

Logs are retained in [evidence](evidence/); independent inspection and exact source
hashes are recorded alongside them. The independent verifier is
`/root/runtime_verify`, separate from the implementer.

| Claim | Evidence |
| --- | --- |
| Production entry point visibly owns the cycle | `ApplicationRunLoop.#runTurn` and independent source inspection |
| Pauses retain the turn; tools settle once | Shared-runtime temporary probe plus real built-CLI journey through two manual approvals and chained tool outputs |
| Input edits/retraction/release/cancellation have one owner | New `scripts/provider-black-box/conversation-loop.blackbox.ts` drives actual PTY keys and inspects loopback HTTP wire requests; edited text appears, original/retracted text does not, released input starts once, cancelled input never starts |
| Existing protocol/recovery behavior remains covered | Full provider black-box suite: 202 passed, 1 skipped; 22 files. New retained CLI scenario passes separately |
| Conversation/persistence/gateway behavior remains covered | Integration suite: 121 passed, 1 skipped; 15 passed files, 1 skipped file |
| Existing end-to-end and fake Codex server workflows remain covered | E2E: 31 passed; Codex network suite: 16 passed |
| Build and repository constraints hold | Build/typecheck pass; lint passes with 31 preexisting warnings; static guards 28 passed; no-unit-tests check passes |

The full provider/e2e/Codex runs precede the final small compatibility edits
(admitted-steer cancellation race, per-decision policy refresh, local type rename
and dead initialization removal). Final-source typecheck, build, static guards,
lint, integration and the independent CLI journey cover those edits. Logs retain
their actual commands and timestamps rather than implying a later full rerun.

Two introduced lifetime defects were found and fixed before integration; their
red/green evidence and sibling audit are described in the
[retrospective](retrospective.md). Historical fake actor traces are not counted as
production evidence. The new permanent test crosses real process, terminal,
HTTP and filesystem boundaries; temporary probes are removed.

## Limits

This verifies the exercised workflows, not every possible schedule or remote
provider outage. Provider tests use local fixture servers, not paid live model
calls. Existing skipped scenarios remain skipped. No human comprehension trial
was performed, and no code-size reduction is claimed: the improvement is the
visible central cycle and removal of duplicated advancement/submission owners.
Execution-registry consolidation and provider-reuse redesign remain separate work.
