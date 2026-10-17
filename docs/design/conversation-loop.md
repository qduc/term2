# Design the architecture around `runTurn`

**Proposed revision, not a production implementation.** This revises the
[ownership-first design](../../experiments/conversation-actor/v2/DESIGN.md) around
the human's model: ask the model; execute requested tools and return their outputs;
repeat; finish when the model has no tools. Start with the
[short explanation](conversation-core.md).

## The design decision

One live async `runTurn` owns advancement through the model–tool cycle. The
conversation owns input admission and the lifetime of that task. Request preparation,
model exchange, tool settlement and finalization hide their own policy and protocol
details behind named operations. They return to the loop whenever another model
round is required. They do not call one another to start model rounds.

This is a different choice from the v2 actor's explicit phase/token dispatch. In
that experiment, a reader must reconstruct the loop from result handlers. Its
race simulations still teach useful ownership rules; its control structure is no
longer the proposed human-facing architecture.

| Alternative | What a caller must understand | Decision |
| --- | --- | --- |
| One async turn with named operations | One active turn handle; the operation being awaited; explicit results and cancellation | Chosen: the source can follow the same order as the explanation. |
| Conversation reducer stores a phase and resumes on each event | Phase transitions, event routing and continuation tokens to reconstruct one model–tool cycle | Retain as experimental evidence; its explicit continuation is useful when a process must durably resume at arbitrary await points, which current restart policy does not promise. |

The earlier async alternative was rejected because it introduced a second owner
beside the conversation's workflow state. This proposal gives that continuation
to the single live function and removes the mirrored phase machine. An async
function alone does not guarantee simplicity; retaining both would defeat the
change.

## Read one turn from top to bottom

The short page's pseudocode is the proposed central order. These are domain
operations, not a requirement to create five services or five wrapper classes.
Keep cohesive code local unless extraction hides a real contract. The central
function owns repetition and terminal choice; operation implementations own how
their individual steps work.

| Operation | Receives / returns | What it hides | What it may not do |
| --- | --- | --- | --- |
| `prepareRequest` | Live turn → frozen logical request | Eligible steer admission, canonical history projection, request budget decision, compaction and prompt/context preparation | Start the model or consume the same submission again on request retry. |
| `askModel` | Turn + logical request → accepted response candidate with ordered calls | Transport serialization/reuse, streaming, request execution ownership, safe attempt retry and accounting | Execute tools, silently restart the turn, or classify incomplete/failed transport as a final answer. |
| `recordResponse` | Candidate → accepted transcript/tool-plan facts | Current-turn authority check and journal acceptance; retain committed partial output on failure | Accept a revoked turn's late output or report a failed write as durable success. |
| `executeTools` | Accepted ordered call plan → settled tool round | Authority-bound approvals, ask-user, safe parallel dispatch, outcome recording, uncertain-effect reconciliation, foreground/background ownership | Ask the model, restart the tool plan after a partial failure, or silently redispatch an ambiguous effect. |
| `finishTurn` | No-tool response → `done` or explicit `continue` | Required post-execution decisions and existing completion policy; final receipt settlement on `done` | Hide another model request, treat a pause as completion, or consume follow-up input as an implicit new turn. |

`continue` at completion is a named exception to the ordinary no-tools/end rule,
needed where production policy deliberately injects more work at completion. A
reviewer must see the decision in the central loop. Budget-driven wrap-up or
other terminal controls may also end a turn without an ordinary final answer;
these exits return through the same terminal owner.

No helper succeeds merely because its underlying promise settled. It validates
its contract: an incomplete model stream is an error; a foreground tool with an
unknown effect waits for reconciliation or returns through explicit interruption;
a foreground execution must meet its required settlement/quiescence contract
before another conflicting operation starts. Cancellation authority is checked
before dispatch and before accepting asynchronous results.

## A worked turn

The user asks “Inspect the config and update the command.”

1. The conversation consumes that submission once and starts `runTurn`.
2. `prepareRequest` builds history; `askModel` streams the response. The accepted
   response contains a read call and an edit call, recorded as the tool plan.
3. `executeTools` records the read result, then waits for permission to edit. The
   UI displays approval. A new steer, “Keep the old flag supported,” remains in
   the inbox, editable while the tool operation waits.
4. Approval resumes the pending edit, with the same call identity. Its result is
   recorded. The tool operation returns to `runTurn`.
5. The loop repeats. `prepareRequest` consumes the steer and includes both tool
   outputs. `askModel` receives that input and returns a final response.
6. With no tools and no further completion intervention, `finishTurn` settles
   the turn. The conversation can start the next eligible follow-up.

If Stop occurs during step 3, the approval wait is interrupted and that call is
recorded as undispatched. If Stop occurs after dispatch, cleanup preserves known
outcomes and marks ambiguous effects honestly. The loop cannot advance again;
queued replacement work remains governed by stop evidence and retained-pause
policy. If an eligible job was already backgrounded, it keeps its execution
identity and can later deliver a notification without reviving this turn.

A steer received during approval reaches the next model request; it does not
retroactively change the already accepted tool arguments. Changing or cancelling
that pending operation requires its explicit control path.

## Three supporting boundaries

**Conversation, outside the loop.** One submission record owns executable payload,
identity, order, delivery target and receipt. The conversation chooses when a turn
may start and owns one active task handle with cancellation authority. It keeps
manual/failure pauses, preflight, edit/retract rules, gateway leases and recovery
policy. UI clients send commands and observe projections. They do not choose a
fallback execution path when steering is released or retracted.

**History and request construction, beside the loop.** The journal and effect
ledger retain accepted facts and call/result debt. Provider input is a projection
with the necessary provenance and complete pairs; an anchor is insufficient as
the sole history source. Provider adapters own model/socket/opaque-state reuse
rules. Compaction happens at a request boundary and must preserve effect knowledge.
Streaming may commit partial output before a terminal response exists; final
`recordResponse` reconciles that response with already committed facts rather than
appending them again. Output consumers cannot decide whether a turn continues.

**Physical executions, below operations.** Requests, tools and child tasks keep
identity and ownership even when the caller stops waiting. A result and stop proof
are distinct. Tool backgrounding transfers ownership of the existing execution
when supported; it cannot relaunch the effect. Normal surviving jobs do not block
foreground admission. Retired work subject to the stop barrier must be proved
stopped before replacement admission. Rollover moves the context destination and
eligible ownership; stale results cannot mutate a successor. Shared execution
mechanics remain usable by nested callers without inheriting a root inbox.

These boundaries need concrete state. The reduction is removing multiple owners
of the same advancement decision, not erasing necessary execution or journal data.

## Where the current implementation maps

Source baseline for this comparison: `1d53249f`. These symbols locate behavior;
they are not a claim that extracting a method completes the migration.

| Current owner | Proposed destination | State or coordination to remove | Guarantee that must survive |
| --- | --- | --- | --- |
| `ApplicationRunLoop.#execute` in `source/services/agent-runtime/application-run-loop.ts` | The recognizable model–tool loop and its deep operations | Request preparation, transport attempts and approval recovery interleaved through the main cycle; no second outer model–tool loop | Streaming/partial commits, completion and budget interventions, ordered tool settlement, nested callers. |
| `TurnWorkflow.executeInitial`, `executeContinuation` and `TurnCoordinator.start`, `continueAfterApproval` | One logical turn task, with approval resuming the pending operation | Root-specific re-entry paths that exist to reconstruct the same waiting turn; independent continuing/running decisions | Same turn identity, budgets and approval authority; post-execute and terminal cleanup semantics. |
| `QueueController`, `ConversationAdapter.#messagesById`, `#pendingSteerIds`, `TurnInputMailbox.admitAtRequestBoundary` | Conversation submission records + `prepareRequest` boundary | Payload transfers, mirrored pending identities and cross-store edit rollback | Submission contract, rich payload, ordering, preflight, receipts, retained pauses, persistence and gateway leases. |
| `ToolCallExecution.plan`, `settle`, `resolveApproval` in `source/services/agent-runtime/tool-call-execution.ts` | Deep implementation of `executeTools` | Root lifecycle decisions surrounding tool-plan continuation; keep the actual ordered plan | Approval identity, partial batches, parallel-safe eligibility, unknown effects and no duplicate dispatch. |
| `ProviderContinuity` and provider adapters | Logical request preparation + transport attempt implementation | Competing resumption flags where they describe one request constraint | Complete-history fallback, call debt, provider/model/socket affinity and opaque provenance. |
| Existing cancellation proof and background owners | Conversation task cancellation + owned execution contracts | Duplicate decisions about logical revocation and same-execution settlement | Actual process/child quiescence, output retrieval, source-specific cleanup and exact-execution transfer. |
| UI orchestrator | Command client and event/snapshot projection | Domain scheduling fallbacks and lifecycle repair in presentation | Visible ordering, approval presentation, errors, queue editing and receipt identity. |

Shared `ApplicationRunLoop` callers include child/subagent paths. Root queue and
session policy cannot be pushed into them while removing root coordination.
Existing policy owners in `services/approval/` and `services/retry/` still own
approval and recovery classification; `runTurn` owns their place in the flow.

## What state remains

| State | One authority | What disappears | Additional cost / local reasoning |
| --- | --- | --- | --- |
| Pending and consumed submissions | Conversation submission records | Duplicate executable/display payload ownership and steer identity stores | Target/receipt/pause data remains; edits and consumption can be reasoned about at one record. |
| Current position in a live turn | The suspended `runTurn` call and the pending operation's owned plan | A parallel generic phase machine and root approval/retry restarts | One live task handle and cancellation identity; readers follow ordinary control flow. |
| Tool plan progress | `executeTools` implementation | Another root copy of next-call/approval position | Pending call identities/results remain essential; tool ordering stays local. |
| Effects still capable of running | Execution ownership | Treating turn completion or rejected promises as proof of stop | Execution result/stop facts and background ownership remain; no new timeout or force-release rule. |
| Accepted history and durability | Existing journal/effect subsystem | Competing lifecycle components repairing the same facts independently | Provider projections and durable-write evidence remain separate from the JS call stack. |

A waiting-state snapshot for the UI is derived from the pending operation. It
must not become a separately mutable authority used to resume the turn. Where a
production adapter requires a resumable handle, keep that handle inside its
operation; do not mirror its program counter in the conversation.

The live async stack is not persisted. Contract 12 already does not restore an
interrupted active provider/tool/approval operation. Retained queued work still
requires explicit resume; interrupted effects retain their existing recovery
semantics. A future requirement to durably resume arbitrary await points would
require revisiting this choice, rather than serializing a promise or inventing a
second continuation store now.

## Ownership invariants and failure cases

These are proposed requirements, not claims enforced by new production code.
Existing v2 evidence applies only to its fake actor and is not proof for the
proposed async implementation.

| Invariant | Enforcing owner in the proposal | Failure if omitted / evidence status |
| --- | --- | --- |
| Only the central loop advances between model rounds | `runTurn` | Hidden request loops recreate distributed control. Proposed; source inspection must establish it after migration. |
| A submission is consumed once at an eligible boundary | Conversation records, admitted by `prepareRequest` | Lost/duplicate input or stale edits. V2 exercises a simplified payload; production Contracts 01 and 12 remain acceptance obligations. |
| Pausing retains the same turn and accounting | The active task + pending operation | Approval/retry restarts reset budgets or duplicate work. Existing production continuation behavior must be preserved in real workflows. |
| Revocation prevents further dispatch and fact acceptance | Turn authority checked by operations and journal acceptance | A late reply can run tools or change the successor. V2 cancellation races establish the rule, not this implementation. |
| Stop evidence is independent of outcome | Execution owner, enforced at replacement admission | Effects can overlap after Stop. V2 demonstrates both arrival orders; real adapter proof remains required. |
| Known pre-revocation outcomes survive settlement | Journal/effect settlement | Cancellation erases knowledge of an already completed effect. V2 has a red/green reproduction; async terminal paths must reuse that knowledge. |
| A tool effect is not repeated by model-request recovery | Tool plan + retry policy | Duplicate writes. Production tool-effect and provider-continuity contracts remain load-bearing. |
| A final answer is accepted only after valid completion | `askModel` validation + explicit `finishTurn` | Empty/incomplete streams become success or pending policy is bypassed. Existing `#execute` rejects empty incomplete streams; retain supported tool-only fixture behavior. |

Concern dispositions:

- **The earlier story obscured the loop — changed design.** Readable async flow
  becomes the entry point; ownership is explained after that flow.
- **An async stack might become a second owner — changed design.** Remove the
  mirrored generic continuation rather than retaining both models.
- **Stop may leave an ignored promise or child running — changed design.** A
  cancelled await can release the logical task while execution ownership retains
  the underlying work and its completion observer. Admission still waits for the
  applicable stop proof; interrupting a wait is not that proof.
- **Moving branches into helpers could merely hide complexity — accepted risk
  with an inspection criterion.** Each operation must own a coherent contract;
  operation code cannot call the model outside `askModel` or start a new turn.
  No plugin/middleware chain, generic transition bus or five-service extraction is
  required. Readability remains unmeasured until the resulting source is read.
- **Simplification could drop production features — accepted migration obligation.**
  Keep existing behavior and owners until each replacement passes the workflows
  below; an illustrative loop is insufficient evidence to delete them.

## Migration and acceptance

First make the current cycle recognizable inside the shared run-loop boundary:
separate request preparation, model exchange and tool settlement while preserving
its current public callers and observable behavior. Avoid adding a new coordinator
around the old one. Extract only enough to make those operations deep and clear;
keep completion interventions explicit in the central flow. This is an internal
control-flow cut, not submission or persistence migration.

Next move root approval/retry re-entry onto one owned logical turn, preserving
all identity, accounting, cancellation and post-execute contracts. Only remove the
old continuation state after a pending operation can resume without it. Then
consolidate submission ownership as a whole, retaining rich payload, preflight,
queue pause/recovery and receipt semantics. Execution-registry consolidation and
provider-reuse changes are separate proofs, not prerequisites for a readable loop.

This revises v2's submission-first priority: the human's clarified goal makes the
recognizable central cycle the first design checkpoint. It does not require
combining these production cuts or rewriting the runtime from scratch.

A production cut must demonstrate the actual workflows it touches: ordinary
multiple-tool turns; streaming and partial failure; repeated approval/ask-user
and post-execute decisions; edit/retract/steer while paused; request retry and
invalid-chain recovery; Stop during each await with late results; safe parallel
batches; foreground/background child ownership; rollover; compaction; retained
queue restart and persistence failure. Use the repository's verification and
provider-testing policies when implementation begins. The v2 fake harness cannot
substitute for these workflows.

The human-readability checkpoint is concrete: open the central function and trace
model → tools → model without following event handlers. For each surrounding
feature, identify its one operation or outer owner and predict the next step in
the worked example. Do not claim a comprehension improvement from shorter code
or a passing fixture suite. Actual reader evidence and production implementation
remain pending.
