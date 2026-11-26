# Contract 14 — agent-wire v2 server transport

**Status:** the root and browser/BFF pin the source-built vendored
`@qduc/agent-wire` 0.2.3 artifact. `AGENT_WIRE_V2_RUNTIME_AVAILABLE` is **true**.
Explicit v2 hydration, events and configuration mutations use the native
Session contract below. Matching native/BFF/browser acceptance and independent
activation review include background `ask_orchestrator` open/answer/close,
pending and settled hydration, and accepted-cursor reconnect.

Task descriptors preserve `pendingQuestion`, native tool tracking and the last
activity observation. These fields are validated by the shared package, not
removed or relabeled to fit a parser. Wire 0.2.2 accepted question names but
rejected the tracking carried by real child tool execution; 0.2.3 fixes that
boundary. See [wire package ownership](../../vendor/README.md).

## Access and compatibility

The HTTP host is a transport/access adapter over the native Session and protocol.
It never drives turns, writes conversation state, or persists admission dedupe.
Session owns original admissions and their `clientRequestId` replay.

All 21 assertion purposes in `src/host/server-contracts.ts` bind to the methods
and paths in `server-routes.ts`. The existing RS256 assertion validation, issuer,
audience, expiry, one-use replay ledger, route purpose/session binding, local-owner
checks, native session ownership, canonical workspace admission and read/write
posture remain authorities. Pairing registers the BFF key, not a browser key.
Concurrent first-page requests may share a registration attempt; after a competing
registration, the BFF retries authentication once with a fresh assertion. A retry
never bypasses signature validation or invents a command/admission key.

The compatibility aliases are `POST /` for creation and both GET/POST
`/private/agent/v1/workspaces`. The private session-read route is **POST**
`/private/agent/v1/sessions/:sessionId`, including v2 hydration. The browser's
public GET is translated to that POST by the BFF.

There are two bounded wire exceptions: explicitly negotiated v2 atomic events
and keyed/revisioned configuration receipts, including pending results. There is
no v1 shim, automatic fallback, generated request key or revision rebasing.
Same-root access conflict below is the separately named access exception.

Unqualified events refuse with HTTP 400 `protocol_upgrade_required`,
`retryable:false`, and `details.requiredFormat:'agent-wire-v2'`, after assertion
and route binding checks but before connecting to the Session. This refusal
reveals no session existence or owner. An unkeyed configuration mutation refuses
with the same code after the normal connection/ownership check, before dispatch,
and names `clientRequestId` and `expectedRevision`. Empty `{}` configuration
discovery remains separate. The BFF supplies fixed actionable messages instead
of forwarding arbitrary upstream diagnostics.

## Same-root access conflict

An owner selecting an already-granted root with different access receives the
existing HTTP 403 `workspace_forbidden`, nonretryable, with the existing access
and guidance. Selecting the same access reuses the grant. Ownership is
checked before disclosing access; other-owner and other grant failures retain
their generic errors. The BFF accepts only the `read`/`read_write` access and
`persisted`/`static`/`memory` storage enums and constructs its own message, rather
than forwarding upstream text or paths. The folder selector's existing error
alert displays that message. Write-policy and filesystem checks still precede
the conflict check; a denied write request can therefore retain its generic 403.

### Changing or removing a grant

A persisted or in-memory dynamic grant is changed in place with
`PUT /private/agent/v1/workspaces/:workspaceId/access` or removed with
`DELETE /private/agent/v1/workspaces/:workspaceId`; the web folder picker's
saved-folder menu calls them. Contract 13, "Saved folder edits", has the
status codes and live-session behavior. Stopping the server to hand-edit
`direct-workspace-grants.json` is no longer needed.

Existing direct sessions record the grant's workspace ID in their
`session_started` binding and its access in `workspaceIdentity`. After an
access change, an older session reopens with the narrower of that access and
the current grant (`bindDirectSessionAccess.resolveStoredRoot` in
`host-config-access.ts`; the session store refuses anything wider than the
recorded access). A removal stops them for good: re-granting the same root issues a new ID that
does not reauthorize them. Their logs remain on disk.

Startup-supplied `staticGrants` are not in the grant file and both routes refuse
them (`409 workspace_grant_static`); consult the embedding operator's startup
configuration instead. The direct `launchServe` composition supplies no static
grants. An embedded authority without `stateDirectory` has only in-memory
dynamic grants; restarting clears those, not any static inputs.

## Negotiation

V2 SSE, hydration and configuration use `?format=agent-wire-v2`. An optional
`x-term2-event-format: agent-wire-v2` header must agree with query negotiation.
SSE/configuration reject unknown or conflicting formats. `format=direct` remains
the explicit native snapshot/live transport; it is not a browser fallback.
`format=direct-wire-v2` (SSE only) sends native `WireEvent`s unchanged, one
`accepted`/`live`/`snapshot` frame per Session publication, for clients that fold
with the shared fold (`src/protocol/fold/`). Its envelope and ordering rules are
in `src/host/server-sse.ts` and the web transcript build spec, section 2.1.
Unqualified events are refused, rather than automatically upgraded to v2.
Older gated server builds refuse explicit v2 requests with `503 agent_wire_v2_unavailable`; use matching server and browser builds.

## Atomic events and reconnect

An accepted frame is `event: accepted`, with exactly one real accepted FactLine
boundary: `{schemaVersion:2,kind:'accepted',sessionId,seq,occurredAt,changes}`.
Its SSE `id` is that seq. The ordered changes form one atomic batch; an empty
batch is legal and sequences may be sparse. Consumers checkpoint only after the
whole batch succeeds, ignore duplicate accepted batches, and never manufacture
per-change IDs, timestamps, missing history or contiguous sequences.

Input messages from native `turn_started` and queue steering are `message`
changes in their original accepted batch. They keep actual message IDs, content
and turn ownership; message IDs are not replaced with turn IDs. Accepted final
messages keep draft-replacement correlation. Tool calls, starts, results, task
metadata and branch identity preserve native evidence; an unmatched result does
not create an invented tool name, start or turn.

Live frames are `event: live`, have no SSE id, seq or timestamp, and never advance
a checkpoint. They contain only the pinned live vocabulary, including transient
`error`/`turn_failed`. A transient failure settles visible activity without
claiming an accepted terminal. Raw reasoning/progress may be unavailable after
reconnect; accepted summaries/final results remain authority.

V2 SSE has no snapshot frame. The transport flushes headers and an immediate SSE
comment so the BFF/browser can connect to an idle session without waiting for the
next event or heartbeat. Comments carry no cursor or history. Only blank-line
terminated SSE frames dispatch; EOF does not complete a truncated batch.

Reconnect requests the last fully applied accepted seq. Native capture supplies
the tail `(fromSeq,toSeq]`, synchronized transient state and then live updates,
in that order; no current snapshot is prepended to the tail. A full socket
buffer makes the stream wait for drain rather than disconnect; a subscriber whose
frame writes stay backpressured for 10 s in total (stopped, or reading slower
than the Session emits) is detached. Disconnect and that detach release only the
subscriber attachment, not the Session. A refused
replay remains explicit; the browser stops on `replay_unavailable`/410 and offers
an explicit new hydration cut, without a live-only fallback.

## Hydration

Private **POST** `/private/agent/v1/sessions/:id?format=agent-wire-v2` with `{}`
returns `{schemaVersion:2,kind:'snapshot',sessionId,seq,snapshot,interaction,
earliestReplayableSequence}`. It is a current accepted projection, not a replay
event, and has no fabricated occurrence timestamp. Snapshot/envelope cursors
must match. The pending InteractionDTO resolver uses the same snapshot cut.
Open SSE with `after=seq` after installing this snapshot once.

Optional `branches` are native read models at the enclosing root cut. `[]` means
no accepted branches; absence means capability unavailable. Each entry retains
its actual branch/task/turn identity and ancestry, accepted transcript/tool
order, pending interactions/budgets, results and selected request receipts.
`acceptedSeq` is observation provenance, not another reconnect cursor. Branch
`queue:null` means unavailable; the root queue is never copied into it. A
result-only timeline slot remains exact evidence without a guessed tool card.

## Cost evidence

Native aggregate `cost` and physical request receipts are separate contracts.
An aggregate `cost` event is an absolute `{totalUsd,currency:'USD'}` observation,
never an increment. Current native hydration can report `cost:null`; this means
unavailable, not zero. The server/browser must not reconstruct a session bill
from partial usage, task metadata, compaction estimates or selected receipts.

`request_cost_recorded` keeps the complete native request record and real
turn/root/parent ownership. Root receipt state upserts by physical `requestId`;
a correction replaces the earlier record, and duplicate delivery is not another
charge. Branch receipts select the same root charges and are never added again.
The browser's separately labeled known receipt subtotal describes only supplied
receipts, with exact/estimated/partial/unavailable pricing and unknown historical
coverage. It is never added to a native aggregate or presented as a complete bill.

## Interactions and configuration

Native interaction IDs may contain colons, e.g. `turn-7:question:1`. Projection,
BFF requests, native routes and browser response validation accept
`[A-Za-z0-9_:-]{1,256}` for these IDs. Session IDs retain their narrower validation.
Approval and rejection must travel through the native resolver. A settled abort
retains `abortStatus:'terminal_accepted'`; this is evidence of accepted terminal
state, not inferred physical cleanup.

Configuration mutations retain the caller's original `clientRequestId` and
`expectedRevision`, optional idle admission, and selection patch. Responses are
`{schemaVersion:2,sessionId,result:<native configure result>}`, including pending,
finished, rejected/interrupted and non-receipt outcomes. Pending means no installed
outcome yet. Same-key lookup preserves the original receipt/revision and replayed
provenance. Native failure results can arrive on non-2xx HTTP; the BFF preserves
the versioned result while applying safe diagnostic redaction. Neither BFF nor
browser re-keys, rebases or automatically retries an old patch.

Current-state discovery is a separate empty `{}` request and cannot stand in for
a mutation's original outcome. The browser offers Standard/Bare/Lite; retained
aliases resolve to Bare. A captured `pair` label can be displayed without offering
it as a new selection. Removed Plan/Mentor/Orchestrator profiles are not offered.
Native command/replay error codes retain their HTTP status through the BFF with
fixed safe text, instead of being masked as generic gateway failures.

## Migration and activation

The direct launcher uses a separate state directory and preserves old gateway and
conversation data. Conversation migration is outside this contract (#148). Never
restore the legacy runtime or point the native writer at old gateway data.

Activation still requires a corrected artifact built by the shared-package owner,
matching root/web pins, combined browser/native acceptance including background
questions, and independent approval of the combined evidence. No deployment,
npm publication, aggregate reconstruction, raw live-stream replay parity, branch
queue support, or protocol support for unmapped native model-response/budget audit
facts is implied. The operator topology is documented in the
[web gateway setup](../../website/src/content/docs/remote/web-gateway.md).
