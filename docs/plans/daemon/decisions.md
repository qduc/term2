# Singleton Daemon Decision Log

Each architectural, protocol, or operational decision made during the singleton daemon program is recorded here with its date, context, options weighed, choice, rationale, and link to any follow-up in `worth-revisiting.md`.

---

## D001 — Program plan baseline and state layout (2026-11-27)

- **Context:** Starting the singleton daemon program from `docs/plans/daemon/README.md` (originating on `claude/gracious-goldberg-7pbzpv` commit `8417a42`, cherry-picked onto `origin/main` `46b7a97`).
- **Choice:** Store program state in `docs/plans/daemon/` across `README.md` (status + Resume here), `criteria-and-threat-model.md` (Step 0 & Step 6), `decisions.md` (this file), `progress.md` (step ledger), and `worth-revisiting.md` (owner review items). Subsequent design/spec artifacts (Step 7 comparison, Step 8 scenarios, Step 9 inventory, Step 10 RFC spec, Step 11 zoom notes) live in the same folder.
- **Why:** Keeps `main` always green and resumable by any fresh orchestrator session without polluting the allowlisted repository root (`scripts/check-root.mjs`).

## D002 — Execution order of Step 12 (freeze) and Step 13 (session-list prototype) (2026-11-27)

- **Context:** `README.md` lists Step 12 ("Recheck the draft spec against what the zoom-ins found, then freeze under step 5's rule") before Step 13 ("Prototype the session-list stream against the draft spec and feed what it teaches back into review before anything freezes").
- **Choice:** Run Step 13 (prototype the session-list stream and wire the web sidebar against the draft Client API spec) **before** executing the Step 12 spec freeze, then incorporate prototype learnings into the final review round and freeze.
- **Why:** Step 13 explicitly states "feed what it teaches back into review before anything freezes". Freezing before prototyping would force an immediate reopen/version bump if the first real client uncovers wire friction.

## D003 — Move headless approval policy (`headlessPolicy`) into Host/Runtime (2026-11-27)

- **Context:** In-process `src/app/application.ts:headlessPolicy` currently reaches directly into `session.acceptedHistory()` and `runtime.surface.decideInteraction(...)` because headless clients do not see provider history over the wire.
- **Choice:** Move headless auto-approve / non-interactive approval evaluation inside the daemon/session runtime, configured via an explicit session/attach approval policy rather than running in the client process.
- **Why:** Under Step 6 criteria, keeping approval policy in the client either leaks provider history across the wire or weakens security authority. Keeping all approval policy inside Host/Runtime preserves single-arbiter authority and keeps clients thin.

## D004 — Dual-binding transport auth preserving current security posture (2026-11-27)

- **Context:** `DirectServerTransport` currently requires RS256 `x-term2-assertion` JWTs even over a local Unix socket (`0o660`), while local CLI surfaces (TUI, headless, control, Discord, ACP) run as the same OS user.
- **Choice:** The daemon serves the same core Client API over two transport bindings:
  1. **Local Unix domain socket** (`0700` runtime directory, `0600` socket file) authenticating as the local OS user principal without JWT ceremony.
  2. **HTTP + SSE (LAN / web BFF)** preserving existing `server-auth.ts` (RS256 assertions + `SqliteReplayLedger`), `server-pairing.ts` (OTP), and `server-trusted-clients.ts` unchanged.
- **Why:** Tightens local socket permissions (`0660` -> `0600`) without weakening or inventing new auth machinery, and eliminates unnecessary JWT overhead for local CLI clients while keeping LAN/web security intact.

## D005 — Keep TUI `!` bang-shell client-local (2026-11-27)

- **Context:** `launch-tui.tsx` (`integration.shell`) executes `!` bang-shell commands directly in the TUI process (disabled in SSH mode).
- **Choice:** Keep `!` bang-shell as a local terminal convenience in the TUI client (still disabled on remote/SSH sessions) rather than adding an unapproved arbitrary shell-execution RPC to the Client API.
- **Why:** Preserves local TTY/shell environment ergonomics and avoids exposing an approval-bypassing shell RPC over the Client API. Logged in `worth-revisiting.md`.

## D006 — Stage the Client API TypeScript schema + generated JSON Schema in `src/protocol/client-api/` before graduating to `@qduc/agent-wire` (2026-11-27)

- **Context:** Step 4 calls for one TypeScript schema in `@qduc/agent-wire` with JSON Schema generated from it. `@qduc/agent-wire` is maintained in the separate `qduc/agent-runtime` repository, which is outside this run's mounted project resources (`qduc/term2` only).
- **Choice:** Author the Client API schema as a self-contained, zero-Term2-internal-dependency module under `src/protocol/client-api/` (using Zod v4 + `z.toJSONSchema()` to generate `docs/plans/daemon/spec/client-api.schema.json`), and log its graduation into `qduc/agent-runtime` (`packages/wire`) in `worth-revisiting.md`.
- **Why:** Delivers a single authoritative TypeScript schema and generated JSON Schema immediately without touching an unmounted external repository or patching vendored tarballs (`vendor/README.md`). Keeping the module free of Term2-internal imports makes upstream graduation into `@qduc/agent-wire` mechanical.

## D007 — Unify conversation store and session visibility across local and web principals (2026-11-27)

- **Context:** Today `cli.ts` stores sessions in `<xdg-data>/term2/conversations-next` (unbound `DirectBinding` for local sessions) whereas `launch-serve.ts` isolates sessions in `<stateDir>/conversations` (`<data>/gateway-next/conversations`) with `binding: { client: ownerUserId, id: workspaceId }`.
- **Choice:** In daemon mode, one daemon owns the canonical `<xdg-data>/term2/conversations-next` store (unless overridden by `TERM2_CONVERSATIONS_DIR` / `--state-dir` for isolated test runs). Local Unix-socket owner clients auto-admit their local `cwd` and see all local-owner sessions; HTTP/web clients continue authorizing against explicit workspace grants (`DirectWorkspaceAuthority`), seeing sessions whose workspace root matches an authorized grant.
- **Why:** Required for the core goal ("one long-lived daemon owns every session and every UI is a client of it" — e.g. seeing a TUI session live in the web sidebar and attaching both UIs to the same session) while preserving explicit workspace-grant boundaries for web/LAN clients. Logged in `worth-revisiting.md` for migration of existing `<data>/gateway-next/conversations` history.

## D008 — Freeze Client API v1.0 after Review Round 2b + Step 13 prototype (2026-11-27)

- **Context:** Independent Spec Review Round 1 (2 reviewers across all 4 lenses) found 21 blocking issues; Round 2 found 3 blocking issues + 1 version-negotiation edge case; all were resolved and verified PASS in Round 2b. Both sides of the contract were zoomed (Step 11: Host/Runtime and Web Client), and Step 13 prototyped the full session-list stream end-to-end (`SessionIndex` → `GET /private/agent/v1/sessions/events` → Next.js BFF `GET /api/agent/sessions/events` → browser `session-list-stream.ts` → `server-data.ts` → live web sidebar, verified by conformance tests and 17/17 Chromium browser flows including background-session live updates).
- **Choice:** Freeze Client API `1.0` (`docs/plans/daemon/spec/{client-api,transport-unix,transport-http-sse}.md`, `src/protocol/client-api/client-api-schema.ts`, `docs/plans/daemon/spec/client-api.schema.json`). Any subsequent contract change MUST reopen design/review/freeze and negotiate via connect-time versioning per the standing rules.
- **Why:** All Step 5 freeze gates passed with zero open blocking findings and live end-to-end confirmation across both transport and browser boundaries.

## D009 — Stage TUI migration behind the existing application integration (2026-11-28)

- **Context:** The [TUI zoom-in](zoom/tui.md) found that the terminal UI's app
  adapter reads live runtime settings and owns several lifecycle operations.
  Client API v1.0 alone cannot express every operation the TUI uses today.
- **Choice:** Repair the existing workspace and attachment seams first. Keep
  Ink and terminal input behavior shared. Change the app adapter to consume an
  explicit backend, and reopen the Client API for the missing operations before
  routing TUI traffic through the daemon.
- **Why:** Side-by-side verification can exercise the same TUI in both modes.
  Smaller changes keep the existing entry point usable while the daemon backend
  gains parity.

## D010 — Reopen, review, and freeze Client API v1.1 (Unix minor bump) (2026-11-28)

- **Context:** Per D009 and the TUI + Step 14e surface zoom-ins (`zoom/tui.md`),
  Client API v1.0 lacked additive local-owner operations required for full TUI
  and local-surface parity: `session.launch` (workspace/selection/override
  admission before attach), `session.list { cwd }` + `messageCount`,
  `session.handoff { model }`, scoped TUI `settings.get`/`settings.subscribe`/
  `settings.update` (`view: "tui"`, `sessionId`, `persist`, `reset`, `requestId`),
  per-provider `models.list { provider, refresh }` with favorites/nicknames,
  `providers.upsert { keepApiKey, keepBaseUrl }`, `mcp.login { handoffUrl }`,
  and connection-bound local leases (`daemon.serve.start`/`stop`,
  `session.control.bind`/`rebind`/`unbind`, `session.acp.set_mcp`) gated behind
  the `local_leases` capability.
- **Choice:** Bump the Unix transport protocol version to `1.1` (backward
  compatible with `1.0`, strict connect-time version negotiation rejecting v1.1
  methods/fields on `1.0` connections) while keeping the HTTP+SSE transport
  pinned to `1.0` (`CLIENT_API_HTTP_VERSION = '1.0'`,
  `CLIENT_API_HTTP_CAPABILITIES`). Withhold `local_leases` from `protocol.hello`
  capabilities until Step 14e wires those lease handlers. Freeze `1.1` after two
  independent review rounds (Security/Threat-Model Lens 1 and Protocol/Conformance
  Lens 2 both returned PASS) and full schema + conformance verification.
- **Why:** Keeps v1.0 clients and the HTTP+SSE security boundary unchanged,
  avoids ad-hoc side channels for TUI/serve/control/ACP, enforces secret and URL
  credential/query/hash redaction on TUI settings projections, and honors Step 5's
  contract-freeze rule.

## D011 — Control sockets and ACP over the daemon (Step 14e Part 2, 2026-11-28)

- **Context:** after Part 1 (#475), `local_leases` was advertised while
  `session.control.*` and `session.acp.set_mcp` still answered `unavailable`. The
  daemon-mode TUI had a no-op control bridge, `--control-socket` forced
  in-process mode, and `term2 acp` built its own host.
- **Choice: control sockets.** The daemon owns the TUI's named control socket
  (`src/app/daemon/leases/control-lease.ts`). It is the same `ControlSocketServer`
  as in-process (`startDirectControlSocket`), so the location, file modes (dir
  0700, socket and advertisement 0600) and wire protocol are unchanged.
  - The socket is bound to the binding connection: EOF releases it without
    cancelling the session; `rebind` follows `/clear` and `/resume`.
  - `/restart` sends `unbind {pauseForHandoff}`. The socket stays up with
    mutations paused, and the replacement process claims it with `rebind` using
    the lease id passed in `TERM2_CONTROL_HANDOFF_LEASE`. An unclaimed paused
    socket closes after 30 s.
  - Only terminal sessions get a socket: `bind`, or a `rebind` that moves onto a
    headless or ACP session, answers `forbidden`, because in-process only a TUI
    ever has one.
  - `rebind` and `unbind` on one lease run one at a time, so a move in flight
    cannot lift a handoff pause. Release runs outside that queue, so EOF and
    shutdown never wait on a stuck operation.
  - Discord send reaches daemon interactive sessions exactly as in-process TUI
    sessions; headless and ACP sessions get no `discord_send`.
- **Choice: ACP.** In daemon mode `term2 acp` opens and resumes sessions through
  `session.launch { clientMode: 'acp' }`. The servers an ACP client supplies run
  inside the daemon through `session.acp.set_mcp`, reusing `createAcpSessions`
  (`src/app/acp/daemon-acp.ts`, `launch-acp-daemon.ts`).
  - **Holder model.** The connection whose ACP launch admitted a session holds
    it until that connection ends, like the in-process writer lock. A second ACP
    launch gets `busy`. Only the holder may call `set_mcp` (`forbidden`
    otherwise). When the holder disconnects, every MCP process the session ever
    had is closed, including ones it cleared or replaced. A new holder is reset
    to Ask before any requested configuration, or refused.
  - **Posture lives in the session.** An ACP session's own settings refuse
    Assisted, Unattended and sandbox-off on every write path, and `configure`
    checks requested approval modes against `DirectSessionPolicy.refuseSetting`.
    Per-RPC guards were not enough: the independent verifier reached Unattended
    through the web session-config route after the Unix routes were guarded.
    In-process ACP does not install this refusal, because ACP v1 may choose
    Assisted there.
  - **MCP isolation.** ACP servers never join the daemon's per-workspace MCP
    pool, and their processes get only the six variables the MCP SDK passes on,
    taken from the ACP client, never the daemon's environment (which holds
    forwarded provider keys).
- **Deviations:** bind/rebind return `{ leaseId, name, socketPath,
  discordInputEnabled, startup, pid }`, a result shape the frozen schema does not
  define (it freezes only params). The handoff lease id travels in a
  client-internal environment variable. The daemon-mode startup message reads
  `Control socket on: <name> (daemon)`.
- **Why:** both surfaces move onto the daemon with in-process posture or
  stricter, and the in-process path (`TERM2_IN_PROCESS=1`, or no
  `TERM2_DAEMON_MODE`) is unchanged. Gaps that need a Client API change or an
  owner decision are worth-revisiting items 11–16.


## D012 — Local daemon launch fixes found while preparing the flip (2026-11-28)

Bugs on `main` that matter while daemon mode is still opt-in, split out of the
Step 14f flip work. Each has a built-CLI case in
`tests/host/daemon-local-launch.integration.test.ts` that fails on `d60623817`.

- **State directory of a non-default store.** `resolveDaemonPaths` used the
  parent of `TERM2_CONVERSATIONS_DIR` as the daemon's state directory, and
  `ensureSecurePrivateDir` then made it 0700 and put `daemon.lock.sqlite` and
  `run/` in it. With `TERM2_CONVERSATIONS_DIR=/tmp/convs` that chmods `/tmp`
  (seen as root while running the e2e suite in daemon mode); with
  `~/conversations` it chmods the home directory. Such a store now gets
  `<xdg-state>/term2/stores/<sha256(store)[:12]>`.
  - **Deviation from the frozen Unix binding §1.1** (paths only, no wire
    schema): the spec still says "derived from `$TERM2_CONVERSATIONS_DIR`
    parent". Update the text when the binding is next revised.
  - **Existing opt-in users with a custom store:** the lock and the socket move
    (the runtime directory is `<stateDir>/run`, or under `XDG_RUNTIME_DIR` named
    after a digest of the state directory). A daemon started before the upgrade
    keeps running on the old paths and a new client starts a second one on the
    new paths; per-session writer locks still keep the two from writing one
    session. Running `term2 daemon stop` with the old build (or ending the old
    daemon) once avoids it. The old lock and `run/` stay in the parent and can
    be deleted. The default store is unaffected by this change.
- **One socket for the default store.** Clients pass the store they resolved,
  the default one included, and `resolveDaemonPaths` treated any passed path as
  "another store": auto-starting clients used `<data>/term2-nodejs` as state
  directory and a digest-named runtime directory, while `term2 serve` and
  `term2 daemon status|stop` (which pass no store) used `<xdg-state>/term2` and
  `term2-daemon`. `term2 daemon status` could not find the auto-started daemon,
  and `term2 serve` started a second daemon on the same store, so the web UI did
  not see terminal sessions (against D007). A store now counts as another store
  only when it differs from the default by value, as §1.1 states. Existing
  opt-in users of the default store: a daemon auto-started before the upgrade
  keeps running on the old paths until it is stopped; nothing else moves.
- **Local sessions on the web's outside-sandbox path.** The daemon's surface
  gave local TUI and headless sessions `shellEscapeApproval: true` and
  `preserveSandboxedShellApproval: true`, copied from the web surface in 14a.
  With them a `shell` call with `sandbox: 'unsandboxed'` gets the requirement
  "Run shell command outside sandbox once" (`grants: ['unsandboxed-once']`), and
  `execute` runs it only with that grant for the current directory
  (`source-tools.ts`). The TUI's approval prompt answers with a plain allow, so a
  command the person approved (after the reviewer declined, or in `off`) was
  refused with "An explicit outside-sandbox grant for the current working
  directory is required." Nothing ran unreviewed: it failed closed. Local
  sessions now take the in-process path (neither flag set); the web surface
  keeps its grants, and ACP never had them.
