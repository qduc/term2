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
evidence names). Both belong to the same still-unreleased **0.2.0**, not 0.2.1.
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

The eight new shared names are **accepted only**, not additions to the live
allowlist. `native-state.ts` validates their public application payloads for the
browser and reduces them inside the same atomic accepted batch:

| Change | Consumer meaning |
| --- | --- |
| `cost` | Replace actual `{totalUsd,currency:'USD'}` aggregate state; never increment it |
| `request_cost_recorded` | Upsert actual `{turnId,rootTurnId,parentTurnId?,record}` by `record.requestId`; immutable physical ancestry, later complete records may enrich/correct |
| `goal` | Replace nullable native goal, retain optional actual generation |
| `goal_proposed` | Retain proposal separately; do not activate it |
| `verification` | Replace nullable native verification; do not infer user-task acceptance |
| `notice` | Retain actual `{kind,message}` notice |
| `background_notice_enqueued` | Retain actual `{notice:{id,kind,taskIds,text}}` |
| `background_notices_delivered` | Retain `{clientRequestId,turnId,notificationIds}`; actual silent turn, no foreground turn created |

Cost and request receipts have no additional branch wrapper. Request payload
ancestry already owns the physical request. Branch receipt panels select the
same root records, not new charges. No request sum, aggregate-plus-request sum,
compaction-reference charge, invented currency, pricing estimate or missing
metric default is computed. Null/omitted fields, recorded zero, empty arrays and
signed accounting values remain distinct. Details disclose the measured record
and original outcome, including unknown/unpriced evidence.

`Term2NativeEvidence` also displays actual progress/reasoning/compaction,
queue/tasks and command/configuration evidence. Context estimates and request
references are not billed usage. User-selected **option B** (Discord decision `1566281061087059989`) keeps raw
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

The aligned native base has **no accepted aggregate-cost producer**. Fresh-process
root hydration supplies aggregate cost as previous native projection cost or
null, and notices as previous native projection notices or an empty array; it
does not reconstruct historical cost/notices. Actual request receipts are
retained independently. Browser preservation is not fresh-process parity, and
the vocabulary does not authorize synthesizing missing producers or history.

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
