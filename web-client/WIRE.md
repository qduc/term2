# Browser/BFF wire versions

This is an **implementation target, not activated or verified support**. M6's
combined migration gates remain closed. This checkout still pins the historical
0.1.0 artifact; named v2 imports require the packaging owner's local 0.2.0
artifact and coordinated pin/lock/vendor updates. There is no automatic downgrade
or fallback to the old runtime. No external ChatForge uptake is established.

## Version ledger and source dependencies

| Contract | Historical browser | This source migration |
| --- | --- | --- |
| Shared package | `@qduc/agent-wire@0.1.0` vendored artifact | Requires still-unreleased local source `0.2.0`; artifact unbuilt |
| Event schema | `schemaVersion:1`, one `id/type/payload` event | `schemaVersion:2`, ordered accepted/live `changes` |
| HTTP selection | Unversioned canonical endpoint | Explicit `format=agent-wire-v2` on hydration, events and keyed configuration |
| Native snapshot | Historical app projection | Separate schema-2 wrapper around public native `WireSnapshot` (`protocolVersion:1`) |
| Interaction DTO | Version 1 | Still version 1, same accepted cut; not an event-schema downgrade |

The exact shared originals are `ece5d65393f56503070512251e1ae06d78f9d659`
(versioned wire) plus `af3d0ffbe68489c3604148948177d0763acaf154` (eight accepted
evidence names). Shared documentation follow-up `c01d054a253bb2451c2cb8bc9e4bcc6ea37375d6`
(parent af3d0ff) records option B; `67d3cba8151d83eee851a9eb5638e27e6f193f64`
(parent c01d054a) persists the maintained-large-module-interface rule in shared
AGENTS.md. These documentation commits change no API/provider/native history.
Shared accepted-message/task follow-up is ORIGINAL
`6cad9b2990f6df1c521022fc45ad05a6a8e33a10` (parent 67d3cba); payload types
remain generic `AgentChangePayloadsV2`, without exported native message/task
interfaces. Tool/error/live-failure shared ORIGINAL
`a4bcebc48dc22086c655a601bf4911c64882a8eb` (parent 6cad9b29) is also required.
Its accepted list/type excludes error; AgentChangeTypeV2/AgentChangeV2 is the
accepted-or-live union, while each envelope restricts changes using the matching
accepted/live Extract. Browser consumption narrows by envelope kind and uses
those exact shared types, without casting or widening accepted admission.
All remain the same still-unreleased **0.2.0**, not 0.2.1.
The package's `packages/wire/docs/v1.md`, `v2.md`, and `migration-v1-v2.md` define
the shared contracts. `TERM2_FREEZE_SHA` identifies a historical v1 fixture, not a
v2 digest. This consumer uses named v2 exports, not unqualified v1 aliases or a
browser-local replacement parser.

Application-side dependencies, all based on
`355cfe147956fd2dcf3e854582a337ee0c55731e`:

- Server originals `bc516fc442799dbe220c864ee2bdd42581fe0f15` and
  `44072eae73bae181ac364ce5fb61a4c049b7d59a`: v2 transport, native hydration,
  keyed configuration and accepted evidence mapping. Server documentation follow-ups
  are `f5c54c784dafebdf8fb1cb00f653503296caddc6` and
  `639adc4ccd9c4d6345a7843b31c103edfa43c09a`.
- Native original `838664750acec8a65de2526a7712c743e9d17989`: optional same-cut
  branch snapshots. The browser consumes the native DTO, not a fabricated child
  session or server-side projection fan-out.

Incremental native event delivery additionally requires server originals
`188b11e89e054595d5c5e0891a45bb4a9407697e` (accepted message/task),
`1a0506784a07f183b39557b4d6c8fe1ee97fed7f` (accepted call/live error), and
`d4df461589e5599f4a9569f510bc2e2f75dd64b4` (live synchronized failure),
in that order on their candidate-based server lineage. They are not browser-base
ancestors to replay into this isolated tree.

These are delivery identities and required integration inputs, not acceptance
claims. The browser slice does not modify server/native/shared code, manifests,
locks or vendor artifacts.

## v1: historical contract, not a fallback

The old browser bound SSE IDs to per-event IDs and required contiguous delivery.
It parsed configure acknowledgements as current configuration. Those assumptions
cannot represent sparse accepted boundaries, several command messages in one
boundary, native queue/branch state, root rotation or original keyed receipts.
Production hydration/stream consumption no longer uses that projection path.
Legacy helper exports and v1 example tests remain historical; their presence is
not supported downgrade behavior. Roll back compatible server/consumer/artifact
versions together; source rollback alone does not establish log compatibility.

## v2: hydration and replay

The browser first reads `GET session?format=agent-wire-v2`. The BFF forwards the
separate `x-term2-hydration-format: agent-wire-v2` and
`x-term2-hydration: current-accepted` headers. `parseSessionHydration` consumes:

- `{schemaVersion:2,kind:'snapshot',sessionId,seq,snapshot,interaction,
  earliestReplayableSequence}`; outer seq is the actual accepted cut, including
  zero when supplied by the native snapshot. It is not a new SSE event.
- `snapshot` is the actual public `WireSnapshot`, still `protocolVersion:1`, with
  matching session/seq. Root messages, mixed message/tool timeline, queue/tasks,
  usage, request receipts, goals/verification, notices and commands remain native
  evidence rather than being squeezed into a legacy transcript.
- `interaction` is a nullable, same-cut pending root/child interaction using DTO
  version 1 and actual turn/subagent identity. There is no second interaction GET
  or join against a newer cut.

Hydration installs once, then requests atomic replay strictly after the supplied
root seq. A zero cut means omit the replay cursor, not fabricate accepted seq 0.
`earliestReplayableSequence:null`, unavailable/non-atomic replay, or HTTP 410 fail
closed with Reload required; there is no v1 GET fallback or concurrent hydration
loop. Explicit refresh aborts the old stream before rehydration. An older cut
cannot replace an already installed accepted checkpoint. `history_replaced`
closes the stream and obtains a real current native cut.

`parseEventEnvelope` delegates to `parseAgentEventEnvelopeV2`.
`consumeSseResponse` requires `x-term2-event-format: agent-wire-v2` and atomic
replay support: `event: accepted` has exactly one matching positive safe SSE ID;
`event: live` has no ID, seq or accepted time. The BFF preserves actual replay,
mode and from/to headers and does not rewrite native IDs/timestamps. Sparse safe
accepted seq values are legal.

`applyTerm2Event` folds the whole ordered batch before publishing a view or
checkpoint. Repeated accepted boundaries deduplicate as a whole; empty accepted
batches still checkpoint. A malformed change leaves the prior published state
and checkpoint intact. Live changes cannot advance the accepted checkpoint. No
timers, sub-event IDs, invented timestamps or replay journal are added. Several
command messages sharing a call ID retain their actual message identities;
native execution IDs may contain colons.

## Branch and context boundaries

Optional native `snapshot.branches` preserves absence (capability unavailable)
versus `[]` (real no accepted branches). Each branch keeps its actual
branch/task/turn ancestry and native messages/tools/timeline, unmatched results,
interactions/budgets, turn results, nullable usage/reasoning, reasoning identity,
terminal/notices and request receipts. `queue:null` means unavailable, not an
empty queue or a copy of the root queue. Null usage is unobserved, not zero.

A branch's `acceptedSeq` is observation provenance at the outer root cut, not a
second reconnect cursor. Joined interaction/cost evidence may be newer through
that outer cut. Neither an open branch nor a task card proves a child is
physically running. Branch transcripts use actual message/tool turn ownership
and mixed timeline references; unbound messages and unavailable mixed order are
shown separately instead of guessing ownership or chronology.

A real `session_rotated` clears root conversation context and the old root
hydration context while retaining branch views, noncontext native evidence,
measured usage and archived task cards. Retired root text/reasoning/commands are
not restored as provider context. Raw evidence disclosures are separate from
current provider context. Same-session hydration retains previously observed
raw event evidence, not a claim of complete producer retention.

## Accepted public evidence and accounting

The cost/goal/notice names plus `message`, `task_changed` and `tool_called` are
**accepted only**, not additions to the live allowlist. `native-state.ts`
validates/reduces observed message/task/cost/goal/notice state;
`event-adapter.ts` validates/presents the exact accepted call. All install inside
the same atomic accepted batch:

| Change | Consumer meaning |
| --- | --- |
| `message` | Upsert exact public message ID/role/content/text/optional ownership; replace the named draft in place, no synthetic assistant turn or inferred terminal |
| `task_changed` | Upsert exact root task descriptor by real task ID; retain change/numeric at as evidence, not a cursor or foreground status |
| `tool_called` | Pending command from real execution/turn/call identity and input, not a physical start |
| `cost` | Replace actual `{totalUsd,currency:'USD'}` aggregate state; never increment it |
| `request_cost_recorded` | Upsert actual `{turnId,rootTurnId,parentTurnId?,record}` by `record.requestId`; immutable physical ancestry, later complete records may enrich/correct |
| `goal` | Replace nullable native goal, retain optional actual generation |
| `goal_proposed` | Retain proposal separately; do not activate it |
| `verification` | Replace nullable native verification; do not infer user-task acceptance |
| `notice` | Retain actual `{kind,message}` notice |
| `background_notice_enqueued` | Retain actual `{notice:{id,kind,taskIds,text}}` |
| `background_notices_delivered` | Retain `{clientRequestId,turnId,notificationIds}`; actual silent turn, no foreground turn created |

Accepted messages retain both actual replacement fields where supplied, false/
zero/empty values and optional native identities. The browser stores ordered
native message entries; replacement retains the named draft's position. Turn
presentation is recalculated only for affected actual turn IDs. Missing turn
ownership stays unbound; message content is not provider history. Root rotation
clears root message context but not branch messages, tasks or accounting.

`task_changed` is root metadata, with no branch wrapper. It replaces the complete
supplied task descriptor rather than merging absent optionals from an old task.
Counts are **task.result.toolUseCounts**, not a new top-level field. Unknown
counts differ from []; task_stop_requested stays native cancelling. A child
terminal does not complete a task. Current native task descriptors supersede
legacy task-card presentation with the same actual id/agentId; initial snapshot
disclosures remain labelled at their hydration cut.

Tool calls retain the exact public `WireTool` (including optional native callId,
parentExecutionId, input/display/content). The legacy command `callId` slot is
the actual executionId, matching the server's later tool_started/command_message
mapping. Pending is labelled not started; only a real tool_started marks running.
Multiple result messages remain distinct by real message ID. A result without a
matching observed call/start stays exact unmatched evidence, not a guessed Tool
card or physical execution. Public descriptor/input is not provider-native history.

Cost and request receipts have no additional branch wrapper. Request payload
ancestry already owns the physical request. Branch receipt panels select the
same root records, not new charges. The root panel derives a receipt-scoped
summary from the latest records, as described below. No aggregate-plus-request
sum, compaction-reference charge, invented currency, pricing lookup or missing
metric default is computed. Null/omitted fields, recorded zero, empty arrays and
signed accounting values remain distinct. Details disclose the measured record
and original outcome, including unknown/unpriced evidence.

`Term2NativeEvidence` also displays actual progress/reasoning/compaction,
queue/tasks and command/configuration evidence. Context estimates and request
references are not billed usage. The shared/server/browser user-facing disclosure is:

> Raw reasoning chunks and intermediate tool-progress updates are visible live
> but may be unavailable after reconnect or crash. Recovery uses actually
> accepted reasoning summaries and final tool results, not the original raw
> stream or an interrupted prefix. This is an explicit raw-stream replay parity
> exception, not full replay parity.

User-selected **option B** (Discord decision `1566281061087059989`) keeps raw
reasoning chunks and intermediate tool-progress updates **live-only**, including
after reconnect/crash. Accepted reasoning summaries and final tool results are
the recovery surface. This is an explicit **raw-stream replay parity exception**,
not full replay parity. Connection-local UI observations are separate from
accepted evidence and cleared on stream disconnection/hydration; no transient
prefix, replay cursor or history is persisted or reconstructed.

This UI policy does not authorize stripping provider-native history. Complete
provider-required reasoning items, signatures, encrypted metadata, tool calls
and tool results must remain intact in the provider/runtime lane. This browser
slice does not edit that lane. Actual provider continuation must be verified
after M6; UI chunk handling does not establish it.

### Receipt-scoped presentation (native candidate `65194f48`)

The selected native source has **no aggregate-cost producer or complete historic
receipt-coverage marker**. An actual `cost` snapshot/event is retained separately
as native aggregate evidence, not substituted for, reconciled with or added to
the receipt amount. Null/absence does not erase real request receipts.

`lib/term2/receipt-cost.ts#summarizeReceiptCosts` is a **pure root presentation**
over the current validated latest-per-physical-`requestId` receipt set. It does
not write accepted state, append a fact, emit an event, retain a second journal
or create a cursor. Snapshot hydration and incremental corrections use the same
`nativeState.requestCosts`, already upserted by that actual request identity.
Branch subsets remain views of root receipts; no branch summary is added again.

Arithmetic follows `source/services/cost/model-cost.ts#summarizeCost`: sum signed
supplied USD micros (zero/credits included), count priced (`usdMicros` present)
and unpriced receipts, and label pricing `unavailable` if none are priced,
`partial` if some are unpriced, otherwise `estimated` if any supplied price is
catalog-sourced, else `exact`. These labels describe **only the supplied receipt
set**, never complete historical coverage. A `partial` sum can also contain
catalog estimates. No catalog/usage/model lookup or response-cost fallback runs.
The browser has no runtime/type dependency on that source module: direct reuse
fails Turbopack's `.js` dependency resolution, and its BigInt literals also fail
the browser's ES2017 type target. The small presentation arithmetic stays local;
a bounded author check compares it to the actual pure source implementation.

The UI always says **historical coverage unknown; not a complete session bill**.
Absent receipt evidence means unavailable counts, not an inferred empty set.
An observed empty set has zero observed counts but no available charge; an
all-unpriced set likewise never displays zero as a bill. With priced receipts,
known amount is shown in USD to six decimals and exact USD micros, preserving
zero, negative corrections and a net-zero known sum. Complete record replacement
can remove a previously priced amount, and the derived view clears it naturally.
No synthetic record fills missing history.

Accepted notice replay is a separate native responsibility. The native source
report traces accepted-prefix notice recovery on this candidate; raw reasoning
and progress remain live-only. Neither that trace nor this receipt derivation
claims runtime reopen/reconnect/provider parity or gate acceptance.

## Live errors and transient runtime lifecycle

Native/server `error` is live-only with exact `{error:{kind,message,retryable?,
retryAfterMs?}}`. Shared source must reject an accepted error even if a common
change union represents its type. Browser accepted reduction uses the narrowed accepted alias and fails closed on unsupported changes;
there is no accepted notice/terminal conversion. Actual live errors display in
connection-local evidence, never advance a checkpoint and disappear on disconnect/
hydration rather than becoming replayable history.

A real null-seq synchronized turn_ended failure maps to **live `turn_failed`**
with actual turnId/outcome/reason and optional native finalText/cause. The same
name in an accepted envelope retains the existing durable meaning; envelope kind
must not be lost. `presentTerm2SessionView` overlays live failed activity/error
on the existing actual turn only. It creates no turn/result and does not mutate
the accepted turn status, accepted transcript or checkpoint. UI labels the
failure transient/live-only. A later accepted lifecycle supersedes this live
observation; dropping connection-local evidence removes the overlay. Hydration/
current accepted state remains recovery authority, not a persisted live terminal.
The browser does not invent a synchronized snapshot/status_changed event or
reconstruct a missed live failure after reconnect; refresh obtains a real cut.

`model_response_completed` (accepted audit boundary) and `budget_observed`
(snapshot evidence not currently consumed by this browser) remain deliberately
unmapped. Neither becomes cost, notice, status or terminal here. status_changed
has no current native accepted producer; retry_eligibility has none established.
These explicit limits are not full incremental parity claims.

### Incremental-publication failure lesson

Hydration showing a current cut did not establish ongoing message/task parity:
the v2 adapter had fallen through a v1 mapping that dropped those real updates.
Producer, shared parser and consumer must agree on each selected incremental
public change. The browser keeps default unsupported-change failure rather than
silently ignoring a new shared name. Post-freeze verification must exercise
post-hydration root/branch draft replacement and task/call/lifecycle updates,
not just initial snapshots. No new guard, journal or permanent unit test is added.

## Configuration: original receipt versus current discovery

`updateSessionConfig` sends the established HTTP patch: caller-owned
`clientRequestId`, original `expectedRevision`, optional `admission:'idle'`, and
`modelSelection` / `reasoningEffort` / `mode`. The BFF does not re-key/rebase it or
replace it with receipt operation data. Automatic HTTP retries are disabled;
the UI's explicit original-command retry reuses the same object and revision.
New intent gets a new key, not an ambiguous pending retry.

`parseAgentConfigureResultV2` consumes `{schemaVersion:2,sessionId,result}`,
including validated receipt-bearing non-2xx bodies passed through the gateway.
Pending has no configured outcome. Finished/rejected/interrupted, original
configuration, admission revision and optional actual replay provenance are
shown separately. Neither a transport failure nor later discovery becomes a
fabricated original outcome or installed revision.

`readSessionConfig` is separate empty `POST {}` current discovery, retaining the
existing app-owned body and validating session identity. Native numeric defaults
revisions stay numeric. Discovery does not preflight-lock admission. Receipt UI
is session-keyed; late callbacks do not mutate another session. The retry handle
exists only while mounted, not in a durable command outbox. Navigation/reload
loses it; retain the displayed original request/key before leaving unresolved work.

## Activation and evidence limits

Packaging must build/pack the exact independent shared source and update both
Term2 and web-client pins/locks/vendor integrity **after** M6 implementation and
authorization. Server/native/browser/artifact integration must be coherent before gate opening; the explicit option-B raw-stream exception
remains in force, rather than requiring persistence of every transient update.
Source-side support does not prove transport, hydration, accounting, replay or
configuration behavior.

All #65 tests, probes, typechecks, guards, lint, builds, reviews, packaging and
runtime acceptance remain deferred by instruction until all M6 implementation.
No permanent unit tests were added. Existing v1 example tests were not migrated
or run during the freeze; later verification must use allowed integration/e2e/
generated-property routes, not restore permanent unit tests. No end-to-end,
compatibility or fresh-load/replay acceptance is claimed here.
