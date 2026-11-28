# Step 14e Part 2b: `term2 acp` over the daemon

Branch `step14e-part2b-acp-main`, based on `origin/main` `93be5b603` (main's Step 14e
Part 1, #475). The first version of this work was built on the superseded PR #476
base (`f59ad21`). It is kept only as WIP commit `d00c42abc` on branch
`step14e-part2b-acp`, and is not for landing. Everything below was re-applied and
re-verified on main's layout.

**Round 2 (after verifier reject of `d5b001030`).** Fixed D1 (MCP processes outlived
their owner after a clear; a foreign client could clear another's servers), D2 (a new
ACP client inherited a live session's approval mode; a second ACP client was admitted
onto a held session) and D3 (a configuration write after a foreign close reopened the
session under the default surface and persisted defaults), plus the minor findings
(Assisted/Unattended and sandbox-off via `settings.update` or a non-ACP launch on an
ACP session; `sandboxEnabled:false` on an ACP launch). All with one model: **an ACP
holder** (decision 2 below). The verifier's probes T1 to T9 now all show the fixed
behaviour against the rebuilt bundle (summarized under "Verifier probes").

**Round 3 (after verifier reject of `0682d0a88`, finding R1).** The web owner could put
a held ACP session in Unattended through `POST /private/agent/v1/sessions/:id/config`
with `approvalMode` (serve presentation `withApprovalMode` reaches
`app.withApprovalMode`), a route `guardV11` never saw. The ACP rule now lives in the
session's runtime, so no route can apply it:

- `src/app/settings.ts`: `SessionSettingsService.refuseValues(refusal)`. Once set,
  every write to the session's own settings (`setDynamic`, hence `set` and
  `setDynamicTransaction`; `setPersistentDynamic`; `setPersistentDynamicTransaction`;
  `reset`) first checks `shell.autoApproveMode` and `sandbox.enabled`, including a
  write to their parent object. `createSessionSettings` installs it last, after the
  launch flags have set Ask and the sandbox.
- `src/app/application-runtime.ts`: `DirectSessionPolicy.refuseSetting`. It is passed to
  `createSessionSettings`, and `configure` checks any approval mode against it before
  it builds the next tool generation. That covers launch configuration and
  `withApprovalMode` (the web route). A generation's settings are a snapshot of the
  session's settings, so the guarded write path covers the rest.
- `src/app/acp/daemon-acp.ts`: `sessionPolicy` (the ACP policy, model rule and
  `refuseSetting`); `daemon.ts` returns it from `sessionPolicy` for ACP sessions.
  In-process ACP does not use `refuseSetting`: v1 may choose Assisted there.
- Web `PUT /private/agent/v1/settings` takes no session: its `sessionId` field is
  ignored and it writes global settings. A running session holds Ask and the sandbox
  as runtime values that a global write does not reach. Checked with the verifier's
  R10/R11 probes on the rebuilt bundle: the session stays `off`/sandbox `true`, the next
  `run_code` asks for one permission, and the web config route answers 503
  `command_rejected` for both `auto` and `unattended`.
- The test now starts a serve lease, grants the workspace, and checks that the web
  config route refuses Unattended on the held session (the next `run_code` still asks).
  It was proved red twice, by disabling the policy's refusal and by disabling only the
  configure-level check. The 16 earlier proofs were rerun on the round-3 bundle and all
  went red again.
- Not mine, per the coordinator: the daemon-wide pending launch policy race with a
  headless `autoApprove`.

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
    the ACP v1 `McpServer` union and per-session serialization.
  - It keeps the ACP **holder** of each session: the Unix connection whose ACP launch
    admitted it, recorded in `admitLaunch` from the launch's connection, which an
    `AsyncLocalStorage` set in `guardV11().launchSession` carries.
  - It releases every MCP process a session had (current and retired) on session close
    and on holder EOF; EOF also rebuilds the still-open session's tools through a
    `createDirectMcpRefresh` tracker.
  - It provides the ACP model rule, `admitLaunch`, `holds`, and `guardV11` (launch
    connection plumbing plus the `settings.update` guard for ACP sessions).
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
  - The lifecycle hook, v11 port `acpSetMcp`, `admitLaunch` and `guardV11` are wired in.
  - `policyForSession`: a session a live ACP holder holds reopens with the ACP flag and
    no pending local policy or flags, whoever reopens it.
  - Shutdown closes `daemonAcp`.
  - The launch-flag type is deduplicated as `DaemonLaunchFlags`.
- `src/app/daemon/daemon-v11-ops.ts`:
  - exports `DaemonLaunchFlags`;
  - adds an optional async `admitLaunch(sessionId, params)` dep, awaited after the
    launch has its session and before any configuration applies;
  - folds the two copies of the pending-policy/flags bracket into one `withPending`
    helper. That keeps the file at 500 lines; it was already at the 500 limit.
- `src/host/daemon/daemon-rpc.ts`: `session.launch` passes its connection to
  `launchSession` (one argument added on an existing line; the file stays at 500).
- `src/host/daemon/daemon-rpc-v11.ts` (shared, additive): `DaemonV11ControlPort.acpSetMcp?`
  and an optional `connection` argument on `launchSession`.
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
2. **One connection holds an ACP session; `set_mcp` is bound to it and cleaned up on
   session close.**
   - The connection whose ACP `session.launch` admitted a session holds it until that
     connection ends, as one in-process ACP process holds the writer lock. Another ACP
     launch onto it is refused (`busy`, v1 -32010). Only the holder may call `set_mcp`
     for it (`forbidden` for anyone else: the caller is authenticated, just not the
     holder). The holder may re-launch it (approval changes) without losing it.
   - D010 lists `session.acp.set_mcp` among the connection-bound local leases. The spec
     line says "cleanup on session close", and both hold. Holder EOF closes every MCP
     process the session had since it opened, whatever clear or replace sequence came
     before (retired managers included), and rebuilds the session's tools without them
     once idle. Session close does the same, but keeps the holder: while the holder
     lives, the session reopens only with the ACP surface (decision 4).
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
   - A new holder starts in Ask. If the session is live in another mode (left by a
     previous holder), admission applies Ask before any requested configuration, as a
     new in-process ACP process reopens at Ask. If background work makes that change
     impossible, the admission is refused (`busy`) rather than handing over a weaker
     mode.
   - Assisted and Unattended are refused (`unavailable`, see gap G1) for ACP sessions
     from every daemon path: an ACP launch, a non-ACP resume launch, and
     `settings.update` (`shell.autoApproveMode` auto, unattended or reset). Turning the
     sandbox off is refused the same way (`sandboxEnabled:false` on any launch,
     `sandbox.enabled` false or reset through `settings.update`).
   - While a holder lives, a reopened session (for example after another client's
     `session.close`) gets the ACP flag in `policyForSession`, so it reopens with the
     ACP surface and `sessionPolicy` (Ask, sandbox, no saved-default writes), never the
     default local surface, whoever reopens it. That closes D3: an ACP configuration
     read or write after a foreign close reopens the session under ACP posture. Its MCP
     servers are gone (closed with the session) until the client reloads them.
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
- **G4 (closed in round 2).** A foreign close no longer lets an ACP configuration
  read or write reopen the session under the default surface (decision 4).
- **G5 (closed in round 2).** A new holder starts in Ask (decision 4).
- **Holder after the ACP client's own `session/close`.** The holder is kept until its
  connection ends, so while that ACP process lives, another ACP process cannot load the
  session it closed. In-process, the closed session's lock is released at once. This
  only ever refuses; the daemon cannot tell who closed a session.
- **`pendingLaunchFlags` stays daemon-wide (not fixed).** Launches are serialized
  (`DaemonRpc` `#createLock`), so only a concurrent plain `session.attach` that opens a
  dormant session during a launch can pick up the launch's flags. That makes the other
  session stricter (an ACP flag) or causes a spurious `busy`; a session a live ACP
  holder holds ignores pending flags. Keying per launch needs the new session's id
  before `createSession` returns it, which means a store change, so it is not
  straightforward.
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
two `term2 acp` (v1) processes. Vitest time is about 4.7 s; it makes 3 built-CLI
launches. The journey checks:

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
- on the reopened session, all of these are refused: `settings.update` to Auto
  (`unavailable`), an interactive resume launch with Unattended (`unavailable`), a
  foreign `set_mcp` clear (`forbidden`), and a second ACP process's load (-32010);
- the holder clears its servers (`session/load` with `[]`), sets Always, and exits
  (code 0): the cleared MCP process is gone (D1) and the session stays in the daemon;
- the second ACP process then loads the still-live session: it is in Ask, and its next
  `run_code` asks for permission (D2);
- an observer closes the session under the second client; the client's configuration
  write reopens it with Ask and `sandbox.enabled` true, not the saved `always`/`false`
  (D3);
- `settings.json` is unchanged at the end.

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

Round 2 used the same method (private bundle backup, `cmp` after restore) on the bundle
rebuilt from the round-2 code. The nine proofs above were rerun on it and all went red
(the EOF proof now disables the holder-EOF release). These were added:

| Disabled | Failing assertion |
| --- | --- |
| D1: old design reintroduced (a clear drops the installation marker; release skips unmarked sessions) | cleared MCP pid alive after holder exit |
| D2: reset to Ask for a new holder | second client sees Always |
| T4: one ACP holder per session | second client's load resolved |
| T5: holder-only `set_mcp` | foreign clear resolved |
| D3: holder precedence in `policyForSession` | reopened session not in Ask |
| `settings.update` guard | Auto accepted |
| non-ACP launch guard | interactive Unattended resume accepted |

## Verifier probes (rerun by the author against the round-2 bundle)

The probe file was read from the verifier's folder; nothing was written there.

- T1: the cleared pid is dead 4 s after ACP exit.
- T2/T2b: `settings.update` to auto is refused (`unavailable`).
- T3: an interactive Unattended resume is refused. An ACP resume with
  `sandboxEnabled:false` is refused (`invalid_request`); the sandbox stays on and
  outside writes are refused.
- T4: a second ACP load is refused (-32010).
- T5: a foreign clear is refused (`forbidden`); the old pid dies when its owner exits.
- T6: a config write after a foreign close reopens the session in Ask with the sandbox
  on; the `settings.json` diff is empty; outside writes are refused.
- T7b: the second client sees Ask, and `run_code` asks for one permission.
- T8: the MCP process is gone after daemon shutdown.
- T9: the MCP process is gone after an ACP SIGKILL mid-`set_mcp`.

There is also a temporary, uncommitted check. The existing `v1.integration` and
`spec.integration` suites were rerun under `TERM2_DAEMON_MODE=1` with isolated
daemons. 24 of 30 passed: all v2 cases (lifecycle, cancellation, questions, signals),
and in v1 the MCP stdio/http/sse cases, redirect, the cold-cache model selector, tool
updates and provider failure. The 6 failures are G2 (title, 1) and G1 (5 shell or
Assisted cases). The copies were deleted and their daemons stopped.

## Commands and results (round 3, built after the last code edit)

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
- `tests/clients/acp/daemon.integration.test.ts` alone: passed, about 4.0 s of test
  time, 3 built-CLI launches, plus one RSA key generation for the serve lease.
- Not run: the full integration, e2e and provider lanes. No provider or run-loop code
  changed.
