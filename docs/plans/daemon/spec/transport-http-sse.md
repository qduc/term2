# Term2 Client API — HTTP + SSE Transport Binding (v1.0)

- **Applies to:** Core Protocol Specification `1.0` ([`client-api.md`](client-api.md))
- **Status:** Frozen (2026-11-27)
- **Primary Consumers:** Web Client (via BFF) and LAN / Remote Clients.

---

## 1. Transport Security and Authentication

This binding preserves term2's existing HTTP/LAN security posture without weakening or adding new auth machinery (Step 0 standing rule):
- Served by `DirectServerTransport` over either a private Unix domain socket (for a co-located BFF) or HTTPS/TLS (with optional mTLS).
- Every route other than `POST /private/agent/v1/pairing/register` MUST authenticate a valid RS256 assertion JWT in `x-term2-assertion`, verified by `AssertionVerifier` and deduplicated by `SqliteReplayLedger`.
- **Auth before version negotiation:** Assertion verification MUST execute strictly BEFORE protocol version negotiation (`401 unauthorized` on missing/invalid assertion, preventing pre-auth version/activity disclosure).
- The assertion's `purpose`, `sessionId`, and `workspaceId` MUST match the requested route and query filters.
- `owner`-only purposes (`settings_*`, `credential_*`, `oauth_*`, `provider_*`, `skills_list`, `workspace_candidate_*`, `workspace_ssh_*`, `workspace_remove`, `workspace_access_update`, `daemon_status`) MUST additionally satisfy `claims.sub === localOwnerUserId`.
- **Trusted-client revocation:** When a trusted client is revoked, the Host MUST immediately close all active HTTP SSE streams owned by that client.
- **No host-path exposure:** HTTP responses and SSE payloads MUST ALWAYS emit opaque `workspaceId` aliases (`OpaqueId`) and MUST NEVER emit `workspaceRoot`.

---

## 2. Version Negotiation

- **Request header:** Clients SHOULD send `x-term2-client-api-version: 1.0` on Client API `1.0` requests and MUST send it (or query param `?apiVersion=1.0` when `EventSource` cannot set custom headers) on `GET /private/agent/v1/sessions/events`.
- **Negotiation rules:**
  - If the header is omitted on legacy routes, Host treats the request as `"1.0"` compatibility mode.
  - If the header carries an unsupported **major** version (e.g., `"2.0"`), Host MUST respond (after auth!) with HTTP `400` and `code: "protocol_incompatible"`.
  - If the header carries the same major version (`"1.x"`), Host negotiates `min("1.x", "1.0") = "1.0"` and echoes `x-term2-client-api-version: 1.0` + `x-term2-daemon-id: <daemonId>` on the response.
- **Handshake vs. Daemon Status (separated):**
  - `GET /private/agent/v1/hello` (`purpose: "protocol_hello"`, **any authenticated principal**): returns `protocol.welcome` (`{ protocolVersion, daemonId, daemonVersion, capabilities }` — omitting `pid`).
  - `GET /private/agent/v1/daemon/status` (`purpose: "daemon_status"`, **`owner` only**): returns full `daemon.status` (`pid`, `startedAt`, active counts).

---

## 3. Core Method → HTTP Route Mapping

All existing `/private/agent/v1/*` routes are retained for backward compatibility. Unmapped Unix-only methods are explicitly marked below.

| Core Method | HTTP Method & Route | Assertion Purpose | Authority |
| --- | --- | --- | --- |
| `protocol.hello` | `GET /private/agent/v1/hello` | `protocol_hello` | Any authenticated |
| `daemon.status` | `GET /private/agent/v1/daemon/status` | `daemon_status` | `owner` |
| `daemon.shutdown` | *(Unix local transport only)* | — | — |
| `session.list` | `GET /private/agent/v1/sessions` (`?limit=&cursor=&workspaceId=`) | `session_list` | Authenticated |
| **`session.list.subscribe`** | **`GET /private/agent/v1/sessions/events`** (SSE) | **`session_list_events`** | Authenticated |
| `session.list.unsubscribe` | *(Close SSE stream)* | — | — |
| `session.create` | `POST /private/agent/v1/sessions` (legacy alias `POST /`) | `session_create` | Workspace grant |
| `session.fork` | *(Unix local transport only in v1.0)* | — | — |
| `session.handoff` | `POST /private/agent/v1/sessions/:id/handoff` | `session_handoff` | `read` + workspace |
| `session.close` | *(Unix local transport only in v1.0)* | — | — |
| `session.attach` (snapshot) | `POST /private/agent/v1/sessions/:id` | `session_read` | `read(sessionId)` |
| `session.attach` (stream/replay) | `GET /private/agent/v1/sessions/:id/events` (SSE) | `events_connect` | `read(sessionId)` |
| `session.detach` | *(Close SSE stream)* | — | — |
| `session.command(submit)` | `POST /private/agent/v1/sessions/:id/messages` | `message_submit` | `write(sessionId)` |
| `session.command(cancel)` | `POST /private/agent/v1/sessions/:id/abort` | `abort` | `write(sessionId)` |
| `session.command(configure)` | `POST /private/agent/v1/sessions/:id/config` | `session_update` | `write(sessionId)` |
| `session.command(compact/retry/rollover)` | `POST /private/agent/v1/sessions/:id/commands` | `command_invoke` | `write(sessionId)` |
| `session.command(answer/take_over_review/answer_budget)` | `POST /private/agent/v1/sessions/:id/interactions/:requestId` | `interaction_resolve` | `write(sessionId)` |
| `session.command(set_goal)` | `POST /private/agent/v1/sessions/:id/goal` | `session_goal` | `write(sessionId)` |
| `session.command(queue_*)` | `POST /private/agent/v1/sessions/:id/queue` | `session_queue` | `write(sessionId)` |
| `session.command(task_control)` | `POST /private/agent/v1/sessions/:id/tasks` | `session_task_control` | `write(sessionId)` |
| `session.command(rewind/list_rewind_targets)` | `GET/POST /private/agent/v1/sessions/:id/rewind(-targets)` | `session_rewind(_targets)` | `read`/`write` |
| `session.command(preview/reset/command_status/command_revision)` | *(Unix local transport only in v1.0)* | — | — |
| `settings.get` / `settings.update` | `GET/PUT /private/agent/v1/settings` | `settings_read` / `settings_write` | `owner` |
| `settings.subscribe` / `unsubscribe` | *(Unix local transport only in v1.0)* | — | — |
| `models.list` | `GET /private/agent/v1/models` | `model_list` | Authenticated |
| `providers.*` | `GET/POST/DELETE /private/agent/v1/providers*` | `provider_*` | `owner` |
| `credentials.*` | `POST/DELETE /private/agent/v1/credentials/:id` | `credential_*` | `owner` |
| `oauth.*` | `POST/DELETE /private/agent/v1/oauth/:provider/*` | `oauth_*` | `owner` |
| `quota.get` | `GET /private/agent/v1/sessions/:id/quota` | `session_quota` | `read(sessionId)` |
| `workspaces.list` | `GET` (alias `POST`) `/private/agent/v1/workspaces` | `workspace_list` | Authenticated |
| `workspaces.candidates.*` | `POST /private/agent/v1/workspace/candidates/{validate,browse,select}` | `workspace_candidate_*` | `owner` |
| `workspaces.ssh.*` | `GET /private/agent/v1/workspaces/ssh-hosts`, `POST .../workspaces/ssh` | `workspace_ssh_*` | `owner` |
| `workspaces.remove` / `access` | `DELETE /private/agent/v1/workspaces/:id`, `PUT .../access` | `workspace_remove` / `workspace_access_update` | `owner` |
| `workspaces.files` | `GET /private/agent/v1/workspaces/:id/files`, `GET .../sessions/:id/files` | `workspace_files` / `session_files` | Workspace/session `read` |
| `skills.list` | `GET /private/agent/v1/skills` | `skills_list` | `owner` |
| `mcp.status` / `mcp.login` | *(Unix local transport only in v1.0)* | — | — |
| `auth.pairing.register` | `POST /private/agent/v1/pairing/register` | *(OTP pairing)* | Unauthenticated OTP |

**`auth.pairing.register` schema:** Request `{ code: string, clientId: OpaqueId, publicKeyPem: string, label?: string }` → Response `201 { clientId, fingerprint, trustedAt }` (preserving existing `server-pairing.ts` contract).

---

## 4. SSE Stream Bindings

### 4.1 Session-List Stream (`GET /private/agent/v1/sessions/events`)
- **Headers:** `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`, `x-term2-client-api-version: 1.0`, `x-term2-daemon-id: <daemonId>`.
- **Optional query params:** `workspaceId` (`OpaqueId`, MUST be intersected with the assertion's workspace claims), `limit` (`1..500`, default `200`).
- **SSE Event Types (identical payloads to Core §5.3 — NO injected `protocolVersion` field inside JSON `data`):**
  1. Initial snapshot:
     ```
     event: session.list.snapshot
     data: {"streamEpoch":"...","sessions":[...],"truncated":false,"nextCursor":null}
     ```
  2. Incremental upsert:
     ```
     event: session.list.upsert
     data: {"session":{...}}
     ```
  3. Incremental removal:
     ```
     event: session.list.remove
     data: {"sessionId":"...","reason":"workspace_revoked"}
     ```
  4. Slow-consumer / epoch resync (terminal):
     ```
     event: session.list.resync_required
     data: {"reason":"slow_consumer"}
     ```
  5. Daemon draining:
     ```
     event: daemon.draining
     data: {"reason":"shutdown","gracePeriodMs":5000}
     ```
  6. Keepalive comment: `: heartbeat\n\n` every `15_000 ms`.
- **SSE `id:` rule:** Session-list frames MUST NOT set non-numeric SSE `id:` lines (keeping compatibility with strict numeric `parseFrame()` parsers); `streamEpoch` lives exclusively inside the JSON `data` payload.
- **Backpressure:** Bounded queue (`MAX_BUFFERED_EVENTS = 256`, `DRAIN_TIMEOUT_MS = 10_000`). On overflow, the server emits terminal `session.list.resync_required` if writable and closes the SSE response cleanly so the client reconnects for a fresh snapshot.
- *(Non-normative note for `web-client` BFF):* The web BFF proxies this stream unbuffered at `GET /api/agent/sessions/events`, signing a `session_list_events` assertion and forwarding `x-term2-client-api-version` / `x-term2-daemon-id`.

### 4.2 Session Event Stream (`GET /private/agent/v1/sessions/:id/events`)
- Retains existing `format=direct-wire-v2` (canonical native `WireEventBatch` frames), `format=agent-wire-v2`, and `format=direct` compatibility formats.
- Cursor resume uses `Last-Event-ID` header or `?after=<seq>` query parameter; conflicting values fail with HTTP `400` (`invalid_request` / compatibility alias `protocol_conflict`).
- Out-of-range `after` / `Last-Event-ID` fails with HTTP `400` (`cursor_out_of_range`, or compatibility `410 cursor_compacted`) for `fetch`-based SSE clients (such as `web-client`'s `openDirectEvents`).
- **Core ↔ `direct-wire-v2` SSE Frame Mapping:**

| Core Frame | `direct-wire-v2` SSE `event:` | SSE `id:` | Notes |
| --- | --- | --- | --- |
| `session.snapshot` | `snapshot` | `<seq>` (when `> 0`) | Full `WireSnapshot` + `interactions` DTO |
| `session.accepted` | `accepted` | `<seq>` | Atomic `WireEventBatch` (`seq: PositiveInt`) |
| `session.live` | `live` | *(omitted)* | Transient `WireEventBatch` (`seq: null` in batch payload) |
| `session.resync_required` | `session.resync_required` | *(omitted)* | Terminal; closes SSE response |
| `session.closed` | `session.closed` | *(omitted)* | Terminal; closes SSE response |
| `daemon.draining` | `daemon.draining` | *(omitted)* | Advisory before EOF |

---

## 5. HTTP Error Envelope and Status Code Mapping

HTTP error responses preserve the existing `{ error: { code, message, retryable?, details? } }` JSON envelope:

| Core Error Code | HTTP Status | Existing HTTP Compatibility Aliases |
| --- | --- | --- |
| `invalid_request`, `protocol_incompatible` | `400` | `validation_error`, `protocol_conflict`, `protocol_upgrade_required` |
| `cursor_out_of_range` | `400` / `410` | `cursor_invalid` (`400`), `cursor_compacted` (`410`) |
| `unauthorized` | `401` | — |
| `forbidden` | `403` | `settings_forbidden`, `workspace_forbidden` |
| `not_found` | `404` | — |
| `stale_revision`, `stale_interaction`, `busy` | `409` | `settings_conflict`, `session_busy`, `session_not_admitting` |
| `env_disconnected`, `unavailable`, `closed` | `503` | `projection_unavailable`, `gateway_unavailable` |
| `internal_error` | `500` | — |
