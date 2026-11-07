# Contract 14 — agent-wire v2 server transport (gated)

**Status:** source implementation for the M6 versioned-wire migration; **not
active** and not a consumer-acceptance claim. Root and web manifests now pin the
vendored `@qduc/agent-wire` 0.2.1 artifact and the browser/BFF request v2, but
`AGENT_WIRE_V2_RUNTIME_AVAILABLE` remains false pending combined-path proof.
The historical artifact/intake prerequisites below are not current build results.

## Direct-host old-client refusal (first #80 slice)

The direct build accepts two bounded compatibility exceptions, not unchanged
v1 parity: explicit v2 atomic events and keyed/revisioned configuration receipts
(including native pending responses). No v1 shim or event journal is supplied.
Alongside those two v2 exceptions, **same-root access conflict** is a named,
reversible #80 exception: one grant per canonical root, with access fixed at
admission. It is not permission to redesign grants or claim other route parity.

`createDirectServerHandler` refuses unqualified events with HTTP 400
`protocol_upgrade_required`, `retryable:false` and
`details.requiredFormat:'agent-wire-v2'` before opening SSE or connecting to the
host. The generic message tells clients to upgrade browser/BFF together. Transport
assertion authentication and route/purpose/session binding precede that refusal;
native session ownership is not queried, and the response discloses no session
existence, owner or configuration.

`configureSession` runs after the existing host connection/ownership check. A
selection patch missing `clientRequestId` or `expectedRevision` receives the same
nonretryable 400 code, naming both required fields and the explicit v2 format,
before preparation or command dispatch. Clients must not invent keys, rebase or
retry the old patch. Empty `{}` discovery remains separate. Recognized formats
are absent, `direct` and `agent-wire-v2`; unknown config formats now reject with
400 validation error, including discovery. Invalid/conflicting format headers
still reject. Existing valid keyed requests and native receipt projection are
unchanged; explicit v2 mutation/SSE still receive the honest unavailable response
while the capability gate is false.

The BFF recognizes this refusal code and supplies its own fixed actionable
message, without forwarding arbitrary upstream messages or details. This slice
does not prove browser/native runtime compatibility or all 21 route purposes;
the old gateway/default CLI contract in Contract 13 is unchanged.

## Same-root access conflict

An owner selecting an already-granted root with different access receives the
existing HTTP 403 `workspace_forbidden`, nonretryable, with the existing access
and operator guidance. Selecting the same access reuses the grant. Ownership is
checked before disclosing access; other-owner and other grant failures retain
their generic errors. The BFF accepts only the `read`/`read_write` access and
`persisted`/`static`/`memory` storage enums and constructs its own message, rather
than forwarding upstream text or paths. The folder selector's existing error
alert displays that message. Write-policy and filesystem checks still precede
the conflict check; a denied write request can therefore retain its generic 403.

### Operator procedure for a persisted dynamic grant

This maintenance procedure removes authority, not conversation data. Confirm that losing access to the
old grant's sessions is acceptable before proceeding; otherwise keep the existing
access. There is no in-place access migration or browser revoke control.

1. Identify the running direct server's effective state directory from its launch
   arguments and environment. `prepareStateDir` in `launch-serve.ts` uses
   an explicit nondefault `--state-dir` (canonicalized). When the requested path
   equals `defaultServeStateDir`, it substitutes the sibling `gateway-next` leaf:
   `$XDG_STATE_HOME/term2-nodejs/gateway-next`, or, with XDG_STATE_HOME unset,
   `$HOME/.local/state/term2-nodejs/gateway-next`. This substitution also applies
   when the default path was explicitly supplied. Do not edit the legacy
   `gateway` directory or assume the BFF owns this file.
2. Stop the server and any other process using that state directory; confirm they
   have exited. Grants are loaded into memory at startup, so editing a running
   server's file neither revokes its active authority nor prevents a later save
   from overwriting the edit.
3. Privately back up `<effective-state-directory>/direct-workspace-grants.json`,
   preserving owner-only permissions (file 0600, directory 0700). Its format is
   an object with `version: 1` and a `grants` array. Identify exactly one entry
   using its canonical `root`, `ownerUserId` and `workspaceId`; confirm its
   `access`. If the file/entry is absent, ambiguous, or malformed, stop rather
   than deleting other records or inventing a replacement.
4. Remove **only that array entry**, preserving `version: 1`, every other entry
   and their fields. Validate JSON before replacing the file; retain its private
   ownership/mode. Do not delete the whole file, change access/IDs/versions in
   place, or edit conversation logs, pairing keys, or replay state.
5. Restart with the same state directory, identity and allowed roots. In the
   browser, check the path again and select the desired access. `read_write`
   still requires `--allow-write` and filesystem write permission. A new grant
   gets a new workspace ID; create a new session under it. Confirm unrelated
   workspace grants remain usable.

Existing direct sessions record the old workspace ID in their `session_started`
binding. Removing that grant makes authorization fail for those sessions even
after re-granting the same root: the new ID does not migrate or reauthorize them.
Their logs remain on disk. Stopping the server also interrupts active work and
connections. A private backup permits operator recovery of the original grant
while stopped, but it must not be restored alongside a new grant for the same
root; duplicate roots/IDs fail startup. This is not a promise of session migration.

Only dynamic records are saved by `saveDynamicGrants` and reloaded by
`loadDynamicGrants` in `host-config-workspace-grants.ts`. Startup-supplied
`staticGrants` are not in that file and cannot be changed by this procedure;
consult the embedding operator's startup configuration instead. The direct
`launchServe` composition supplies no static grants. An embedded authority
without `stateDirectory` has only in-memory dynamic grants; restarting clears
those, not any static inputs. `bindDirectSessionAccess` in
`host-config-access.ts` establishes the old-session limitation above.

## Versions and negotiation

- **v1:** the unqualified `@qduc/agent-wire` envelope remains schemaVersion 1
  and unchanged. The existing canonical route remains unavailable while its
  mappings are incomplete; `format=direct` remains the existing direct
  snapshot/live transport. There is no automatic v1-to-v2 upgrade.
- **v2:** an explicitly negotiated transport, never inferred from `Accept` or a
  package version. SSE and configure mutation use
  `?format=agent-wire-v2`; an optional `x-term2-event-format: agent-wire-v2`
  request header must agree if both are present. Unknown formats are invalid.
  While the combined gate is closed, v2 SSE and configure mutation return
  `503 agent_wire_v2_unavailable` with a required-dependency detail; they do not
  fall back to v1 or direct.

## SSE

Accepted frames are named `event: accepted` and contain exactly one real
accepted FactLine boundary:

```text
event: accepted
id: <real accepted seq>
data: {"schemaVersion":2,"kind":"accepted","sessionId":"...","seq":123,"occurredAt":"...","changes":[...]}
```

The ordered `changes` array is the atomic batch for that seq/at; empty is legal.
One SSE id is the cursor for the whole batch. Seq may be sparse. No sub-event
IDs/timestamps are manufactured. A root change omits `branch`; a child change
carries only the accepted branch identity. Native queue aggregate ID arrays,
rotation identity, context-compaction attempt evidence including real
`turnId`/`compactionId`, history replacement correlation and configure receipts
are retained. The server explicitly maps the proposed accepted-only `cost`,
`request_cost_recorded`, `goal`, `goal_proposed`, `verification`, `notice`,
`background_notice_enqueued` and `background_notices_delivered` names to their
exact native payloads; shared source prior delta `af3d0ff` added those accepted
names and rejects branch wrappers on cost/request receipt. Shared final
`a4bcebc4` now also adds accepted `message`, `task_changed` and `tool_called`,
adds live `error`/`turn_failed`, exports accepted/live change types, and rejects
accepted `error`; the unbuilt artifact keeps the gate closed. `request_cost_recorded` and aggregate `cost` are not branch
wrapped; request records retain physical ancestry and are upsert-only, never a
second charge. Native accepted `message` and `task_changed` are mapped to those
exact requested names with their complete native public payloads; see
“Required remaining accepted vocabulary” below. Changes without a shared name
are not relabelled; the accepted boundary may be an empty batch.

### Accepted/live type boundary

The server source imports the shared exports from `@qduc/agent-wire` rather
than defining a local mirror. The earlier source-only alignment required 0.2.0;
the root and web consumers now pin the locally packaged 0.2.1 artifact, whose
queue-submission validator follows the flattened public projection. Package
installation and captured-frame parsing do not by themselves prove the combined
browser/native path or authorize activation.

- accepted changes use shared `AgentAcceptedChangeTypeV2`; `error` is not in
  that allowlist;
- live changes use shared `AgentLiveChangeTypeV2`, including `error` and
  `turn_failed`;
- the general shared `AgentChangeTypeV2` includes both, but envelope kind
  narrows the batch.
  `turn_failed` is a normal accepted terminal and also the transient
  synchronized-failure name; kind and absence of a cursor distinguish them.
- The server rejects an accepted error before constructing the envelope and
  rejects a branch wrapper on `task_changed`; shared `a4bcebc4` does the same.

### Required remaining accepted vocabulary (M6)

The candidate native producer has two concrete accepted changes that were
previously dropped and that M6 transcript/task-history parity needs:

- `message`: exact `{message: WireMessage, replacesDraftId?: string}` from the
  accepted `item` fact. The message retains its real `id`, role, content/text,
  optional turn/modelStep/execution identity, error/draft flags and exact
  replacement relation. No provider history or private content is added.
- `task_changed`: exact `{change: task_started|task_backgrounded|task_stop_requested|task_finished,
  at: number, task: WireTask}` from the accepted task fact. Preserve the task's
  actual optional input/name/role/model/mode/timestamps/progress/result and
  `toolUseCounts`; absent and empty remain distinct. A stop request or child
  terminal is not task completion.

The server source maps these names now and imports the shared final
`a4bcebc4` allowlists/types directly. Shared adds them to the accepted
allowlist, validates their payloads, exports
`AgentAcceptedChangeTypeV2`/`AgentLiveChangeTypeV2`, and rejects accepted
`error`; the server no longer copies that vocabulary. Browser reduction remains
external intake; the 0.1.0 artifact remains a build/activation dependency. Until
that combined intake is complete, the v2 gate stays closed and an activation
attempt with these names would be invalid, not silently downgraded.

`status_changed` is not added by this step: the candidate native producer has
no accepted `status_changed` fact. Status is current snapshot state and the
existing accepted lifecycle events; inventing a status event would fabricate
replay provenance. If a native accepted status producer is added later, it
needs a separate exact `{status}` contract and consumer intake.

### Tool calls and transient runtime errors

- `tool_called` is a real accepted native fact emitted before a physical
  `tool_started`. It carries the exact `{tool: WireTool}` public descriptor
  (`status:'called'`, actual execution/call/turn identity and public input), and
  may be branch-scoped. It is needed for an accepted pending tool call that has
  not reached physical start; it must not be relabelled as `tool_started` or
  discarded. The server maps it now; shared/browser intake is required.
- `error` is a native **transient** observation: `DirectProjection` publishes it
  with `seq:null` when synchronized runtime error state appears. It carries
  `{error: WireError}` only. The server maps it as `event: live` and refuses any
  accepted error boundary; consumers must not checkpoint it or infer a durable
  terminal.
- `turn_failed` is the companion **live-only** lifecycle change for the same
  synchronized runtime failure. Native `synchronize` emits a null-seq
  `turn_ended` with the active turn and failed terminal; the server maps it
  through the existing canonical failed-terminal shape as `event: live`
  (`turnId`, failed outcome/reason, and any real cause). It has no SSE id, seq,
  `occurredAt` or replay position, and is not an accepted terminal. It settles
  the client's visible activity without claiming durable history; hydration and
  the last accepted terminal remain authority. A synchronized state `snapshot`
  is not re-emitted as a cursor-bearing event.
- `status_changed` is not synthesized for this path: the native producer emits
  no accepted or transient status event; status is represented by the transient
  failed terminal plus the current snapshot/hydration state.
- `model_response_completed` is accepted native audit with modelStep/stopReason/
  optional costUsd, but the shared reducer has no public state change and no
  current M6 client consumes it. It is not mapped in this step; do not synthesize
  a cost/terminal from it.
- `budget_observed` is accepted native evidence retained in the direct snapshot's
  `budgetObservations`, but no current M6 client behavior consumes that field.
  It is not mapped in this step; budget-opened/closed authority remains separate.

These are explicit remaining vocabulary gaps, not parity claims.

Live frames are named `event: live`, have no SSE id or seq/time fields, and carry
only the shared v2 live change types. They never advance a resume checkpoint and
do not claim replay parity. Reconnect uses the last fully applied accepted seq.

## Hydration and replay

V2 SSE has no snapshot frame. A separate current-accepted hydration route is
`GET /sessions/:id?format=agent-wire-v2`; it returns seq plus the exact public
direct `WireSnapshot`, a same-cut InteractionDTOv1 resolver field, and real
earliest replay metadata. It is not a replay event and has no synthetic
timestamp. The snapshot does not reconstruct fresh aggregate cost or historical
notices; those remain native-owner gaps and must not be fabricated from request
records, task metadata or compaction estimates.

Native ORIGINAL `838664750acec8a65de2526a7712c743e9d17989` supplies optional
`branches: WireBranchSnapshot[]` at the same outer cut. When integrated, the
server passes it through unchanged: `[]` means real no accepted branch_started
and an absent field means capability unavailable; each entry keeps actual
`branchId/taskId/turnId`, optional recorded ancestry, `acceptedSeq` (not a
reconnect cursor), accepted transcript/tool/order, pending interactions/budgets,
turn results, nullable usage/reasoning, terminal/notices, requestCosts views and
`queue:null`. RequestCosts are selected views by producing child turnId, never
additional charges; root queue is never copied. Raw reasoning/progress are not
reconstructed. See `m6-v2-hydration-interface.md` for the exact client sequence
and gaps.

## Interaction identity

Native interaction request IDs can contain colon-delimited turn and sequence
components (for example, `turn-1:question:1`). The browser projection, BFF
interaction route and private host interaction route accept letters, digits,
underscore, hyphen and colon, up to 256 characters. Session IDs keep their
separate, narrower validation. A browser happy-path test alone does not cover
this boundary: exercise both a real approval and a real rejection through the
native interaction route when changing it.

## Configure receipts

`POST /sessions/:id/config?format=agent-wire-v2` keeps the established HTTP
mutation patch (`clientRequestId`, original `expectedRevision`, optional idle
admission and selection fields). The request operation in the native receipt is
evidence, not a replacement for the caller's patch. Mutation responses use
`{schemaVersion:2,sessionId,result:<native configure result>}`, preserving
pending/configured/rejected/interrupted/non-receipt outcomes, original receipt
revision, optional replayed provenance and the established safe diagnostic
redaction. Empty `{}` remains the separate current-state discovery response; it
is not the original mutation result.

Direct discovery reports native profile labels, including `bare` and `pair`;
these are not the older gateway's mode enum. The browser must accept both or
it silently loses the configuration controls after a successful discovery.
The direct mutation path accepts `bare` but not `pair`, so the browser displays
a current `pair` profile without offering it as a new selection. Exercise actual
discovery as well as configuration receipts when changing this boundary.

## Migration and limits

The shared package source code and documentation own the v1/v2 schema and local artifact route.
The 0.2.1 artifact is locally vendored and installed in both consumers; it has
not been published. The gate remains closed until the combined browser parser,
atomic reducer, sparse cursor, hydration/replay and BFF configuration paths have
independent verification. Until then no v2 runtime support, replay
parity, fresh branch history, aggregate cost reconstruction, complete M6
transcript/task-history/tool-call delivery, model-response/budget-observation
delivery or M6 completion is claimed.
