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
| 14d | TUI zoom-in + TUI client over daemon | Done | `TuiBackend`, `daemon-tui-backend.ts`, `DaemonTuiSettingsStore`, `daemon-tui-providers.ts`, `daemon-tui.e2e.test.ts` (independent verifier: `accept`) | `54fb732` |
| 14e (Part 1) | `term2 serve` & web UI over daemon (`daemon.serve.start`/`stop`, `local_leases`) | Done | `DaemonServeLeaseManager`, `launchServeOverDaemon`, unified D007 store/`SessionIndex`/`GlobalMutationCoordinator`, `daemon-serve-lease.integration.test.ts`, 35/35 Playwright browser flows under `TERM2_DAEMON_MODE=1` (independent verifier: `accept` on `9b3772a`) | Pending PR |
| 14e (Part 2) | Control socket, Discord, and ACP over daemon (`session.control.*`, `session.acp.set_mcp`) | In review | `control-lease.ts`, `control-bridge.ts`, `daemon-acp.ts`, `launch-acp-daemon.ts`, `DaemonLaunchPolicies`; daemon TUI e2e control case, `tests/clients/acp/daemon.integration.test.ts` (D011; independent verifiers: `accept`) | — |
| 14f | Default flip to daemon mode + in-process escape hatch + full verification | Pending | Depends on Step 14e Part 2 | — |

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

### Step 14e Part 1 (`term2 serve` & web UI over daemon)

- Implemented connection-scoped `daemon.serve.start` / `daemon.serve.stop` local leases
  (`src/app/daemon/leases/{serve-lease,serve-lease-helpers,launch-serve-daemon}.ts`,
  `src/host/daemon/{daemon-rpc-v11,daemon-rpc,daemon-streams,daemon-unix}.ts`),
  advertising `local_leases` on Unix v1.1+ only (gated off on Unix v1.0 and HTTP+SSE `1.0`).
- Composed HTTP+SSE listeners directly over the daemon's ONE `DirectApplication`, ONE
  conversation store (D007), ONE `GlobalMutationCoordinator`, and ONE `SessionIndex`,
  with connection-scoped `serve.pairing_otp` delivery, race-free EOF mid-start teardown,
  Symbol-tagged per-lease `SessionIndex` subscriber isolation, ALS-only `activeLease()`,
  shared `findMatchingLocalGrant` ordering (preferring explicit directory grants over static
  `host`), and live session posture enforcement (`enforceLivePosture`) preventing read-only
  or sandboxed web leases from executing writes on wider live local or resumed bound sessions.
- Routed opt-in `TERM2_DAEMON_MODE=1` `term2 serve` and `term2-web` (`scripts/start-web.mjs`)
  through `launchServeOverDaemon` (recording custom `--issuer`/`--audience` in-process fallback
  in `worth-revisiting.md`).
- Verified with `daemon-serve-lease.integration.test.ts`, `daemon-unix-conformance.integration.test.ts`,
  `tests/host/gateway/*` (both default and `TERM2_DAEMON_MODE=1`, 27/27 passed), and
  `TERM2_DAEMON_MODE=1 pnpm test:web-browser` (35/35 Playwright Chromium flows passed).
  Independent verifier caught 5 defects on `a5233ba` and 1 bound-session posture gap on `48ffd16`;
  all were fixed, covered by regression tests, and independently verified **`accept`** on `9b3772a`.

### Step 14e Part 2 (control socket, Discord, ACP over daemon)

- Two parts built in parallel worktrees and combined: control socket and Discord
  (`src/app/daemon/leases/control-{lease,bridge}.ts`) and ACP
  (`src/app/acp/{daemon-acp,launch-acp-daemon,acp-common}.ts`). Design in D011.
- A first version of both was built on a duplicate Part 1 (closed PR #476) and
  ported onto #475's layout; only the ported versions were verified.
- Evidence:
  - Control: one built-CLI journey in `tests/cli/daemon-tui.e2e.test.ts` (daemon
    pid owns the socket, in-process location and modes, `term2 control submit`
    reaches the session, `/clear` moves it, a killed TUI releases it, `/restart`
    keeps the same socket) plus a conformance case (terminal-only `bind`,
    non-holder refusals, move plus pause). Eight mutations of the fix in the CLI
    bundle each fail a check.
  - ACP: `tests/clients/acp/daemon.integration.test.ts` drives two ACP processes
    and an observer: daemon-owned MCP child processes, client-only environment,
    holder refusals, Ask reset for a new holder, foreign close reopening in Ask
    with the sandbox on, the web config route refusing Unattended, and an
    unchanged `settings.json`. Eighteen bundle mutations each fail it.
- Independent verification: control was accepted on `960da4159`, and its
  follow-ups (terminal-only binds, per-lease serialization) on `003eab871`. ACP
  was rejected twice before acceptance on `1cb7bc80a`:
  - round 1: MCP processes outliving their owner after a clear, approval mode
    inherited on resume, and a config write after a foreign close persisting to
    `settings.json`;
  - round 2: the web session-config route bypassing the per-RPC guards, which
    moved the ACP rule into the session runtime.
- Debugging trap: the subagents first shared one scratchpad folder, and one
  overwrote another's backup of `dist/src/app/cli.bundle.cjs` mid red-proof. Keep
  bundle backups in a per-agent folder and confirm restores with `cmp`.

