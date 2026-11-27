# Step 8: Scenario Validation Against Chosen Ownership Boundaries

Status: completed 2026-11-27.

Each scenario traces end-to-end across **Clients**, **Host (daemon)**, **Agent runtime**, and **Execution environments** using the ownership matrix from [Step 7](step7-ownership-comparison.md). Per the plan: *"A row that cannot explain a scenario is not settled."*

---

## Required Core Scenarios (from `README.md` Step 8)

### S1. Send a message (interactive & headless)
1. **Attach / create:** Client (TUI, Web, Headless, Control, or Discord) connects over its transport binding (Unix socket or HTTP+SSE), completes `hello`/`welcome` protocol version negotiation (Row 16, Row 14), and calls `session.create` (passing local `cwd` or `workspaceId`) or `session.attach(sessionId)` (Row 1).
2. **Optional preflight / skill:** If the client wants large-input preflight, it sends `session.command(preview)` (Row 3). If submitting with a `/skill`, it passes `{ text, skill }` so Host resolves and injects the skill server-side via `prepareSkillText` (Row 13).
3. **Submit:** Client sends `session.command(submit, { requestId, text, ... })` (Row 3). Host authorizes `write` on `sessionId` (Row 14) and invokes `DirectSession.submitWithDelivery` (Row 3).
4. **Execution:** Agent runtime starts a turn (`@qduc/agent-core`), calls providers through Host's credential-bearing `ModelRegistry` (Row 7), appends accepted facts with monotonic `seq` to the durable log (Row 2), and updates usage/cost facts (Row 15).
5. **Fanout:** Host's `DirectAttachment` projects each update once into `WireEventBatch` (`accepted` with `seq` or `live` with `seq: null`) and fans it out to every attached client (Row 2). Host updates its lightweight session-list index (`status: 'running'` → `'idle'`, `updatedAt`, `title`, `latestSequence`) and pushes a `session_list.upsert` delta to all session-list subscribers (Row 1).
6. **Rendering:** Each client folds events via `src/protocol/fold/` and updates its UI; on `turn_ended`, clients optionally fire local desktop/bell/browser notifications (Row 15).
- **Verdict:** All rows (1, 2, 3, 7, 13, 14, 15, 16) explain S1 cleanly.

### S2. Approve a tool (human interactive, review takeover, and headless unattended)
1. **Tool call & policy check:** During a turn, Agent runtime pauses at `interaction_required` (Row 4, Row 9). Host/Runtime's `ApprovalReviews` evaluates the shared approval route (`approval-route.ts`) against `SessionAccessState` dynamic grants and session approval mode (Row 4, Row 6).
2. **Case A — Assisted review + human takeover:** While model review runs, Host emits transient `approval_review` live events (Row 2, Row 4). A human client may send `session.command(take_over_review)`, aborting the review and committing a durable `interaction_opened` fact.
3. **Case B — Human prompt:** If human approval is needed, Runtime commits `interaction_opened` (`seq = N`) and waits in memory (Row 4). Host fans out `interaction_opened` to all attached clients and emits `session_list.upsert` (`status: 'awaiting_approval'` / pending interaction flag) so the web sidebar / TUI list reflects waiting state immediately (Row 1).
4. **Resolution:** Client sends `session.command(answer, { interactionId, decision: allow | deny | grant })` (Row 4). Host authorizes `write`, Runtime applies first-answer-wins CAS, persists `interaction_resolved` + any dynamic grant, and wakes `TurnHandle.answer`. Tool executes via `ExecutionContext` without credentials (Row 9).
5. **Case C — Headless unattended:** When a headless client attached/created the session with headless approval policy (`autoApprove` / non-interactive decision mode), Host/Runtime evaluates the headless decision policy directly inside the daemon (with access to `session.acceptedHistory()`), records the settlement fact, and never requires provider history on the wire (Row 4).
- **Verdict:** Settled! Moving `headlessPolicy` into Host/Runtime (Row 4 pick) was essential to make Case C work without leaking provider history across the Client API.

### S3. Reconnect after a dropped connection
1. **Drop:** Network hiccup or client restart breaks the Unix socket or HTTP SSE connection. Host detects EOF/backpressure timeout, closes only that client's `DirectEventQueue` subscription, and keeps the `DirectSession`, running turn, pending approvals, and background tasks alive (Row 2, Row 3, Row 11).
2. **Reconnect:** Client reconnects, runs `hello`/`welcome` (Row 16), and calls `session.attach(sessionId, { fromSeq: lastCommittedSeq })` (Row 2).
3. **Replay + live transition:**
   - If `fromSeq` is within replayable retention, Host replays accepted batches `(fromSeq, toSeq]` atomically followed by cut-state sync and seamlessly transitions to live fanout (Row 2).
   - If `fromSeq` is older than earliest replayable sequence or absent, Host returns a fresh `snapshot` at `seq` + live stream (`resync_required` / full hydration) (Row 2).
   - Per the explicit option-B raw-stream policy, missed ephemeral live chunks (`reasoning_delta`, `tool_progress`) are not reconstructed; accepted reasoning summaries and final tool outputs provide recovery.
4. **In-flight submit retry:** If the drop happened mid-`submit`, the client safely retries `submit` with the same `requestId`; Host/Runtime deduplicates idempotently (Row 3).
5. **Session-list stream reconnect:** Web sidebar / TUI reconnects to `session_list.subscribe` and receives a fresh `snapshot` of summaries followed by incremental `upsert`/`remove` deltas (Row 1).
- **Verdict:** All rows (1, 2, 3, 11, 16) explain S3 cleanly.

### S4. Two UIs on one session (e.g., TUI + Web browser concurrently)
1. **Shared attachment:** TUI connects via local Unix socket; Web connects via HTTP+SSE through the BFF. Both attach to the same `sessionId` inside the singleton daemon. Host holds ONE `DirectSession` (one SQLite writer lock) and ONE `DirectAttachment`/`DirectProjection`, fanning out identical `seq`-ordered batches to both clients' independent queues (Row 1, Row 2, Row 14).
2. **Slow consumer isolation:** If the Web SSE connection stalls on LAN, Host's bounded queue (`MAX_BUFFERED_EVENTS`) detaches only the Web reader; TUI and the running turn are completely unaffected (Row 2).
3. **Concurrent submit / queue edit:** TUI submits a prompt (`turn_started`); Web sees `turn_started` and live deltas in real time. While running, Web queues a follow-up; TUI sees `queue_updated` and edits it using `expectedRevision`. If Web tries a stale edit against the old revision, Runtime rejects with `stale_revision` and Web reconciles from the live event (Row 3).
4. **Concurrent approval race:** Tool requests approval; both TUI and Web show the prompt. User clicks Allow on Web while hitting `y` on TUI 10ms later. Runtime settles the first request atomically, commits `interaction_resolved`, returns `stale_interaction` to the second client, and fans out `interaction_resolved` so both UIs dismiss the prompt and converge (Row 4).
5. **Concurrent settings / model change:** User changes model or approval mode in Web (`session.configure` with `expectedRevision`). Runtime commits the config receipt and fans out `session_configured`; TUI updates its header/status bar immediately. Meanwhile, TUI uses its own skin/theme and Web uses its own `localStorage` density without conflict (Row 6).
6. **User interaction (`ask_user`, durable goal, budget):** Same single-arbiter CAS (`interactionId` / `goalGeneration` / `budgetId`); answer from either UI immediately settles on the other (Row 5).
- **Verdict:** All rows (1, 2, 3, 4, 5, 6, 14) explain S4 cleanly.

### S5. Execution environment disappearing mid-turn (e.g., SSH box disconnects or future VM drops)
1. **Mid-turn drop:** Session is bound to an SSH workspace (`prepareServeSshSurface` / `DirectRemoteWorkspace`, Row 8). Mid-turn, while a shell or file tool is running via `ExecutionContext` (Row 9), the SSH transport drops.
2. **Fail-closed tool error:** The execution adapter detects EOF/channel close, aborts the pending tool execution cleanly, and returns a structured error (`env_disconnected`) to Agent runtime — **never** silently falling back to the local host machine (Row 8, Row 9).
3. **Durable fact & pending approval cleanup:** Runtime records `tool_finished` (error) as a durable fact (`seq = N`) so the conversation log never contains a dangling `tool_use` block (Row 9). Any workspace-scoped stdio MCP bound to that target transitions to disconnected (Row 10), and any background jobs on that target transition to interrupted/unreachable (Row 11). If a child subagent branch was running on that target, it fails cleanly and reports back to the parent (Row 12).
4. **Client visibility & daemon health:** Host fans out the durable tool failure and environment-status update to all attached clients and updates the session list (Row 1, Row 2, Row 15). The daemon itself stays healthy; other sessions on local or other SSH targets continue undisturbed (Row 16).
5. **Recovery:** The session remains bound to the SSH target; user can retry once connectivity returns (re-establishing SSH lazily) or explicitly switch workspace/create a new session (Row 8).
- **Verdict:** All rows (1, 2, 8, 9, 10, 11, 12, 15, 16) explain S5 cleanly.

---

## Additional Operational Scenarios (Daemon Seams)

### S6. Daemon auto-start, concurrent launch race, and version mismatch
1. **Cold start race:** Two terminals launch `term2` simultaneously when no daemon is running. Both check the daemon socket, see `ENOENT`/`ECONNREFUSED`, and spawn a detached `term2 daemon` candidate (Row 16).
2. **Singleton lock winner:** Both daemon candidates attempt `acquireStateDirLock` (`daemon.lock.sqlite` `BEGIN IMMEDIATE`). Candidate 1 wins, binds the `0600` Unix socket inside the `0700` runtime directory, writes its atomic advertisement file (PID, start time, version, protocol version), and signals readiness. Candidate 2 sees `SQLITE_BUSY` and exits cleanly with code 0 (Row 16, Row 14).
3. **Handshake:** Both CLI clients connect to the socket and exchange `hello`/`welcome`. Compatible protocol versions proceed; an incompatible version returns `protocol_incompatible` with daemon version & active-turn count so the client can surface an actionable upgrade/restart message (or auto-restart if idle and local) (Row 16).
- **Verdict:** Settled (Rows 14, 16).

### S7. Daemon restart / crash recovery while a session is mid-turn or waiting on approval
1. **Graceful or sudden exit:** Daemon stops (SIGTERM/shutdown or crash). Active turns and local background jobs terminate; OS releases SQLite locks (`daemon.lock.sqlite` and per-session `.locks/*.sqlite`) (Row 11, Row 16).
2. **Client detection & reconnect:** Attached clients see socket/SSE EOF (preceded by `daemon.draining` on graceful shutdown), enter reconnecting state (or auto-start a fresh daemon for local CLI), re-handshake `hello`/`welcome`, and re-attach with `fromSeq` (Row 2, Row 16).
3. **Durable state recovery:** On reopen, `DirectSession` replays the append-only log: any in-flight turn or tool call lacking a terminal fact is cleanly marked interrupted (nothing resumes on its own, matching `layers.md`); durable goals, session overrides, history, and usage facts survive intact (Row 1, Row 2, Row 3, Row 5, Row 6, Row 15).
- **Verdict:** Settled (Rows 1, 2, 3, 5, 6, 11, 15, 16).

### S8. Live web sidebar (and TUI `/resume`) session-list updates without N+1 polling
1. **Subscribe:** Web BFF/browser opens the session-list stream (`session_list.subscribe` over HTTP SSE / Unix socket) (Row 1).
2. **Initial snapshot:** Daemon serves the initial list from its lightweight in-memory session index (populated from store metadata on startup + live session hooks — zero N+1 `host.connect()` calls!) filtered by the principal's authorization (Row 1, Row 14).
3. **Cross-surface live push:** User runs a turn in TUI (or creates a new session in headless CLI). Daemon's session index observes the session creation, status transition (`idle` → `running` → `awaiting_approval` → `idle`), title update, and `updatedAt`/`latestSequence` bump, pushing a single incremental `session_list.upsert` row to the Web sidebar immediately (Row 1).
- **Verdict:** Settled (Rows 1, 14). Directly solves the motivating problem from `README.md`!

### S9. `--in-process` escape hatch alongside a live daemon
1. **Escape hatch invocation:** User runs `term2 --in-process` (or `TERM2_IN_PROCESS=1`). CLI skips daemon discovery/auto-start and builds `createDirectInProcessHost` behind the same `DirectHost`/`DirectConnection` interface (Row 16).
2. **Lock safety:** Creating a new session acquires its own per-session SQLite writer lock and runs safely alongside the daemon. Attempting to open a session already live in the daemon fails loudly with a clear writer-lock conflict error (`SQLITE_BUSY` → actionable message) instead of corrupting the log (Row 1, Row 16).
- **Verdict:** Settled (Rows 1, 16).

### S10. Control socket & Discord attached via daemon
1. **Control & Discord:** `term2 control` and `term2 discord` attach to sessions through the daemon's Client API (Unix socket) instead of piggybacking exclusively on an interactive TUI process's ad-hoc socket (Row 1, Row 14, Row 16). Wait: what about TUI's `/bridge` status or `term2 control` targeting a specific interactive session?
   - **Check:** Today `launch-control.ts` (`runControlCommand`, `runDiscordBridge`) talks to `ControlSocketServer` (`src/clients/control/control-socket-server.ts`) which exposes `send`, `status`, `wait`, `approve`, `events`, etc. against the TUI's current `DirectConnection`! Under the daemon, `term2 control` and `term2 discord` can attach directly to the daemon's session (using the daemon's Client API or targeting a named/active session in the daemon) AND optionally keep existing control-socket compatibility where needed for tests!
   - **Actionable detail surfaced by S10:** Daemon needs a lightweight way to identify the target session for control/Discord (explicit `--session <id>` or session alias/binding, plus listing sessions), which is already covered by Row 1 (`session.list` + `session.attach`)! Let's ensure Step 11/14 preserves all existing control-socket & Discord e2e/integration contracts.
- **Verdict:** Settled (Rows 1, 2, 3, 4, 14, 16).

---

## Step 8 Conclusion

Every row (1–16) of the Step 7 ownership matrix survived all 10 scenarios without contradiction. Two important concrete requirements were confirmed by scenarios:
- **Row 4 (Approvals):** Headless/unattended approval policy MUST be configurable at session create/attach so S2 Case C works without provider history on the wire.
- **Row 6 (Settings) & Row 5 (Goals):** Session configuration (`approvalMode`, runtime settings) and durable goal mutations MUST be first-class Client API operations so S4 works symmetrically across TUI and Web without in-process bypasses.
