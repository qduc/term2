# Contract 14 — agent-wire v2 server transport (gated)

**Status:** source implementation for the M6 versioned-wire migration; **not
active** and not a consumer-acceptance claim. The shared `@qduc/agent-wire`
artifact is still the pinned 0.1.0 package, which has no v2 parser. Canonical
SSE/configuration gates remain closed until the shared v2 artifact, browser/BFF
migration and this server path are combined. All verification is deferred under
the evidence-driven-development freeze.

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
exact native payloads; shared source delta `af3d0ff` now adds those accepted
names and rejects branch wrappers on cost/request receipt, but the unbuilt
artifact keeps the gate closed. `request_cost_recorded` and aggregate `cost` are not branch
wrapped; request records retain physical ancestry and are upsert-only, never a
second charge. Native accepted `message` and `task_changed` are mapped to those
exact requested names with their complete native public payloads; see
“Required remaining accepted vocabulary” below. Changes without a shared name
are not relabelled; the accepted boundary may be an empty batch.

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

The server source maps these names now. The shared v2 source must add them to
the accepted allowlist and validate their payloads; the browser must reduce
them. Until that cross-owner intake is complete, the v2 gate stays closed and
an activation attempt with these names would be invalid, not silently downgraded.

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
  terminal. It may accompany a transient `turn_ended`/snapshot update that is
  not representable as accepted v2 evidence.
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

## Migration and limits

The shared package source/docs own the v1/v2 schema and local artifact route.
This server file is source-only; it does not build, pack, publish, edit the
vendored tarball, migrate browser/BFF code, or activate the gate. The next
combined migration must update both consumer pins plus the browser parser,
atomic reducer, sparse cursor, hydration/replay and BFF config handling, then
provide independent verification. Until then no v2 runtime support, replay
parity, fresh branch history, aggregate cost reconstruction, complete M6
transcript/task-history/tool-call delivery, model-response/budget-observation
delivery or M6 completion is claimed.
