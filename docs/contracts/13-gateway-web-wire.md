# Contract 13 — Gateway ↔ ChatForge Web Wire

**Status:** M0 deliverable of [web client gateway completion](../plans/web-client-gateway-completion.md).
Docs-only; records the wire as it exists at term2 source commit `fbec9bb6` (branch
`wg-m0-wire`). Nothing here is merged, and no production file changed.

This record is an **inventory**, not the executable-seam shape of Contracts 01–12 in
[README.md](./README.md). Those assume one cross-owner seam with invariants, settlement,
and a public test boundary. M0's subject is the whole wire surface between two
repositories, so it uses the five sections the plan prescribes: routes, auth, events,
gaps, mismatches. A later milestone that repairs a seam here should get its own
seam-shaped record.

**Sources read for this record.** term2: `source/gateway/gateway.ts`, `contracts.ts`,
`assertion.ts`, `pairing.ts`, `trusted-clients.ts`, `server.ts`,
`interaction-protocol.ts`, `persistence/{contracts,projection,coordinator,session-index,interaction-checkpoint}.ts`,
and `source/services/conversation/conversation-events.ts`. ChatForge
(`~/chat-term2-integration/chat/`, read-only): `backend/src/lib/term2GatewayClient.js`,
`backend/src/routes/agentGateway.js`, `backend/src/lib/agentProtocol.js`,
`backend/src/lib/term2LocalControlBroker.js`, `frontend/lib/term2/event-adapter.ts`,
`frontend/lib/term2/types.ts`, `frontend/lib/api/term2.ts`, `frontend/hooks/useTerm2Session.ts`.
The ChatForge checkout is a git repository at `~/chat-term2-integration/chat`, on branch
`integration/v1-chat`, HEAD `2757fbd87cce0153146b51cf279b9a140856bc7c`. Every ChatForge claim
below is pinned to that revision, together with the file and symbol that carries it.

## 1. Routes

Every gateway route is matched by `matchPrivateRoute` in two steps: a literal path, then a
purpose assertion that must equal the route's purpose. The table's "Purpose" column is the
`ASSERTION_PURPOSES` value the assertion must carry.

| Gateway method + path | Purpose | Request | Success response | BFF caller |
| --- | --- | --- | --- | --- |
| `POST /private/agent/v1/pairing/register` | none — the only route that takes no assertion | `{ publicKeyPem, otp }` (`isPairingRegisterBody`; otp is exactly six digits) | `200 { paired: true, kid, fingerprint }` | `Term2GatewayClient.pair()` |
| `GET` or `POST /private/agent/v1/workspaces` | `workspace_list` | `?limit=1..50` | `200 { workspaces: [{ workspaceId, label, access }], nextCursor: null }` | BFF route `GET /agent/workspaces` → `Term2GatewayClient.request()` (GET is canonical; POST is a tested compatibility alias) |
| `POST /private/agent/v1/workspace/candidates/validate` | `workspace_candidate_validate` | `{ absolutePath }` | `200` validator result | BFF route `POST /term2/workspace/candidates/validate` → `createForwarder` |
| `POST /private/agent/v1/workspace/candidates/browse` | `workspace_candidate_browse` | `{ candidateId, child? }` | `200` browse result | BFF route `POST /term2/workspace/candidates/browse` → `createForwarder` |
| `POST /private/agent/v1/workspace/candidates/select` | `workspace_candidate_select` | `{ candidateId, access }` | `200` select result including `binding` | BFF route `POST /term2/workspace/candidates/select` → `createForwarder` |
| `GET /private/agent/v1/models` | `model_list` | — | `200 { models: [{ provider, id, name?, default_reasoning_level?, contextWindow? }] }` | BFF route `GET /term2/models` → `Term2GatewayClient.request()` |
| `GET /private/agent/v1/settings` | `settings_read` | — | `200` `buildSettingsProjection(settings, access)` | `Term2LocalControlBroker.getSettings` ← BFF route `GET /term2/settings` |
| `PUT /private/agent/v1/settings` | `settings_write` | `{ expectedRevision, changes: [{ key, value }] }` (`isSettingsWriteBody`) | `200 { committed: true, revision, projection }` | `Term2LocalControlBroker.putSettings` |
| `POST /private/agent/v1/credentials/:credentialId` | `credential_write` | `{ value }` | `200` `setCredential` result | `Term2LocalControlBroker.setCredential` |
| `DELETE /private/agent/v1/credentials/:credentialId` | `credential_delete` | — | `200` `deleteCredential` result | `Term2LocalControlBroker.deleteCredential` |
| `POST /private/agent/v1/oauth/:provider/login` | `oauth_login` | — | `200` login result | `Term2LocalControlBroker.oauthLogin` |
| `POST /private/agent/v1/oauth/:provider/select` | `oauth_select` | `{ accountId }` | `200` select result | `Term2LocalControlBroker.oauthSelect` |
| `DELETE /private/agent/v1/oauth/:provider/accounts/:accountId` | `oauth_delete` | — | `200` delete result | `Term2LocalControlBroker.oauthDelete` |
| `POST /private/agent/v1/sessions` | `session_create` | `{ workspaceId }`, and nothing else — `isSessionCreateBody` rejects other keys; `model`/`reasoningEffort`/`mode` produce `422 model_selection_deferred` | `201` in both branches — `{ session }` when `config.persistence` is present, otherwise `{ sessionId, workspaceId, accepted }` | BFF routes `POST /term2/sessions` and `POST /agent/sessions` → `createForwarder` |
| `POST /` (legacy) | `session_create` | `null` | same as above | Not called: `safeRpcPath` requires the `/private/agent/v1/` prefix |
| `GET /private/agent/v1/sessions` | `session_list` | `?limit=` and `?cursor=` | `200 { sessions: [{ id, workspaceId, status, createdAt, updatedAt, latestSequence }], nextCursor }` from `GatewaySessionIndex.list` | BFF route `GET /agent/sessions` → `createForwarder` (the BFF replaces its public cursor with the stored upstream cursor) |
| `POST /private/agent/v1/sessions/:sessionId` | `session_read` | — | `200 { session }` — `toSessionProjection` | BFF routes `GET /agent/sessions/:sessionId` and `GET /term2/sessions/:sessionId`; `#requestOnce` forces the upstream method to POST for this purpose |
| `POST /private/agent/v1/sessions/:sessionId/messages` | `message_submit` | `{ text, clientRequestId }` only, text 1..128000 chars | `202 { sessionId, clientRequestId, turnId, accepted, replayed }` | BFF route `POST /agent/sessions/:sessionId/messages` → `createForwarder` |
| `POST /private/agent/v1/sessions/:sessionId/abort` | `abort` | `{ turnId }` only | `202 { sessionId, turnId, accepted: true }`, or `200 { sessionId, turnId, accepted: false, alreadySettled: true }` | BFF route `POST /agent/sessions/:sessionId/abort` → `createForwarder` |
| `GET /private/agent/v1/sessions/:sessionId/events` | `events_connect` | `?after=` (0 or a positive integer, at most 15 digits) | `200` `text/event-stream` (see §3) | BFF route `GET /agent/sessions/:sessionId/events` → `Term2GatewayClient.stream()` |
| `POST /private/agent/v1/sessions/:sessionId/config` | `session_update` | `{ model?, reasoningEffort?, mode? }` (`isSessionUpdateBody`) | `200` `sessionConfigProjection(session)` | `Term2LocalControlBroker.sessionUpdate` ← BFF route `POST /term2/sessions/:sessionId/config` |
| `POST /private/agent/v1/sessions/:sessionId/interactions/:interactionId` | `interaction_resolve` | `{ revision, answer, rejectionReason?, approvalAnswer? }` (`isInteractionResolveRequest`) | `202 { sessionId, turnId, interactionId, accepted: true }`, or `200 { accepted: false, interaction }` for an ask_user follow-up question | BFF route `POST /agent/sessions/:sessionId/interactions/:interactionId` → `createForwarder` |

Every gateway route except the legacy `POST /` alias has a BFF caller; `POST /` is unreachable from the BFF because `safeRpcPath` requires the `/private/agent/v1/` prefix. The BFF declares one path constant it
never uses — `rpc.sessionConfig` in `term2GatewayClient.js` is shadowed by the broker's own
`RPC.sessionConfig`, which is the one actually sent.

**Server-level gates (`GatewayServer.#handle`), independent of the route table.** Only
`GET`, `POST`, `PUT`, and `DELETE` are accepted (`405 protocol_conflict` otherwise). A
non-GET request with a non-JSON `content-type` is rejected `415 unsupported_media_type`.
Bodies are capped at `MAX_REQUEST_BYTES` (1 MiB) with `413 request_too_large`, and
unparseable JSON gives `400 validation_error`. A malformed `x-correlation-id` (pattern
`CORRELATION_ID_PATTERN`) gives `400 validation_error`. Any handler throw becomes
`503 gateway_unavailable` with `retryable: true`, unless headers were already sent.

**Assertion/route coupling.** `Term2Gateway.#handleRpc` rejects a route whose purpose does
not match the assertion (`400 protocol_conflict`), a session-scoped path whose
`:sessionId` differs from `claims.sessionId` (`400 protocol_conflict`), and an unmatched
path (`404 not_found`). `isClaims` in `assertion.ts` is the second gate: purposes
`workspace_list`, the three candidate purposes, `settings_*`, `credential_*`, `oauth_*`,
`session_list`, and `model_list` must carry **no** `workspaceId` or `sessionId`;
`session_create` must carry `workspaceId` and no `sessionId`; `session_update` must carry
`sessionId` and may not carry `workspaceId`; every other purpose requires `sessionId`. The
BFF mirrors both rules in `createAgentAssertion`, so its own construction throws
`validation_error` before the request is sent.

## 2. Auth

### The assertion header

The one credential header is `x-term2-assertion`, read in `GatewayServer.#handle`. It is
absent or unverifiable → `401` with code `pairing_required` when a pairing handler is
configured, and `authentication_required` otherwise. The verifier's own failure codes
(`malformed`, `invalid_signature`, `unknown_key`, `invalid_claims`, `expired`,
`not_yet_valid`, `replay`, `wrong_purpose` — `GatewayAssertionError`) are deliberately not
disclosed; every one maps to the same 401 body.

`Term2GatewayClient.#requestOptions` sends exactly `accept: application/json`,
`content-type: application/json`, a `content-length` when a body serializes, the optional
`x-term2-assertion`, and `x-correlation-id`. It never copies a browser `authorization`
header. `#streamOnce` hard-codes the assertion purpose to `events_connect` and the query to
`^$|\?after=\d{1,15}$`.

### Claims

| Claim | Gateway type (`GatewayAssertionClaims`) | Verifier rule | BFF value (`createAgentAssertion`) |
| --- | --- | --- | --- |
| `iss` | string | must equal the configured issuer | `config.term2Gateway.issuer` |
| `aud` | string | must equal the configured audience | `config.term2Gateway.audience` |
| `sub` | non-empty string | not otherwise constrained | the authenticated `req.user.id` — never a browser token |
| `purpose` | `AssertionPurpose` | `isAssertionPurpose`; must match the route unless it is the legacy `POST /`; `wrong_purpose` when an expected purpose is passed | the operation's purpose |
| `iat`, `nbf`, `exp` | integers | `nbf <= now + skew`; `exp > now - skew`; `exp > iat`; `exp - iat <= MAX_ASSERTION_LIFETIME_SECONDS` (60) | `nbf = now - clamp(clockSkewSec, 0, 30)`; `exp = now + clamp(ttlSec, 1, 60)` |
| `jti` | non-empty string | consumed once through the `ReplayLedger`; a second use is `replay` | fresh `randomUUID()` |
| `ver` | literal `1` | must be 1 | `1` |
| `workspaceId` | optional string | required for `session_create`; forbidden for the list/global purposes and `settings_*`/`credential_*`/`oauth_*`/`session_update` | sent only where permitted |
| `sessionId` | optional string | required except for the list/global and `session_create` purposes; forbidden on `session_create` and the globals | sent only where permitted |

Signing and verification are `RS256` over `base64url(header).base64url(claims)` with
`typ: JWT` and the key id in the JWT header. `AssertionVerifier` resolves `kid` against
configured public keys plus any key added by `addTrustedKey` after pairing; an unknown
`kid` is `unknown_key`. Clock skew above 30 s is rejected at construction.

### OTP pairing

1. `GatewayPairing` issues a six-digit OTP at construction when pairing is enabled and the
   trust store is empty, printing it through `printOtp` (default `PAIRING OTP: <otp>`).
   `DEFAULT_OTP_TTL_MS` is 5 minutes and `DEFAULT_MAX_ATTEMPTS` is 3; a wrong OTP consumes an
   attempt, and exhausting attempts discards the OTP and issues a new one.
2. The BFF calls `Term2GatewayClient.pair()`, which reads the private key from
   `gatewayConfig.privateKeyPath`, derives the SPKI PEM public key, and posts
   `{ publicKeyPem, otp }` to `/private/agent/v1/pairing/register` with a fresh correlation id
   and no assertion. A non-six-digit `pairingOtp` throws `pairing_invalid` client-side.
3. Registration is single-client: once `TrustedClientsStore.size > 0`, `GatewayPairing.register`
   throws `pairing_not_allowed`, and the gateway's pairing handler reports that as
   `401 pairing_required` — the same code it uses for a missing/expired OTP. Revocation is by
   deleting the trust file and restarting (the handler comment on `pairing.trustFilePath`).
4. On success the gateway stores the key and returns `{ paired: true, kid, fingerprint }`,
   and adds the key to the live verifier through `addTrustedKey`.
5. Automatic (re)pairing: `#retryAfterPairing` wraps `request`/`stream`; on a
   `pairing_required` error, when pairing is enabled and `pairingComplete` is false, it calls
   `pair()` once and retries the original operation once.

### Fingerprint and kid

`TrustedClientsStore.normalizePublicKey` sets `fingerprint` to the lowercase hex SHA-256 of
the key's SPKI DER, and `add` stores the client under that fingerprint — so **kid equals
fingerprint** for a paired client. The BFF computes the same digest in
`#assertionKeyId` when `pairingEnabled` and asserts `result.kid === expectedKid`, else throws
`gateway_unavailable`. With pairing disabled the BFF signs under the configured
`gatewayConfig.keyId` instead — the pre-paired/fixture path. Neither side keeps a shared
pairing secret: the BFF stores only the boolean `pairingComplete` in memory, and the signing
key stays the process-local private key.

### Local-owner gate

`LOCAL_OWNER_PURPOSES` = `settings_read`, `settings_write`, `credential_write`,
`credential_delete`, `oauth_login`, `oauth_select`, `oauth_delete`. For those,
`#handleRpc` requires `claims.sub === config.localOwnerUserId` and otherwise returns
`403 settings_forbidden`. Since `sub` is the ChatForge user id, those seven operations are
available only to the one user the launcher names. Every other purpose is reachable by any
`sub` the BFF asserts for. The BFF also has its own gate — its local-owner middleware
rejects non-local owners on the `/term2` routes with `403 local_owner_required` — but that
code is BFF-side vocabulary; the gateway never emits it.

## 3. Events

The gateway publishes one journal event per session. Its vocabulary is frozen by
`FROZEN_AGENT_EVENT_TYPES` (29 types after M4), and `isPublicEventEnvelope` is the gate every
published frame must pass: `schemaVersion === 1`, integer `id`, opaque `sessionId`, a type
in that list, an ISO `occurredAt`, and a payload that only uses keys from
`PUBLIC_EVENT_PAYLOAD_KEYS` (nesting to depth 8, arrays ≤ 512, strings ≤ 32000 chars).
A frame that fails that gate is not sent — `writeEvent` calls `closeSlowSubscriber`, which
destroys the SSE response.

| Wire type | Origin | Payload | `applyTerm2Event` case |
| --- | --- | --- | --- |
| `session_created` | gateway — `GatewayPersistenceCoordinator.create` appends it when it creates the session | `{}` | handled — sets view status `connected` |
| `user_message_accepted` | gateway — `Term2Gateway.#submitMessage` `acceptedEvent` | `{ turnId, clientRequestId, messageId }` | handled — requires `messageId === turnId`, appends a user turn using `payload.text` (**absent on the wire**, see §5) |
| `user_message_rejected` | gateway — `#submitMessage` queue-discard path and `#abortSession` for discarded turns | `{ turnId, clientRequestId?, reason }` | handled — marks the turn `rejected` |
| `assistant_started` | gateway — `#submitMessage` `beforeCommit` critical journal append | `{ turnId }` | handled — flips the turn to assistant, status `streaming` |
| `text_delta` | `mapConversationEvent` ← `ConversationEvent` `text_delta` | `{ turnId, delta }` (bounded 8192) | handled |
| `reasoning_delta` | `mapConversationEvent` ← `reasoning_delta` | `{ turnId, delta }` (bounded 8192) | handled |
| `tool_started` | `mapConversationEvent` ← `tool_started` | `{ turnId, callId, toolName }` (toolName bounded 256) | handled — reads optional `argumentsText`, which the gateway never sends |
| `command_message` | `mapConversationEvent` ← `command_message` | `{ turnId, callId, toolName, status, output?, error?, message }` | fixed by M4 |
| `approval_required` | `mapConversationEvent` ← `approval_required`, binding minted by `#interactionBindingFor` | `{ turnId, interaction }` — `PendingInteractionDto` | handled |
| `interaction_updated` | gateway — `#resolveInteraction` ask_user follow-up | `{ turnId, interaction }` | handled (rejects a stale id or non-increasing revision) |
| `interaction_resolved` | gateway — `#resolveInteraction` settlement | `{ turnId, interactionId, outcome, variant }` | handled |
| `interaction_recovered` | gateway — `interaction-checkpoint.ts` `recover()` on startup | `{ turnId, interaction, reason }`, reason limited to `daemon_restart`, `forced_shutdown`, `persistence_recovery` | handled |
| `usage_update` | `mapConversationEvent` ← `usage_update` | `{ turnId, inputTokens, outputTokens, totalTokens, usage }` | fixed by M4 |
| `turn_completed` | `mapConversationEvent` ← `final` | `{ turnId, outcome: 'completed', text }` (bounded 16384) | handled |
| `turn_failed` | `mapConversationEvent` ← `error`; also gateway-originated in `#recordContinuationFailure` | `{ turnId, outcome: 'failed', reason, finalText? }` | fixed by M4 |
| `turn_aborted` | gateway — `#abortSession` | `{ turnId, outcome: 'aborted' }` | handled |

Durability split: `text_delta` and `reasoning_delta` are appended with
`durability: 'stream'` and are the two `NONCRITICAL_RUNTIME_EVENT_TYPES`, so the runtime
sink does not await them; every other mapped event is `critical` and does.

### SSE framing and resume

The stream response sets `content-type: text/event-stream`, `cache-control: no-cache`,
`connection: keep-alive`, and `x-accel-buffering: no`. Each event is one frame —
`id: <envelope.id>\ndata: <envelope JSON>\n\n` — and the heartbeat is
`GATEWAY_EVENT_STREAM_HEARTBEAT` (`: heartbeat <ISO timestamp>`) every
`GATEWAY_EVENT_HEARTBEAT_INTERVAL_MS` (15000 ms). A subscriber that cannot keep up is
dropped: at most `MAX_BUFFERED_SSE_EVENTS` (256) events are buffered before the response is
destroyed, and a `response.write` returning false closes it too.

Resume is a sequence cursor over the session journal:

- `?after=` and `Last-Event-ID` are both accepted; `parseEventCursor` rejects anything that
  is not `0` or a 1–15 digit integer with `400 cursor_invalid`, and supplying both with
  different values gives `400 protocol_conflict`.
- The BFF does its own equivalent checks and, notably, **never forwards `Last-Event-ID`**:
  it converts the browser header into `?after=`, so the gateway's two-cursor comparison is
  unreachable from the web path.
- A cursor the journal can no longer serve produces `reload_required` from
  `subscribeFrom`: `410 cursor_compacted` with details `{ reloadRequired: true, session,
  latestSequence }` when the reason is `cursor_compacted`, and `503 gateway_unavailable`
  for `sequence_gap`, `generation_mismatch`, or `journal_unhealthy`. The details are nested
  inside `error.details` as `publicError` builds them, and the BFF validates exactly those
  keys in `validateCursorCompactedDetails` before forwarding.
- The browser's recovery is to refetch the projection and resume from
  `projectionSequence` (`useTerm2Session` 410 branch). Because the adapter asserts
  `event.id === lastAppliedSequence + 1`, a silently skipped sequence would be fatal; the
  410 path is what prevents that.

## 4. Gaps

`ConversationEvent` declares 36 types (`conversation-events.ts`).
`mapConversationEvent` projects 8; the remaining 28 are dropped, and a dropped event is not
merely unrendered — it is absent from the journal, so it cannot be replayed either. The M4
recommendation column follows the plan's rule that every gap is assigned to a milestone or
deferred with a reason.

| Dropped `ConversationEvent` | Recommendation |
| --- | --- |
| `tool_dispatched` | Defer. `tool_started` already moves the client's command to `running`; a second running transition would add no state the adapter can represent. |
| `tool_call_streaming_delta` | Defer. Payload is an argument character count only, and `Term2Command` has no such field. |
| `retry` | **M4.** Bounded fields (`toolName`, `attempt`, `maxRetries`, `retryType`, `errorKind`, delays) explain a stalled turn; `errorMessage` needs `boundedText`. |
| `retry_exhausted` | **M4**, with `retry`. Without it a retrying turn becomes a silent `runtime_error`. |
| `tool_recovery` | Defer. Recovered/dropped call ids are ledger bookkeeping with no client surface. |
| `subagent_started` | **M4.** The 11-async-features task projection needs a start fact; payload is bounded and `async`/role/task are already sanitizable. |
| `subagent_tool_started` | **M4**, same task-card owner as `subagent_started`; carries a `commandMessages` array that needs bounding. |
| `subagent_text_turn` | **M4.** Bounded progress text for a task card; the plan's M4 asks for bounded payloads, which `boundedText` provides. |
| `subagent_streaming_text` | Defer. The event is explicitly a peek that overwrites rather than accumulates; persisting it would replay stale peeks. |
| `subagent_streaming_tool` | Defer. Argument character count only. |
| `subagent_command_message` | **M4**, with `subagent_text_turn` — it is the tool-card equivalent for a child run. |
| `subagent_approval_required` | **M4, and the plan requires it explicitly.** It must resolve through the existing `PendingInteractionDto` path (`projectPendingInteraction`), because a child approval presented by any other shape bypasses the durable interaction checkpoint. |
| `subagent_completed` | **M4.** Terminal task fact; `SubagentResult` needs an explicit bounded projection rather than a raw pass-through. |
| `subagent_interrupted` | **M4**, with `subagent_completed` — a child that stopped at an approval must not read as still running. |
| `subagent_transferred` | Defer until the unified-subagent-UI transfer exists in a browser surface; the Ink card ownership it describes has no web equivalent yet. |
| `subagent_question` | **M4.** The async-run blocker a browser user must answer; 11-async-features defines the question route, so the event is its input. |
| `background_shell_started` | Defer to the 11 task-DTO work. A shell job needs a task namespace (`BackgroundTaskRef`, status vocabulary) that 11 says must be frozen by the transport owner before implementation. |
| `background_shell_completed` | Defer, same reason; its `output` field is unbounded and needs a defined byte bound first. |
| `background_shell_output` | Defer. 11 names `BackgroundShellOutputPayload` and its own bounds (`matchedLines`, `coalescedCount`, `droppedBytes`); projecting a second shape here would invent a wire contract ahead of that decision. |
| `background_check_in_due` | Defer. This is the liveness/check-in lane; its Ink surface has no web counterpart and the payload embeds activity detail that needs its own sanitizer. |
| `codex_rate_limits` | Defer. Provider-scoped (`CodexRateLimitInfo`); a generic client contract should not be shaped by one provider's plan quotas. |
| `user_message_consumed_for_abort` | Defer. It exists to make the Ink undo menu skip a consumed turn; the browser has no undo surface, so persisting it would only add a dead wire type. |
| `context_compaction_started` | **M4.** All three compaction events carry no free text — a provider id, token counts, a duration, a strategy enum, and an `errorCategory` enum — so they are cheap to bound, and they explain a long stall that currently has no user-visible cause. |
| `context_compaction_completed` | **M4**, same trio. |
| `context_compaction_failed` | **M4**, same trio. |
| `cost_update` | Defer. 08-session-controls treats cost as later-version presentation data, and `Term2TurnView` has no cost field; projecting `ModelRequestCost` now would fix a shape before the usage/cost DTO is designed. |
| `run_budget` | Defer. Budget/stall evidence (`RunBudgetEvent`) is escalation input for the run loop and the Ink approval surface; the browser already receives the projected evidence inside `approval_required.interaction.descriptor.runBudgetEvidence`. |
| `subagent_run_budget` | Defer, same owner and reason as `run_budget`. |

### The `runtime_error` collapse

`mapConversationEvent`'s `error` case emits a fixed
`{ turnId, outcome: 'failed', reason: 'runtime_error' }` and discards the entire
`ErrorEvent`: `message`, `finalText`, `kind`, `stack`, and `droppedUserMessage` are all
lost. The only other reason the gateway ever writes on `turn_failed` is
`interaction_continuation_failed` (`#recordContinuationFailure`). So the browser can
distinguish exactly two failure causes for a turn, one of which is a catch-all, and can
never tell "the provider refused" from "the turn was aborted mid-stream" from "the model
produced nothing". The plan's M4 already owns replacing this with a bounded reason-code
set; the inventory's contribution is that the collapse is total (no field of the source
event survives) and that `finalText` is dropped even though `ErrorEvent` carries it for a
turn that failed after producing an answer.

### ChatForge spec features with no gateway route

08-session-controls and 11-async-features are both marked deferred in ChatForge's
`ACCEPTED-PLAN-INDEX.md` and both describe routes in the *public* `/api/agent/v2/`
namespace. "No gateway route" below means: no `/private/agent/v1/` counterpart, and no M5b
command route either.

| Spec feature | Wire element the spec names | Gateway status |
| --- | --- | --- |
| Session controls (08) | `PATCH /api/agent/v2/sessions/:id/controls`, DTO `SessionControls` with `modelId`, `reasoningEffort`, `mode`, `revision`, `editable`, `allowedReasoningEfforts`, `allowedModes` | Partially covered by `session_update` (`POST .../sessions/:id/config`) with different field names and a different response (`configRevision`, no `editable`/`allowed*`); see §5 |
| Usage and cost projection (08) | `SessionUsage` DTO with `cost`, `knownUsdMicros`, `state`, `byModel` | No route. Live usage arrives only as the `usage_update` event; no cost reaches the wire |
| Queue pause/resume (08) | `POST /api/agent/v2/sessions/:id/resume`, event `queue_state_changed`, `409 queue_not_resumable` | No route and no event. `abort` discards queued turns (`queue_discarded`) instead |
| Rewind target listing (08) | `GET /api/agent/v2/sessions/:id/rewind-targets` | No route. `ConversationStore.rewindToTarget()` exists in term2 but is unreachable from the gateway |
| Rewind edit/resend (08) | `POST /api/agent/v2/sessions/:id/rewind`, event `rewind_applied` | No route, no event |
| Last-tool-output / interrupted-turn retry (08) | `POST /api/agent/v2/sessions/:id/retry`, event `retry_accepted` | No route. `retryLastToolOutput()` exists but is Ink-only |
| Attachment mutation handoff (08) | none — the spec names no route or field | Nothing to add; `message_submit` rejects attachments with `422 attachments_not_enabled` |
| Background task listing (11) | `GET .../background-tasks` | No route |
| Background task cancellation (11) | `POST /api/agent/sessions/:id/background-tasks/:kind/:taskRef/cancel`, event `background_task_updated(stop_requested)` | No route and no `background_task_*` event type exists at all |
| Background subagent approval (11) | `POST .../background-tasks/subagent/:taskRef/interactions/:interactionRef` | No route. Only the root interaction path exists; a child approval has no wire representation today |
| Background subagent question (11) | `POST .../background-tasks/subagent/:taskRef/questions/:questionRef` | No route |
| Skills catalog / activation (11) | `GET /api/agent/sessions/:id/skills`, `POST .../skills/:skillRef/activate` | No route |
| Memory list/search/detail (11) | `GET .../memory`, `.../memory/search?q=`, `.../memory/:memoryId` | No route |
| Authorized file and diff artifacts (11) | `GET .../artifacts/files/:fileRef`, `GET .../artifacts/diffs/:artifactRef` | No route |
| Quotas and capability flags (11) | none — prose only | Nothing to add |
| `BackgroundTask*Payload` async event DTOs (11) | `background_task_started`, `background_task_updated`, `background_interaction_required`, `background_task_completed`, `background_shell_output` | None of the five wire types exists; they are not in `FROZEN_AGENT_EVENT_TYPES` |

## 5. Mismatches

Verified against the code on both sides. "Live" means the current BFF passes the gateway's
value through unchanged, so the browser sees it.

1. **`usage_update` payload shape — live.** `mapConversationEvent` writes
   `payload.usage.{inputTokens, outputTokens}`; `applyTerm2Event`'s `usage_update` case reads
   `payload.inputTokens`, `payload.outputTokens`, and `payload.totalTokens` at the top level,
   guarded by `typeof ... === 'number'`. Every field is therefore `undefined` and the turn's
   usage is always blank. It cannot throw, so nothing surfaces the loss. `totalTokens` does
   not exist anywhere on the gateway side.
2. **`command_message` payload shape — live, and fatal to the client view.**
   `mapConversationEvent` writes `payload.message.{id, role, text}`; `applyTerm2Event` requires
   `payload.callId` and `payload.toolName` (through `payloadId`/`id`) and a `payload.status`
   in `pending`/`running`/`completed`/`failed`/`aborted`. `payloadId(payload, 'callId')`
   throws `Term2ProtocolError('Missing opaque event identity')` on the gateway's shape, and
   `useTerm2Session`'s `Term2ProtocolError` branch responds by setting `reloadRequired: true`
   and refetching the whole projection. Whether one broken frame can repeat depends on
   whether the reloaded `projectionSequence` already covers the offending event; that
   second-order behavior is **UNVERIFIED** — the first-order defect (a thrown protocol error
   per command message) is confirmed by the two code paths above.
3. **Nothing reshapes frames in between.** The BFF streams verbatim — `upstream.pipe(res)`
   under the comment "Do not parse or rewrite frames: gateway ids, data, and comment
   heartbeats are passed through verbatim and consume no BFF sequence state" — and
   `validateEventPayload` only checks the four interaction-shaped types
   (`approval_required`, `interaction_updated`, `interaction_recovered`,
   `interaction_resolved`). So mismatches 1 and 2 are the gateway's shapes arriving intact,
   not a BFF translation bug, and the BFF's `EVENT_TYPES` allowlist plus
   `validateEventEnvelope` are not on the SSE path at all.
4. **`user_message_accepted` has no `text` — masked, not fixed.** The gateway payload is
   `{ turnId, clientRequestId, messageId }`, while the adapter appends the user bubble with
   `text(payload.text)` (`''` when absent). `useTerm2Session` compensates by injecting
   `payload.text` from `pendingTextRef`, keyed by `clientRequestId`, and only for a message
   submitted in that browser session. Any other reader of the same event — a second window,
   or a replay after the ref is cleared — sees an empty user turn until the projection
   transcript supplies the text.
5. **Error-code vocabulary drifts at the edges.** The gateway's `pairing_unavailable` (503)
   is absent from the BFF's `SAFE_ERROR_CODES`, so it is normalized to
   `gateway_unavailable`; behaviourally similar (503, retryable) but the specific cause is
   lost. `settings_forbidden` is deliberately rewritten to `settings_not_allowed` **and its
   status is rewritten to 400**, so a gateway 403 reaches the browser as a 400. Conversely,
   these BFF codes are never emitted by this gateway: `model_unavailable`,
   `projection_too_large`, `cursor_invalid`, `candidate_expired`, `candidate_not_found`,
   `candidate_invalid`, `workspace_owner_mismatch`, `workspace_path_escape`,
   `credential_invalid`, `flow_in_progress`, `not_persisted`, `local_owner_required`,
   `pairing_disabled`, `settings_not_allowed`. Also note the gateway's SSE cursor rejection
   code is `cursor_invalid` while the BFF's own pre-check emits `invalid_cursor`.
6. **`session_create`'s body depends on persistence being configured; its status does not.**
   Both branches return `201`, so the BFF's `expectedStatuses()` check passes either way. The
   body differs: `{ session }` when `config.persistence` is set, otherwise
   `{ sessionId, workspaceId, accepted }`. `validateSessionResponse` requires exactly a
   `session` key (`exactKeys(value, new Set(['session']), ['session'])`), and `protocolFail()`
   raises `Term2GatewayError('gateway_unavailable', ...)` — so the persistence-less body
   reaches the browser as `503 gateway_unavailable` **even though the gateway created the
   session successfully**, leaving an orphaned session behind. The M2 launcher must always
   supply the persistence coordinator for session create to be usable.
7. **The session projection is not the source of `sessionConfig`.** The gateway's
   `toSessionProjection` has no `sessionConfig` field; the BFF attaches one from its own
   in-memory `sessionConfigStore` (populated by `rememberSessionConfig` from
   `session_update` responses and re-attached by `attachSessionConfig`). After a BFF restart
   the frontend's `session.sessionConfig` is absent until a config write happens, even though
   `GET /term2/sessions/:id/config` will re-fetch it from the gateway.
8. **08's controls DTO cannot be added additively.** Its request fields are `modelId` and its
   response DTO is `appliedRevision`/`editable`/`allowedReasoningEfforts`/`allowedModes`,
   while the shipped route takes `model`, `reasoningEffort`, `mode` and answers with a
   `configRevision`-carrying projection. D4 in the plan forbids renaming an existing field,
   so 08 as written either supersedes the shipped route or needs a new one. 08 also asserts
   "there is no v1 `GET /api/agent/models`", which is stale: `GET /private/agent/v1/models`
   exists (`model_list`) and the BFF serves it as `/term2/models`.
9. **Two local-owner gates with different vocabularies.** The BFF rejects a non-local owner
   on `/term2` routes with `403 local_owner_required`; the gateway independently rejects the
   same request with `403 settings_forbidden`, which the BFF then relabels
   `settings_not_allowed` at 400. A browser therefore cannot tell a BFF-side rejection from
   a gateway-side one.
10. **The frontend's event contract is narrower than the BFF's.** `types.ts` declares
    `AgentEventEnvelope.payload` as `Record<string, unknown>` with no per-type member, and
    `parseEventEnvelope` rejects any type outside `TERM2_EVENT_TYPE_SET` (16 literals —
    `TERM2_EVENT_TYPES` in the adapter). Because the BFF pipes frames verbatim, a new gateway
    event type would not be ignored by the browser: it would throw and trigger the same
    reload path as mismatch 2. Any M4 addition must therefore land in the same change as its
    adapter case.
11. **A rejected turn's reason is unrecoverable.** `turn_failed` carries only
    `runtime_error` or `interaction_continuation_failed` (see §4), while the adapter stores
    `payload.reason` straight into the turn's `error` string. This is the same defect as
    §4's collapse, recorded here because the browser's displayed failure text is where it
    becomes visible.

## 6. Not verified

- Whether a `command_message`-triggered reload can repeat for the same event
  (mismatch 2). It depends on whether the recomputed `projectionSequence` advances past the
  offending sequence; confirming it needs a live run through the real runtime, which does
  not exist until M1.
- The ChatForge deployment values of the gateway configuration — issuer, audience, key id,
  pairing enabled/disabled, socket vs port — because they live in ChatForge's environment
  config, not in the files read here. The gateway's side of the contract takes them from
  `GatewayLaunchConfig`.
- ChatForge's own test suite state. Nothing in this inventory ran ChatForge tests; the
  claims are source reads only. No ChatForge file was modified.
- `specs 08/11` accuracy beyond the wire elements quoted in §4; both are marked deferred and
  were read as design intent, not as current behavior.

## 7. Verification of this record

No production file changed, so no behavior test applies. The claims above were checked by
reading the symbols named in each row; the two payload-shape mismatches were additionally
confirmed by following both sides of the same value (`usage_update` from
`mapConversationEvent` to `applyTerm2Event`; `command_message` likewise, including
`payloadId`/`id` and the `useTerm2Session` `Term2ProtocolError` branch).

```sh
git diff --stat   # docs/contracts/13-gateway-web-wire.md only

## M4 additions

M4 adds the thirteen assigned event types: retry, retry_exhausted,
subagent_started, subagent_tool_started, subagent_text_turn,
subagent_command_message, subagent_approval_required, subagent_completed,
subagent_interrupted, subagent_question, context_compaction_started,
context_compaction_completed, and context_compaction_failed. Their payloads
are bounded projections from M4-dto.md; no raw arguments, provider bodies,
paths, stacks, cost records, or nested run state cross the wire. Retry,
terminal card, approval/question, and compaction events are critical; progress
text is stream; usage_update remains critical.

The command-message repair maps source cancelled/interrupted to wire aborted
and backgrounded to running, and skips messages without callId/toolName with a
bounded safe counter. The turn-failed repair maps recognized ErrorEvent kinds
to bounded reason codes and optionally carries bounded finalText. Child
approval/question payloads use the existing PendingInteractionDto and
interaction checkpoint/resolve seam; async child events retain their
originating turnId when the root turn is no longer active.

Child approval frames are emitted from the session-owned FIFO approval
controller after its foreground lease publishes a pause, and the existing
interaction resolve route calls that controller rather than the root approval
state. Child questions use the async registry mailbox through the same route.
At present, child approvals are available only through the adopted foreground
subagent lease path; native async children do not publish approval pauses.
Async children use subagent_question and the mailbox answer route instead.
Pending child checkpoints are recovered as interaction_recovered, then
explicitly settled as cancelled and followed by subagent_interrupted for the
child. The gateway never fabricates a continuation for a lease that lived in
the previous process, and never appends a terminal failure to the originating
root turn.
```

## 8. M5b additions: Session Commands RPC

### Route and Authorization
- **Method & Path**: `POST /private/agent/v1/sessions/:id/commands`
- **Assertion Purpose**: `command_invoke` (session-scoped assertion requiring `sessionId: :id` matching the route parameter; mismatch yields `400 protocol_conflict`).
- **Owner Guard**: `claims.sub` must match `session.binding.ownerUserId`. Unknown sessions or sessions owned by another user return `404 not_found`.
- **Busy Guard**: If the session is currently in `running` or `awaiting_interaction` state, the invocation is rejected with `409 session_busy`.
- **Audit Logging**: Every permitted command invocation writes a structured audit log entry with `operation: 'command_invoke'`, `outcome: 'allowed'`, and `reasonCode: 'accepted'`.

### Request DTO
The request body is strictly validated to contain exactly two properties:
```json
{
  "commandId": "compact" | "retry-tool" | "retry-turn",
  "clientRequestId": "<opaque-id-1-256-chars>"
}
```
Any additional properties, empty values, or missing properties return `400 validation_error`.

### Command Allowlist
Commands are validated against an exact-match allowlist (no prefix matching):
- `compact`
- `retry-tool`
- `retry-turn`

Any unlisted command name (e.g. `clear`, `auto-approve`, `sandbox`, `model`, prefix variants like `comp` or `retry`) is rejected with `422 command_not_allowed`.

### Response DTO
All successful executions (including `nothing_to_retry` outcomes and replayed requests) return HTTP status `200`:
```json
{
  "commandId": "compact" | "retry-tool" | "retry-turn",
  "outcome": "completed" | "not_reduced" | "accepted" | "nothing_to_retry" | "failed",
  "reason": "bounded-failure-code (compact 'failed' outcomes only)",
  "turnId": "optional-turn-uuid",
  "tokensBefore": 1000,
  "tokensAfter": 400,
  "replayed": true
}
```

### Execution Semantics and Event Sequence
1. **`compact`**:
   - Idempotency is pre-reserved in the admission store and in-flight registry before executing the side effect.
   - Invokes `ConversationService.compactContext()`. Concurrent same-`clientRequestId` requests await the in-flight compaction and receive the identical result with `replayed: true`.
   - `tokensBefore` and `tokensAfter` are estimated rendered **history** input tokens from the runtime's own estimator, measured on the model request before and after the compaction (the local checkpoint's bookkeeping marker and the harness prompt/tool scaffolding are excluded from both). They are estimates of the conversation-sized part of the input, not the provider-reported `usage.inputTokens` of a turn.
   - `outcome: 'completed'` means the compaction ran and the context did not grow. When `tokensAfter >= tokensBefore` the compaction was applied but grew the context, and the outcome is `not_reduced` (added 2026-09-12; a manual compaction of a small conversation whose summary is longer than the cold turns it replaces is the common case).
   - The outcome is derived from the runtime's typed compaction result, never from the result's display text (fixed 2026-09-12; previously any non-compaction result text — including a failed compaction's "Context compaction was blocked: …" message — was mapped to `nothing_to_retry`, contradicting the journaled `context_compaction_failed` event).
   - `outcome: 'nothing_to_retry'` is reserved for genuinely nothing to compact: the runtime reported nothing eligible (`not_needed` / `deferred`) or no complete cold turn to compact (`no_complete_cold_turn`).
   - A compaction that did not compact returns the additive failure outcome `{ outcome: 'failed', reason }` with `reason` drawn from the typed compaction result's bounded codes: `busy` (conversation not idle), `cancelled`, `native_failed` (the provider's native compaction request failed; added 2026-09-12, replacing the fabricated `result_still_too_large` this case used to report), or a blocked reason (`single_turn_too_large`, `result_still_too_large`, `hot_tail_would_orphan_tool_result` — kept only for the local planner's genuine size outcomes). The journaled terminal frame is `context_compaction_failed`, so the response and the event stream agree in kind; the response carries no free-text error detail.
   - The command runs as a journal turn: it publishes `context_compaction_started`, then `context_compaction_completed` (or `context_compaction_failed`), to the session journal with a command `turnId` in the payload, and those frames reach the event stream like any other session event. The generated `turnId` is not returned in the response.
   - Compaction completes synchronously within the RPC; admission is immediately settled as `terminal`.

2. **`retry-tool`**:
   - Inspects `session.service.peekLastToolOutput()`.
   - If no tool output exists to retry, settles admission as `terminal` and returns `{ commandId: 'retry-tool', outcome: 'nothing_to_retry' }`.
   - If a tool output exists, generates a UUID `turnId` and admits the turn through the same transaction as `message_submit` via `GatewayAdmissionPersistence.admit`:
     1. Prepares the message in the runtime and persists the prepared admission in SQLite.
     2. Retries do not create a user message: no `term2Fact` (`user_message`) is persisted to the transcript, and no `user_message_accepted` is published to the journal. This prevents empty user turns from entering `state.history` on replay or projecting empty user message bubbles. Instead, the durable accepted journal event is `assistant_started`.
     3. Commits the runtime turn asynchronously via `session.service.retryLastToolOutput({ preferredMessageId: turnId })`.
     4. If runtime start fails, the transaction transitions admission to `terminal` with result `failed` and settles the event journal with `turn_failed`.
   - Returns `{ commandId: 'retry-tool', outcome: 'accepted', turnId }`.
   - The browser observes `assistant_started`, streaming deltas, and `turn_completed` / `turn_failed`, at which point `#persistConversationEvent` transitions the admission to `terminal`.

3. **`retry-turn`**:
   - Inspects the canonical transcript (`session.service.exportState().history`), which is what `retryLastFailedTurn` replays: scanning back over synthetic user items (shell context, mode notices, local summaries) and non-message items, the last genuine user message must still be unanswered. A tool result or assistant output after it means the turn committed output.
   - If no such failed turn exists — including a session whose last turn succeeded, and a session with only synthetic items — settles admission as `terminal` and returns `{ commandId: 'retry-turn', outcome: 'nothing_to_retry' }` (the pre-check replaced "history is empty" on 2026-09-12, which admitted a retry on succeeded sessions that then failed after admission).
   - If the retry resolves with nothing to replay *after* the turn was admitted, the admission is settled `terminal`/`failed` and a `turn_failed` fact is journaled for the admitted `turnId`, so no `assistant_started` is left stranded. The HTTP response is the already-issued `200 accepted`; the failure is delivered through the event stream.
   - If history exists, generates a UUID `turnId` and admits the turn through the same transaction as `message_submit` via `GatewayAdmissionPersistence.admit`:
     1. Prepares the message in the runtime and persists the prepared admission in SQLite.
     2. Retries do not create a user message: no `term2Fact` (`user_message`) is persisted to the transcript, and no `user_message_accepted` is published to the journal. This prevents empty user turns from entering `state.history` on replay or projecting empty user message bubbles. Instead, the durable accepted journal event is `assistant_started`.
     3. Commits the runtime turn asynchronously via `session.service.retryLastFailedTurn({ preferredMessageId: turnId })`.
     4. If runtime start fails, the transaction transitions admission to `terminal` with result `failed` and settles the event journal with `turn_failed`.
   - Returns `{ commandId: 'retry-turn', outcome: 'accepted', turnId }`.
   - The browser observes `assistant_started`, streaming deltas, and `turn_completed` / `turn_failed`, at which point `#persistConversationEvent` transitions the admission to `terminal`.

### Idempotency and Conflict Detection
- `clientRequestId` is reserved before command side effects and tracked through `GatewayAdmissionPersistence` backed by SQLite and in-memory in-flight deduplication.
- Replaying a request with the same `clientRequestId` and identical payload returns HTTP 200 with the original outcome (`outcome`, `turnId`, or compaction token metrics) and `replayed: true`.
   - Replayed compaction records are safely decoded: completed, non-reducing, and no-op compactions return status 200 with `outcome: 'completed'`, `'not_reduced'`, or `'nothing_to_retry'` (a replayed `not_reduced` carries the recorded `tokensBefore`/`tokensAfter`). Interrupted compactions (`compact:in_progress`) return HTTP 409 `compact_interrupted` with `retryable: false`. Failed compactions (`compact:failed`, optionally suffixed with the bounded reason code since 2026-09-12) return HTTP 409 `compact_failed` with `retryable: false`. Unrecognized compaction states return HTTP 500 `compact_invalid_state` with `retryable: false`. Replayed failed retries return HTTP 409 `retry_failed` with `retryable: false`.- Replaying a `clientRequestId` with a different payload body throws an idempotency conflict and returns `409 idempotency_conflict`.

## 9. Restart recovery: the per-session provider/model snapshot (F3, 2026-09-12)

A restart-restored session must come back on the provider/model it was created
with, not on whatever the launcher currently defaults to. The gateway therefore
persists an immutable per-session snapshot at session creation — a sidecar file
`session-snapshot.json` (`{ schemaVersion: 1, providerId, modelId,
reasoningEffort }`, atomic write, mode 0600) in the session directory, because
the session-index schema gains no new columns.

Rules, and why they are shaped this way:

- **Creation is durable in the snapshot.** `session_create` does not return a
  session until the sidecar is written. A write failure disposes the created
  runtime, closes the persistence handle, removes the admission, and responds
  `503 snapshot_unwritable` (`retryable: true` — state is rolled back, so a
  retry creates a fresh session). A best-effort write here is what re-enables
  silent substitution after a restart.
- **Restore validates the exact snapshot.** On revival the stored
  provider/model are checked against the live provider registry and model
  catalog: gone provider → `409 provider_unavailable`; gone model →
  `409 model_unavailable`; catalog unreachable → `503
  model_catalog_unavailable` (`retryable: true`). The restored runtime is
  built from the persisted provider/model snapshot via the
  `RuntimeFactory.create` `settingsSnapshot` override. Its write posture is
  recomputed on fresh creation and revival from the current launcher
  `--allow-write` authority and revalidated binding access: `read_write` is
  writable only when both are true. A `read` binding therefore remains
  read-only across restart, while a `read_write` binding on an allow-write
  launcher remains write-capable.
- **Absent vs corrupt (the legacy-record rule).** A session created before the
  sidecar existed has *no* record: restore falls back to the launcher's
  current snapshot, which is validated like any other, so the fallback can
  still refuse — but when it succeeds it legitimately changes the session's
  provider/model. That identity-changing behavior is the compatibility cost of
  pre-change sessions having no recorded identity. A record that exists but is
  unreadable or does not parse as `schemaVersion: 1` is corruption: revival is
  refused with `500 session_snapshot_invalid` (`retryable: false`) and never
  treated as legacy, because silently substituting on top of an untrustworthy
  identity record is indistinguishable from the substitution this rule exists
  to prevent.
- **Owner scoping during revival.** Revival is keyed per owner and session; a
  different owner's valid assertion for the same session id is `404 not_found`
  both while a revival is in flight and against a live session, and can never
  inherit another owner's restored runtime.


