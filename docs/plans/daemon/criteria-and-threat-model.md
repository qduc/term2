# Step 0 & Step 6: Threat Model, Acceptance Criteria, and Comparison Rubric

Status: fixed before Step 7 runs (2026-11-27).

This document locks two prerequisites before any ownership decision or wire-schema design begins:

1. **Step 0:** Goals, non-goals, threat model, and the concrete definition of "works like today".
2. **Step 6:** The fixed comparison criteria and scoring rubric used in Step 7 to judge Branch A (code-blind) against Branch B (code-derived) row by row.

---

## Step 0: Goals, Non-Goals, and Threat Model

### Goal

One long-lived daemon process owns every session and runs the agent runtime. Every surface — TUI, web UI, headless CLI, control socket, Discord (and ACP where attached) — acts as a client of that daemon over the Client API.

Daemon mode becomes the default launch path. In-process mode remains available as an explicit escape hatch (and stays operational alongside daemon mode until the flip).

### Non-Goals (Out of Scope for This Program)

- **Multi-tenant hosting or public-internet exposure.** Term2 remains a single-user local/trusted-LAN assistant.
- **Execution Environments / Environment API port.** Deferred per `README.md`. New code MUST reach execution through `ExecutionContext` (`src/tools/execution-context.ts`), MUST NOT add new `isRemote()` / `getSSHService()` branches, and MUST NOT expose credentials to tool processes.
- **New authentication or authorization machinery.** Keep term2's existing auth posture — neither weaker nor stronger. Any proposed security enhancements go to `worth-revisiting.md`.
- **Rewriting client UIs or changing agent loop semantics.** This program moves the host boundary out of process behind `DirectConnection` and the Client API; logic changes trigger full `verification` skill scrutiny.

### Threat Model

**Trust boundaries:**

1. **Local OS user boundary (Unix domain socket / loopback IPC):**
   - Assets: session logs, provider API/OAuth credentials, tool execution authority (shell/file/SSH), active approvals.
   - Assumption: Processes running as the same OS user already share filesystem access to `~/.config/term2` and the session store. Other local OS users MUST NOT be able to connect to the daemon's Unix domain socket.
   - Control: Daemon Unix socket directory is created with mode `0700` and socket file with mode `0600` (matching existing local IPC posture); socket path lives under the user's XDG runtime/state directory (overridable by env var for test isolation).
2. **LAN / HTTP + SSE boundary (`term2 serve` / `term2-web`):**
   - Assets: same as above, exposed over TCP when bound beyond loopback.
   - Control: Existing auth (`src/host/server-auth.ts`, `src/host/server-pairing.ts`, `src/host/server-trusted-clients.ts`) remains the gate for HTTP/SSE requests. Loopback vs LAN binding preserves today's token/pairing/trusted-client rules.
3. **Tool execution boundary:**
   - Control: Credentials and the agent turn loop stay inside the daemon / agent runtime; tool processes never receive provider credentials (preserving today's posture and the Execution Environments ownership rule).
4. **In-flight approvals and multi-client attachment:**
   - Risk: Two attached clients racing to answer an approval/question, or a disconnected/stale client answering an already-settled interaction.
   - Control: The daemon/session is the single arbiter of interaction settlement; idempotent or first-writer-wins semantics with explicit rejection/stale-interaction status for late answers, and replayable state so all attached clients converge.

**Explicit out-of-scope threats:** Compromised same-user local process, hostile root user, internet-exposed unproxied daemon without TLS/auth, multi-user isolation inside one daemon.

### Definition of "Works Like Today" (Flip Acceptance Criteria)

1. **Existing behavioral suites pass in daemon mode:**
   - `pnpm test:integration`
   - `pnpm test:e2e`
   - `pnpm test:provider-black-box`
   - `pnpm test:web-browser`
   - `bench/headless.mjs`, `bench/hops.mts` (updated/verified for the daemon boundary), and `parity/run.mjs check`
2. **New seam checks cover the daemon boundary (crossing real process/socket/HTTP boundaries):**
   - Client attach and detach (single and multiple sessions)
   - Reconnect after dropped socket/HTTP connection without losing accepted state (cursor replay + option-B live-stream disclosure)
   - Reconnect / graceful recovery after daemon restart (in-flight turns reopened as interrupted; nothing resumes on its own)
   - Two clients attached concurrently to one session (e.g. TUI + web, or two clients): synchronized live events, approval answered from one client settles cleanly on the other, session-list updates propagate
   - Session-list stream: initial snapshot + incremental row upsert/removal over both Unix socket and HTTP+SSE, driving the web sidebar live without full refetch
   - Daemon lifecycle: auto-start when absent, singleton lock preventing split-brain daemons, connect-time protocol version handshake (compatible accept + incompatible rejection), stale socket/PID recovery, clean shutdown, and in-process escape hatch working independently
3. **Per-PR tripwire:** Any PR that changes domain logic rather than relocating/rewiring transport gets full `verification` skill evidence (including independent verification for high-risk areas).
4. **Hands-on smoke at the flip:** One real end-to-end smoke exercise per surface (TUI, web, headless) in default daemon mode before merging the flip PR.

---

## Step 6: Fixed Comparison Criteria for Step 7

Before Branch A (code-blind) and Branch B (code-derived) run, we lock the exact criteria and tie-breaking rules for comparing their ownership proposals row by row.

### Criteria (Scored 1–5 per Branch per Concern)

| Criterion | Weight | What a 5 (strong) looks like | What a 1 (weak) looks like |
| --- | --- | --- | --- |
| **1. Security** | Mandatory gate + High (25%) | Respects trust boundaries; credentials and approval authority stay inside Daemon/Runtime; never weakens term2's existing auth/approval/sandbox posture; clear single arbiter for security-sensitive actions. | Leaks credentials to clients or tool envs, allows client-side approval bypass, or creates split-brain authority. Any proposal that weakens security is disqualified regardless of total score. |
| **2. Fit with Target Architecture** | High (25%) | Cleanly matches the four-part model (Clients = render/input; Host/Daemon = control plane & fanout; Agent runtime = session durability/turn loop/providers/creds; Execution env = tools). Enables multi-client sharing and future remote/cloud Execution Environments without rework. | Blurs control plane and rendering, embeds turn/log state in clients, or hard-codes local-only assumptions that block remote Execution Environments. |
| **3. Small API Surface** | Medium-High (20%) | Minimal, cohesive Client API commands and events; avoids leaking internal runtime/persistence mechanics across the wire; uses one canonical projection and uniform subscription primitives. | Requires dozens of special-case RPCs, exposes raw log files/internal reducers to clients, or duplicates state synchronization per surface. |
| **4. Behaviour Under Failure** | High (20%) | Deterministic, well-defined recovery across client crash, network drop, daemon crash/restart, execution environment disappearance, and two concurrent UIs on one session. No lost accepted facts, no split-brain writers. | Undefined behavior when two UIs race, silent state divergence on reconnect, orphaned locks/processes on crash, or data loss on disconnect. |
| **5. Migration Cost** | Low-Medium (10%) | Reuses existing clean seams (`DirectConnection`, `WireCommand`/`WireEvent`, `session/` log) with incremental, `main`-always-green PRs. **Explicitly non-decisive alone:** higher migration cost is accepted when another option wins on Security, Architecture Fit, API Surface, or Failure Behaviour. | Requires a flag-day rewrite of every client at once or breaks existing suites mid-migration. |

### Decision Rules

1. **Security floor:** Any option that weakens term2's current security posture is rejected immediately.
2. **Weighted preference:** Compute weighted score (`0.25*Security + 0.25*ArchFit + 0.20*SmallAPI + 0.20*Failure + 0.10*Migration`).
3. **Migration cost is never decisive alone:** If Branch B only beats Branch A because of Migration Cost while trailing on Architecture Fit, Small API, or Failure Behaviour, pick Branch A (and plan an incremental migration path).
4. **Hybrid allowed when justified:** If a concern naturally splits into sub-concerns (e.g., Settings split into runtime/session settings owned by Daemon vs UI-only theme/skin owned by Client), record the split explicitly and score the split.
5. **Scenario veto (Step 8):** Every chosen row must survive all Step 8 scenarios; any row that cannot explain a scenario is reopened before Step 9.

---

## Step 7 Concern List (Shared Input for Branch A and Branch B)

Both branches MUST assign a primary owner (`Client`, `Host (daemon)`, `Agent runtime`, `Execution environment`, or an explicit split) and specify what crosses the Client API for each of these 16 concerns:

1. **Session lifecycle & discovery** (create, resume, fork, delete/archive, rename, session list & live status updates)
2. **Session event stream, projection & replay** (cursors, snapshots/hydration, live deltas vs accepted facts, transcript folding)
3. **Turn execution & queue** (submit, steer, cancel, retry, queued message editing/reordering)
4. **Approvals** (policy evaluation, approval review takeover, human approval prompt, dynamic workspace/session grants, headless auto-approve/unattended policy)
5. **User interactions** (`ask_user`, durable goal proposals / plan accept-reject, run-budget pause/continue)
6. **Settings & preferences** (global persisted settings, live runtime setting changes, per-session overrides like model/reasoning/approval mode, UI-only preferences like TUI theme/skin/web layout)
7. **Models, providers, credentials & quota** (model catalog, provider registry, API keys/OAuth tokens, subscription quota tracking)
8. **Workspaces & remote SSH targets** (working directory, host-mode switching, per-session SSH config/target selection, workspace grants)
9. **Tool execution & sandboxing** (tool dispatch, `ExecutionContext`, shell sandbox policy, credential isolation — respecting deferred Execution Environment rule)
10. **MCP servers** (server configuration, connection lifecycle, OAuth/auth, tool catalog binding, per-session vs daemon-shared server instances)
11. **Background jobs & detached shell tasks** (spawning, monitoring, output streaming, transfer/kill, survival across client disconnect and daemon restart)
12. **Subagents & delegation** (child branches, role pools, nested turns, worker worktrees, oversight/peer communication)
13. **Context, memory, skills & prompts** (compaction, rollover, personal/teammate memory, workspace skills discovery, system prompt assembly)
14. **Auth, pairing & transport access** (local Unix socket auth, HTTP/LAN bearer/pairing/trusted-clients auth, session visibility)
15. **Notifications, usage/cost & observability** (desktop/bell notifications, token/cost accounting, app logs, wire traffic logs)
16. **Daemon lifecycle & escape hatch** (discovery, auto-start, singleton locking, connect-time protocol/version handshake, daemon shutdown/upgrade, `--in-process` escape hatch)
