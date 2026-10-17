# Minimal conversation actor experiment

A standalone TypeScript runtime and deterministic simulation, built from a blank
architecture against the supplied brief. It imports no Term2 runtime code, uses
fake providers/tools, and changes no production execution behavior.

The next design iteration is the [human-facing model](../../docs/design/conversation-core.md)
and its [v2 executable challenge](v2/DESIGN.md). The original model and evidence
below are preserved as the first experiment.

Run from the repository root with the repository's installed dependencies:

```sh
pnpm exec tsx experiments/conversation-actor/simulate.ts --all
pnpm exec tsx experiments/conversation-actor/simulate.ts --list
pnpm exec tsx experiments/conversation-actor/simulate.ts cancel-during-approval --trace
pnpm exec tsc -p experiments/conversation-actor/tsconfig.json
pnpm exec tsx experiments/conversation-actor/metrics.ts
```

Every scenario has an independent CLI entry point. A failed assertion exits
nonzero. `--trace` prints the ordered event journal. No credentials, network,
wall-clock delays, or infrastructure are used. The simulation is an explicit
deliverable of this request, not a new permanent unit-test tier for Term2.

Read [the one-page diagram](ARCHITECTURE.md), [comparison and recommendation](COMPARISON.md),
and [retained verification](evidence/verification.md). The independent review is
recorded in [review.md](evidence/review.md).

## Experiment contract

Goal: discover whether a single conversation owner and a resumable workflow can
express the brief's eight capabilities and ten adversarial scenarios with local
control flow. Completion requires runnable TypeScript, independently selectable
scenarios, adversarial event ordering, independent review, a diagram, and an
evidence-based comparison. Each scenario contains outcome assertions; the
simulation additionally checks unique consumption/settlement, event sequencing,
and complete call/result history on every dispatched model request.

Scope: one in-memory conversation, one foreground turn, multiple sequential tools
per response, concurrent background tools, cooperative abort, complete model
responses. A queued message starts automatically when the actor becomes idle.
Accepted submissions are acknowledged and settled through events, rather than
through a second map of pending promises. The public `send` boundary accepts only
external commands; effect completions use a private mailbox entry point.

Authority: local implementation, experiments, review, and repository integration.
No production migration, real providers, UI, external side effects, or performance
claim is authorized by this prototype brief.

Main risks: stale completions, duplicate effects, lost steering at boundaries,
misidentified approvals, background results delivered to retired sessions, aliasing
across ports, and misleading architectural comparisons. The harness observes
dispatches and emitted events through the public actor/port boundaries.

## Design decisions

Chosen design: one `Conversation` owns all lifecycle state; its private workflow
is an explicit continuation consisting of phase, pending calls, and next index.
There is no separate workflow service, scheduler, or actor framework.

Rejected alternative: a mailbox owner feeding an asynchronous generator owned by
a separate workflow object. Callers would have to coordinate generator closure,
approval resumption, and unconsumed steering when cancelling or retrying. That
boundary adds a lifecycle handshake without hiding a requirement in this scope.

| Decision | State/transition removed | Enforced invariant | New state introduced | Local reasoning |
| --- | --- | --- | --- | --- |
| One submission map in insertion order | Separate queue payload, pending promise, and steering stores | Each ID has one authoritative status | Optional target turn on queued submission | Admission, edit, retract, consume, settle are in the actor |
| Explicit workflow continuation | Generator restart and approval rehydration | Phase and operation token must both match | Five phase variants: model, retry, approval, tool, unknown | One switch resumes the stored tool index |
| Monotonic operation identity | Separate session/turn/approval epoch comparisons | Revoked identity cannot match a later operation | One serial counter shared for turns and operations | A single check rejects stale foreground results |
| Actor-owned background registry | Turn cleanup owning surviving jobs | A job completion requires a live registry entry | Job token, origin session, survival policy, abort handle | Rollover deletes session jobs, retains conversation jobs |
| Canonical history plus optional chain hint | Cached chained delta as a second source of history | Retry without anchor has complete local history | One optional response anchor | Fake port receives a complete snapshot on every request |

## Owners and enforcement

| Invariant | Sole owner | Mechanism / executable evidence |
| --- | --- | --- |
| Stable IDs, FIFO, editable/retractable queued payload | `Conversation` | `#submissions`, `#receive`, `retract-and-edit-queued`, `concurrent-arrivals` |
| A submission is consumed and terminally settled at most once | `Conversation` | Status transitions in `#consume` / `#finish`; `Simulation.verify` |
| A steer is consumed at the next eligible model boundary or returned to queue | `Conversation` | `#requestModel` / `#finish`; both steering-boundary scenarios and retry scenario |
| Approval resumes the same continuation; stale decisions have no effect | `Conversation` workflow | `#workflow` checks phase/token; cancellation and order-matrix scenarios |
| Late foreground results cannot mutate a successor | `Conversation` workflow | Monotonic token, clearing `#turn` before abort; late-response and cancelled-tool scenarios |
| Ambiguous tool effects are not automatically replayed | `Conversation` workflow | Unknown phase has no retry transition; `reconcile` records externally established outcome and advances |
| Async completion routing cannot be mutated by a tool port | `Conversation` | Primitive routing policy captured before adapter invocation; both mutable-port scenarios |
| Only eligible jobs outlive rollover | `Conversation` job registry | `#jobs` membership and survival policy; both background-rollover scenarios |
| Consumers do not own execution state | `Conversation` | Cloned events, snapshots, and admitted commands; throwing-observer isolation scenario |

## Recovery and guard contract

Harm prevented: stale continuation revival, unapproved dispatch, and blind replay
of uncertain effects. Scope: this fake runtime only. Class: identity/authority
checks and recovery settlement, with direct evidence (operation token + phase,
or job registry membership), not a timeout or inferred lack of progress.
Enforcement and recovery owner: `Conversation`. No configuration, clamping,
persisted values, automatic retry count, timer, or migration exists here.

Cancellation revokes the active turn, marks a dispatched unfinished tool unknown,
marks later undispatched calls `not-executed`, drops continuity, settles consumed
submissions, returns pending steers, then requests cooperative abort. It does
**not** prove the adapter stopped. A cancellation command names its target turn;
stale cancellation cannot stop a successor. Work already dispatched may finish
outside the actor. Production physical quiescence is a missing guarantee.

A typed transient or invalid-chain provider failure pauses for a token-bound
`retry` command. Both drop the anchor; full canonical history is rebuilt into
the next request. Unclassified/fatal provider failures terminally fail the turn.
An exception from a tool is conservatively unknown, never a provider retry.
`reconcile` takes an externally established outcome, never executes the tool
again, and is rejected outside its exact unknown phase. Unknown background
outcomes become explicit notifications, with no automatic replay.

False-positive boundary: valid slow or silent operations are not cancelled;
there is no elapsed-time signal. Matching operations complete normally; only
non-owning identities are rejected. Events expose tokens, calls, turn/session
identity, failure cause, and truthful settlement. Rollback boundary: delete this
isolated experiment and the ESLint project override; no production guard or
persisted setting changes. This is not a new entry in the production guard ledger.

## Limits and unresolved assumptions

Ports are typed, trusted in-process adapters. Requests/calls are disposable copies;
ports may mutate them. Results must satisfy the TypeScript shapes and be
structured-cloneable. An adapter may ignore abort; this is exercised deliberately.
The actor serializes mailbox arrival order in one JS event loop. It does not
claim a global order for distributed senders.

History and events are retained in memory without caps for this finite simulation.
No crash recovery, persisted receipts, streaming/partial output, transport-level
delta encoding, provider-specific opaque state, compaction, parallel foreground
tools, or foreground-to-background transfer is implemented. Tool effect identity
across new calls/turns needs external idempotency/reconciliation. The experiment
does not change a skill or ship an agent delegation capability; real-provider and
production real-use acceptance remain pending, rather than inferred from fixtures.

The first executable run covered ordinary execution and 14 adversarial cases;
later passes added ordering matrices, fatal failure, mutation regressions, and
request-history checks. This is evidence of a bounded model, not proof that the
actor model is the best production architecture.
