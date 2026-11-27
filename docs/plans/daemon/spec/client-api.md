# Term2 Client API — Core Protocol Specification (v1.0)

- **Protocol Version:** `1.0`
- **Status:** Frozen (2026-11-27; passed independent Review Rounds 1 & 2b across all four lenses, Step 11 Host/Web/Runtime zoom-ins, Step 13 session-list stream prototype, and `tests/host/client-api-conformance.integration.test.ts` under Step 5)
- **Schema Source:** `src/protocol/client-api/client-api-schema.ts` (staged for graduation to `@qduc/agent-wire`, Decision D006)
- **Generated JSON Schema:** `docs/plans/daemon/spec/client-api.schema.json`
- **Transport Bindings:**
  - [Unix Domain Socket Binding](transport-unix.md)
  - [HTTP + SSE Binding](transport-http-sse.md)

---

## 1. Conventions and Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 (RFC 2119 and RFC 8174) when, and only when, they appear in all capitals, as shown here.

### 1.1 Primitives
- **`NonNegativeInt`**: integer in `[0, 9007199254740991]` (`Number.MAX_SAFE_INTEGER`).
- **`PositiveInt`**: integer in `[1, 9007199254740991]`.
- **`UtcTimestamp`**: UTC RFC 3339 date-time string ending in `Z` (e.g., `"2026-11-27T14:00:00.000Z"`).
- **`OpaqueId`**: non-empty ASCII identifier matching `/^[A-Za-z0-9_-]{1,256}$/`.
- **`ControlFreeString`**: UTF-8 string matching `/^[^\x00-\x1F\x7F]+$/`.

### 1.2 Roles
- **Client:** A rendering and input surface. Clients MUST NOT execute model turns, write conversation logs directly, evaluate approval policy against raw provider history, or hold provider secrets.
- **Host (Daemon):** The long-lived singleton control-plane process owning session discovery, writer locks, authorization, projection, fanout, and transport endpoints.
- **Session:** A single durable conversation owned by the Host and backed by an append-only fact log with strictly monotonic `PositiveInt` sequence numbers (`seq`).
- **Principal:** The authenticated caller identity, classified into two abstract trust tiers:
  - **`owner`**: Full local-owner authority (trusted local user surfaces or an authenticated remote identity matching the Host's local owner identity).
  - **`scoped`**: Restricted identity authorized only for explicitly granted workspaces and sessions.
- **Accepted Boundary:** A durable commit in a Session's append-only log carrying a strictly increasing `PositiveInt` `seq` and `UtcTimestamp` `occurredAt`.
- **Live Frame:** A transient, non-durable publication carrying NO `seq` (streaming deltas, tool progress, review status, quota updates, retries, transient errors).

---

## 2. Architecture and Transport Separation

This specification defines the **core logical protocol** independently of transport framing. Every message envelope and core payload conforms to `src/protocol/client-api/client-api-schema.ts` and its generated JSON Schema (`client-api.schema.json`); nested session-domain payloads (`WireSnapshot`, `WireEvent`, `WireCommand`) are defined in `src/protocol/fold/` and validated at envelope level in `client-api.schema.json` until graduation into `@qduc/agent-wire`.

A conforming Host MUST support at least one normative transport binding and MAY serve multiple bindings concurrently backed by the same session store, writer locks, and live attachments. Native Client API `1.0` event payload schemas MUST be identical across all transport bindings (transport bindings MUST NOT inject extra transport-only metadata fields into core event payloads; legacy HTTP compatibility adapters such as `direct-wire-v2` on `GET /private/agent/v1/sessions/:id/events` are explicitly scoped in `transport-http-sse.md` §4.2).

A transport binding MUST specify:
1. How a `Principal` (`owner` vs `scoped`) is authenticated BEFORE any protocol processing or version-error disclosure.
2. How request/response RPCs (`C -> H`) are framed, correlated, and how `ClientApiError` objects are encoded.
3. How server-pushed streams (`H -> C`) preserve FIFO ordering per subscription and enforce bounded backpressure.
4. How connect-time version and capability negotiation is performed.

---

## 3. Whole-Spec Versioning, Handshake, and Daemon Control

### 3.1 Version Format and Negotiation Algorithm
Protocol versions MUST match `/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/` (`<major>.<minor>`, currently `"1.0"`). Releases follow a linear-release invariant: once major version `M + 1.0` ships, no new `M.x` minor releases are published, so a range `[min, max]` spanning majors implies support for all published versions in that interval.

- Given client range `[cMin, cMax]` and host range `[hMin, hMax]`:
  1. Both ranges MUST have valid syntax and `min <= max`.
  2. Compute the intersection `[max(cMin, hMin), min(cMax, hMax)]` symmetrically across client and host ranges.
  3. If the intersection is non-empty (`low <= high`), the negotiated `protocolVersion` MUST be `high` (the highest mutually supported version).
  4. If the intersection is empty, the Host MUST fail with `ClientApiError` `code: "protocol_incompatible"`.

### 3.2 Forward-Compatibility Rules (Minor Bumps)
- **Responses and events (`H -> C`):** Minor bumps MAY add optional object properties or new stream event names. `H -> C` schemas allow additive properties (`z.looseObject` / open JSON Schema objects). Clients MUST ignore unrecognized stream event names and SHOULD ignore unrecognized additive non-sensitive object properties (while still rejecting any forbidden secret/host-path keys per client security policy).
- **Requests (`C -> H`):** `C -> H` request schemas reject unrecognized properties (`z.strictObject` / `"additionalProperties": false`). Hosts MUST reject invalid or unrecognized request properties with `invalid_request`. New optional methods or fields introduced in a minor bump MUST be gated behind negotiated `protocolVersion` or capability tokens.
- **Capabilities:** `welcome.capabilities` MUST equal the intersection of `hello.capabilities` (or all host capabilities if omitted) with the Host's supported set. Invoking a capability not present in `welcome.capabilities` MUST fail with `unavailable`.
- **Normative v1.0 capability tokens:** `"session_list_stream"`, `"settings_stream"`, `"daemon_control"`, `"mcp"`.

### 3.3 Handshake (`protocol.hello` / `protocol.welcome`)
- **`protocol.hello` (`C -> H`):**
  - `protocolVersion`: version string (client's preferred/max version, e.g. `"1.0"`)
  - `minSupportedVersion`: version string (oldest version the client accepts, e.g. `"1.0"`)
  - `clientKind`: identifier matching `/^[a-z][a-z0-9_-]{0,31}$/` (well-known values: `"tui"`, `"web"`, `"headless"`, `"control"`, `"discord"`, `"acp"`, `"custom"`)
  - `clientVersion`: `ControlFreeString` (package/build version)
  - `capabilities`: optional array of capability token strings
- **`protocol.welcome` (`H -> C` result):**
  - `protocolVersion`: negotiated version string
  - `daemonId`: `OpaqueId` (opaque per-process boot identifier)
  - `daemonVersion`: `ControlFreeString`
  - `pid`: optional `PositiveInt` (included for `owner` on local transports; omitted for `scoped` principals)
  - `capabilities`: array of negotiated capability strings
  - `upgradeRecommended`: optional boolean (advisory only; true when `clientVersion !== daemonVersion` within a compatible protocol version)
- **Version mismatch error:** Returned as a standard `ClientApiError`:
  - `code: "protocol_incompatible"`
  - `details: { daemonProtocolVersion: string, daemonMinSupportedVersion: string, daemonVersion: string, activeTurnCount?: NonNegativeInt }` (`activeTurnCount` included for `owner` principals only).

### 3.4 Daemon Control (`daemon.status`, `daemon.shutdown`, `daemon.draining`)
- **`daemon.status` (`C -> H`, `owner` only):** Params `{}`. Returns `{ daemonId, daemonVersion, protocolVersion, pid, startedAt: UtcTimestamp, activeSessionCount: NonNegativeInt, activeTurnCount: NonNegativeInt, activeBackgroundTaskCount: NonNegativeInt, attachedClientCount: NonNegativeInt }`.
- **`daemon.shutdown` (`C -> H`, `owner` only, local transport):** Params `{ mode: "graceful" | "immediate", whenIdle?: boolean, timeoutMs?: PositiveInt, onTimeout?: "cancel" | "abort" }`.
  - If `mode === "graceful"` and `whenIdle === true` and `activeTurnCount > 0`, Host MUST NOT enter draining state and MUST return `busy` (`details: { activeTurnCount }`).
  - Otherwise Host enters draining state (refusing new turn admissions with `closed`), broadcasts `daemon.draining` (`{ reason: "shutdown" | "restart", gracePeriodMs: NonNegativeInt }`) to all attached clients, and returns `{}`.
  - Under `"graceful"`, Host waits up to `timeoutMs` (default `10_000`) for active turns to finish. If `timeoutMs` expires: `onTimeout: "cancel"` (default) cancels remaining turns and exits; `onTimeout: "abort"` exits draining state only if no sessions were torn down (or cancels if already shutting down).
  - Under `"immediate"`, Host cancels active turns, releases locks, and exits promptly.
- **`daemon.draining` (`H -> C`):** `{ reason: "shutdown" | "restart", gracePeriodMs: NonNegativeInt }`. Advisory notice so attached clients enter reconnecting state without treating EOF as a fatal error.

---

## 4. Error Model and Authorization Matrix

### 4.1 Core `ClientApiError`
Every failed `C -> H` request MUST produce a `ClientApiError` object (encoded by the active transport binding):
```ts
{
  code: ClientApiErrorCode,
  message: string,
  retryable?: boolean,
  details?: Record<string, unknown>
}
```
Void mutations MUST return an empty result object `{}` on success (never a nested `{ ok: true }`). Domain rejections (`stale_revision`, `stale_interaction`, `busy`, `cursor_out_of_range`, `protocol_incompatible`) MUST be returned as `ClientApiError` responses, never wrapped inside a success result.

Normative `ClientApiErrorCode` values:
- `protocol_incompatible`: Version negotiation failed.
- `unauthorized`: Missing, expired, or invalid authentication.
- `forbidden`: Caller lacks permission for an owner-only operation or a write operation on an already-visible resource.
- `not_found`: Resource does not exist OR is invisible to a `scoped` caller (non-owner requests for unauthorized or nonexistent session/workspace IDs MUST both return `not_found` to prevent existence oracles).
- `invalid_request`: Schema validation failure, invalid cursor, conflicting parameters, or mismatched `requestId` payload reuse.
- `stale_revision`: Optimistic concurrency check failed (`expectedRevision`, `expectedGeneration`, or `expectedTurnId` mismatch). `details` SHOULD carry the current revision/projection when safe.
- `stale_interaction`: Approval, question, review takeover, or budget pause was already resolved or cancelled.
- `busy`: Operation cannot run while active turns or background tasks hold the target resource.
- `cursor_out_of_range`: Requested `fromSeq` is outside `[earliestReplayableSequence - 1, latestSequence]` or invalid for the current session epoch; client MUST fall back to a fresh snapshot attach.
- `env_disconnected`: Execution environment (e.g., SSH target) is unavailable; Host MUST fail closed.
- `unavailable`: Optional capability or subsystem is not configured/available.
- `closed`: Connection, session, or host is closed.
- `internal_error`: Unexpected host failure (MUST NOT leak raw secrets or stack traces to `scoped` principals).

### 4.2 Normative Authorization Matrix

| Operation(s) | Required Authority |
| --- | --- |
| `protocol.hello` | Any authenticated principal |
| `daemon.status`, `daemon.shutdown` | `owner` only (`daemon.shutdown` local transport only) |
| `session.list`, `session.list.subscribe` | Authenticated; filtered per principal visibility |
| `session.create` (with `cwd` or `approvalPolicy.mode === "headless"`) | `owner` only (local `cwd` auto-admission NEVER widens `scoped` workspace grants) |
| `session.create` (with `workspaceId`) | Authorized `read_write` (or `read`) workspace grant |
| `session.fork`, `session.handoff` | `read(sourceSessionId)` + `create` on target workspace |
| `session.close` | `write(sessionId)` (or `owner`) |
| `session.attach` | `read(sessionId)` |
| `session.command` (read-only: `preview`, `list_rewind_targets`, `command_status`, `command_revision`) | `read(sessionId)` |
| `session.command` (mutating) | `write(sessionId)` (`owner` only for `configure({ sandboxEnabled: false })`) |
| `settings.*`, `credentials.*`, `oauth.*`, `providers.*`, `skills.list` | `owner` only |
| `models.list` | Authenticated (redacted catalog) |
| `quota.get` | `read(sessionId)` when `sessionId` given; `owner` only when omitted |
| `workspaces.list`, `workspaces.files` | Authorized workspace grant (or `owner`) |
| `workspaces.candidates.*`, `workspaces.ssh.*`, `workspaces.remove`, `workspaces.access`, `mcp.login` | `owner` only |
| `mcp.status` | `read(workspaceId/sessionId)` (or `owner`) |

---

## 5. Session Catalog and Session-List Stream

### 5.1 Canonical `SessionListItem`
Every session summary returned by `session.list` or pushed on the session-list stream MUST conform to `SessionListItem`:
- `id`: `ControlFreeString` (logical session ID; matches `OpaqueId` for generated IDs)
- `workspaceId`: `OpaqueId` (ALWAYS an opaque workspace alias/ID on every transport so `item.workspaceId` safely round-trips into `session.list`, `session.list.subscribe`, and `session.create`; raw host paths MUST NEVER appear in `workspaceId`)
- `workspaceRoot`: optional `ControlFreeString` (local `owner` Unix transport ONLY; MUST NEVER be emitted over HTTP/remote transports)
- `status`: `WireStatus` = `"idle" | "running" | "awaiting_interaction" | "interrupted" | "closed"`
- `awaitingKind`: optional `"approval" | "question" | "budget"` (present when `status === "awaiting_interaction"`, derived by precedence `budget > approval > question`)
- `createdAt`: `UtcTimestamp`
- `updatedAt`: `UtcTimestamp`
- `latestSequence`: `NonNegativeInt` (`0` for a newly created session with no durable facts yet)
- `title`: optional `ControlFreeString` (UTF-16 length `1..120`, first non-empty user message line; omitted when empty)
- `model`: optional `{ provider: string, model: string }`
- `pendingInteractionCount`: optional `NonNegativeInt` (sum of pending approvals/questions + pending budget pauses)
- `activeBackgroundTaskCount`: optional `NonNegativeInt` (count of active background tasks)

**Canonical ordering:** `updatedAt` descending (by parsed UTC instant, equivalent to lexicographic order on normalized `UtcTimestamp`), then `id` ascending (UTF-16 code-unit order).

**Normative `status` derivation from `WireSnapshot`:**
1. `snapshot.status === "closed"` → `"closed"`
2. `snapshot.pendingBudgets.length > 0` → `"awaiting_interaction"` (`awaitingKind: "budget"`)
3. `snapshot.pendingInteractions[0]?.kind === "approval"` → `"awaiting_interaction"` (`awaitingKind: "approval"`)
4. `snapshot.pendingInteractions[0]?.kind === "question"` → `"awaiting_interaction"` (`awaitingKind: "question"`)
5. `snapshot.status === "running"` → `"running"`
6. `snapshot.status === "interrupted"` → `"interrupted"`
7. Otherwise → `"idle"`

### 5.2 Lightweight Index & Crash-Recovery Normalization
- The Host MUST maintain an in-memory session index seeded from store metadata on startup and updated incrementally on live transitions. Listing sessions or serving `session.list.subscribe` MUST NOT open/attach dormant sessions (no N+1 hydration).
- On daemon startup (including recovery after `SIGKILL`/crash), the index seeder MUST normalize any persisted live-only status (`"running"`, `"awaiting_interaction"`) to `"interrupted"` and initialize `pendingInteractionCount = 0` and `activeBackgroundTaskCount = 0`.
- When an uncleanly terminated session is later opened/attached, the Host MUST durably commit its terminal `"interrupted"` recovery facts BEFORE computing `session.snapshot` or serving `fromSeq` replay.

### 5.3 Operations and Stream Events
- **`session.list` (`C -> H`):** Params `{ limit?: PositiveInt (1..100, default 20), cursor?: string, workspaceId?: OpaqueId }`. Invalid/tampered `cursor` MUST return `invalid_request`. Returns `{ sessions: SessionListItem[], nextCursor: string | null }`.
- **`session.list.subscribe` (`C -> H`):** Params `{ workspaceId?: OpaqueId, limit?: PositiveInt (1..500, default 200) }`.
  - **Atomic snapshot-to-live cut:** Host MUST capture the in-memory index snapshot and register the subscriber atomically (no `await` gap between snapshot cut and live registration, or strictly filtered by a monotonic `catalogVersion`) so zero events are dropped or applied out of order.
  - Emits:
    1. Initial `session.list.snapshot`: `{ streamEpoch: OpaqueId, sessions: SessionListItem[], truncated: boolean, nextCursor: string | null }`. Upon receiving `session.list.snapshot`, the client MUST replace its local session list for that subscription. `streamEpoch` uniquely identifies the snapshot cut.
    2. Incremental `session.list.upsert`: `{ session: SessionListItem }`. Emitted for any authorized session matching `workspaceId` (even if omitted by initial `limit` truncation); clients merge by `session.id` and maintain canonical sort. Rapid `updatedAt`/`latestSequence`-only ticks during a turn MAY be coalesced per session, PROVIDED every `status`, `awaitingKind`, `title`, `model`, `pendingInteractionCount`, and `activeBackgroundTaskCount` transition is emitted promptly.
    3. Incremental `session.list.remove`: `{ sessionId: string, reason: "workspace_revoked" | "deleted" }`. MUST ONLY be emitted for sessions previously visible to that subscriber (preventing existence oracles). **Causal coalescing invariant:** emitting `session.list.remove` MUST immediately cancel/purge any pending coalesced `upsert` for that `sessionId`.
    4. Terminal `session.list.resync_required`: `{ reason: "slow_consumer" | "epoch_changed" }`. Emitted on slow-consumer overflow (retiring the subscription cleanly).
- **`session.list.unsubscribe` (`C -> H`):** Stops the subscription (`{}` on success).
- **`session.create` (`C -> H`):** Params carry **exclusively** either `workspaceId: OpaqueId` OR `cwd: ControlFreeString` (passing both or neither MUST fail with `invalid_request`), plus optional `model`, `approvalPolicy?: SessionApprovalPolicy`, and `includeSnapshot?: boolean`. Local `cwd` auto-admission is strictly scoped to `owner` and MUST NOT create or widen grants visible to `scoped` principals. Returns `{ session: SessionListItem, snapshot?: WireSnapshot }` (`snapshot` included when `includeSnapshot === true` or on HTTP compatibility projection).
- **`session.fork` (`C -> H`):** Params `{ sourceSessionId: string }`. Returns `{ session: SessionListItem }`.
- **`session.handoff` (`C -> H`):** Params `{ sourceSessionId: string, name?: string, text?: string }`. Returns `{ session: SessionListItem }`.
- **`session.close` (`C -> H`):** Params `{ sessionId: string, force?: boolean }`. Serialized per session with `session.attach`. Rejects with `busy` when turns or background tasks are active unless `force === true`. Releases the live session and writer lock and emits `session.closed { sessionId, reason: "closed" }` to attached clients.

---

## 6. Session Attachment, Event Stream, and Replay

### 6.1 `session.attach` and `session.detach`
- **`session.attach` (`C -> H`):** Params `{ sessionId: string, fromSeq?: NonNegativeInt, sessionEpoch?: string }`.
  - **Empty-session boundary values:** A newly created session with no durable facts has `snapshot.seq = 0`, `latestSequence = 0`, and `earliestReplayableSequence = 1`.
  - **Fresh attach (`fromSeq` omitted):** Host registers the subscriber in buffering mode, captures `{ snapshot, cutSeq, earliestReplayableSequence, sessionEpoch }` atomically, emits `session.snapshot`, drops any buffered `session.accepted` with `seq <= cutSeq` and any buffered `session.live` tagged before `cutSeq`, and drains remaining frames FIFO.
  - **Cursor resume (`fromSeq` provided):**
    - Valid iff `fromSeq >= earliestReplayableSequence - 1` and `fromSeq <= latestSequence` (so `fromSeq = 0` on an empty session or a session with `earliestReplayableSequence = 1` is valid and replays all facts `seq >= 1`) AND `sessionEpoch` (if provided) matches the current session epoch.
    - If invalid or out of retention, Host MUST fail the `session.attach` request uniformly across ALL transports with `ClientApiError` `code: "cursor_out_of_range"` (`details: { earliestReplayableSequence, latestSequence, sessionEpoch }`). Clients MUST fall back to a fresh snapshot attach.
    - If valid, Host buffers live updates while replaying all accepted batches with `seq > fromSeq` in ascending `seq` order, drops buffered duplicates `<= replayEndSeq` and pre-cut live frames, then transitions seamlessly to live streaming.
  - **Non-Replayable Live Deltas (Client Rule):** Upon disconnect/reconnect, clients MUST discard any unaccepted transient `session.live` text/reasoning/tool-progress buffers; recovery uses accepted summaries and final tool outputs from `session.snapshot` / `session.accepted`.
- **`session.detach` (`C -> H`):** Closes ONLY the caller's subscription. MUST NOT cancel turns, close the Session, or disturb other clients.

### 6.2 Session Stream Frames
- **`session.snapshot` (`H -> C`):** `{ sessionId: string, seq: NonNegativeInt, earliestReplayableSequence: PositiveInt, sessionEpoch: string, snapshot: WireSnapshot }`.
- **`session.accepted` (`H -> C`):** `{ sessionId: string, seq: PositiveInt, occurredAt: UtcTimestamp, events: WireEvent[] }`. Atomic boundary; client MUST apply all `events` before advancing `lastSeq`. Sequences MAY be sparse; clients require strictly increasing `seq`.
- **`session.live` (`H -> C`):** `{ sessionId: string, events: WireEvent[] }`. Transient events with NO `seq` and NO replay guarantee.
- **`session.resync_required` (`H -> C`, terminal):** `{ sessionId: string, reason: "slow_consumer" | "session_rotated", earliestReplayableSequence: PositiveInt, latestSequence: NonNegativeInt }`. Emitted mid-stream when a slow consumer exceeds backpressure or a session rotates incompatibly; automatically retires the subscription without disturbing other clients or the Session.
- **`session.closed` (`H -> C`, terminal):** `{ sessionId: string, reason: "closed" | "workspace_revoked" | "daemon_shutdown" }`. Automatically retires the subscription.

---

## 7. Session Commands (`session.command`)

Sent via `session.command` (`C -> H`) with params `{ sessionId: string, command: WireCommand }`.

Supported `command.type` values (Client API `1.0` command set, extending `src/protocol/fold/wire-commands.ts` with `set_goal`, server-resolved `skill`, and explicit `approvalMode`/`sandboxEnabled` on `configure`):
1. **Turn & Queue:**
   - `submit` (`requestId` durably persisted for idempotency across daemon restarts; reusing `requestId` with a different payload MUST fail with `invalid_request`; optional `skill` resolved server-side)
   - `preview` (read-only preflight; optional `skill`)
   - `cancel` (`expectedTurnId?` — mismatched `expectedTurnId` MUST return `stale_revision`; optional `discardQueue`, `returnSteers`)
   - `retry` (`target: "turn" | "tool"`, `requestId`, `expectedTurnId?`)
   - `queue_edit`, `queue_retract`, `queue_resume`, `queue_discard` (MUST check `expectedRevision` → `stale_revision`)
   - `rewind`, `list_rewind_targets`, `reset`, `command_status`, `command_revision` (`rewind`, `reset`, `compact`, `rollover` MUST fail with `busy` if an incompatible active turn is in progress)
2. **Approvals & Interactions:**
   - `answer` (`requestId`, `decision`) — single-arbiter first-writer-wins CAS; late/duplicate answers MUST return `stale_interaction`.
   - `take_over_review` (`requestId`) — single-arbiter CAS; stale/already-settled review MUST return `stale_interaction`.
   - `answer_budget` (`requestId`, `decision`) — single-arbiter CAS; late answers MUST return `stale_interaction`.
   - `set_goal` (`expectedGeneration`, `action`, `goal?`, `proposalId?`) — stale generation MUST return `stale_revision`.
3. **Configuration, Tasks & Context:**
   - `configure` (`model?`, `reasoning?`, `temperature?`, `approvalMode?`, `sandboxEnabled?`, `expectedRevision?`, `clientRequestId?`) — rejects stale `expectedRevision` with `stale_revision`; `clientRequestId` provides idempotent replay.
   - `task_control` (`taskId`, `action: "cancel" | "background" | "check_in" | "foreground"`)
   - `compact`, `rollover`

### 7.1 Headless / Unattended Approval Policy & Background Auto-Drain
- `SessionApprovalPolicy = { mode: "interactive" } | { mode: "headless", autoApprove: boolean }`.
- Headless approval policy is configured at `session.create` (owner-only; never silently escalated by an observer attaching to an interactive session) and evaluated entirely inside Host/Runtime with full access to session history and Host security ceilings.
- Host-side background notification auto-drain is authoritative in daemon mode; clients MUST NOT send duplicate drain commands.

---

## 8. Global Configuration, Models, Providers, Credentials & Quota

All mutations in this section are serialized by the Host.
- **`settings.get` (`C -> H`, `owner`):** Returns `{ revision: string, settings: SettingsProjection, schema?: SettingsFieldMeta[] }` (secrets redacted).
- **`settings.update` (`C -> H`, `owner`):** Params `{ expectedRevision: string, changes: Array<{ key: string, value: unknown }> }`. Stale revision returns `stale_revision` with current projection in `details`. On commit, broadcasts `settings.changed { revision, settings }`.
- **`settings.subscribe` / `settings.unsubscribe` (`C -> H`, `owner`):** Atomically emits initial `settings.snapshot { revision, settings }` followed by `settings.changed { revision, settings }`.
- **`models.list` (`C -> H`):** Returns `{ models: ModelCatalogEntry[], favorites?: string[], nicknames?: Record<string, string> }`.
- **`providers.presets` / `providers.upsert` / `providers.delete` (`C -> H`, `owner`):** Serialized custom provider management (last-writer-wins within serialized lane; never returns secrets).
- **`credentials.set` / `credentials.delete` (`C -> H`, `owner`):** Write-only credential mutations.
- **`oauth.login` / `oauth.select` / `oauth.delete` (`C -> H`, `owner`):** Serialized per provider. `oauth.login` MAY return `{ authUrl, state }` for client display/open and MUST NEVER return PKCE `code_verifier`, `client_secret`, or raw tokens.
- **`quota.get` (`C -> H`):** Params `{ sessionId?: string }`. Returns latest observed subscription quota snapshot (also pushed via `session.live`).

---

## 9. Workspaces, Files, Skills & MCP

- **`workspaces.list` (`C -> H`):** Returns authorized workspace grants (`directory`, `host`, `ssh`).
- **`workspaces.candidates.validate` / `browse` / `select` (`C -> H`, `owner`):** Workspace admission.
- **`workspaces.ssh.hosts` / `workspaces.ssh.add` (`C -> H`, `owner`):** Lists `~/.ssh/config` aliases and registers SSH grants.
- **`workspaces.remove` / `workspaces.access` (`C -> H`, `owner`):** Revokes or changes a workspace grant. Host MUST close affected live sessions on that root, emit `session.closed { reason: "workspace_revoked" }` to attached clients, and emit `session.list.remove { reason: "workspace_revoked" }` to subscribers that lose visibility.
- **`workspaces.files` (`C -> H`):** Params `{ workspaceId?: OpaqueId, sessionId?: string, refresh?: boolean }`.
- **`skills.list` (`C -> H`, `owner`):** Params `{ workspaceId?: OpaqueId, sessionId?: string }`.
- **`mcp.status` (`C -> H`):** Params `{ workspaceId?: OpaqueId, sessionId?: string }`. Returns server statuses and tool counts (no secrets).
- **`mcp.login` (`C -> H`, `owner`):** Params `{ serverId: string, workspaceId?: OpaqueId }`. Initiates OAuth login and MUST NEVER return raw secrets or PKCE verifiers.

---

## 10. Failure, Recovery, and Security Invariants

1. **Client Disconnect:** Closing a client connection MUST NOT cancel active turns, terminate background tasks, or close the Session.
2. **Daemon Restart / Crash:** On reopen, any in-flight turn, pending tool call, or local background task lacking a terminal durable fact MUST be durably marked `"interrupted"` before snapshot/replay; nothing resumes automatically.
3. **Execution Environment Drop (SSH / Future VM):** On transport loss, Host/Runtime MUST:
   - Fail active tool calls with `env_disconnected` and commit terminal tool-error facts (no dangling `tool_use`).
   - Stop the active turn cleanly in `"interrupted"` / error state rather than letting the model loop retries against a dead target.
   - Fail pending approvals closed with `env_disconnected` (never executing locally).
   - Transition remote background tasks to `"interrupted"` and decrement `activeBackgroundTaskCount`.
   - Fail all workspace-bound RPCs (`workspaces.files`, `skills.list`, `mcp.status`) closed with `env_disconnected` — NEVER reading local host paths at the same path.
   - Keep the daemon healthy for all other sessions; subsequent `retry`/`submit` explicitly attempts reconnection and fails closed if still unreachable.
4. **Credential Isolation:** Provider API keys, OAuth tokens, PKCE verifiers, and MCP OAuth secrets MUST NEVER appear in Client API responses/events or in child tool / Execution Environment process environments.
5. **Active Stream Revocation:** When a trusted client or workspace grant is revoked, the Host MUST immediately terminate all active streams owned by the revoked client or bound to the revoked workspace.
