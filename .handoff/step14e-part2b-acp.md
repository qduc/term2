# Step 14e Part 2b: `term2 acp` over the daemon

Branch `step14e-part2b-acp-main`, based on `origin/main` `93be5b603` (main's Step 14e
Part 1, #475). The first version of this work was built on the superseded PR #476
base (`f59ad21`). It is kept only as WIP commit `d00c42abc` on branch
`step14e-part2b-acp`, and is not for landing. Everything below was re-applied and
re-verified on main's layout.

## What changed, by file

- `src/app/acp/launch-acp.ts`: with `TERM2_DAEMON_MODE=1` and no `TERM2_IN_PROCESS=1`,
  hands off to `launchAcpOverDaemon`. This is the same check `launch-headless.ts` and
  `shouldLaunchServeOverDaemon` use. `src/app/daemon/` already holds 15 files, so there
  is no shared `daemon-mode.ts` on main. The in-process path is unchanged; it now takes
  its policy from `acp-common.ts`.
- `src/app/acp/acp-common.ts` (new): ACP policy shared by the in-process launcher, the
  daemon client and the daemon:
  - `ACP_SESSION_POLICY` (`approvalAlwaysAsks`, `requireSandbox`,
    `persistSessionConfiguration: false`);
  - `authorizeAcpModel`;
  - the cache-only/refresh model catalog;
  - `applyAcpModelFlags`, which now returns the chosen model/effort so the daemon
    client can pass it to `session.launch`;
  - approval-mode mapping.

  This was moved out of `launch-acp.ts` without changing behaviour.
- `src/app/acp/launch-acp-daemon.ts` (new): the ACP daemon client. It drives the
  unchanged `createAcpBackend` over `RemoteDirectHost`:
  - **Create:** `session.launch {cwd, new, clientMode:'acp', requireSandbox, model/reasoning flags}`, then `session.attach`.
  - **Resume:** first `session.launch {resume, clientMode:'acp'}`, so a dormant session reopens with the ACP surface and admission runs.
  - **MCP:** `session.acp.set_mcp`, then a fresh attach, as in-process takes a fresh view after installing.
  - **Approval mode:** read from `settings.get {view:'tui', sessionId}`; set (v1 only) through a resume `session.launch {approvalMode}`.
  - **Configuration** (model plus effort intent): read from `settings.get`.
  - **Validation:** the MCP list goes through the same `resolveAcpMcpServers` before anything is created.
  - **Stdio environment:** stdio servers get this process's MCP-SDK default environment (HOME, LOGNAME, PATH, SHELL, TERM, USER).
  - **Errors:** daemon errors map back to the ACP codes in-process reports (`not_found`; `invalid_request` → -32602; operational → -32000, which v1 maps to -32010).
  - **Exit:** sessions stay in the daemon. Closing the Unix connection releases this client's MCP servers.
- `src/app/acp/daemon-acp.ts` (new): the daemon side.
  - `createDaemonAcp` wraps the in-process `createAcpSessions`, so validation, atomic
    replacement, retired generations and stdio spawning do not fork.
  - It adds strict zod parsing of the frozen `servers: Record<string, unknown>[]` into
    the ACP v1 `McpServer` union, per-session serialization, and connection ownership
    (`onDisconnect`).
  - It adds release on session close and on owner EOF; EOF also rebuilds the still-open
    session's tools through a `createDirectMcpRefresh` tracker.
  - It provides the ACP model rule and `admitLaunch`.
- `src/app/acp/acp-sessions.ts`: exports the existing validator as
  `resolveAcpMcpServers`; it was renamed only.
- `src/app/application-runtime.ts`: new optional
  `DirectRuntimeOptions.sessionPolicy(sessionId, {binding})` returning a
  `DirectSessionPolicy` (`approvalAlwaysAsks`, `requireSandbox`,
  `persistSessionConfiguration`, `authorizeModel`). It overrides the app-wide values
  for one session, read once as the runtime opens. When it is absent nothing changes.
- `src/app/launch-configuration.ts`: `authorize` takes an optional per-session rule
  (`sessionRule`, defaulting to the application's).
- `src/app/daemon/daemon.ts` (shared, additive):
  - `sessionPolicy` gives sessions launched with `clientMode:'acp'` (never bound/web
    sessions) `ACP_SESSION_POLICY` plus the ACP model rule.
  - `prepareSurface` sends ACP sessions to `daemonAcp.prepare` instead of the
    per-workspace pool.
  - `surface.mcp` is the ACP source for ACP sessions.
  - The lifecycle hook, v11 port `acpSetMcp` and `admitLaunch` are wired in.
  - Shutdown closes `daemonAcp`.
  - The launch-flag type is deduplicated as `DaemonLaunchFlags`.
- `src/app/daemon/daemon-v11-ops.ts`:
  - exports `DaemonLaunchFlags`;
  - adds an optional `admitLaunch(sessionId, params)` dep, called after the launch has
    its session and before any configuration applies;
  - folds the two copies of the pending-policy/flags bracket into one `withPending`
    helper. That keeps the file at 500 lines; it was already at the 500 limit.
- `src/host/daemon/daemon-rpc-v11.ts` (shared, additive): `DaemonV11ControlPort.acpSetMcp?`.
  `handleLocalLeaseMethod` now backs `session.acp.set_mcp`, with strict schema parsing
  and a required connection. `session.control.*` still answers `unavailable`, for the
  control agent.
- `src/app/README.md`: new section "ACP over the daemon".
- `tests/clients/acp/daemon.integration.test.ts` (new) and
  `tests/host/daemon-unix-conformance.integration.test.ts`. On v1.1, `set_mcp` now
  answers `not_found` for a session that is not a live ACP session and
  `invalid_request` for a malformed server list. It used to answer `unavailable`.

## Design decisions and why

1. **Per-session ACP MCP vs the daemon's per-workspace MCP (`daemon-mcp.ts`).** An ACP
   session gets only the servers its ACP client supplies. It never joins, and never
   sees, the per-workspace pool loaded from the user's `mcp.json`/project `.mcp.json`.
   ACP-supplied servers never join that pool either: they are keyed by session.
   - In-process `term2 acp` never loads user or project MCP configuration
     (`mcp: sessions.surface(id)`, `mcpCatalog: sessions`). Joining the pool would
     change what an ACP agent can do and would hand ACP sessions the pool's
     browser-interactive OAuth authority, which belongs to the terminal owner.
   - Editor-supplied servers carry editor-supplied env, headers and cwd, so they must
     not leak to other sessions in the same workspace. The in-process test already
     asserts sibling isolation.
2. **`set_mcp` is bound to the calling connection, and cleaned up on session close.**
   - D010 lists `session.acp.set_mcp` among the connection-bound local leases. The spec
     line says "cleanup on session close", and both hold. An installation is owned by
     the connection whose `set_mcp` last succeeded. Its EOF closes the servers (current
     and retired managers) and rebuilds the session's tools without them once idle.
     Session close does the same.
   - Without the binding, MCP processes that carry the editor's env would outlive the
     editor and stay callable from any later client of that session. That is wider
     than in-process, where the processes die with the ACP process.
   - A clear (`servers: []`) behaves like in-process replacement: the previous managers
     retire until session close. The session itself is not closed when the ACP client
     exits, because spec §10.1 says a client disconnect never closes a session.
3. **Posture: ACP sessions open only through `session.launch` with `clientMode:'acp'`.**
   On top of the existing `clientMode:'acp'` surface (no session browser, no
   unsandboxed shell, no shell-escape approval), `sessionPolicy` restores what used to
   be app-wide in-process:
   - Ask mode at every open even when the saved preference is `always`;
   - the sandbox is required;
   - model and effort changes never write saved defaults;
   - model moves are limited to cached models of configured providers.
4. **Admission (`admitLaunch`).**
   - An ACP launch onto a session that is live under another client's surface is
     refused with `busy`, which v1 reports as -32010. In-process, the writer lock
     refuses the same case; in the daemon, accepting it would let ACP drive a session
     built with TUI posture (unsandboxed allowed, possibly `always`).
   - Assisted and Unattended are refused (`unavailable`, see gap G1); they are never
     accepted with weaker review.
5. **MCP process environment.** The daemon spawns stdio servers through the same
   `McpConnectionManager`, and the MCP SDK passes only HOME, LOGNAME, PATH, SHELL,
   TERM and USER plus the server's own env. The client fills those six from its own
   process, so a server sees exactly what in-process ACP gives it. It never sees the
   daemon's environment, which holds forwarded `*_API_KEY` and `OPENAI_*` values. The
   test asserts both: the provider key is absent, and the PATH is the client's, not
   the daemon's. Credentials in HTTP headers stay in daemon memory, as they stayed in
   ACP-process memory, and cross only the 0600 Unix socket.
6. **No new execution path.** MCP calls stay `run_code`-only through the existing
   approval machinery. No `isRemote()` branch was added, and no code reaches
   execution outside the existing tool surface.

## Deviations, gaps and owner questions

- **G1. The frozen schema cannot say which ACP version is talking.** `clientMode` is
  just `'acp'`. In-process, v1 gets `shellEscapeApproval: true`: sandboxed shell runs
  without prompts, an "outside sandbox once" grant is offered, and in Assisted or
  Unattended a mutating sandboxed command is reviewed. v2 gets `false`. The daemon's
  ACP surface is the v2 one for both, which leaves three effects:
  - v1 in Ask mode: more prompts and no escape-once. Stricter.
  - v1 in Always mode: equivalent. Unsandboxed runs are still refused at execution
    without a grant.
  - v1 in Assisted or Unattended would be **weaker**. Measured: `echo cancelled | tee cancelled.txt`
    ran with no review. So the daemon refuses those modes for ACP, with "not available
    over the term2 daemon yet; run term2 acp with TERM2_IN_PROCESS=1".

  The fix needs a Client API change, for example `clientMode:'acp_v1'` or a
  `shellEscapeApproval` launch flag. The schema was not changed.
- **G2. Titles.** The ACP session title and `session_info_update` come from the
  daemon's session index: the Client API's canonical first line, up to 120 characters,
  sliced to 60 by `RemoteDirectHost`. In-process uses the store's normalized 60-character
  title with an ellipsis. This affects every daemon client, not only ACP. Fixing it
  means a session-index or schema change (a `shortTitle` field).
- **G3. Session lifetime.**
  - An ACP session stays live in the daemon after its ACP client exits. A running turn
    keeps running (§10.1), and a pending permission waits for the next client. In
    process, exit interrupts it.
  - Daemon sessions opened by the TUI also stay live after it exits, so ACP cannot
    resume them until they are closed. In-process the lock is released at exit.
  - Owner question: close idle sessions when their last client detaches, or rebuild
    the surface per client mode?
- **G4. Residual race.** Only `session/new` and `session/load`/`resume` re-admit through
  `session.launch`. Re-admitting on every attach would cost a store scan each time.
  Configuration reads and writes attach plainly. If another local client closes an ACP
  session while ACP still shows it, a later ACP configuration read reopens it under the
  daemon's default local surface. It needs the same local user acting from another
  client. Owner question: should the daemon remember `clientMode` across close?
- **G5. A resumed live ACP session keeps its current approval mode.** In-process, a new
  ACP process reopens at Ask. The current mode is visible to the client in config
  options. A resume launch does not force Ask: `applyLaunchConfiguration` refuses any
  approval change while background work runs, so forcing it would break resume.
- **Model catalog.** The ACP process still lists models itself (local settings,
  disk-cached catalog), exactly as in-process. The daemon authorizes moves against the
  same shared disk cache. That is thinner-client debt, not a posture change. A
  `handoff` from an ACP session would use the daemon's app-wide model rule, but ACP
  has no handoff.
- **Shared-file edits for the control agent.** `daemon-rpc-v11.ts` (one branch in
  `handleLocalLeaseMethod`, one port member) and `daemon.ts` (additive wiring). The
  `session.control.*` branch is still the `unavailable` refusal.

## Tests added, and red proofs

`tests/clients/acp/daemon.integration.test.ts`, one journey. It uses the built CLI: a
foreground `term2 daemon start`, whose env has a provider key and a marker PATH, and
one `term2 acp` (v1). Vitest time is about 3.1 s; it makes 2 built-CLI launches. The
journey checks:

- the session is in the daemon's Unix `session.list`;
- the MCP server's parent pid is the daemon;
- the user `mcp.json` pool does not start for the ACP session, and does start for a
  later interactive one (positive control);
- a permission request arrives although `shell.autoApproveMode` is `always`;
- the MCP tool result reaches the model with the right cwd and sentinel, the client's
  PATH, not the daemon's, and no provider key;
- thinking level and approval-mode changes; Assisted is refused;
- failed replacement gives -32010 and the old server still works;
- cancel resolves `cancelled`;
- session close kills the MCP process;
- an ACP load of a live interactive session is refused;
- reopen, then ACP exit (code 0): the MCP process is gone, the session is still in the
  daemon, and `settings.json` is unchanged.

Each red proof below was made by patching `dist/src/app/cli.bundle.cjs` on the new
base and restoring it afterwards (`cmp` confirmed the restore). Every one went red:

| Disabled | Failing assertion |
| --- | --- |
| daemon routing in `launchAcp` | session not in daemon `session.list` |
| client `set_mcp` call | no MCP pid / no permission |
| release on session close | MCP pid still alive after `session/close` |
| release on connection EOF | MCP pid alive after ACP exit |
| `sessionPolicy` for ACP | no permission request (`always` leaked) |
| `admitLaunch` busy refusal | load of interactive session resolved |
| `admitLaunch` Assisted refusal | Assisted accepted |
| client stdio default env | MCP saw the daemon's PATH |
| ACP sessions bypass the workspace pool | user `mcp.json` server started |

There is also a temporary, uncommitted check. The existing `v1.integration` and
`spec.integration` suites were rerun under `TERM2_DAEMON_MODE=1` with isolated
daemons. 24 of 30 passed: all v2 cases (lifecycle, cancellation, questions, signals),
and in v1 the MCP stdio/http/sse cases, redirect, the cold-cache model selector, tool
updates and provider failure. The 6 failures are G2 (title, 1) and G1 (5 shell or
Assisted cases). The copies were deleted and their daemons stopped.

## Commands and results (new base, built after the last code edit)

- `pnpm build`: OK.
- `npx tsc --noEmit`: clean.
- eslint and prettier on the changed files: clean.
- `node scripts/check-*.mjs`: all pass except two that cannot pass here.
  `check-ci-runtime` needs `GITHUB_REPOSITORY`/`GITHUB_RUN_ID`. `check-release-identity`
  refuses a dirty or untagged checkout.
- `pnpm test:integration tests/host tests/clients/acp tests/clients/acp-v2`: 22 files,
  133 tests, all passed. This includes every in-process ACP suite, so the in-process
  path is unchanged.
- `pnpm test:e2e tests/cli/daemon-tui.e2e.test.ts`: 2 of 2 passed.
- Not run: the full integration, e2e and provider lanes. No provider or run-loop code
  changed.
