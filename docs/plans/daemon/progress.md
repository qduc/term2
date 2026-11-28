# Singleton Daemon Progress Ledger

Tracks every step of [the singleton daemon plan](README.md), its status, key artifacts, and merge commits on `main`.

| Step | Description | Status | Artifacts / Notes | Merge Commit |
| --- | --- | --- | --- | --- |
| 0 | Goals, non-goals, threat model, "works like now" | Done | `criteria-and-threat-model.md` | `65db33e` |
| 1 | Shape (4 parts, 2 contracts) | Done | `README.md` | `65db33e` |
| 2 | Start small (session-list stream first) | Done | Implemented in Step 13 | `3c37277` |
| 3 | RFC-style spec governs Client API | Done | `spec/client-api.md` (v1.0 Frozen) | `3c37277` |
| 4 | MCP/LSP spec format + TypeScript schema + JSON Schema | Done | `src/protocol/client-api/`, `spec/client-api.schema.json` (D006) | `3c37277` |
| 5 | Design-then-review rounds & freeze rule | Done | Round 1 (2 reviewers, 21 blockers fixed) + Round 2/2b PASS | `3c37277` |
| 6 | Fix comparison criteria before Step 7 | Done | `criteria-and-threat-model.md` | `65db33e` |
| 7 | Ownership boundaries (Branch A code-blind vs Branch B code-derived) | Done | `step7-ownership-comparison.md` | `65db33e` |
| 8 | Scenario validation against chosen boundaries | Done | `step8-scenarios.md` (10/10 scenarios pass) | `65db33e` |
| 9 | Client API inventory (names & directions only) | Done | `step9-client-api-inventory.md` | `65db33e` |
| 10 | Draft RFC spec + conformance suite + review rounds | Done | `spec/*.md`, `tests/host/client-api-conformance.integration.test.ts` | `3c37277` |
| 11 | Sub-module zoom-ins (Host full, Web client, Runtime shallow) | Done | `zoom/host-and-runtime.md`, `zoom/web-client.md` | `3c37277` |
| 13 | Prototype session-list stream (web sidebar) & feed back into review | Done | `SessionIndex`, `GET /sessions/events`, BFF + web sidebar live push (17/17 browser flows pass) | `3c37277` |
| 12 | Recheck draft spec & freeze Client API v1.0 | Done | Frozen 2026-11-27 (D008) | `3c37277` |
| 14a | Daemon core (Unix socket + lifecycle + headless policy + sandbox lease fix) | Done | `DaemonUnixServer`, `DaemonRpc`, `GlobalMutationCoordinator`, `startTerm2Daemon`, `connectOrStartDaemon`, `term2 daemon [start\|status\|stop]`, D003 session-owned headless approvals, scoped sandbox leases | `bf0ef68` |
| 14b | Remote `DirectConnection` over Unix socket | Done | `UnixRpcClient`, `createRemoteDirectHost`, `connectRemoteDirectHost`, `remote-direct-host.integration.test.ts` | `7a2c636c0` |
| 14c | Headless client over daemon | Done | Opt-in `TERM2_DAEMON_MODE=1` in `launch-headless.ts` + built-CLI headless-over-daemon integration test | `7a2c636c0` |
| 14d | TUI zoom-in + TUI client over daemon | Done | `TuiBackend`, `daemon-tui-backend.ts`, `DaemonTuiSettingsStore`, `daemon-tui-providers.ts`, `daemon-tui.e2e.test.ts` (independent verifier: `accept`) | Pending PR |
| 14e | Control socket, Discord, ACP, and web clients over daemon | Pending | Depends on Step 14d | — |
| 14f | Default flip to daemon mode + in-process escape hatch + full verification | Pending | Depends on Step 14e | — |

### Step 14d workspace and discovery

The Unix catalog's local workspace IDs work for creation across daemon
restarts. Skills and file reads accept session or workspace scope and reject
malformed scope instead of using the daemon's working directory. These are
implementations of existing v1.0 operations.

The independent verifier reproduced create-by-alias failure on `7a2c636c0`.
It also found that malformed skill requests had silently defaulted to the
daemon's working directory. The corrected candidate passed independent Unix
socket checks for the restart, scoped discovery, and malformed requests, and
the three daemon and Client API integration suites.

### Step 14d attachment seam, capability enforcement, and v1.0 runtime operations

- Repaired `RemoteDirectHost` attachment/replay seam (`remote-direct-attachment.ts`,
  `daemon-streams.ts`, `DirectEventQueue.finish()`): `cut()` now pairs the
  folded snapshot with its exact batch ordinal, empty-event accepted facts
  advance `seq`, state-sync snapshots stay non-transient under slow-consumer
  backpressure, and `DirectReplayConnection.replay.toSeq` is `number | null`.
- Enforced connection-scoped negotiated capabilities and matching stream-close
  methods in `DaemonUnixServer` (`requiredClientApiCapability`).
- Wired daemon-owned per-workspace MCP (`daemon-mcp.ts`), `quota.get`,
  `set_goal` (host-attached with strict validation and `expectedGeneration`
  CAS), server-resolved `skill` on `submit`/`preview`, settings fanout on
  provider/credential/OAuth commits, and `SettingsService.settingsDir`
  forwarding in `createSessionSettings` (PR #472).

### Step 14d Client API v1.1 freeze (D010)

- Reopened, independently reviewed across Security (Lens 1) and Protocol/Conformance
  (Lens 2) through two rounds (both returned PASS), and froze Client API `1.1`
  on the Unix binding while keeping HTTP+SSE pinned to `1.0` (`CLIENT_API_HTTP_VERSION`).
- Implemented version-gated v1.1 schemas, generated `client-api.schema.json`,
  `session.launch`, `session.list { cwd }` + `messageCount` + scoped cursors,
  `session.handoff { model }`, scoped TUI `settings.get`/`subscribe`/`update`
  (redacting `SENSITIVE_SETTING_KEYS` and URL userinfo/query/hash, non-resurrecting
  live inspection, unified durable `SettingsService`, `requestId` idempotency,
  and live `settings.changed` fanout), per-provider `models.list`, `providers.upsert`
  key/baseUrl retention, and `local_leases` gating (unadvertised until Step 14e).
- Verified with `daemon-unix-conformance.integration.test.ts` and all 4 host
  conformance integration suites (13/13 passed) plus all repository quality gates.

### Step 14d TUI client over daemon

- Introduced explicit app-layer `TuiBackend` seam (`src/app/lib/tui-backend.ts`)
  and Client API v1.1 Unix daemon backend (`src/app/daemon/daemon-tui-backend.ts`,
  `daemon-tui-settings-store.ts`, `daemon-tui-providers.ts`), keeping
  `launch-tui.tsx` under 500 lines and `TuiSession` within its existing ceiling.
- Wired opt-in `TERM2_DAEMON_MODE=1` interactive TUI launch (respecting
  `TERM2_IN_PROCESS=1`), headless v1.1 `session.launch` overrides, flushed/refreshed
  scoped settings & provider projections (normalizing wire `credential.configured` /
  `active` / `disabled`), server-resolved workspace `/skills`, `/mcp`, `/goal`,
  `/resume`, `/model`, client-only `/restart`, retryable reconnect on daemon restart,
  and terminal non-reconnecting close on explicit `session.close` / `workspace_revoked`.
- Added built-CLI e2e suite `tests/cli/daemon-tui.e2e.test.ts` (zero fixed sleeps).
  Independent verifier caught 4 defects on `19002d1` (`WireGoal.text` mapping,
  terminal `session.close` reconnect, OAuth `isInUse`, parallel `/resume` picker
  readiness); all 4 were fixed and independently verified `accept` on `ec3b19d32`.
