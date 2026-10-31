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
- Original task input and toolsUsed are not separate fields in the consumed native
  task descriptor/result contract. DirectSubagents.start retains request.task as
  label; the branch driver returns items/outcome. Protocol keeps label distinct
  from result output and does not expose arbitrary provider items, relabel output
  as input, or invent tools-used metadata. Native accepted public metadata is
  required before those additional pinned fields can be projected.
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
| context_compaction_started, context_compaction_completed, context_compaction_failed | compacted/notice DTO presentation only; no current Session producer |
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
`{ok:true,kind:'abort',result:<native DirectAbortResult>}`. `no_op` means no new
abort, **not** evidence the turn physically settled; `not_admitting` is distinct.
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
public display. Native `tools/source-tools.ts#displayFor` and
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

## Bounded legacy JSON live deltas, not a final window

`direct-json.ts#legacyTextDelta` and `legacyReasoningDelta` copy actual wire
chunks into their source ConversationEvent DTOs with `type` and `delta` only.
Both source DTOs make fullText optional. The helpers deliberately omit it:
message-local drafts are not the legacy turn-wide accumulated stream, and native
reasoning transients provide no durable complete prefix/block identity. An accepted
reasoning summary is not emitted as a new reasoning_delta. The original wire
turn/branch envelope retains ownership; consumers must select the correct scope
before using these unscoped legacy DTOs. No event, cursor or identity is allocated.

`DIRECT_LEGACY_JSON_FINAL_WINDOW_AVAILABLE` is statically false. It is an explicit
negative declaration for the complete legacy final contract, not a per-session
runtime readiness promise. Existing cost, command-message and argument-progress
helpers plus these delta helpers are partial slices, not an ungating condition.

The consumed native turnResults contain public messages and terminal metadata,
not authoritative ordered PersistedAssistantTurnItem records, per-turn terminal
usage/reasoning or source live/final command/cost partition. Session cumulative
usage and public message/tool/timeline projections must not be presented as those
windows. No legacy final, remaining live event family, private providerHistory or
complete --json parity is supplied by these helpers. Headless owns its existing
client completion/error records and keeps --json fail-closed until genuine native
public final-window authority and required event coverage are delivered.
