# Step 14e Part 2a: control socket and Discord over the daemon

Branch `claude/step14e-part2a-control-v2`, based on `origin/main` `93be5b603`
(Step 14e Part 1 as merged in #475). Not pushed; no PR.

## Follow-ups after independent verification (commit after `960da4159`)

The independent verifier accepted `960da4159` with no confirmed defects and
asked for three follow-ups, all done:

1. **Headless and ACP sessions get no control socket.** `session.control.bind`
   to a session launched headless or for ACP, and a `rebind` that would move a
   socket onto one, answer `forbidden` ("Control sockets attach only to terminal
   sessions"). In process only a TUI ever has a socket; before this, the verifier
   bound a `discordInput: true` socket to a headless session and
   `term2 control submit` started a turn. The refused move happens before any
   change, so the socket stays bound where it was. `daemon.ts` gains one
   `launchMode(sessionId)` reading of launch policy and flags, used by both the
   session surface and this admission check (`forbidden` because the caller is
   allowed to bind sockets, just not to that kind of session).
2. **A move in flight can no longer lift a handoff pause.** `rebind` and
   `unbind` on one lease now run one at a time (`#serial`, a per-lease promise
   chain); each re-checks the lease when its turn comes. Before, a moving
   `rebind` in flight when `unbind { pauseForHandoff }` arrived released the
   pause, leaving the lease detached from every connection yet admitting
   mutations.
3. **Conformance test.** New case in
   `tests/host/daemon-unix-conformance.integration.test.ts`: headless and ACP
   binds are `forbidden` and leave no socket; another connection's `rebind`,
   `unbind` and `unbind { pauseForHandoff }` on the holder's lease are
   `not_found` and its bind of the same name is `busy`; moving the lease onto a
   headless session is `forbidden` and keeps it bound; a concurrent move plus
   pause leaves the socket refusing `submit` (`unavailable`) on its own v1 wire.
   It runs the daemon in-process from source, with a private `XDG_RUNTIME_DIR`.

Also, because `daemon.ts` crossed the 500-line gate with the new wiring, the
session/root lookup for control sockets moved into the lease module that owns
that rule: `attach(app, sessionIndex, resolveWorkspaceRoot, isTerminalSession)`
(was a `rootFor` closure in `daemon.ts`). Behaviour unchanged.

Optional items:

- **Fixed:** the bridge's `adopt` kept one `onClose` listener per `/bridge
  connect` cycle; it now unsubscribes the previous one (`stopWatching`).
- **Left alone:** `/clear` while the connection is down. The bridge's lease is
  already dropped then, so its `rebind` is a no-op; the re-bind after reconnect
  uses whatever session the reconnect attaches, which may not be the one the
  `/clear` produced. Not reproduced or tested; left for a later change.

Red proofs for items 1 and 2, against the rebuilt bundle (sha256
`d93658942e76d912484dcf4f278252fc769c8c1badb89535c9ed537ec20c8fbf`): a
temporary copy of the new conformance case that starts the **built** daemon
(`node dist/src/app/cli.js daemon start`) instead of the source one passed on
the clean bundle and failed under each mutation; the bundle was
restored from a private backup and checked with `cmp` after every run. The
same mutations applied to `control-lease.ts` source make the committed
conformance case fail (source restored and `cmp`-checked). The temporary copy
was deleted.

| Mutation | Built-daemon probe | Committed conformance case (source) |
| --- | --- | --- |
| `noterminal`: `#isTerminalSession` check disabled | fails: headless bind answers `ok` | fails: same |
| `noserial`: `#serial` runs operations at once | fails: `submit` admitted on the detached socket (also 3 of 3 runs on the previous build, before the `attach` refactor; clean probe passed 4 of 4 there) | fails: same |

The six earlier mutations were re-run on the rebuilt bundle; all still fail
the daemon TUI e2e case, restores `cmp`-checked. (`nohandoff` this time kept the
inode and changed only the ctime, so the inode+ctime identity check is
load-bearing.)

Commands on the follow-up revision (working tree on `960da4159`, same source as
the commit): typecheck, eslint and prettier pass; every `scripts/check-*.mjs`
gate passes except `check-ci-runtime` (CI-only) and `check-release-identity`
(release gate); `pnpm test` 22/22; `pnpm test:e2e
tests/cli/daemon-tui.e2e.test.ts` 3/3; `pnpm test:integration tests/host
tests/clients/control-socket tests/clients/discord` 19 files, 57 tests pass
(includes the new conformance case). The full lanes were not re-run for these
follow-ups; the sections below record them on `960da4159`.

**Port note.** This work was first written on `f59ad21` (PR #476's Part 1,
which will not land) as `eefbfb532` on `claude/step14e-part2a-control`. This
branch re-applies it to main's structure; it does not merge #476. What changed
in the port:

- The daemon side and the TUI bridge moved next to main's serve lease:
  `src/app/daemon/leases/control-lease.ts` and
  `src/app/daemon/leases/control-bridge.ts` (was `src/app/control/…`). The
  `leases/` folder now holds 5 files.
- Dispatch goes through main's `handleLocalLeaseMethod` in
  `src/host/daemon/daemon-rpc-v11.ts` and the `DaemonV11ControlPort`
  (`controlBind`/`controlRebind`/`controlUnbind`), not `daemon-rpc-leases.ts`
  (absent on main). `daemon-rpc.ts` is unchanged.
- The lease binds to main's `DaemonRpcConnectionContext`
  (`connectionId`, `onDisconnect`) instead of `DaemonConnection`
  (`id`, `onClose`).
- `daemon.ts` adds the control methods to main's `v11Port` object.
- Everything else (launch files, `daemon-tui-backend.ts`, `clients/control`,
  the e2e case) applied unchanged; those files were identical on both bases.
- The conformance test on main had no v1.1 `session.control.bind` assertion, so
  one was added (unknown session and unknown lease are `not_found`) next to
  main's `set_mcp` line, which is untouched.
- README: main has no "Serve over the daemon" section; the new
  "Control socket over the daemon" section is appended at the end.

## What changed, by file

- `src/app/daemon/leases/control-lease.ts` (new): `DaemonControlLeases`, the
  daemon side of `session.control.bind`/`rebind`/`unbind`. Each lease owns one
  `startDirectControlSocket` (the same `ControlSocketServer` an in-process TUI
  opens) over the daemon's application, bound to the calling connection.
  Also `outbound(sessionId)`: Discord send authority for a daemon session's
  tools.
- `src/app/daemon/leases/control-bridge.ts` (new): `createDaemonControlBridge`,
  the daemon-mode TUI's `DirectControlBridge` (replaces
  `createDaemonNoOpControlBridge`). `/bridge`, `--control-socket`,
  `/clear`/`/resume` and `/restart` become lease RPCs on the TUI's connection;
  it re-binds after the TUI reconnects on a new connection.
- `src/app/daemon/daemon.ts`: constructs `DaemonControlLeases`; adds its
  `outbound` to the local session surface for interactive (not headless, not
  ACP) sessions; `attach`es it with a root resolver that rejects unknown
  sessions (`not_found`); adds `controlBind`/`controlRebind`/`controlUnbind`
  to the `v11Port`; closes all control leases at shutdown (after serve
  leases, before the application) and on a failed start.
- `src/host/daemon/daemon-rpc-v11.ts`: `DaemonV11ControlPort` gains optional
  `controlBind`/`controlRebind`/`controlUnbind`; `handleLocalLeaseMethod`
  parses the frozen v1.1 schemas and dispatches them (`unavailable` if the port
  lacks them). `session.acp.set_mcp` still answers `unavailable`.
  `daemon-rpc.ts` is unchanged.
- `src/app/daemon/daemon-tui-backend.ts`: uses the new bridge; closes it before
  the backend; `openDaemonTuiSession` exposes the current `rpc` and calls a
  reconnect hook after a reconnect that replaced the connection.
- `src/app/launch-tui.tsx`: `--control-socket` no longer forces in-process mode
  in daemon mode (`useDaemon` dropped `!request.controlSocket`); the daemon path
  now passes `controlSocket` to `renderMountedTui`.
- `src/app/launch-tui-restart.ts`: merges `bridge.restartEnv?.()` into the
  restart plan's environment.
- `src/app/launch-control.ts`: `DirectControlBridge.server` narrowed to
  `{ name, socketPath, discordInputEnabled }` (all callers read only these);
  optional `restartEnv()`; `metadataFor` exported as `controlMetadataFor` taking
  a root getter. In-process behaviour unchanged.
- `src/clients/control/index.ts`: `startDirectControlSocket` takes an optional
  `cwd` for the advertisement (default unchanged: `process.cwd()`).
- `src/app/README.md`: new section "Control socket over the daemon".
- `tests/cli/daemon-tui.e2e.test.ts`: new case (below); `startProvider` can
  script one function call.
- `tests/host/daemon-unix-conformance.integration.test.ts`: `session.control.bind`
  on an unknown session is now `not_found` (was `unavailable`); unknown-lease
  `unbind` is `not_found`. The `session.acp.set_mcp` line is untouched.

## Design and why

- **Same socket, different owner.** The daemon opens the identical
  `ControlSocketServer` via `startDirectControlSocket`, so the directory
  (`<XDG_RUNTIME_DIR>/term2/control`), modes (dir 0700, socket and
  advertisement 0600), reaping, admission and the v1 wire are exactly what
  in-process creates. The standalone `control` client and the Discord bridge
  need no change: they only read advertisements and talk to the socket. The
  advertisement's `pid`/`startedAt` are the daemon's; its `cwd` is the session's
  workspace root.
- **Lease lifecycle follows the serve lease pattern.** Name reserved and
  `connection.onDisconnect` registered before the first await; serialized,
  re-entrant teardown (`#release`/`#teardown`); a bind that finds itself
  released after an await backs out. EOF or plain `unbind` closes the socket,
  which detaches only the control attachment; the session keeps running.
- **`rebind` has two uses, both on the frozen `{ leaseId, sessionId }`:** the
  holding connection moves the socket to another session (`/clear`, `/resume`;
  a failed move closes it, as in-process), or any connection claims a lease
  paused for handoff.
- **Handoff (`/restart`).** The bridge's `hold()` sends
  `unbind { pauseForHandoff: true }`: the daemon pauses mutations
  (`pauseMutations`, drains admission), detaches the lease from the connection
  before awaiting the drain, and starts a 30 s handoff window. The restart plan
  carries the lease id in `TERM2_CONTROL_HANDOFF_LEASE`; the replacement's
  `attachAtStartup` reads and deletes it, sends `rebind`, and the daemon
  re-binds the lease to the new connection and releases the pause in the same
  tick as any session move. If the claim fails the replacement binds the name
  afresh. If prepare fails after `hold()`, `release()` re-claims on the same
  connection. The old process's `close()` skips its unbind while handing off.
- **Discord.** The daemon's local interactive session surface gets
  `DaemonControlLeases.outbound(sessionId)`, the same `createSessionDiscordSend`
  fail-closed authority in-process uses, resolved at each call to a live,
  opted-in, unpaused socket whose binding is that session.
- **Reconnect.** The bridge watches its lease's connection; if it closes
  (outside a handoff) the lease is dropped and `/bridge` shows "not attached".
  After the backend reconnects on a new connection it binds the same name again
  (retrying `busy` three times over 0.85 s while the old lease's EOF release
  lands).

### Guard contract: handoff window

- Harm prevented: a control socket paused for a replacement that never comes
  (exec failed, process killed) staying open forever and holding the name.
- Scope: only leases detached by `unbind { pauseForHandoff: true }`.
- Class: inactivity watchdog. Enforcement and recovery owner:
  `DaemonControlLeases`.
- Signal: no `rebind` claim within 30 s of the handoff unbind. Proxy, not proof.
- Legitimate work with the same signal: a slow replacement start (terminal
  probe, cold cache, loaded machine).
- Action: close the socket (`#release`), never the session. Justified because a
  false expiry costs only a short control gap: the late replacement's claim
  fails and it binds the name afresh (same path, same advertisement location).
- Partial work: mutations admitted before the pause drained first; nothing is
  discarded. Not configurable (no new setting).

## Deviations

- `session.control.bind`/`rebind` results are not in the frozen schema (only
  params are). They return `{ leaseId, name, socketPath, discordInputEnabled,
  startup, pid }`; the client reads `leaseId`, `name`, `socketPath`,
  `discordInputEnabled`.
- The lease id reaches the replacement process through an environment variable
  (`TERM2_CONTROL_HANDOFF_LEASE`), client-internal, not in the spec.
- `local_leases` still also covers `session.acp.set_mcp`, which still answers
  `unavailable` (the parallel ACP task owns it).
- The startup message in daemon mode reads `Control socket on: <name> (daemon)`
  instead of `(pid <tui pid>)`; the socket's pid is the daemon's.
- A `--control-socket` TUI now runs over the daemon when `TERM2_DAEMON_MODE=1`;
  before, that flag forced in-process mode.

## Security questions for the owner

Posture kept: same directory, modes, owner checks and wire as in-process; no new
auth. New situations, not new machinery:

1. **Whose `XDG_RUNTIME_DIR`.** The socket lands in the daemon's
   `XDG_RUNTIME_DIR` (inherited from whichever client auto-started it). If a TUI
   runs with a different value, its socket is not where its own `term2 control`
   looks. The frozen bind params carry no runtime dir, so the daemon cannot use
   the TUI's. `/bridge status` shows the real `socketPath`. Not a weakening (both
   are the user's private dirs), but a usability gap; a future schema revision
   could add it.
2. **Handoff exposure.** For up to 30 s after `/restart` the paused socket keeps
   answering read-only `status`/`get` with no TUI behind it (in-process, the
   socket vanishes during the exec). Same-user only.
3. **Lease id as a bearer token.** Any local daemon connection that knows a
   paused lease's id (128-bit random, in the replacement's initial environment,
   readable only by the same uid via `/proc/<pid>/environ`) can claim it. Same
   user, who can already connect to the socket and the daemon.
4. **Two TUIs on one session.** In-process could never have two sockets bound to
   one session (writer lock). Over the daemon it can; Discord send then uses the
   first opted-in, live socket bound to that session. Is that the desired rule?

## Pre-existing behaviour noticed (unchanged, both modes)

The `discord-communication.md` prompt section is chosen when the session's tool
surface is built, which is before `attachAtStartup` binds a startup socket. So a
`--control-socket --discord-input` session's first prompt lacks that section, in
process and over the daemon alike (checked with a temporary in-process copy of
the e2e case: 0 matches for "Discord communication" in the request,
`discord_send` present in the `run_code` bridge).

## Tests

New case in `tests/cli/daemon-tui.e2e.test.ts`: "hosts the TUI control socket in
the daemon: control and Discord reach the session through it, /clear moves it,
a killed TUI releases it, and /restart hands it over". One journey on an
auto-started isolated daemon:

1. TUI with `--control-socket=coord --discord-input` prints `Control socket on`.
2. `term2 control list --status`: one socket, `pid` = the daemon's pid,
   `discordInput: true`, `cwd` = workspace, under `controlDirectory(runtimeDir)`,
   socket 0600 and dir 0700; `control get coord session` reports the workspace
   root.
3. `term2 control submit coord` reaches the session (`delivery: started`); the
   model's `run_code` call `tools.discord_send({action:'status'})` answers
   `not_mapped` (live send authority, no bridge running; without authority the
   tool does not exist or answers a bare `unavailable`).
4. `/clear`: the socket's `sessionId` follows the new session.
5. SIGKILL the TUI: socket file and advertisement gone, same daemon, same
   active-session count.
6. A second TUI binds `coord` again (no `discordInput`); `/restart`: the
   replacement prints `Control socket on` again, the socket's inode+ctime are
   unchanged (never re-created), same session, same daemon.
7. SIGKILL the replacement: socket released (the claimed lease is bound to the
   new connection).

Duration about 6 s of test time (5.8 s on an idle container). Built-CLI launches:
3 TUI processes (two spawns plus one `/restart` exec), about 12 short CLI runs
(`control` 8–9 depending on the `/clear` poll, `daemon status` 4).

### Proved red against the built bundle

Each mutation edited `dist/src/app/cli.bundle.cjs` (sha256 `c7a92ac9…9a83`, built on the port),
ran the case, then restored the bundle (sha256 checked after every run):

| Mutation | Result |
| --- | --- |
| `inprocess`: `useDaemon` regains `&& !request.controlSocket` | fails: no daemon was started (`daemon status` errors), the socket is the TUI's own |
| `nohandoff`: `pauseForHandoff` treated as plain release | fails: socket identity changed across `/restart` |
| `noeof`: bind does not register `connection.onDisconnect` | fails: socket still exists after the first kill |
| `noclaimeof`: claim does not register `connection.onDisconnect` | fails: socket still exists after killing the replacement |
| `nodiscord`: no `outbound` in the daemon session surface | fails: `Script failed: Unknown tool "discord_send"` |
| `norebind`: `rebind` skips `socket.rebind` | fails: socket `sessionId` never follows `/clear` |

Scripts (not committed) live in a private scratchpad subfolder. Hazard found
while porting: this session's scratchpad directory is shared with another agent
(it also holds `bundle.bak`, `lease.js.bak`, `port.patch`, `red.py` that are not
mine). My first port mutation run kept its bundle backup at
`scratchpad/cli.bundle.cjs.orig`, and the other agent overwrote that name at
06:32:46 UTC, so one restore put their bundle into my `dist/`. I rebuilt and
re-ran every mutation from a private folder. Between about 06:31:50 and
06:32:46 that shared file held my bundle, so if the other agent restored its
`dist/` from it in that window, its bundle is mine; worth a rebuild on its side.

## Commands run (tested revision: the port's working tree on `93be5b603`; same source as the commit)

Built CLI bundle for every built-CLI run: `dist/src/app/cli.bundle.cjs`
sha256 `c7a92ac9ca38933e8bca5637452854e2c8349ceba0b8bd1822417e3ff3a49a83`
(`pnpm build`), re-checked after each mutation restore.

| Command | Result |
| --- | --- |
| `pnpm typecheck` | pass |
| `npx eslint` + `npx prettier --check` on every changed file | pass |
| `node scripts/check-architecture-change.mjs` | pass (skipped: no PR base) |
| `node scripts/check-baselines.mjs` | pass (compared with `93be5b6`); no new recorded deviation |
| `node scripts/check-ci-budget.mjs` | pass |
| `node scripts/check-ci-runtime.mjs` | exit 1: needs `GITHUB_REPOSITORY`/`GITHUB_RUN_ID` (CI-only) |
| `node scripts/check-complexity.mjs` | pass (`src/app/daemon/leases/` now 5 files) |
| `node scripts/check-engine-callbacks.mjs` | pass |
| `node scripts/check-layers.mjs` | pass |
| `node scripts/check-no-unit-tests.mjs` | pass |
| `node scripts/check-reachability.mjs` | pass |
| `node scripts/check-release-identity.mjs` | exit 1: release gate (dirty tree / no release tag at HEAD), as on the first branch |
| `node scripts/check-root.mjs` | pass |
| `node scripts/check-rules.mjs` | pass |
| `node scripts/check-surface-parity.mjs` | pass |
| `pnpm test` (static guards) | 7 files, 22 tests pass |
| `pnpm test:e2e tests/cli/daemon-tui.e2e.test.ts` | 3/3 pass |
| `pnpm test:integration tests/host/daemon-unix-conformance.integration.test.ts` | 4/4 pass |
| `pnpm test:e2e` (full lane; includes in-process `tool-output` `--control-socket`, `scripts/restart*.e2e`, Discord e2e) | 49 files pass, 1 skipped; 251 tests pass |
| `pnpm test:integration` (full lane; includes `tests/host`, control-socket, Discord, process-restart) | 76 files pass, 1 failed, 2 skipped: only the two known `logging-failures` cases (container runs as root) |
| Mutation runs (table above) | all six red; bundle restored to `c7a92ac9…`, sha256 re-checked each time |
| Temporary e2e (deleted): TUI `--control-socket=coord` in daemon mode, `daemon stop`, TUI reconnects to a fresh daemon | pass: the socket is re-bound and `control list` shows the new daemon's pid |

On the first branch (`f59ad21`) the same checks passed too; there the full
integration lane also showed two `run-code/shell` load flakes that passed alone.
They did not recur on the port.

## Uncertain / not covered

- Not committed as a test: the reconnect re-bind (checked once with the
  temporary test above), the `busy` retry during a same-daemon connection
  blip, the 30 s handoff expiry, a prepare failure after `hold()` re-claiming on
  the same connection, and `/bridge connect`/`disconnect` at runtime over the
  daemon (they share the lease paths the e2e case covers).
- The `inprocess` mutation fails because no daemon exists, not at the pid
  assertion; it still shows the case cannot pass on an in-process fallback.
- Independent verification not run by me (the orchestrator runs it).
