# Independent review and verification

Date: 2026-10-17. Reviewer did not implement the actor. Inputs were the original
engineering brief, current actor and harness, repository verification policy, and
Contracts 01 (submission lifecycle) and 02 (provider continuity/effect settlement).
No architecture recommendation or implementer conclusion was supplied.

**Verdict: accept the standalone experiment after one repair; production equivalence
is not established.** No remaining demonstrated blocker in the scoped fake-port,
in-memory workflow. This verdict does not endorse replacing the Term2 runtime.

## Finding and repair

Initial verdict was reject: the disposable `Call` object passed to `ports.tool`
also controlled the actor's later completion routing in `#runTool`. A supported,
mutable port argument therefore remained an owner of actor lifecycle state.

Exact asynchronous reproductions through `Simulation`:

1. Submit a turn; reply with one conversation-background call; finish its originating
   turn; delete `s.tools[0].call.background`; resolve its known outcome. The actor
   emits stale `tool-result`, retains one job, and emits no `job-completed`.
2. Submit a turn; reply with one foreground call; set
   `s.tools[0].call.background = 'conversation'`; resolve known outcome. The actor
   emits stale `job-result`; the turn remains in `tool` and submission remains
   `consumed` indefinitely.

These violate the brief's ownership and background notification guarantees, and
the settlement intent of C1.3. They are reachable without invalid model or tool
output and were absent from the original 15 green scenarios.

The implementer captured `background` as an actor-owned primitive before handing
the disposable call to the port, then used that value for registration, completion
routing, and workflow advancement. No new lifecycle state was introduced. Reviewer
reran the same mutations with success expectations: background job count becomes
zero with one completion; foreground proceeds to the next model request with no
stale completion. Named regression scenarios were also added to the deliverable.

## Executed evidence

Working directory: `/home/qduc/term2/.worktrees/conversation-actor`.

- `pnpm exec tsx experiments/conversation-actor/simulate.ts --all`: initial 15/15;
  final 20/20, including both port mutation scenarios, both approval/cancellation
  orders, both background completion/rollover orders, and fatal provider failure.
- `pnpm exec tsx experiments/conversation-actor/.review-probes.ts`: independent
  temporary script, subsequently deleted. Initial run reproduced both ownership
  hangs. Final run passed both repaired cases and the checks below.
- Independent late foreground result check: cancel after dispatch, start successor,
  resolve old tool; history stays byte-equivalent, old signal is aborted, successor
  stays active, and completes normally.
- Independent background lifetime check: cancel originating turn, perform two
  rollovers, resolve both session and conversation jobs. Session signal is aborted
  and its completion discarded; conversation job stays live, completes exactly once
  in session 3, and is removed from the job map.
- Independent port call identity mutation: changing tool-owned `id` and `name`
  cannot change the authoritative history's matching call/result identity.
- Independent full-history checks over all final scenarios: **46 dispatched model
  requests** have ordered matching tool results, no unpaid call debt at dispatch,
  and no user/notification item interleaving an unpaid tool batch. All scenarios end
  without an active turn. The final harness now checks complete pairing and user
  adjacency itself; the independent probe additionally checked result ordering,
  notification adjacency and absence of an active turn after each scenario.
- `pnpm exec tsc -p experiments/conversation-actor/tsconfig.json`: exit 0.
- `pnpm exec prettier --check experiments/conversation-actor/actor.ts experiments/conversation-actor/simulate.ts`:
  exit 0. Repository-wide lint/typecheck evidence is owned by the implementer;
  these focused checks are not a substitute for those checks.

Final reviewed SHA-256:

```text
60fe77233628f27456534fba8395ccf3f670a5df55e9de12a787a1b9520f7cb7  actor.ts
d0fc9b3d41c3b3f315c820b8eabd3fe606015e7f2e499ada2a57c77620c14796  simulate.ts
```

## Ownership, complexity, and contract limits

The mailbox serializes admission and transitions. Phase tokens reject late model,
tool, approval, retry, and reconciliation messages; background jobs have independent
tokens and explicit session/conversation lifetime. Observers receive copies and
cannot throw through settlement. These are necessary demonstrated mechanisms,
not evidence of needless framework machinery. The repaired call boundary was the
one concrete shared-mutation violation found. No second service or generic workflow
engine is needed to repair it.

The experiment demonstrates C1 identity/edit/retract/steer/settlement intent using
events, not Term2's caller promises or UI projections. C2 call/result ordering,
unknown-versus-never-dispatched outcomes, and self-contained retry history have
fake-port evidence. The input always contains full local history even with an
anchor: a real provider's delta serialization and transport rules remain untested.
Opaque state, compaction, provider switches, and partial streaming do not exist here.

Unknown-outcome protection is scoped to an existing execution. A separate probe
cancelled a dispatched `write`, started another turn, and returned the same call ID:
the port ran twice with execution IDs `1/write` and `4/write`. This is not a replay
of the same actor execution; it demonstrates that semantic duplicate side-effect
prevention across turns is not supplied. The prototype should not be described as
exactly-once execution or proof of complete C2.5 safety for arbitrary regenerated
model calls. The model has no tool arguments or external idempotency protocol.

No process crash/resume durability, persisted settlement, memory retention policy,
real provider behavior, real irreversible effects, terminal UI, or production
integration was verified. Those are deliberate prototype omissions, not newly found
implementation defects. Unbounded event/history/submission retention is reasonable
for this bounded simulation and does not establish long-lived production suitability.

## Final documentation inspection

Reviewed the final README, architecture diagram, comparison and verification
narrative after their creation. Reran the current 20 scenarios after generic
pairing checks were added: 20/20 pass. Actor hash is unchanged; the harness hash
above records that final revision.

No documentation blocker found. The comparison explicitly calls its 11-file
production basket non-equivalent in scope, declines percentage-reduction/parity
claims, distinguishes distributed responsibility from duplicated field ownership,
and acknowledges production's physical cancellation proof as earned complexity.
The diagram matches the runtime's mailbox, stored continuation, independent job
registry and observer boundaries. The adapt recommendation is limited to ownership
principles and proposes production validation as future work. This is a fair bounded
interpretation of the observed experiment, not evidence for a production rewrite.

The implementer's final root check logs and exact metric outputs were still being
generated during this inspection; this report does not independently certify those
outputs or production behavior. The documentation's links to those retained outputs
must resolve when the deliverable is finalized.
