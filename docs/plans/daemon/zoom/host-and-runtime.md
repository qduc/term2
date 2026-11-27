# Step 11 Zoom-In: Host (Full) & Agent Runtime (Shallow)

Status: completed 2026-11-27.

This design note specifies the internal sub-module seams inside `src/host/`, `src/app/`, and `src/session/` / `src/tools/` (respecting `docs/architecture/layers.md` and `scripts/complexity-budget.json`).

---

## Architecture Gate Constraints

- `host/` MAY import ONLY `protocol/`, `session/`, `config/`, `shared/`. All app-owned authorities enter `host/` via typed ports in `src/host/server-contracts.ts` / `in-process-direct-types.ts`.
- `src/host/` is at its 28-file folder ceiling → new daemon/index modules live in **`src/host/daemon/`** (<= 15 files).
- `src/app/` is at its 76-file folder ceiling → new daemon lifecycle/bootstrap modules live in **`src/app/daemon/`** (<= 15 files).
- `src/host/server-sse.ts` is the sole grandfathered `wireEventOutsideProtocol` exception (414 lines) → keep session-list SSE in **`src/host/daemon/session-list-sse.ts`**.
- Filenames MUST describe jobs (no `service`/`adapter`/`orchestrator`) and have globally unique basenames under `src/`.

---

## 1. Host Sub-Modules (`src/host/daemon/`)

### 1.1 `SessionIndex` (`src/host/daemon/session-index.ts`)
- **Job:** Lightweight, principal-filterable in-memory registry of dormant + live sessions powering `session.list` (eliminating `server.ts:listSessions` N+1 live-opens) and `session.list.subscribe`.
- **Cold seed (`seed()`):** Iterates `DirectSessionStore.list()` metadata WITHOUT calling `host.connect()` or acquiring writer locks. Normalizes pre-crash live-only statuses (`running`, `awaiting_interaction`) to `interrupted` and zeroes live-only counts.
- **Live feed (`observeLive` / `observeClosed`):** Fed from `DirectAttachment` (`onProjectionUpdate` on non-transient updates) and `DirectHost` (`createSession`, `attachment`, `release`). Immediate fanout on `status`, `awaitingKind`, `title`, `model`, `pendingInteractionCount`, `activeBackgroundTaskCount`, or `live` changes; `100ms` per-session coalescing for `updatedAt`/`latestSequence`-only ticks during active turns.
- **Causal coalescing invariant:** `notifyWorkspaceRevoked(root)` / `remove` immediately cancels any pending coalesced `upsert` timer for affected sessions before emitting `session.list.remove`.
- **Atomic subscribe cut:** Captures snapshot + registers subscriber synchronously (no `await` gap between snapshot and live subscription) with per-subscriber `visibleIds: Set<string>` so `remove` is emitted ONLY for previously visible sessions.

### 1.2 HTTP+SSE Session-List Route (`src/host/daemon/session-list-sse.ts`)
- **Routes (`src/host/server-routes.ts`):**
  - `GET /private/agent/v1/sessions/events` (`session_list_events`) matched **BEFORE** the `/sessions/:id` regex.
  - `GET /private/agent/v1/hello` (`protocol_hello`) and `GET /private/agent/v1/daemon/status` (`daemon_status`).
- **Assertion claims (`src/host/server-contracts.ts`, `src/host/server-assertion.ts`):** Add `'session_list_events'`, `'protocol_hello'`, `'daemon_status'` to `ASSERTION_PURPOSES` and `isClaims()` global-purpose allowlist.
- **Auth & headers (`src/host/server.ts`):** Auth runs strictly before version negotiation; `daemon_status` is in `LOCAL_OWNER_PURPOSES`, `protocol_hello` is open to any authenticated principal. Echoes `x-term2-client-api-version: 1.0` and `x-term2-daemon-id`.
- **Backpressure:** Bounded queue (`MAX_BUFFERED_EVENTS = 256`, `DRAIN_TIMEOUT_MS = 10_000`), `: heartbeat\n\n` every `15_000 ms`, terminal `session.list.resync_required` on overflow.

### 1.3 Shared Global Mutation Coordinator (`src/host/daemon/global-mutations.ts`)
- Extracts serialized `#settingsMutation` and `#oauthMutation` lanes from `ServerGlobalRoutes` plus `subscribeSettings()` (`settings.snapshot` + `settings.changed`) so HTTP+SSE and Unix NDJSON share one concurrency lane.

### 1.4 Transport-Independent RPC Dispatcher (`src/host/daemon/daemon-rpc.ts`)
- Wraps `DirectHost` + `SessionIndex` + `GlobalMutationCoordinator` + `ServerHostDependencies` + `DaemonControlPort` (`status`, `shutdown`, `fork`, `handoff`, `mcpStatus`, `mcpLogin`).
- Maps errors deterministically to canonical `ClientApiError` (`{ code, message, retryable?, details? }`).

### 1.5 Unix Domain Socket Server (`src/host/daemon/daemon-unix.ts`)
- Implements `transport-unix.md` exclusively for local-owner CLI surfaces: `0700` dir + `lstat` verification + `umask(0o077)` + `0600` socket + lock-held probe before unlink; incremental `4 MiB` inbound line cap; `5_000 ms` pre-handshake timeout; `protocol.hello`/`welcome` negotiation; multiplexed `request`/`response`/`event` with unique non-reused `streamId`s; two-tier backpressure (per-stream shedding/eviction + connection-level `8 MiB` / `10s` drain cap); EOF auto-detach.

---

## 2. Daemon Lifecycle (`src/app/daemon/`)

1. **`src/app/daemon/daemon-paths.ts`:** Resolves `runtimeDir` (`$TERM2_DAEMON_DIR` → `${XDG_RUNTIME_DIR}/term2-daemon[-hash]` → `${XDG_STATE_HOME:-~/.local/state}/term2/run`, never `/tmp`), `socketPath`, `daemon.lock.sqlite` (`acquireDaemonLock`), and atomic `0600` `daemon.json` (`O_EXCL | O_NOFOLLOW` + `rename`).
2. **`src/app/daemon/daemon.ts` + `launch-daemon.ts`:** Acquires `daemon.lock.sqlite`, composes ONE `SettingsService` / `DirectGlobalConfiguration`, ONE `DirectWorkspaceAuthority`, ONE workspace-keyed `DirectMcp` pool, ONE `DirectApplication` (`autoDrainBackgroundNotifications: true`), and ONE `SessionIndex`; runs `DaemonUnixServer` and optional HTTP+SSE `DirectServerTransport`; implements graceful drain (`whenIdle`, `timeoutMs`, `daemon.draining` broadcast) and clean unlink-before-unlock shutdown.
3. **`src/app/daemon/daemon-bootstrap.ts`:** Client discovery, `lstat` socket ownership verification, race-safe detached auto-start with backoff + re-spawn during peer drain, `protocol.hello` handshake, and `--in-process` / `TERM2_IN_PROCESS=1` escape hatch.

---

## 3. Agent Runtime Shallow Plug-In Seams

### 3.1 `DirectSessionStore` & `DirectHost` Lifecycle Hooks
- Extend `DirectSessionStore.list()` summary with optional `createdAt`, `latestSequence`, `status`, `binding`, and 120-char scrubbed `title` (eliminating 60-vs-120 char drift with `server-projection.ts`), backed by `withNativeCatalogue()`.
- Add `onProjectionUpdate` on `DirectAttachmentOptions`, `onSessionLifecycle` on `DirectHostDeps`, and optional `sendCommand` on `DirectHost` (avoiding per-command queue allocation).
- Reconcile D007 visibility in `src/app/host-config-access.ts`: unbound local sessions (`binding === undefined`) are visible to an HTTP `owner` principal iff an active workspace grant covers `started.root`.

### 3.2 Moving `headlessPolicy` into `DirectSession` (D003)
- Add `decideHeadless?` on `ApprovalReviewPort` (`src/session/approval/approval-arbiter.ts`), wired in `src/app/lib/approval-model.ts` using the session's `SessionApprovalPolicy` (`interactive` | `{ mode: 'headless', autoApprove }`).
- Settle unapproved requests, questions, and budget pauses atomically inside `conversation-turn.ts` and `background-interactions.ts` with `resolutionSource: 'policy'`, removing `DirectApplication.headlessPolicy` (`src/app/application.ts`) so headless clients become pure wire observers.

### 3.3 `AnthropicShellSandboxRunner` Multi-Workspace Safety (Stage 1 for Step 14a)
- Replace shared-instance `#heldLease` (`src/tools/shell/sandbox/shell-sandbox-runner.ts`) with a scoped `SandboxLease` handle returned by `acquire()` so concurrent sessions can never bypass `#managerOperation`.
- Move `sandbox-network-approval.ts` module globals (`activeCommand`, `activePauseController`) into a per-lease `NetworkApprovalScope` bound into `sandboxAskCallback`.
- Isolate per-workspace scratch temp dir (`SANDBOX_TEMP_DIR/<sha256(cwd).slice(0,16)>`, `0o700`) and keep `CLAUDE_CODE_TMPDIR` strictly inside the held lease around `wrapWithSandbox()`.
- Stop caching workspace-specific config errors in static `#initializationFailure`.
