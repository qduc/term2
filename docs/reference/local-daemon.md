# Running Term2 with the local daemon

The daemon hosts local sessions over a Unix socket. Clients using the same
daemon share its conversation store and live session state. This mode is
experimental and opt-in. Set `TERM2_DAEMON_MODE=1` on each client you want to
connect. A client starts the daemon in the background when needed.
`TERM2_IN_PROCESS=1` takes precedence and selects the in-process host for that
launch.

| Client | How opt-in applies |
| --- | --- |
| Interactive terminal | `term2` uses the daemon for a local session. A session launched with `--ssh` uses the existing SSH path. |
| Headless | `term2 "<prompt>"` uses the daemon for a local run. A run launched with `--ssh` uses the existing SSH path. |
| Web and gateway | `term2-web` passes the environment to `term2 serve`. The daemon hosts the gateway listener while the serve client holds its lease. Serve with a custom issuer or audience uses the in-process host. |
| ACP | `term2 acp` supports daemon-backed sessions. Set `TERM2_IN_PROCESS=1` for Assisted or Unattended approval mode. |

## Inspect and stop the daemon

Run these from a host terminal as the same user and with the same store and
socket settings as the clients.

```sh
term2 daemon status
term2 daemon stop
```

Status prints JSON with the daemon and protocol versions, PID, and counts for
attached clients, active sessions, turns, and background tasks. Both commands
require a running daemon. Stop requests a graceful shutdown, which gives active
work time to finish before closing the application. Use `term2 daemon start`
to run it in the foreground for diagnosis.

## Match the socket and conversation store

The default daemon socket is `$XDG_RUNTIME_DIR/term2-daemon/daemon.sock` when
`XDG_RUNTIME_DIR` is set. Otherwise it is `run/daemon.sock` under
`$XDG_STATE_HOME/term2`, with `~/.local/state/term2` as the state directory when
`XDG_STATE_HOME` is unset. `TERM2_DAEMON_DIR` changes the runtime directory and
`TERM2_DAEMON_SOCKET` selects an explicit socket path.

`TERM2_CONVERSATIONS_DIR` selects a separate native conversation store. With this
override, the daemon puts its state directory beside the store (in its parent
directory) and uses that state directory to derive the socket location. Use
separate parent directories for separate stores, and give clients that should
share a daemon the same environment. A custom `term2 serve --state-dir` can also
isolate the store when neither `TERM2_DAEMON_SOCKET` nor
`TERM2_CONVERSATIONS_DIR` is set.

Provider credentials taken from the environment are inherited when the client
starts the daemon. After changing them, check for active work, then stop the
daemon and let a new client launch it with the new environment.

The path rules live in `resolveDaemonPaths` and startup is handled by
`connectOrStartDaemon` in [`src/app/daemon/`](../../src/app/daemon/).
See the [daemon ownership contract](../contracts/15-daemon-session-ownership.md)
for session lifetime and the [Unix transport specification](../plans/daemon/spec/transport-unix.md)
for protocol details.
