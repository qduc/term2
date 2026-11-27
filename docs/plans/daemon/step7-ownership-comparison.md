# Step 7: Ownership Boundaries — Branch A vs. Branch B Comparison

Status: completed 2026-11-27.

Two independent branches analyzed the 16 concerns locked in [Step 6](criteria-and-threat-model.md):

- **Branch A (code-blind architect):** Derived ownership from first principles without reading any repository code.
- **Branch B (code-derived researcher):** Derived current ownership, locks, bypasses, and blockers from the live tree (`46b7a97`).

Each row is scored 1–5 against the fixed Step 6 criteria:
**Sec** (25%, mandatory floor) · **Arch** (25%) · **API** (20%) · **Fail** (20%) · **Mig** (10%, never decisive alone).
Weighted score = `0.25*Sec + 0.25*Arch + 0.20*API + 0.20*Fail + 0.10*Mig`.

---

## Row-by-Row Comparison & Picks

### 1. Session lifecycle & discovery
- **Branch A:** Split Host (catalog/index, live status deltas, create/fork/rename/archive/delete) + Runtime (log hydration, fork). Resume = subscribe + lazy hydration.
- **Branch B:** Host owns store, writer locks, lifecycle RPCs, and a new lightweight session index + push stream (eliminating `server.ts:listSessions` N+1 live-open). Notes `delete`/`archive`/`rename` do not exist today, and `DirectBinding` differs between CLI (`undefined`) and `serve` (`{ client, id }`).
- **Scores:**
  - Branch A: Sec 5, Arch 5, API 4, Fail 5, Mig 3 → **4.60** (adds new delete/archive/rename verbs without an existing product scenario)
  - Branch B: Sec 5, Arch 5, API 5, Fail 5, Mig 5 → **5.00** (same target shape, omits unrequested CRUD)
- **Pick:** **Unified A+B (Host + Runtime; scope to existing lifecycle verbs + session-list stream).**
  - Host owns the shared session store, per-session writer locks, lightweight metadata/live-status index, and the `session_list` push stream. Runtime owns log hydration, `fork`, `handoff`, and `reset`. Resume is `attach`/`connect`.
  - Unify store/visibility so local-owner TUI/headless and web share the daemon's session store (record `DirectBinding` unification in `decisions.md`). Defer `delete`/`archive`/`rename` (no current scenario; noted in `worth-revisiting.md`).

### 2. Session event stream, projection & replay
- **Branch A:** Runtime owns durable `seq`-ordered facts + snapshots; Host owns per-client fanout, cursors, backpressure, ephemeral deltas; Client owns transcript folding and view layout.
- **Branch B:** Matches A closely: `DirectSession` owns durable log, `DirectAttachment` + `DirectProjection` own fanout/replay/backpressure (`direct-wire-v2` batches), `Client` owns shared `src/protocol/fold/` + surface presentation. Flags 3 competing SSE formats and `directReplayView` replaying from `seq = 0`.
- **Scores:**
  - Branch A: Sec 5, Arch 5, API 5, Fail 5, Mig 4 → **4.90**
  - Branch B: Sec 5, Arch 5, API 4, Fail 5, Mig 5 → **4.80** (3 wire formats inflate API surface)
- **Pick:** **Branch A's single canonical stream model realized over Term2's existing `accepted`/`live` batch seam.**
  - Core Client API defines one canonical `snapshot` + `accepted` (`seq`) + `live` (`seq: null`) event stream with cursor replay (`fromSeq`) and explicit option-B raw-stream disclosure. Clients fold locally via `src/protocol/fold/`. Legacy HTTP SSE formats (`direct`, `agent-wire-v2`, `direct-wire-v2`) stay supported on the HTTP binding only as compatibility views during migration.

### 3. Turn execution & queue
- **Branch A:** Runtime owns turn loop & durable queue (`submit`, `steer`, `cancel`, `retry`, `queue.*` with `clientRequestId` + revision guard); Host routes & fans out; Client holds only local draft.
- **Branch B:** Already matches A via `DirectSession` + `WireCommand` (`submit`, `cancel`, `retry`, `preview`, `rewind`, `list_rewind_targets`, `queue_edit`, `queue_retract`, `queue_resume`, `queue_discard`). Flags duplicate client-side `drain_background_notifications` in `useClient.ts` vs `DirectAttachment`'s `autoDrainBackgroundNotifications`. Notes `queue_reorder` does not exist today.
- **Scores:**
  - Branch A: Sec 5, Arch 5, API 4, Fail 5, Mig 4 → **4.70**
  - Branch B: Sec 5, Arch 5, API 5, Fail 5, Mig 5 → **5.00**
- **Pick:** **Converged (Runtime + Host own turn/queue; Host owns background-notice auto-drain).**
  - Keep existing idempotent turn & queue verbs (omit unrequested `queue_reorder`). Make host-side `autoDrainBackgroundNotifications` authoritative in daemon mode so multiple clients never race to drain notices.

### 4. Approvals
- **Branch A:** Runtime owns policy engine, single-arbiter CAS settlement, dynamic grants, review takeover, AND headless/unattended auto-approve policy (constrained by Host ceilings). Client renders prompt and submits human decisions only.
- **Branch B:** Confirms `ApprovalReviews`, `SessionAccessState`, `take_over_review`, and first-answer-wins already live in `DirectSession`, **except** `app.headlessPolicy` (`src/app/application.ts`) currently executes in the app wrapper by reading `session.acceptedHistory()` in-process.
- **Scores:**
  - Branch A: Sec 5, Arch 5, API 5, Fail 5, Mig 4 → **4.90**
  - Branch B (if keeping `headlessPolicy` client-side): Sec 2, Arch 1, API 2, Fail 2, Mig 5 → **2.05** (fails security & architecture fit)
- **Pick:** **Branch A (100% Host/Runtime policy, including headless auto-approve/unattended mode).**
  - Move `headlessPolicy` evaluation inside the daemon/session runtime, selected by a session/attach policy option (`unattended` / `autoApprove` within Host ceilings). Clients never inspect provider history to evaluate approval policy.

### 5. User interactions (`ask_user`, durable goals, run-budget)
- **Branch A:** Runtime owns one unified typed interaction state machine (`ask_user`, `plan_proposal`/`goal`, `budget_pause`) with durable pending state and CAS settlement; Client renders UX.
- **Branch B:** `ask_user` and `answer_budget` already ride `WireCommand`/`WireEvent` with durable state; `setGoal` / goal proposal acceptance currently bypasses `WireCommand` via `DirectApplication.setGoal` / HTTP `POST /sessions/:id/goal`; `ServerInteractions` holds legacy multi-question wizard state in server RAM.
- **Scores:**
  - Branch A: Sec 5, Arch 5, API 5, Fail 5, Mig 4 → **4.90**
  - Branch B (status quo bypass): Sec 5, Arch 3, API 3, Fail 4, Mig 5 → **3.90**
- **Pick:** **Branch A's contract discipline mapped onto Term2's existing typed primitives.**
  - Host/Runtime owns all durable pending interactions (`ask_user`, `goal`, `budget`) with optimistic concurrency (`interactionId` / `goalGeneration`). Promote goal mutations (`set_goal` / accept proposal) into the Client API so TUI and Web share one path. Multi-question step UI lives in the Client, submitting answers atomically.

### 6. Settings & preferences
- **Branch A:** Clean 3-way split: Client owns UI-only preferences (theme/skin/layout), Host owns global persisted settings with revisioned updates + push events, Runtime owns per-session overrides (`model`, `reasoning`, `approvalMode`, etc.).
- **Branch B:** Exposes two major status-quo flaws: (1) TUI synchronously reads/mutates `app.liveSettings(sessionId)` and triggers a dummy `configure` rebuild, and (2) `launch-serve.ts` runs two competing `SettingsService` instances. Web already keeps UI prefs in `localStorage` (`browser-prefs.ts`).
- **Scores:**
  - Branch A: Sec 5, Arch 5, API 5, Fail 5, Mig 3 → **4.80**
  - Branch B (status quo): Sec 4, Arch 2, API 2, Fail 2, Mig 5 → **2.80**
- **Pick:** **Branch A's 3-way split, with daemon-served settings projection for TUI `/settings`.**
  - Host owns the single authoritative `SettingsService` (`settings.json`), exposing revisioned `settings.get` / `settings.update` + `settings.changed` events (so TUI maintains a local reactive cache without touching disk or `SessionSettingsService` directly).
  - Runtime owns per-session overrides via explicit `session.configure` (including `approvalMode` and runtime-modifiable session keys, retiring the `AsyncLocalStorage` `withApprovalMode` hack and dummy-configure).
  - Client owns purely local UI preferences (web `browser-prefs.ts`; TUI reads persisted `ui.*` settings from the daemon settings projection so multiple TUI instances share user theme/skin without adding layout RPCs).

### 7. Models, providers, credentials & quota
- **Branch A:** Host owns credential vault, serialized OAuth refresh locks, provider registry, model catalog, and cross-session quota; Runtime calls internal provider handles; Client sees only sanitized catalog/status/quota and write-only auth commands.
- **Branch B:** Confirms `DirectGlobalConfiguration`, `OAuthAccountRefreshCoordinator`, and `WireCodexQuota` already follow this shape! Flags global `defaultProviderRegistry` mutation serialization, headless OAuth browser URL handoff, and CLI `--model` fuzzy resolution running before daemon connect.
- **Scores:**
  - Branch A: Sec 5, Arch 5, API 5, Fail 5, Mig 4 → **4.90**
  - Branch B: Sec 5, Arch 5, API 5, Fail 5, Mig 5 → **5.00**
- **Pick:** **Converged (Host owns registry/vault/catalog/quota; Client gets redacted views + write-only auth).**
  - Serialize custom provider/credential/OAuth mutations in Host. Return OAuth authorization URLs to clients so non-local/headless clients can display or open them locally. Resolve CLI `--model` fuzzy patterns against the daemon's catalog/favorites/nicknames when connected to the daemon.

### 8. Workspaces & remote SSH targets
- **Branch A:** Host owns environment target registry & trust policy; Runtime owns per-session binding `(envId, cwd, hostMode)` & grants; Execution environment implements local/SSH/future-VM access. Never silently fall back from SSH to local on disconnect.
- **Branch B:** `DirectWorkspaceAuthority` + `prepareServeSshSurface` ALREADY support multi-workspace local, host-mode (`~`), and per-session SSH! Flags two concrete seams: (1) local CLI auto-admits user's `cwd` while web requires explicit persisted grants, and (2) `SSH_AUTH_SOCK` differs per client terminal.
- **Scores:**
  - Branch A: Sec 5, Arch 5, API 5, Fail 5, Mig 4 → **4.90**
  - Branch B: Sec 5, Arch 5, API 5, Fail 4, Mig 5 → **4.80**
- **Pick:** **Converged (Host owns workspace grants & SSH lifecycle; Runtime owns per-session binding; fail-closed on SSH drop).**
  - Local Unix-socket owner clients may open/create sessions in any local `cwd` (auto-admitted for the local OS user principal); HTTP/LAN clients continue requiring explicit workspace grants (`DirectWorkspaceAuthority`).
  - Keep `ExecutionContext` as the sole execution path (no new `isRemote()` branches per standing rule). Log `SSH_AUTH_SOCK` forwarding nuances in `decisions.md` / `worth-revisiting.md`.

### 9. Tool execution & sandboxing
- **Branch A:** Runtime owns tool dispatch & credential-free `ExecutionContext`; Execution environment owns FS/shell/sandbox execution & env scrubbing; Client receives read-only tool facts & output deltas only (zero tool-exec RPCs).
- **Branch B:** Confirms `LocalExecutionContext`, `sandbox-env.ts` (`isSecretKey`), and `agent-credential-paths.ts` follow this model, **and** uncovers two concrete items: (1) `AnthropicShellSandboxRunner` (`SandboxManager`) is a process-global singleton mutating `process.env.CLAUDE_CODE_TMPDIR`, and (2) TUI `!` bang-shell runs directly in the TUI process.
- **Scores:**
  - Branch A: Sec 5, Arch 5, API 5, Fail 5, Mig 4 → **4.90**
  - Branch B: Sec 5, Arch 5, API 5, Fail 4, Mig 5 → **4.80**
- **Pick:** **Branch A (Runtime dispatches via `ExecutionContext`; zero tool-execution RPCs on Client API; Execution Environments deferred).**
  - Serialize/isolate `AnthropicShellSandboxRunner` across multi-workspace sessions inside the daemon so concurrent sessions cannot race on `SandboxManager` config or `CLAUDE_CODE_TMPDIR`.
  - Keep TUI `!` bang-shell as a **client-local terminal convenience** (disabled on remote/SSH sessions, exactly as today): this preserves user shell env/TTY ergonomics AND avoids adding an arbitrary unapproved shell-execution RPC to the Client API (Decision D005).

### 10. MCP servers
- **Branch A:** Split by class: Host owns global config, daemon-shared remote MCPs, and OAuth tokens; Execution environment hosts workspace-local stdio MCPs; Runtime binds per-session tool catalog.
- **Branch B:** `createDirectMcp` is already per-workspace shared (with `McpOAuthStore`), ACP creates per-session `McpConnectionManager`s, and `DirectApplication` currently assumes only 1 `mcpCatalog` per app.
- **Scores:**
  - Branch A: Sec 5, Arch 5, API 5, Fail 5, Mig 3 → **4.80**
  - Branch B: Sec 5, Arch 4, API 5, Fail 4, Mig 5 → **4.50** (single-workspace assumption breaks multi-workspace daemon)
- **Pick:** **Branch A's multi-workspace / dual-class boundary, implemented pragmatically in Host while Execution Environments are deferred.**
  - Host owns a workspace-keyed `DirectMcp` pool (plus per-session ACP overrides) and `McpOAuthStore`, launching workspace stdio MCPs via the workspace's execution boundary (zero LLM credentials in MCP child env) so the future Execution Environment split is clean. Client API exposes only status, reconnect/refresh, and OAuth login handoff.

### 11. Background jobs & detached shell tasks
- **Branch A:** Execution environment owns OS process supervisor (surviving daemon restart if supported); Runtime owns logical session job table; Host owns on-demand output streaming & reconciliation.
- **Branch B:** `DirectBackgroundTasks` already survives turn completion and client disconnect, and `DirectAttachment` auto-drains notices when idle. Notes processes die on daemon exit today (`ShellChildRegistry`), reopening as `interrupted` on restart — true restart survival needs an external supervisor (deferred Execution Environment).
- **Scores:**
  - Branch A: Sec 5, Arch 5, API 4, Fail 5, Mig 3 → **4.60**
  - Branch B: Sec 5, Arch 5, API 5, Fail 4, Mig 5 → **4.80**
- **Pick:** **Converged with explicit deferred boundary: Host/Runtime own `DirectBackgroundTasks` + `autoDrainBackgroundNotifications`; client disconnect preserves jobs; daemon restart marks unfinished jobs `interrupted`.**
  - Daemon never idle-evicts sessions with active background tasks. Client API keeps `task_control` (`cancel`, `background`) + task events on the session stream (no separate firehose RPC needed today). External process supervision for cross-daemon-restart survival is deferred with Execution Environments (logged in `worth-revisiting.md`).

### 12. Subagents & delegation
- **Branch A:** Runtime owns delegation graph, role pools, nested turns; Execution environment owns worker worktrees; Host indexes children & caps concurrency. Reuses session APIs for inspection/intervention.
- **Branch B:** Nested turns already execute as branches inside the parent `DirectSession` log (one writer lock, one `WireSnapshot.branches[]`, `WireEvent { type: 'subagent' }`), worker worktrees already use `ExecutionContext.pin(root)`, and child approvals bubble to parent `pendingInteractions`. Notes `DirectSubagentSessions` continuity cache is in-memory per live `DirectSession`.
- **Scores:**
  - Branch A: Sec 5, Arch 5, API 4, Fail 5, Mig 3 → **4.60** (separate child-session endpoints duplicate existing parent-log branch model)
  - Branch B: Sec 5, Arch 5, API 5, Fail 5, Mig 5 → **5.00**
- **Pick:** **Branch B (parent-session branch model inside Runtime/Host, pinned worktrees via `ExecutionContext.pin`).**
  - Preserves term2's single-log invariant with zero extra Client API surface — clients already observe branches and answer child approvals on the parent session stream.

### 13. Context, memory, skills & prompts
- **Branch A:** Runtime owns prompt assembly, compaction, rollover; Host owns cross-session global/personal memory & global skills; Execution environment owns workspace skill/file discovery.
- **Branch B:** Matches A! Compaction, rollover, durable memory snapshots, and server-side `prepareSkillText` already live in Host/Runtime. Flags two daemon blockers: (1) `application-hooks.ts` is wired once per `DirectApplication` with `process.cwd()` and terminal `programStatus` instead of per-session workspace/client mode, and (2) TUI expands skills locally instead of using server-side `prepareSkillText`.
- **Scores:**
  - Branch A: Sec 5, Arch 5, API 5, Fail 5, Mig 4 → **4.90**
  - Branch B: Sec 5, Arch 5, API 5, Fail 5, Mig 5 → **5.00**
- **Pick:** **Converged (Host + Runtime own compaction, rollover, memory, skills discovery/injection, prompt assembly, and per-session hooks).**
  - Migrate TUI `/skills` to daemon `skills.list` + server-side `skill` submission (matching `server-session.ts`). Scope hooks per session workspace and client interactivity mode rather than daemon startup `cwd`.

### 14. Auth, pairing & transport access
- **Branch A:** Host is sole auth authority: local Unix socket (`0700` dir / `0600` socket, local-user scope) + LAN HTTP+SSE (bearer/pairing/trusted clients) + Host-enforced session visibility.
- **Branch B:** `DirectServerTransport` already supports Unix socket + TLS/HTTP, RS256 assertions (`server-assertion.ts`), replay ledger, OTP pairing (`server-pairing.ts`), and `TrustedClientsStore`, **but** currently requires RS256 JWT even on local Unix sockets and uses `0o660` socket mode.
- **Scores:**
  - Branch A: Sec 5, Arch 5, API 5, Fail 5, Mig 4 → **4.90**
  - Branch B (status quo JWT-on-local-socket): Sec 5, Arch 3, API 3, Fail 4, Mig 5 → **3.90**
- **Pick:** **Branch A's dual-binding auth model preserving term2's existing security posture.**
  - **Unix socket binding (local clients):** `0700` runtime directory + `0600` socket file (tightening `0660` → `0600`), authenticating as the local OS user principal without JWT ceremony.
  - **HTTP + SSE binding (web/LAN clients):** Keeps existing RS256 assertion + replay ledger + OTP pairing + trusted-clients auth untouched (neither weaker nor stronger, per Step 0 standing rule).

### 15. Notifications, usage/cost & observability
- **Branch A:** Runtime records durable usage/cost facts; Host owns cross-session rollups & redacted `0600` app/wire logs; Client owns local notification delivery (BEL/OSC/browser toast).
- **Branch B:** Confirms term2 ALREADY follows this exact split! `launch-tui.tsx` drives `notification-service.ts` purely from live `WireEvent`s; `usage-report.ts` reads `WireSnapshot`; `SessionContextService` already uses `AsyncLocalStorage` for per-session provider traffic logging.
- **Scores:**
  - Branch A: Sec 5, Arch 5, API 5, Fail 5, Mig 5 → **5.00**
  - Branch B: Sec 5, Arch 5, API 5, Fail 5, Mig 5 → **5.00**
- **Pick:** **Converged (Client delivers surface notifications from live events; Host/Runtime own usage facts, app logs, audit logs, and provider-traffic logs).**
  - Omit `client.reportPresence` from v1 unless a scenario demands cross-surface notification suppression (keep API small; logged in `worth-revisiting.md`).

### 16. Daemon lifecycle & escape hatch
- **Branch A:** Host owns singleton lock, protocol `hello`/`welcome` handshake, version/capability negotiation, and graceful drain/shutdown; Client launcher owns discovery, race-safe auto-start, and `--in-process` escape hatch (transport swap behind same `DirectHost`/`DirectConnection` interface, guarded by per-session writer lock).
- **Branch B:** Confirms repo already has SQLite singleton locking (`acquireStateDirLock`), stale-socket probing (`prepareSocket`), and atomic advertisement files (`control-transport-files.ts`). Flags `/restart` (`process.execve`) assuming in-process host, and lack of cross-process lock on `settings.json` when `--in-process` coexists with a daemon.
- **Scores:**
  - Branch A: Sec 5, Arch 5, API 5, Fail 5, Mig 4 → **4.90**
  - Branch B: Sec 5, Arch 5, API 5, Fail 4, Mig 5 → **4.80**
- **Pick:** **Branch A (singleton daemon + race-safe auto-start + `hello`/`welcome` version handshake + `--in-process` escape hatch behind `DirectHost`).**
  - `/restart` in daemon mode restarts the client (or requests daemon restart when explicitly invoked as a daemon admin command / idle upgrade); in `--in-process` mode preserves existing `process.execve` behavior. Log cross-process `settings.json` lock for `--in-process` coexistence in `worth-revisiting.md`.

---

## Summary Ownership Matrix (Settled for Step 8 Scenario Testing)

| # | Concern | Primary Owner(s) | Client Role |
| --- | --- | --- | --- |
| 1 | Session lifecycle & discovery | Host (catalog, locks, list stream) + Runtime (log, fork, handoff) | List/sidebar UI, switch/create intents |
| 2 | Event stream, projection & replay | Runtime (facts) + Host (projection, fanout, replay) | Local fold (`src/protocol/fold/`) & render |
| 3 | Turn execution & queue | Runtime (turn) + Host (durable admission, queue, auto-drain) | Composer draft & idempotent commands |
| 4 | Approvals | Host + Runtime (policy, reviews, grants, headless policy, CAS) | Prompt UI & human `answer`/`take_over_review` |
| 5 | User interactions (ask_user, goals, budget) | Host + Runtime (durable state, CAS) | Prompt/wizard/goal/budget UI |
| 6 | Settings & preferences | Host (single `SettingsService` + push) + Runtime (session overrides) | Local UI prefs + cached settings view |
| 7 | Models, providers, credentials & quota | Host (vault, registry, catalog, OAuth lock, quota) + Runtime (calls) | Redacted views + write-only auth + OAuth URL open |
| 8 | Workspaces & remote SSH targets | Host (grants, SSH lifecycle) + Runtime (session binding) | Passes local `cwd` or `workspaceId`/SSH target |
| 9 | Tool execution & sandboxing | Runtime (dispatch via `ExecutionContext`) + Exec Env (deferred) | Read-only tool events (plus TUI-local `!` shell) |
| 10 | MCP servers | Host (per-workspace pool + ACP per-session + OAuth store) | Status & OAuth login UI |
| 11 | Background jobs & detached shells | Host + Runtime (`DirectBackgroundTasks` + auto-drain) | Task panel & `task_control` |
| 12 | Subagents & delegation | Runtime (nested branches in parent log) + Exec Env (worktrees) | Render `branches` & answer escalated approvals |
| 13 | Context, memory, skills & prompts | Host + Runtime (compaction, rollover, memory, skills, hooks) | Skill autocomplete + trigger commands |
| 14 | Auth, pairing & transport access | Host (Unix `0600` local-owner + HTTP/SSE RS256/pairing) | Presents local OS creds or HTTP auth/pairing |
| 15 | Notifications, usage/cost & observability | Client (surface alerts) + Host/Runtime (cost facts, logs, traffic) | Render alerts & `/usage` from stream/snapshot |
| 16 | Daemon lifecycle & escape hatch | Host (lock, handshake, drain) + Client (discover, auto-start, `--in-process`) | Bootstrap & reconnect |
