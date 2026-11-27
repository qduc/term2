# Step 9: Client API Inventory (Names & Directions Only)

Status: completed 2026-11-27.

Per `README.md` Step 9: *"Inventory what the Client API carries: names and directions only, drawn from steps 7–8. Anything with no scenario behind it is cut."*

Directions:
- `C -> H` : Request/command from Client to Host (daemon) (returns structured response or error)
- `H -> C` : Server-pushed event/frame from Host (daemon) to Client on an open subscription/stream
- `C <-> H` : Connect-time handshake exchange

---

## 1. Connection & Daemon Lifecycle

| Name | Direction | Scenario(s) |
| --- | --- | --- |
| `protocol.hello` / `protocol.welcome` (or `protocol.incompatible`) | `C <-> H` | S1, S3, S6, S7 |
| `daemon.status` | `C -> H` | S6, S7 |
| `daemon.shutdown` | `C -> H` | S6, S7 |
| `daemon.draining` | `H -> C` | S7 |

## 2. Session Catalog & Session-List Stream

| Name | Direction | Scenario(s) |
| --- | --- | --- |
| `session.list` | `C -> H` | S1, S8, S10 |
| `session.list.subscribe` / `session.list.unsubscribe` | `C -> H` | S8, S3 |
| `session.list.snapshot` | `H -> C` | S8, S3 |
| `session.list.upsert` | `H -> C` | S1, S2, S4, S5, S8 |
| `session.list.remove` | `H -> C` | S8 (grant revoked / session unavailable) |
| `session.create` | `C -> H` | S1, S2 (headless policy), S4 |
| `session.fork` | `C -> H` | S1 (resume/fork parity) |
| `session.handoff` | `C -> H` | S1 (TUI `/handoff` & web handoff parity) |
| `session.close` | `C -> H` | S1, S7 (explicit session release) |

## 3. Session Attachment, Event Stream & Replay

| Name | Direction | Scenario(s) |
| --- | --- | --- |
| `session.attach` (with optional `fromSeq`, optional attach policy) | `C -> H` | S1, S2, S3, S4, S10 |
| `session.detach` | `C -> H` | S1, S3, S4 |
| `session.snapshot` | `H -> C` | S1, S3, S4 |
| `session.accepted` (atomic `seq`-ordered batch of `WireEvent`s) | `H -> C` | S1, S2, S3, S4, S5, S7 |
| `session.live` (ephemeral `seq: null` batch: deltas, progress, review, quota, retry, error) | `H -> C` | S1, S2, S4, S5 |
| `session.resync_required` | `H -> C` | S3 (cursor outside retention or slow-consumer detach) |
| `session.closed` | `H -> C` | S7 (session evicted/released or workspace grant revoked) |

## 4. Session Commands (Turn, Queue, Approvals, Interactions, Goals, Tasks, Context)

Sent via `session.command` (`C -> H`), authorized per `sessionId`, returning typed receipt/result:

| Command Name | Direction | Scenario(s) |
| --- | --- | --- |
| `submit` (with `requestId`, optional `skill`) | `C -> H` | S1, S3, S4 |
| `preview` (input surge / preflight, optional `skill`) | `C -> H` | S1 |
| `cancel` (with optional `expectedTurnId`, `discardQueue`, `returnSteers`) | `C -> H` | S1, S4 |
| `retry` (`turn` or `tool`) | `C -> H` | S3, S7 |
| `queue_edit` | `C -> H` | S4 |
| `queue_retract` | `C -> H` | S4 |
| `queue_resume` | `C -> H` | S4 |
| `queue_discard` | `C -> H` | S4 |
| `answer` (approval or `ask_user` interaction decision) | `C -> H` | S2, S4, S10 |
| `take_over_review` | `C -> H` | S2, S4 |
| `answer_budget` | `C -> H` | S4 (run-budget pause/continue) |
| `set_goal` (set / achieved / abandon / clear / accept proposal, with `expectedGeneration`) | `C -> H` | S4, S7 |
| `configure` (`model`, `reasoning`, `temperature`, `approvalMode`, session overrides, `expectedRevision`) | `C -> H` | S2, S4 |
| `task_control` (`cancel`, `background`) | `C -> H` | S4, S5, S7 |
| `compact` | `C -> H` | S4 (manual `/compact`) |
| `rollover` | `C -> H` | S4 (manual rollover) |
| `rewind` / `list_rewind_targets` | `C -> H` | S1, S4 |
| `reset` | `C -> H` | S1 (TUI `/new` / reset) |
| `command_status` / `command_revision` | `C -> H` | S3, S4 (idempotent receipt query) |

## 5. Settings, Models, Providers, Credentials & Quota

| Name | Direction | Scenario(s) |
| --- | --- | --- |
| `settings.get` (returns redacted projection + schema metadata + revision) | `C -> H` | S4 (TUI `/settings` & web settings) |
| `settings.update` (with `expectedRevision`) | `C -> H` | S4 |
| `settings.changed` | `H -> C` | S4 (live TUI/web sync on global setting change) |
| `models.list` (catalog + favorites + nicknames) | `C -> H` | S1, S4 (TUI `/model` & web model picker) |
| `providers.presets` | `C -> H` | S4 (provider management) |
| `providers.upsert` / `providers.delete` | `C -> H` | S4 |
| `credentials.set` / `credentials.delete` | `C -> H` | S4 (write-only API keys) |
| `oauth.login` / `oauth.select` / `oauth.delete` | `C -> H` | S4 (returns auth URL when client-open needed) |
| `quota.get` (also pushed via `session.live` `codex_quota`) | `C -> H` | S1, S4 |

## 6. Workspaces, Files, Skills & MCP

| Name | Direction | Scenario(s) |
| --- | --- | --- |
| `workspaces.list` | `C -> H` | S1, S5, S8 |
| `workspaces.candidates.validate` / `browse` / `select` | `C -> H` | S1 (web workspace admission) |
| `workspaces.ssh.hosts` / `workspaces.ssh.add` | `C -> H` | S1, S5 (SSH workspace picker) |
| `workspaces.remove` / `workspaces.access` | `C -> H` | S5, S8 (triggers `session.closed` / `session.list.remove`) |
| `workspaces.files` (file autocomplete / workspace entries) | `C -> H` | S1 (TUI `@` picker & web file picker) |
| `skills.list` (scoped by `workspaceId` / `sessionId`) | `C -> H` | S1 (TUI `/skills` & web skills) |
| `mcp.status` (scoped by `workspaceId` / `sessionId`) | `C -> H` | S1, S5 (TUI `/mcp`) |
| `mcp.login` (OAuth handoff) | `C -> H` | S1 (TUI `/mcp-login`) |

## 7. Transport Auth & Pairing (HTTP/LAN Binding)

| Name | Direction | Scenario(s) |
| --- | --- | --- |
| `auth.pairing.register` | `C -> H` | S4 (existing `server-pairing.ts` OTP registration) |

*(Local Unix socket binding uses OS `0700`/`0600` filesystem permissions + `protocol.hello` without pairing RPCs.)*

---

## Explicitly Cut Items (No Current Scenario / Out of Scope)

Per Step 9 ("Anything with no scenario behind it is cut"):

- **`session.delete` / `session.archive` / `session.rename`**: No current term2 feature or scenario uses them. Deferred to `worth-revisiting.md`.
- **`queue.reorder`**: Not supported by `DirectSession` today; only `edit`, `retract`, `resume`, `discard` exist.
- **`memory.list` / `memory.upsert` / `memory.delete`**: Memory is managed by agent tools and durable snapshots today, not a Client API CRUD screen.
- **`jobs.subscribeOutput` / `jobs.sendInput` / `jobs.transfer`**: Task progress already streams over `session.live` (`task_progress`) and `task_changed`; no separate job-stream UI exists today.
- **`client.reportPresence`**: Cross-surface notification suppression is not required for "works like today" (each client decides notification delivery locally using its own focus/visibility state, as TUI and Web already do).
- **`clients.listTrusted` / `clients.revoke` / `clients.listActive`**: Keep existing CLI/file management of `trusted-clients.json` without inventing new security management RPCs (per Step 0 standing rule).
- **UI-only preferences (`theme`/`skin` layout RPCs, web `localStorage` prefs)**: Stay client-local (TUI reads persisted `ui.*` settings from `settings.get`/`settings.changed` with zero bespoke UI-pref RPCs).
- **Tool execution / `ExecutionContext` / `!` bang-shell / raw MCP JSON-RPC / raw provider history**: Strictly excluded from the Client API for security and architecture fit.
