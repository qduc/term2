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
exact native payloads; the shared 0.2.0 source must add those names before the
gate can open. `request_cost_recorded` and aggregate `cost` are not branch
wrapped; request records retain physical ancestry and are upsert-only, never a
second charge. Changes without a shared name (for example generic `message` or
task history) are not relabelled; the accepted boundary may be an empty batch.

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
parity, fresh branch history, aggregate cost reconstruction or M6 completion is
claimed.
