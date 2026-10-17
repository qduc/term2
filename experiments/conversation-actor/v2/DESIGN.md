# Toward a human-sized Term2 execution design

The user clarified the goal: find a design that simplifies Term2 enough to fit a
human's mental model. A passing toy actor is evidence toward that goal, not the
goal itself. This iteration produces a [short teaching model](../../../docs/design/conversation-core.md),
a production ownership/deletion map, and a stricter executable experiment.

## Contract for this iteration

- A reader can locate submission, continuation, execution lifetime and durable
  history ownership using the short model alone. Check with an independent fresh
  reader answering concrete scenarios; this is a teachability proxy, not a human
  usability study.
- Compare genuinely different owners of control flow and explain the choice.
- Every proposed production deletion names the responsibility it must preserve.
  Distinguish implemented evidence from proposed invariants.
- Demonstrate that cancellation can reject stale results **and** prevent new
  foreground work from overlapping retired work without another controller.
  Outcome receipt and stop evidence must be controlled independently.
- Preserve the first experiment and its evidence unchanged. No production runtime
  migration, settings, journal format, or provider behavior changes in this iteration.

## Alternatives

| Design | Control-flow owner | What a caller must know | Trade-off |
| --- | --- | --- | --- |
| Conversation owns a stored continuation | One serialized decision loop; execution ports report facts | Commands, receipts, snapshots; executions report result and stop evidence | Waiting states are explicit data; ownership is local, but the decision loop must stay about lifecycle rather than absorb transport/policy implementation |
| A long-lived async turn function owns control flow | `await model`, `await tools`, and suspension handles inside the task | The task's input inbox, cancellation/join contract, and where a continuation can be replaced | Ordinary execution reads naturally, but mailbox edits, pending approvals, generator exit, background transfer and cancellation proof need coordination with the conversation owner |
| Keep the production ownership boundaries, consolidate only forwarders | Queue, coordinator, workflow and run loop retain their current decisions | Existing queue/status/continuation/segment rules | Lower migration risk, but removing forwarding methods alone leaves the mental model substantially unchanged |

**Candidate:** conversation-owned continuation plus owned executions. This is a
hypothesis about control ownership, not a commitment to a class named Actor or to
a framework. The alternative async workflow remains reasonable for the execution
driver; it should not independently decide conversation submission or turn fate.
The candidate is preferred because cancellation and steering resolve at one owner,
while the required physical-stop obligation stays explicit.

## What the second executable model establishes

`actor.ts` evolves the first model; `simulate.ts` retains its 20 scenarios and adds
five lifetime scenarios and one review regression. It is deliberately versioned beside the original so that
the first evidence is still reproducible. Run from the repository root:

```sh
pnpm exec tsx experiments/conversation-actor/v2/simulate.ts --all
pnpm exec tsx experiments/conversation-actor/v2/simulate.ts --list
pnpm exec tsx experiments/conversation-actor/v2/simulate.ts cancel-waits-for-stop-evidence --trace
pnpm exec tsc -p experiments/conversation-actor/v2/tsconfig.json
```

The port contract now reports separate `result`, `stopped`, and `stop-unproven`
facts. All model, foreground-tool, and background executions share one registry.
The turn continuation references an execution token; it does not own another
abort controller. Foreground continuation requires both result and stop evidence.
A revoked execution needs only stop evidence to release the replacement barrier;
its late result cannot enter history. A session job retired by rollover also
requires stop evidence. Conversation-scoped jobs remain eligible to notify.

This replaces the first model's separate background map and phase-owned foreground
handles. It adds necessary knowledge—whether work is actually stopped—without a
second state machine, cancellation epoch, cancellation-proof promise map, or
cross-service settlement command. The registry and continuation describe different
facts: actual work lifetime versus the decision currently awaited.

The fake ports normally report outcome followed by stopped, but tests can disable
that behavior. The added scenarios distinguish:

- result/transport rejection without stop proof: replacement stays queued and can
  still be edited;
- result before stop: no next foreground tool starts;
- stop before result: a live turn still waits for its outcome;
- cancellation after stop but before result: replacement proceeds, old output is ignored;
- known tool result before cancellation: the result remains in repaired history,
  while replacement still waits for stop proof;
- two rollovers with retired foreground/session work and a surviving job: the
  survivor notifies the successor but cannot release another execution's barrier.

**Important limit:** `stopped` is trusted adapter evidence in this model. No real
process, server, or descendant is proved stopped. Production adapters must supply
the applicable proof; a rejected HTTP/tool promise is not that proof. The model
tests admission decisions, not the quality of a real adapter's evidence.

## Production ownership and deletion map

This is a proposed final allocation, not an instruction to delete all the named
files now. Source baseline: `5e2fe139`. Greppable owners below establish the
current behavior; historical unit-test citations in contracts are not current evidence.

| Current responsibility and owner | Proposed owner | State/coordination to remove | What must survive before removal |
| --- | --- | --- | --- |
| `QueueController` queue items; `ConversationAdapter.#messagesById`, `#pendingSteerIds`; `TurnInputMailbox.#pending`; orchestrator's pending presentation | Conversation's submission records; UI derives a view | Routing a submission between several payload/status stores; second steer identity set; edit rollback between executable and display copies | Stable identity, rich executable payload, steer/follow-up ordering, all receipt settlements, capacity/preflight, manual/failure pauses, crash recovery, edit authority |
| `TurnStatusMachine` lease; `TurnCoordinator` admission/continuation; `TurnWorkflow` initial/continuation state; run-loop turn/segment openness | Conversation's single turn continuation | Independent running/continuing/awaiting/turn-open decisions; continuation restarts solely to carry status | Approval and ask-user authority, repeated/post-execute pauses, retry budgets, partial-output settlement, stream completion and stale-result fencing |
| Adapter cancellation epoch/proof/active IDs; coordinator abort fanout; workflow `LiveRun` completion; foreground and background controllers | Execution records owned by the conversation, with narrow driver ports | Several components independently tracking the same cancellation decision; separate root background lifetime bookkeeping where execution contracts really align | Real process/group quiescence, owned child lifetimes, retained-work pause policy, source-specific output/cleanup/retrieval, exact-execution background transfer |
| Tool ledger + conversation state projector + stream processor finalization | Existing journal/effect subsystem, behind one fact-acceptance boundary | Direct lifecycle owners independently repairing provider-facing history | Pair/debt reconciliation, committed partial output, unknown vs undispatched effects, deterministic replay, persistence failure semantics |
| `ProviderContinuity`, input planner and provider-private anchors | History supplies complete input/provenance; adapter owns actual wire reuse | Application treating logical response anchors as proof of transport reuse; multiple resumption flags representing one request constraint | Provider/model/socket affinity, opaque lane/origin, compaction coverage, safe unchained full history, provider-state recovery after committed output |
| `ConversationOrchestrator` admission/routing choices plus UI projection | Conversation decides; UI orchestrator remains a projection/client | UI deciding fallback from released/retracted steering or repairing domain settlement | Existing visible ordering, queue editing, receipt IDs, error and approval presentation |

The shared `ApplicationRunLoop` also serves nested/mentor callers directly. It
cannot simply be deleted when simplifying the root conversation. Shared provider,
tool and streaming execution remains a deep driver boundary; root submission and
turn policy must not leak back into it. Child conversations/tasks keep scoped
ownership and child approval identities rather than a root singleton continuation.

## Invariants and evidence

| Invariant | Sole decision owner | Evidence / remaining assumption |
| --- | --- | --- |
| Accepted input has one mutable lifecycle record | Conversation | Implemented in v1/v2 submission map; production rich payload/persistence migration not implemented |
| Exactly one continuation can advance a foreground turn | Conversation | `#workflow` phase/token check and all original adversarial scenarios; production streaming/compaction remains pending |
| An outcome cannot be mistaken for physical stop proof | Execution registry | Separate `Fact` variants, `#acceptFact`, `#advanceExecution`, added ordering scenarios |
| Revoked foreground/session work blocks replacement until stopped | Conversation admission | `#retired`, `#startQueued`, cancellation/rollover scenarios; real adapter evidence remains assumed |
| Surviving jobs keep execution identity across context change | Execution registry | Two-rollover scenario and original rollover scenarios; actual transfer remains unimplemented |
| Provider input is reconstructed from accepted facts, not a transport cache | Journal/projection | Fake complete-pair request checks; production serializer/opaque/partial-stream proof remains pending |
| Durable success requires persistence evidence | Journal | Production Contract 12 requires surfacing write failure; this prototype has no persistence and proves nothing about durability |

For the execution-registry choice: it removes split foreground/background handles;
the one-owner invariant removes cross-owner cancellation settlement; new data is
result knowledge plus stopped evidence; callers need only the execution contract,
not the conversation's phase graph. For submission consolidation: it removes
payload/display/steering routing state; stable records remove edit rollback races;
production will still need retained-pause and durability data; clients know identity
and receipt semantics rather than queue internals. For journal/provider separation:
it removes competing continuation authority; complete history removes dependence
on a live cache; provenance and reuse constraints remain necessary data; the core
does not need wire protocols. Each choice therefore has a complexity cost, not
just a new name.

## What is essential; what may be accidental

Essential: submission identity/order/settlement; authority-bound continuations;
physical execution ownership; uncertain-effect reconciliation; fact durability;
provider provenance and call debt; explicit surviving-task ownership.

Candidate accidental complexity: copying these decisions into queue, adapter,
coordinator, workflow, segment, and UI state; loss of outcome detail across boolean
steer APIs; cancellation fanout that has to synchronize several authorities.
Forwarding, interface count and file count alone are not evidence of accidental
complexity. Specialized approval, retry, transport, tool and persistence modules
should remain deep modules where they hide real policy.

## Migration order and stop conditions

1. **First production cut: submission ownership.** Move whole submission ownership
   behind the existing conversation public boundary. Preserve receipt/promise APIs
   as adapters over that owner. Make the shared engine request pending input at a
   boundary instead of keeping its own root submission store. Prove actual delivery
   of edited rich payloads and retraction, not merely rendered queue state. Retain
   the current queue owner until the replacement covers preflight, retained pause,
   restart recovery and gateway leases. There must be one authoritative owner at
   every intermediate point; no dual-write compatibility period.
2. **Then unify turn decisions.** Replace status/coordinator continuation handshakes
   only after provider black-box journeys cover ordinary, repeated approval,
   committed partial-output recovery, compaction, retry, and interruption gaps.
   Keep the execution driver and effect ledger intact while moving authority.
3. **Then consider execution-registry consolidation.** Adapt real shell and child
   drivers with stop evidence and exact-execution ownership transfer. Keep existing
   registries if their cleanup, authority or retrieval contracts do not fit. A
   generic registry is not valuable if it hides those differences in flags.
4. **Provider reuse ownership is a separate proof obligation.** Do not combine its
   migration with root lifecycle removal. Exercise socket reconnect, model switch,
   foreign opaque compaction, and full-history fallback using real serialization.

Stop or revise a cut if it leaves clients knowing more lifecycle detail, replaces
deleted state with equally complex compatibility flags, adds two authorities, or
cannot preserve a production guarantee. Do not migrate journals or introduce an
actor framework as a prerequisite. This iteration does not authorize or claim
that the production cuts are complete.

## Guard contract for the executable model

Harm: overlapping replacement foreground effects after cancellation. Class:
admission boundary. Scope: v2 fake runtime only. Enforcement/recovery owner:
Conversation execution registry. Signal: execution-scoped `stopped` evidence;
direct and identity-bound, never elapsed time or an outcome/exception proxy.
Action: retain queued input while accepting edits/retractions; no new dispatch
until relevant retired work is stopped. Legitimately slow work remains owned,
not killed. A hung execution deliberately holds admission; no timeout fabricates
proof. Normal background work does not block the foreground. A retired session
job does, until stopped. Partial settlement: turn receipts can be cancelled,
known pre-revocation outcomes are retained; unknown/not-executed tool history is repaired, execution evidence remains visible.
Retries do not replay uncertain tools. Observability: execution IDs, result and
stop facts, unproven-stop reason, release, and session/turn identity. No settings,
clamps, persisted migration or production guard changes; rollback is removing
v2 and its lint override. Production policy stays governed by the existing guard
ledger, especially “Interactive foreground cancellation proof settlement.”

## Remaining evidence needed

The first prototype omitted stop proof; v2 demonstrates how to represent it
locally. It still omits manual/failure queue pause, preflight, rich gateway leases,
restart persistence, real tool argument/effect identity, actual background transfer,
streaming/partial output, compaction, and real provider continuity. No architecture
parity, human comprehension improvement, or production adoption is claimed.

The recommendation is to pursue this ownership model with the first bounded
production cut, contingent on preserving the named contracts. The human-facing
short model is a candidate for feedback, not evidence that a human already found
it understandable. Independent reader/reviewer results and exact run evidence are
retained in `evidence/`.
