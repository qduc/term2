# Term2 Client API — Unix Domain Socket Transport Binding (Draft rc2)

- **Applies to:** Core Protocol Specification `1.0` ([`client-api.md`](client-api.md))
- **Status:** Draft rc2
- **Primary Consumers:** Trusted local-owner CLI surfaces ONLY — TUI, Headless CLI, Control CLI, and local ACP.
- **Explicit Prohibition:** Clients MUST NOT proxy untrusted, remote, or multi-user principals (e.g., Web BFF or multi-user bridges) over `daemon.sock`. Proxying surfaces MUST connect via the [HTTP + SSE Binding](transport-http-sse.md) with per-request RS256 assertions.

---

## 1. Socket Location, Filesystem Security, and Singleton Locking

### 1.1 Runtime Paths
Unless overridden by environment variables (for isolated tests or custom deployments):
- **State directory (`stateDir`):** derived from `$TERM2_CONVERSATIONS_DIR` parent or `<xdg-state>/term2`.
- **Runtime directory (`runtimeDir`):**
  1. `$TERM2_DAEMON_DIR` if set; else
  2. `${XDG_RUNTIME_DIR}/term2-daemon` (or `${XDG_RUNTIME_DIR}/term2-daemon-<sha256(stateDir).slice(0,12)>` when `TERM2_CONVERSATIONS_DIR` is overridden without `TERM2_DAEMON_DIR`, preventing test/isolated runs from colliding with the user's default daemon); else
  3. `${XDG_STATE_HOME:-~/.local/state}/term2/run` (user-private path — NEVER inside world-writable `/tmp`).
- **Unix socket path:** `$TERM2_DAEMON_SOCKET` or `<runtimeDir>/daemon.sock`.
- **Daemon lock file:** `<stateDir>/daemon.lock.sqlite` (exclusive SQLite `BEGIN IMMEDIATE` transaction).
- **Advertisement file (advisory only):** `<runtimeDir>/daemon.json`, containing `{ daemonId: OpaqueId, pid: PositiveInt, procStartTime: UtcTimestamp | number, startedAt: UtcTimestamp, socketPath: string, daemonVersion: string, protocolVersion: string }`. Liveness is always determined by `connect()` + `protocol.hello`; clients MUST NOT signal `pid` without verifying `procStartTime`.

### 1.2 Mandatory Filesystem Security & Strict Startup Order
The Host MUST execute startup in this exact order to eliminate socket-unlink races and TOCTOU windows:
1. Create `<runtimeDir>` and `dirname(socketPath)` with mode `0o700`. Verify via `lstat()` on both directories that each is a real directory (`!isSymbolicLink()`), owned by `process.getuid()`, with `(mode & 0o077) === 0`. Abort if verification fails.
2. Acquire exclusive `<stateDir>/daemon.lock.sqlite` (`BEGIN IMMEDIATE`).
   - If lock acquisition fails with `SQLITE_BUSY` (another daemon candidate holds the lock): probe `connect(socketPath)`. If connectable, exit cleanly with code `0`. If `ENOENT`/`ECONNREFUSED` (peer starting or draining), retry lock acquisition with short backoff up to `3_000 ms`, then exit `0` if peer becomes connectable or fail otherwise.
3. **ONLY while holding `daemon.lock.sqlite`:** inspect `<socketPath>` via `lstat()`. If it exists, probe `connect(socketPath)`. If connectable, abort without unlinking. If `ECONNREFUSED`, verify `lstat().isSocket()` before unlinking (NEVER unlink a non-socket file).
4. Set process `umask(0o077)` around `bind()`/`listen(socketPath)` (restoring prior umask in `finally`), and additionally `chmod(socketPath, 0o600)`.
5. Atomically write `<runtimeDir>/daemon.json` via a sibling temp file opened with `O_CREAT | O_EXCL | O_NOFOLLOW` mode `0o600`, then `rename()`.
6. On shutdown: remove `<runtimeDir>/daemon.json` and unlink `<socketPath>` BEFORE releasing `daemon.lock.sqlite`.

**Client pre-connect check:** Before connecting to `<socketPath>`, local clients MUST verify via `lstat()` that `dirname(socketPath)` and `<socketPath>` are not symlinks and are owned by `process.getuid()` (aborting on mismatch).

Every accepted connection on `daemon.sock` is authenticated as the local `owner` principal (`{ userId: localOwnerUserId, via: "local" }`).

---

## 2. Wire Framing (Multiplexed NDJSON)

All frames are UTF-8 JSON objects terminated by a single newline (`\n`, `0x0A`). Literal newlines inside JSON strings MUST be escaped (`\\n`).

- **Inbound frame cap (incremental):** `4 MiB` (`4_194_304` bytes) for `C -> H` frames. The Host MUST count bytes incrementally as chunks arrive BEFORE `\n` and immediately close the connection if an unterminated line exceeds `4 MiB`.
- **Outbound frame cap:** `16 MiB` (`16_777_216` bytes) for `H -> C` frames.
- **In-flight caps:** Host MAY bound concurrent in-flight requests per connection (default `64`) and concurrent active subscriptions per connection (default `32`), rejecting excess calls with `busy`.

### 2.1 Frame Envelopes

1. **Request (`C -> H`):**
   ```json
   { "kind": "request", "id": "req-1", "method": "session.list", "params": { "limit": 20 } }
   ```
   `id` MUST be a non-empty `ControlFreeString` unique among in-flight requests on that connection. `params` MAY be omitted for zero-argument methods (treated as `{}`). Requests are strictly `C -> H`; the Host MUST NEVER send `kind: "request"` frames.

2. **Response (`H -> C`):**
   - Success:
     ```json
     { "kind": "response", "id": "req-1", "ok": true, "result": {} }
     ```
   - Error (encodes Core `ClientApiError`):
     ```json
     {
       "kind": "response",
       "id": "req-1",
       "ok": false,
       "error": {
         "code": "not_found",
         "message": "Session not found.",
         "retryable": false,
         "details": {}
       }
     }
     ```

3. **Subscription Event (`H -> C`):**
   ```json
   { "kind": "event", "streamId": "sub-1", "event": "session.list.upsert", "payload": { "session": {} } }
   ```

4. **Connection-Level Notification (`H -> C`):**
   ```json
   { "kind": "event", "event": "daemon.draining", "payload": { "reason": "shutdown", "gracePeriodMs": 5000 } }
   ```
   *(Also used for optional Host keepalive `event: "protocol.heartbeat"`, `payload: { now: UtcTimestamp }`.)*

---

## 3. Handshake and Subscription Lifecycle (`streamId`)

1. Immediately after Unix socket connect, the Client MUST send `method: "protocol.hello"`, EXCEPT for the single version-invariant local-owner recovery call `daemon.shutdown({ mode: "graceful", whenIdle: true })` (see §4.3). Connections that fail to send `protocol.hello` (or that recovery call) within `5_000 ms` MUST be closed by the Host.
2. Until `protocol.hello` succeeds with `protocol.welcome`, the Host MUST reject any method other than `protocol.hello` and `daemon.shutdown({ mode: "graceful", whenIdle: true })` with `invalid_request` (or `protocol_incompatible` on failed handshake, after which Host closes the connection).
3. **Multiplexed `streamId` rules:**
   - Every subscribe/attach method (`session.list.subscribe`, `session.attach`, `settings.subscribe`) allocates a `streamId: OpaqueId` unique and NEVER reused within the connection.
   - `session.list.subscribe` returns `{ streamId }` in `response.result`, followed immediately by `{ kind: "event", streamId, event: "session.list.snapshot", payload }` and subsequent `session.list.upsert` / `session.list.remove` frames.
   - `session.attach` returns `{ streamId, mode: "snapshot" | "replay", sessionEpoch, earliestReplayableSequence }` in `response.result`, followed immediately by `session.snapshot` (when `mode === "snapshot"`) and ordered `session.accepted` / `session.live` frames. Out-of-range `fromSeq` fails the RPC with `cursor_out_of_range` (no `streamId` allocated).
   - `settings.subscribe` returns `{ streamId }` in `response.result`, followed immediately by `settings.snapshot` and subsequent `settings.changed` frames.
   - Unsubscribe/detach methods (`session.list.unsubscribe`, `session.detach`, `settings.unsubscribe`) MUST accept `{ streamId: OpaqueId }` and return `{}`.
   - **Terminal events:** `session.resync_required`, `session.list.resync_required`, and `session.closed` automatically retire `streamId`; clients need not send `detach`/`unsubscribe`.
   - **FIFO silence guarantee:** Zero frames for `streamId` MAY be emitted after its terminal event or after the `unsubscribe`/`detach` response frame.
   - **EOF cleanup:** On socket EOF/error, the Host MUST automatically unsubscribe and release every `streamId` owned by that connection without cancelling turns or closing sessions.

---

## 4. Keepalive, Backpressure, and Client Auto-Start

### 4.1 Keepalive
- Clients MAY send `request` `{ method: "protocol.ping" }` (`C -> H` only) → `result: { now: UtcTimestamp }`.
- Host MAY emit unsolicited connection-level `{ kind: "event", event: "protocol.heartbeat", payload: { now: UtcTimestamp } }`.
- Host SHOULD NOT time out idle post-handshake local Unix connections while readable.

### 4.2 Two-Tier Bounded Backpressure
1. **Per-stream queue (`MAX_BUFFERED_EVENTS = 256`):** When a `session.attach` stream approaches capacity, Host SHOULD shed/coalesce transient `session.live` frames first while preserving `session.accepted`. If accepted frames still overflow, Host emits terminal `session.resync_required { reason: "slow_consumer", ... }` (or `session.list.resync_required { reason: "slow_consumer" }` for list streams) and retires only that `streamId`.
2. **Connection-level outbound cap:** Host MUST enforce a bounded per-connection outbound byte buffer (e.g., `8 MiB`) and write drain timeout (`DRAIN_TIMEOUT_MS = 10_000 ms`). If a stalled client stops reading from the socket past the cap/timeout, Host MUST close that client's entire socket and clean up all its subscriptions so it cannot OOM the daemon or starve other clients.

### 4.3 Race-Safe Auto-Start (Client Bootstrap Contract)
When a local CLI launches in default daemon mode (without `--in-process` / `TERM2_IN_PROCESS=1`):
1. Client verifies `<runtimeDir>` / `<socketPath>` ownership (`lstat`) if present and attempts `connect(socketPath)`.
2. On `ENOENT` or `ECONNREFUSED`:
   - Client spawns a detached `term2 daemon` process (`detached: true`, `stdio: 'ignore'`, forwarding isolation env vars such as `TERM2_CONVERSATIONS_DIR`, `TERM2_DAEMON_DIR`, `TERM2_DAEMON_SOCKET`, `TERM2_SETTINGS_DIR`).
   - Client retries `connect()` with exponential backoff (`25ms → 50ms → 100ms → 200ms`, bounded total deadline `10_000 ms`).
   - If the socket remains absent (`ENOENT`/`ECONNREFUSED`) across retries (e.g., an old draining daemon just finished exiting while an earlier candidate backed off), Client MUST re-trigger one fresh daemon spawn before exhausting the deadline.
3. Once connected, Client runs `protocol.hello`:
   - On `protocol.welcome`: proceed normally.
   - On `protocol_incompatible` (after which Host closes the socket): if `activeTurnCount === 0` and local upgrade is permitted, Client MAY open a fresh connection to `<socketPath>`, send the pre-handshake recovery request `daemon.shutdown({ mode: "graceful", whenIdle: true })`, wait for socket exit, respawn the daemon, and retry once; otherwise report an actionable version mismatch error.
