# Direct public mapping and remaining producer contracts

Scope: direct `direct-wire.ts`, `DirectProjection`, `reduceWireEvent` and
`host/in-process-direct*`. The old unprefixed protocol/index exports still serve
the isolated bridge. This document describes implementation, not runtime acceptance.
Tests, probes, typechecks, guards, builds, independent reviews and cold reads are deferred
until after M6 by explicit user instruction.

## Accepted data, snapshots and reconnect

`DirectProjection` translates accepted Session facts; it does not accept effects.
`DirectAttachment` obtains `captureFrom(0)` once, reconstructs the accepted public
prefix, then synchronizes the captured current state before exposing snapshot/live.
Thus mixed chronology and draft/final correlation come from actual accepted fact
order, not an interleave guessed from current message/tool arrays. Tagged draft IDs
come from Session's `directDraftId`; untagged M1 identity remains distinct.

`directReplayView` also captures the accepted prefix at zero, folds it for context,
but sends only events with seq greater than the requested cursor. This intentionally
spends O(log length) local projection work rather than adding another durable read
model or pretending a tail queue edit contains its original admission. It then sends
an authoritative **post-tail** state synchronization and live updates. Connection
snapshot is null. A current snapshot is NEVER sent before old facts. Lost transient
progress is not replayable; the final synchronization replaces retained transient
state with what the actual Session currently knows. Real publication positions stay
private. Runtime-only poisoned-writer errors have null-seq error/semantic-terminal
frames, never invented accepted terminal facts.

The current native `DirectSessionState.timeline` is authoritative for message/tool
snapshot order; reasoning/task entries retain their own public presentation scopes.
A full-prefix projection still initializes an empty timeline and derives exact
message turn/step and draft aliases from accepted facts. Completed messages replace their exact draft slot. A model
call creates a called tool display, not proof its physical body started. Tool audit
and provider-result facts may each upsert the SAME occurrence; clients must use
execution ID, not add a duplicate transcript item per finish frame. Unmatched
terminal output is retained in unmatchedToolResults plus a presentation notice;
no tool name, call input or occurrence is invented. When accepted call metadata is
known, each tool_finished also carries toolName/input/callId/parentExecutionId so
a reconnect after its call frame does not need to guess them. Opaque provider items are not
public transcript messages. Known text/image tool-result parts are normalized.

### Result-only accepted order

Both `reduceDirectFact` and `reduceWireEvent` must retain the first accepted
message/tool display slot across native snapshot synchronization. For tools that
slot comes from the first call, start **or result**, keyed by the actual execution
ID. Later finish/provider-result upserts must not move it after newer messages.
A result-only slot resolves against `unmatchedToolResults`; it does not establish
a tool name, input, provider call ID, physical start or timestamp. The accepted
prefix is still required to recover result content: a timeline reference alone
cannot reconstruct output absent from native tool descriptors. ACP replay uses
this slot for unnamed output; browser hydration must accept the real unmatched
result as reference evidence, without manufacturing a named tool display.

This matters at both reducer boundaries: preserving unmatched output in the
public fold alone is insufficient if native synchronization then replaces its
timeline with call/start-only slots. No new event, sequence or journal is needed.

## Facts currently produced by the M2 Session

| Native fact/update | Public frame |
| --- | --- |
| session_started | configuration |
| turn_started | ONE turn_started, including optional admission and all input messages |
| text_delta | text_delta with exact draft ID and numeric model step |
| item user/assistant | message; completed assistant replaces its own draft |
| item reasoning | reasoning with accepted summary/message ID and optional model step |
| item tool_call | tool_called, keyed by execution occurrence |
| tool_started | tool_started: physical-start fact, not argument streaming |
| tool_finished / item tool_result | tool_finished upsert, rich accepted display/content where available |
| interaction_opened / interaction_closed | interaction_opened / interaction_resolved |
| usage | usage (root accepted token delta, not fabricated cost) |
| turn_ended | turn_ended, preserving supplied outcome/error/cause/notice and nullable correlated finalText; retained turnResults |
| budget_opened / budget_closed / budget_observed | one matching typed budget frame per accepted fact; no tool interaction or settled cost invented |
| history_replaced | public reason only, no private provider history |
| model_response_completed | actual response modelStep/stopReason and optional supplied costUsd, not aggregate pricing |
| request_cost_recorded | one request_cost_recorded event with actual turn/root/parent ownership and full settled ModelRequestCost record |
| branch_started / branch_event | one subagent wrapper with real task/branch identity and a scoped child event; child seq null, outer seq authoritative |
| transient reasoning_delta | reasoning_delta; unknown step/message identity stays null |
| transient tool_progress | tool_progress |
| transient tool_call_streaming_delta | live-only actual turn/step/count/source scope; branch wrapper uses native ancestry, all seq null |
| live state | snapshot; real runtimeError additionally settles event-driven clients with null seq |

Stop-after-resolution is forwarded unchanged to the exact Session answer. It is
NOT cancel: selected allow still settles its approved body/result, selected deny
settles rejection, and an empty question answer keeps the source no-answer result;
engine suppresses later work. Protocol does not reinterpret these as cancellation.

## Native M4 vocabulary and public mapping

The imported unions are the actual helpers, not a parallel Session API:
`direct-background-types.ts`, `direct-queue-types.ts`, `direct-context.ts`.
`DirectProtocolUpdate` now aliases the published authoritative Session update
union. Native Session integration is published through bbff1582/83f61600; this
protocol maps that source-backed contract. Combined execution remains unverified.

- Task start/background/stop/finish -> one task_changed per fact, with native
  `change: task_started|task_backgrounded|task_stop_requested|task_finished` and
  numeric `at` copied from descriptor.startedAt or the corresponding fact.at.
  Envelope occurredAt remains the original accepted FactLine timestamp, not a
  generated task time. Task progress -> transient task_progress. Task kind, ID,
  parent turn/execution, origin, source call ID, mode and actual timestamps survive.
  Cancelling is not completed; child turn_ended is not task_finished.
  Known shell output / nested assistant text is public; arbitrary result objects
  and nested provider items are not. Real branch observations use the scoped
  subagent wrapper, not root tool/usage arrays.
- Task interaction open/close -> one interaction frame with accepted task owner.
  Open carries interaction.taskOwner; close carries payload.taskOwner. This public
  descriptor slice contains id, parent turn as turnId, sessionId and actual optional
  parentExecutionId/sourceCallId/origin/kind/name/role. It is taken from the accepted
  prefix when replaying, not a latest-live snapshot or client event cache. The outer
  turnId is the task parent; the open request retains its actual child turnId.
  Snapshot task questions carry the same owner slice. Root turn completion does
  not delete task questions; background questions do not mark root foreground
  awaiting_interaction. Exact request IDs remain answerable
  through Session, independent of the parent Turn. Session must actually route
  answers this way; protocol cannot resurrect a parent continuation.
- Each queue fact -> ONE queue_changed with `change` retaining the exact native
  type and public body: submitted record, edited content, retracted ID, discarded
  IDs, started ID/turn, steered IDs/turn, cancelling turn/cancelled+retained IDs,
  settled turn/outcome/optional preservePendingSteers, resumed or recovered.
  Full public pending entries/state, pause reason, retained submission records,
  optional admission and optional batch of steered user messages remain alongside
  the boundary. Aggregate cancelled/discarded IDs are not per-reservation rejection
  events; separately numbered canonical rejections require native boundaries or
  an explicitly supported pinned aggregate policy, not cursor splitting.
  The projector folds the real queue reducer and
  obtains canonical raw steer input BEFORE reducing queue_steered. It never
  appends a second item fact or emits N cursor-sharing message frames.
- Native task descriptors may carry original launcher `input`; it is projected as
  `WireTask.input` verbatim when present, and remains absent when unknown. The
  branch result may carry actual accepted physical-start `toolUseCounts`; it is
  projected as `WireTaskResult.toolUseCounts` only after shape/identity validation.
  Absent means unknown, an actual empty array means no physical starts, and
  `toolsUsed`/labels/result text are never used to infer counts. Protocol does not
  expose arbitrary provider items or relabel output as input.
- Public submission records retain original/current content, delivery, origin,
  receipt, stage, owning turn and accepted outcome. finalText is null unless an
  accepted historical completed turn result is actually correlated to that turn.
  Retracted/discarded/cancelled stages do not manufacture a turn terminal.
- Goal changes/proposals, stop reminders, completion verification stages and
  memory facts map one frame each. Goal proposal is not an activated goal.
  A reported PASS is not public passed until accepted verification_ended says
  complete. Private memory snapshots do not become transcript text.

Snapshot synchronization reads optional authoritative tasks, queue and context
fields if Session supplies them; otherwise it retains the accepted-prefix
projection. Session's pendingInteractions/status must include task ownership
without global foreground waiting. Native decoder/recovery and writer integration
remain the Session/queue owners' responsibilities.

## Source gateway event map

Reference: `source/gateway/gateway.ts#mapConversationEvent`. This is a direct
semantic map, NOT a claim that the existing gateway SSE names/envelope, timestamps,
partial-question checkpoints or command receipts are already compatible.

| Gateway input cases | Direct family / actual limit |
| --- | --- |
| text_delta | emitted text_delta |
| reasoning_delta | emitted reasoning_delta; missing transient identity remains null |
| tool_started | tool_called then physical tool_started; no fake first-token marker |
| command_message | accepted source-formatted tool_finished display supports exact DTO slice via legacyCommandMessages; absent/foreign display stays missing |
| approval_required | emitted interaction_opened with exact request target |
| usage_update | emitted usage; totals are public reducer state |
| subagent_usage_update | NOT folded into root usage; real nested driver producer missing |
| retry, subagent_retry | retrying DTO supports tool/max/type/Retry-After/agent; producer missing |
| retry_exhausted | needs actual retry-eligibility/error producer; not fabricated |
| subagent_started, subagent_completed, subagent_interrupted | native M4 task_changed mapper; Session/driver wiring pending |
| subagent_tool_started, subagent_text_turn, subagent_command_message | scoped subagent presentation DTO / task progress; rich driver observations pending |
| subagent_approval_required, subagent_question | task-scoped interaction mapper; real task answer routing pending |
| context_compaction_started, context_compaction_completed, context_compaction_failed | Accepted `compaction_started/completed/failed` facts now map one-for-one to precise direct wire events; the existing `compacted` replaced/summary notice remains a separate presentation projection. Pinned consumer encoding is server-owned. |
| final, error | actual message + turn_ended/error; error is not an inferred successful answer |

Native expectedTurnId cancellation and keyed command receipt/outcome mapping are
implemented below. Remaining server seams include actual configuration/direct metadata,
canonical one-cursor SSE encoding, authority-backed global operations. Protocol
uses native atomic expected-turn abort, NEVER capture-then-cancel. Unsupported
native commands return their actual unavailable receipts, not M6 completion.

## Source ACP event map

Reference: `source/acp-v2/session-backend.ts#mapEvent`.

| Source case | Direct input for ACP encoder |
| --- | --- |
| text_delta | text_delta with stable message ID; message final replaces draft |
| reasoning_delta | reasoning_delta; reasoning summary supplies actual accepted identity |
| tool_started | tool_called (called/pending) |
| tool_dispatched | physical tool_started |
| tool_call_streaming_delta | actual live Session producer mapped below; parsed tool_called is never used as argument progress |
| final | turn_ended + correlated messages; actual terminal cause only if supplied |
| error | error / failed terminal, including null-seq runtime-only failure |

ACP must use reject_if_busy backed by the real queue admission operation, not a
submit/retract race. Tool occurrence IDs are not reusable provider call IDs.
Host authorization and actual workspace assembly remain outside ACP encoding.

## All 34 source TUI reducer cases

Reference: `source/hooks/conversation-ui-reducer.ts#conversationUIReducer`.
Local editor/navigation/reset actions are intentionally not wire commands.

| Source action | Direct source / ownership |
| --- | --- |
| turn/started | turn_started + activeTurnId |
| turn/completed | turn_ended; task requests survive parent completion |
| streaming/thinking_started | reasoning_delta/accepted reasoning; local clock indicator |
| streaming/thinking_cleared | local indicator/turn transition; no invented model-step clear |
| streaming/retry_countdown | retrying presentation; real producer still pending |
| streaming/tool_info | tool_called/started/progress plus actual live scoped argument count/name; no parsed-call substitute |
| streaming/speed_updated | client-local measurement of real text deltas |
| approval/requested | interaction_opened |
| approval/resolved | interaction_resolved |
| interaction/snapshot | snapshot.pendingInteractions (root and task-scoped) |
| interaction/composer_entry | local pinned-request composer state |
| ask_user/set_waiting | typed questions + local question editor |
| ask_user/clear_waiting | local editor transition / real resolution |
| ask_user/answer_submitted | local answer accumulation; one final typed answers command |
| ask_user/advance_to_next | local question navigation |
| ask_user/go_back | local question navigation |
| rejection/set_waiting | local denial-reason editor for exact request |
| rejection/cleared | local editor state |
| max_turns/approved | owning budget interaction needed; do not reinterpret any allow |
| max_turns/declined | owning budget stop/interaction needed; do not fake cancel |
| usage/updated | accepted usage + shared reducer |
| usage/cleared | local reset/session replacement |
| cost/updated | actual request_cost_recorded with complete native ModelRequestCost; no locally invented prices |
| run_budget/noticed | missing authoritative typed budget/recovery event, not generic success |
| rate_limit/updated | provider rate-limit producer missing; not inferred from token usage |
| rate_limit/cleared | local reset / future authoritative update |
| queue/updated | native queue_changed full entries/state/pauseReason |
| queue/message_pending | queue_changed.admission + exact queued content |
| queue/message_reclassified | native queue state delivery/stage |
| queue/message_started | queue state + turn_started; no removal-as-completion inference |
| queue/message_removed | explicit retained retracted/discarded/cancelled submission stage |
| queue/message_edited | native queued content; attachments omitted retains, [] clears |
| reset_transient | local UI reset; no Session cancellation implied |
| reset_all | local replacement only after authorized actual session switch |

The shared reducer retains retry/compaction notices and scoped subagent
presentation rather than dropping them. Legacy retrying/compacted DTOs still
need corresponding native producers; real branch/history facts now have direct
mappings. Notice retention is not runtime evidence that these paths occurred.

## Commands / external gaps

Actual native operations include delivery admission, exact answer/budget answer,
queue mutations and atomic abort. Remaining optional operations must be supplied
from the same Session, never a second runtime. Queue mutations return native DirectQueueMutation (accepted/no_op/too_late/rejected);
too_late is a distinct wire failure, and invalid does not become accepted. Task
controls return native outcomes; unknown/inactive targets are not successful.
Explicit non-auto delivery and structured Discord input require real
submitWithDelivery. Scoped grants are not offered while supportedGrants is empty.
Expected-turn cancellation calls native atomic Session.abort. Rewind returns the
actual editable draft, not reconstructed provider history. Host/global slash actions
are app authority, not an arbitrary invoke-method RPC.

Structured origin is frozen in direct-wire/parseWireOrigin: Discord
{kind:'discord',source:'human'|'agent'|'reaction',sender,discordMessageId?,relayedBy?};
control source may be orchestrator. Shared DirectOrigin, durable decoder and both
native fingerprints must retain every field plus requested normalized delivery.
Current M2 kind/id-only fingerprint is insufficient. No opaque authority encoding.

Old headless --json compatibility is NOT implemented by raw wire emission. The
requested old schema needs accepted request cost records, argument streaming,
command/turn-item DTOs and terminal summaries absent from current Session facts.
Keep its fail-closed gate until that producer-backed mapping exists. No prices,
usage, providerHistory, private provider frames or success markers are fabricated.
Silent task-notification turns, check-in settlement, budget recovery evidence,
full historical result recovery and real metadata/config also need their owning
accepted facts/capabilities. These are integration blockers, not optional parity.

## Native facade integration (current lead working contract)

Delivery and queue edits/retract/resume/discard now call actual `DirectSession`
methods; `DirectCommandCapabilities` no longer defines parallel injected versions.
`submitWithDelivery({...request,delivery})` preserves auto/reject_if_busy/steer/
follow_up semantics under native admission. An expected-turn cancel calls atomic
`Session.abort(expectedTurnId,discardQueue?)` and returns
`{ok:true,kind:'abort',result:<native DirectAbortResult>}`. `no_op` carries the
requested `turnId` and native `status`: `terminal_accepted` means an actual
accepted root terminal for that turn exists; `cancellation_requested` means the
same current root is already cancelled without stronger terminal evidence;
`not_current` means neither. `no_op` is not physical settlement and
`not_admitting` remains distinct.
Untargeted cancel remains a request acknowledgement, never task completion.

`answer` accepts optional explicit `provenance` and passes it to every native
resolution path (including structured questions and grants). Missing provenance
stays missing; protocol never upgrades a policy/system answer to human. Native
failed answers can represent policy/validation as well as writer failure, so the
wire reports generic rejected, not an invented storage diagnosis. `answer_budget`
passes the native budget decision/provenance to `Session.answerBudget`; accepted
budget closure carries its actual source. Wire steering inputs are restricted to
explicit user-message IDs/content, never arbitrary provider frames. The current
native root implementation may reject steer or parent extension; a typed decision
is not an assertion that policy permits it.

`pendingBudgets`, observed evidence and `turnResults` are retained in the public
fold/snapshot. Historical submission finalText uses that turn result, not the
current terminal. Completed finalText excludes live drafts; null means accepted
completed-answer evidence is unavailable. A native task terminal remains solely
`task_finished`: a scoped child turn ending does not claim cleanup/task completion.
Genuine task supported-action metadata still needs the Session owner; no action
list is inferred from task kind/status or merely having a generic control seam.

The native facade/facts/state are now published in the lead lineage through
`83f61600` (current inspected HEAD `950a30ea`). `DirectProtocolUpdate` is exactly
the native `DirectSessionUpdate`, not an extra helper union. Native accepted
updates/replay retain original `at`; host passes the original replay entry.
The new native automatic_memory_notice transient maps its public success/command/
output to a null-seq notice event; no private snapshot/receipt is serialized. No compile/runtime/acceptance evidence was collected.

## Accepted physical request costs / bounded legacy JSON projection

The native `DirectRequestCostFact` is copied into `WireRequestCost` with exact
`turnId`, `rootTurnId`, optional `parentTurnId` and the complete actual `record`.
`WireSnapshot.requestCosts` is the accepted retained request window. Native same-ID
corrections replace by record.requestId; the public fold does the same. Cost facts
never update root usage, active turn, terminal or response identity; late child/
summary/failed records do not become a new main response. Transcript replacement
or root terminal does not erase accounting. No prices/tiers/usage fields are
manufactured from raw costUsd or current cumulative tokens. The narrow portable
cost type is reused rather than maintaining a second schema/pricing calculation.

`direct-json.ts#legacyRequestCostUpdate` maps this real wire cost event to exact
old `{type:'cost_update',record}` and preserves all optional price/normalized-usage
fields. It is a **bounded cost projection, not a complete legacy --json gate**.
Headless selects actual owning root/tree via event.payload ancestry before writing
that record; it must not infer a root from whichever turn is currently active.
Old --json stays unavailable until complete public command/ordered
turn-item/final/approval and other required producer contracts exist; actual
argument stream is now published and mapped in the followup below. Raw wire
JSON is not legacy parity and no complete conversation_event producer is claimed.

Native branch_started now supplies optional actual parent/root ownership; the
subagent wrapper exposes it and keeps child turnId on the nested event. Outer
turnId is the known parent (or null), never a child mislabeled as root. Older facts
may omit rootTurnId; it remains absent, not guessed from the latest session turn.

## Accepted source-formatted command slice and concrete cost dependencies

`direct-json.ts#legacyCommandMessages` consumes only the accepted `tool_finished`
public display. Native `app/source-tools.ts#displayFor` and
`tools/adopted/index.ts#displayFor` retain the actual source `formatCommandMessage`
array, optionally wrapped with `messages`/`approvalPresentation`. The helper
recognizes those existing `CommandMessage` DTOs and clones them to exact
`command_message` records, retaining actual identity/sender/status/output and
optional success/failure/rejection/automatic-approval/tool/call fields. It does not
re-format physical output, infer rejection from an error, or turn missing display
into blank successful commands. Unrecognized display entries emit no legacy
record. This is not proof every native tool/denial has a source-formatted DTO.
Consumers preserve event/branch ownership, array order and message-ID upsert;
neither duplicate audit/provider finish nor reconnect is a new command identity.
There is still no authoritative legacy final/ordered turnItems producer.

Cost producer/state/shared types are published in lead
`d00b10b1401fe343cf8594a881729fa871a56641`; cost decoder/replay is published
separately in queue `018a6c93fa9cfcc0811e5af90636569ca48de43a` (after its existing
`3bfe2947` decoder baseline). These are concrete integration dependencies, not a
claim the combined candidate has compiled or run. Actual argumentCharCount and
native keyed commands were still missing at lead `bcbe501d`; this dependency is
now superseded by the committed `f14c9baa` integration described below. Old optional
void callbacks were not durable idempotence and have been removed.


## Keyed native commands (f14c9baa contract)

`Session.command(DirectCommandRequest):Promise<DirectCommandResult>` and
`Session.rewindTargets()` are native committed APIs in lead `f14c9baa`, after
command leaves `a9ce4b1d`. Wire retry/compact/configure/rewind/rollover now REQUIRE a
caller-supplied `commandId` and forward the unchanged identity and exact operation
body. Unkeyed input is invalid, not silently allocated another operation. Removed
optional void/rewind/rollover callbacks are not fallback authority. Reset and
preview remain separate app-owned capabilities; they are not newly durable keyed
native operations. This mapping adds no fingerprint, writer, receipt cache or
physical effect, and never re-executes a tool to implement retry.

`publicCommandResult` maps pending to `ok:true,kind:command_pending`, actual success
to `ok:true,kind:command_finished`, rejected/interrupted to `ok:false` with exact
original receipt (`command_rejected`/`command_interrupted`), conflict to
`request_conflict`, and refusal to `not_admitting`. A pending receipt is not effect
success; a retried turnId is admission, not execution completion. Rewound draft
retains native `content`, not a guessed text/attachment split. Missing final
outcome or original start context is an internal inconsistency, never success.
Exceptions return a generic public error with the supplied commandId when parsed;
a lost response is not evidence the effect did not occur. Query/retry the original
ID/body according to native receipt semantics, never make up a new retry ID.

Snapshots expose actual `commands` receipts, independent of root transcript,
usage/cost/terminal state. Each native command_started/command_finished maps one
session-scoped wire frame carrying its correlated full receipt, original seq/at,
turnId:null. The actual retried turn stays inside its outcome. Full-prefix replay
reconstructs start context before projecting a tail finish; shared public fold
upserts by request.commandId only. It is not another acceptance/deduplication policy.
`command_status` captures the actual Session receipt window atomically, detaches,
and returns the same typed response or not_found; it never calls command().
`command_revision` reads the native current root-history/configuration revision
(`DirectSession.commandRevision()`) without a mutation, receipt allocation or
cursor inference. It is the supported status/configure-discovery read; callers
must still pass that exact revision back in a keyed request for atomic checking.
Configure input is `WireConfigureRequest`, which retains requested `profileId`
and `reasoning:'default'|effort` without normalization; accepted configuration
events, snapshots and `configured` outcomes remain the narrower concrete
`WireConfiguration` (actual model/effective reasoning/temperature only). Profile
metadata remains in its existing accepted location, not in effective output.
Keyed wire requests may carry `admission:'idle'` and/or `expectedRevision`;
both are forwarded verbatim to native command admission, whose original same-key
receipt replay happens before evaluating current preconditions. Changed
preconditions under the same key remain a native conflict; protocol does not add
a lock, retry loop, default idle policy or replay flag.
`list_rewind_targets` maps native revision-scoped IDs/labels, not a UI index guess.

Server legacy command selector `commandId:compact|retry-tool|retry-turn` is NOT the
wire invocation ID. Map its stable `clientRequestId` verbatim to wire commandId,
selector to wire type/target. Session owns same-key replay before new ownership/
busy refusal. Native f14c9baa result does not distinguish first call vs duplicate;
protocol does NOT claim `replayed:true` from snapshots/timing or process memory.
Server's pinned replayed flag needs an actual native result extension. Native
ineligible does not prove nothing_to_retry; compacted alone does not provide
legacy token counts/not_reduced. Manual compact/configure/rollover currently
return durable unavailable failures until their real native authority lands.
Decoder/replay registration of command facts and retryContext/requestConfiguration
metadata remains a separate native owner integration dependency. No checks or
runtime acceptance evidence is claimed before M6.


## Session live stream, replayed result and silent notice followup (684f9ae0)

Native producer original `e2f24aa3` (lead import `210bba91`) and Session publication
`684f9ae0` now provide real live `tool_call_streaming_delta`. Protocol emits one
null-seq frame with producing turnId, physical modelStep, unchanged actual cumulative
argumentCharCount, and only supplied toolName/callId/itemId/callIndex. Call/item/
index identities stay distinct; no execution ID, fake delta, completed tool/item
or persisted/replayed progress is created. Native branch envelopes produce a
null-seq subagent wrapper with actual task/branch/parent/root and inner child turn;
root active identity/usage/transcript are untouched. Shared reducer intentionally
retains no streaming replay state. `legacyToolCallStreamingDelta` returns only the
old type/count/optional name, with actual scope left on wire envelopes. --json is
still gated pending the remaining authoritative final/legacy coverage contracts.

`684f9ae0` also adds authoritative native pending/finished `replayed:boolean`.
`publicCommandResult` forwards it on both successful and negative receipt replies.
Read-only command_status returns actual receipt status WITHOUT a replayed flag:
reading a retained receipt does not classify an invocation as first or duplicate.
No snapshot/timing inference or protocol idempotency mechanism was introduced.
This supersedes the missing-replayed dependency recorded for f14c9baa above.

The same native Fact union now includes background_notice_enqueued and
background_notices_delivered. Protocol preserves each accepted boundary, native
notice/planning text/task IDs, original delivery request/turn/notice IDs and retained
snapshot.notifications. The public fold retains all notices/deliveries as native
state does; clients derive pending IDs by excluding delivered notice IDs, not by
guessing parent completion or fabricating notification text. Real silent
turn_started carries silent:true and NO synthetic human input in public input/
transcript. drain_background_notifications forwards its stable requestId unchanged
to native drainBackgroundNotifications and returns the exact typed started/
duplicate/empty/busy result, or not_admitting failure; started is actual silent
turn admission, not completion. It is not a replacement Session waiter or implicit
loop. Headless owns its native-task-aware drain/wait sequence and timeout/cancel
reporting. Native notification decoder registration remains its owner's dependency.
No tests/checks/builds/reviews/runtime evidence collected.

## Bounded legacy JSON live deltas and accepted terminal window

`direct-json.ts#legacyReasoningDelta` copies an actual live reasoning chunk into
its source ConversationEvent DTO with `type` and `delta` only; native reasoning
transients provide no durable complete prefix/block identity, and an accepted
summary is never emitted as a new reasoning_delta. Headless `--json` supplies
`legacyTextDelta`'s optional `fullText` only while it has observed that message's
deltas from the first chunk in the current target turn; the value is the exact
accumulated native delta text, not a transcript-derived prefix. The original wire
turn/branch envelope retains ownership; consumers must select the correct scope
before using these unscoped legacy DTOs. No event, cursor or identity is allocated.

`WireTerminal.finalWindow` now carries the exact accepted root
`DirectFinalWindow` (version `public-turn-v1`) for a terminal. `WireTurnResult`
retains it in the snapshot, and `direct-json.ts#legacyFinalResponse` projects its
`final` record into the old DTO, filtering only command-message IDs the consumer
actually emitted live. It preserves actual per-turn usage, ordered public result
items, accepted source command DTOs, root-tree cost records and terminal cause.
The old final omitted durable `tool_call` admission items and carried a
`providerItem` view of each accepted public tool result; the projection filters
the former and builds the latter only from the public result's own call/tool/output
fields, and only when the window's coverage proves no provider/opaque content was
omitted. It does not synthesize `providerHistory`, private/opaque items or a live
prefix when the accepted view cannot faithfully represent them. Cost records and
live cost updates use the old run-local `req-N` view,
the old standard-tier default for an unspecified dispatch, and only clarify an
accepted `unknown_model` reason when the real source catalog reports an unknown
provider; no price or charge is invented. Zero cache counters are omitted from
legacy usage. Coverage limits remain documented here rather than emitted as an
extra field that old consumers did not define.

`DIRECT_LEGACY_JSON_FINAL_WINDOW_AVAILABLE` remains false as a declaration about
the complete legacy ConversationEvent/private-history schema, not the bounded
terminal window. Headless consumes the final window and exact live slices.
In log version 2, `recoverDirectFinalWindow` projects each root terminal window
read-only from its accepted fact prefix when a preceding `turn_started` exists.
This is current-format projection, not `derivedFromAcceptedFacts`/`legacyDerived`
output, and does not rewrite the terminal. Without the prefix, headless emits
`legacy_final_window_unavailable` and exits 1 rather than a partial final.

Exact producer-backed live slices now include `tool_started` from `tool_called`
and `tool_dispatched` from physical `tool_started` only when the wire carries the
source-required `callId`; `retry` only with the source-required toolName,
maxRetries and a known retryType; and `run_budget` from accepted budget evidence. Transient `error` forwards the
actual message and known kind; optional source code/finalText/stack are unavailable.
Missing IDs/metadata make those records unavailable rather than synthesized.
Headless also maps a settled request's cost-record usage and a real `usage` fact
into old `usage_update` records at the request-cost boundary, so live consumers
see them during intervening work; pending observations are flushed before a
terminal when no cost settlement follows. Provider history, private/opaque items,
approval descriptors, `retry_exhausted`, context-compaction source event semantics,
memory-injection and subagent/background event families remain unavailable or
need a real producer contract. This is not complete --json parity.

## Accepted branch hydration at one logical Session cut

`DirectProjection.snapshot` exposes `WireSnapshot.branches` from the existing
accepted branch projection map. `DirectAttachment` reconstructs that map from
`Session.captureFrom(0)` before returning a connection snapshot; synchronization
snapshots also carry the branch read models. No second journal, reader, sequence
or timestamp is introduced. The outer `sessionId`/`seq` is the single hydration
and subsequent replay cut. Branch `acceptedSeq` is only the last real
`branch_started`/`branch_event` boundary; task interaction and request-cost joins
can be newer, up to the outer cut, and never create separate resume cursors.

Each `WireBranchSnapshot` carries actual `branchId`, `taskId`, child `turnId` and
only recorded optional `parentTurnId`/`rootTurnId`. Its messages, tools, mixed
timeline, accepted summaries, budget state and terminal observations come from
that branch's existing public reducer. These are accepted public context/items,
not private provider history or proof that an unfinished branch is still running.
No root configuration/model or inferred task outcome is exposed as child state.
Usage stays null until an actual accepted child usage fact; reasoning stays null
until an accepted summary. Raw live reasoning/progress remain non-replayable.

Pending interactions join the root's task-owned public requests by exact taskId
and child turnId. Request costs select the root's accepted physical records by
producing child turnId and retain their requestId and native ancestry. They are
views of the SAME charges: do not sum them again with root requestCosts, optional
response costUsd or an aggregate cost. No usage/price comes from compaction
estimates or request references. Child queue is explicitly null (unavailable):
the branch fact grammar has no queue producer. Root queue is not child history.
An absent branches capability is unavailable; [] from this producer means no
accepted branch_started exists in the reconstructed prefix. Branch models survive
root context rotation, while native root transcript/usage follow the existing
foreground reset semantics and physical request-cost accounting survives.

Native WireSnapshot already includes root tasks, queue/submissions, requestCosts,
goal/verification and notice/notification evidence. The canonical HTTP
`projectServerSession` is a different, narrower DTO; its omission of those fields
must not be mistaken for their absence from the native producer. Versioned HTTP
hydration needs the native snapshot, not that canonical narrowing. V2 accepted
codecs/consumers must explicitly preserve real native request_cost_recorded,
goal/goal_proposed/verification/notice and background notice changes instead of
falling through a lossy v1 mapper. A `cost` wire type is not a cost producer:
the current accepted projection emits request receipts and optional response
costUsd, not a synthesized aggregate total. No aggregate event is added here.

This native DTO addition does not implement shared-wire artifacts, server/browser
serialization/parsing, external consumer migration, raw-stream retention or M6
activation. Those owners must integrate the actual shape and keep the combined
gate closed until required implementation and authorized verification finish.

## Accepted goal provenance

`contextFactEvent` carries the accepted `goal_changed.source` in the public
`goal` event. Consumers may announce model-check closure only for an achieved
`goal_check` change, not from a tool acknowledgement or an achieved status alone.
The headless client reaches the shared source formatter through the existing
`direct-json.ts` presentation adapter, not a client-to-source import. It writes
the summary on stderr; it does not accept a goal write, infer verification, or add a legacy event to native history.
This retains the distinction from user/launcher/proposal changes at the client
boundary instead of trying to reconstruct who changed the goal from status.


### Native log version 2: physical payload ownership

`session/log.ts` is the only serialization/hydration boundary. Public `FactLine`
values contain full facts; JSONL envelopes may additionally contain `refs` and
`null` placeholders in their physical `fact`. `log-payloads.ts` resolves each
reference from an accepted same-turn `(seq, path)` string, optionally selecting a
string inside its parsed JSON (`jsonPath`), optionally JSON-string escaping that
source (`jsonEscape: true`, without surrounding quotes), then applying a UTF-16
slice and literal prefix/suffix. Same-line references resolve in recorded order. Missing, forward,
cross-turn or malformed sources/targets fail the conversation read. Other native
versions are refused, not interpreted by a legacy fallback.

Hydrated payload validation dispatches through `log-facts.ts#nativeSchemas`, one
validator per native fact type, with shared shape helpers for compaction and task
lifecycle facts. Queue, context, command, notification and configuration decoders
retain their own schemas. Envelope/version/sequence checks stay in `log.ts`; this
validator split does not strengthen or normalize existing accepted payloads.

This keeps `tool_finished` canonical and complete before a later provider item:
structured adopted results can become `provider_input`, not `tool_result`, and
readers still get the original output. Different display framing is retained,
not inferred from a tool name. Sharing is within the accepted logical lineage;
rotation readers/writers supply predecessor envelopes via `LogContinuationOptions.prefix`.
`readDirectLogLineage` and `createDirectRollingLog` own this plumbing. An isolated
successor file with references cannot be decoded without its predecessor.

`turn_ended` stores only terminal metadata; `recoverDirectFinalWindow` projects
from the accepted prefix across history replacement and physical rotation.
`text_delta` and full `history_replaced` snapshots remain literal exceptions.
Large-string sharing uses at least 200 UTF-16 code units. References may cost more
than a short literal near that boundary; canonical body ownership takes priority
over per-field byte savings. This is not cross-conversation deduplication.
The `native-log.single-source` generated property checks real log round-trips,
result-first reopen, continuation segments, structured results, display variants,
tool arguments, reasoning/opaque metadata, and unique body storage. Its oracle
checks every large semantic string leaf in the generated same-turn facts, plus
literal reference framing, rather than only tool-result markers. It is not an
exhaustive generator of all fact schemas or a substitute for process-kill/CLI
controls.


Storage failure lesson: the old terminal snapshot repeated both public items and
its derived final record, while tool completion, display and provider items also
repeated output bodies. Measuring a real tool/resume run exposed the copies even
though replay itself rendered once. The version-2 boundary removes terminal
snapshots and shares payloads before consumers project them. Equality-only and
prefix/suffix-only matching miss structured-output/display framing at both ends;
the generated property found that case. Its oracle must decode nested JSON once
before counting string bodies, or escaped structured output gives false failures.

A broader generated control exposed the reverse JSON-encoding case: parsed tool
input could precede `rawArguments`, so source-side `jsonPath` alone retained both
copies when quotes/backslashes split every literal matching span. References may
now select the JSON-escaped form of an earlier string, preserving the original
provider argument string exactly rather than rebuilding it from parsed input.
The earlier result-only generator missed argument and metadata leaves; the oracle
now examines all large semantic leaves in its generated facts. Do not assert a
framed sentinel must remain one contiguous literal when sharing can legally
split its framing; round-trip equality is the fidelity check.
