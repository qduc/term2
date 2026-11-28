# Daemon and native session ownership

The local daemon owns a Term2 application, the native session store and the
local Unix binding. The [Client API specification](../plans/daemon/spec/client-api.md)
defines its requests and streams. The [native conversation contract](09-rewrite-native-conversation.md)
defines admission, accepted facts and recovery.

## Ownership and lifetime

| State or operation | Owner and lifetime |
| --- | --- |
| Daemon process | `startTerm2Daemon` in [daemon.ts](../../src/app/daemon/daemon.ts) acquires the SQLite singleton lock for the resolved daemon paths before starting the application or binding the socket. Its startup metadata advertises the active instance. |
| Native session | The daemon’s direct host owns sessions and their writers. A command reaches the host through `DaemonRpc` in [daemon-rpc.ts](../../src/host/daemon/daemon-rpc.ts). An explicit close can release a session. The RPC refuses an active session close unless forced. |
| Client attachment | `openDaemonStream` in [daemon-streams.ts](../../src/host/daemon/daemon-streams.ts) attaches to a native session, optionally from an accepted cursor. An epoch mismatch or rejected replay cursor requires a fresh snapshot. Unix disconnect retires that connection’s streams, leaving the daemon session available for another attachment. |
| HTTP listener | `DaemonServeLeaseManager` in [serve-lease.ts](../../src/app/daemon/leases/serve-lease.ts) owns the listener’s HTTP state and adapts the daemon’s existing host and session index. The launcher’s control connection holds the lease. Closing it releases the listener. |
| Named control socket and ACP resources | `DaemonControlLeases` in [control-lease.ts](../../src/app/daemon/leases/control-lease.ts) binds named sockets to their current holder and handles explicit handoff. `createDaemonAcp` in [daemon-acp.ts](../../src/app/acp/daemon-acp.ts) tracks the ACP connection’s per-session MCP servers and releases them when the connection closes. |

The [Unix binding](../plans/daemon/spec/transport-unix.md) negotiates client
capabilities per connection. The [HTTP contract](14-agent-wire-v2-server.md)
defines the separate BFF assertion, workspace and event-format boundary.

## Launch values belong to their session

`DaemonLaunchPolicies.withLaunch` in [daemon-session-ops.ts](../../src/app/daemon/daemon-session-ops.ts)
scopes flags and approval policy to the create or open that starts a session.
Opening a stored session identifies it up front. A new session acquires its
values when it is built. Concurrent attachment to a different dormant session
keeps that session’s own posture. In particular, it cannot inherit a headless
launch’s unattended approval policy.

Graceful shutdown starts draining the daemon and gives active turns and
background tasks time to finish. The daemon then closes transports and the
application before relinquishing singleton authority. On reopen, the native
session uses its durable facts to recover an interrupted turn.

## Behavioral evidence

- [Unix conformance](../../tests/host/daemon-unix-conformance.integration.test.ts)
  exercises singleton startup, attach and cursor replay, disconnect, version
  negotiation, control holder checks and overlapping launch policy.
- [HTTP listener lease](../../tests/host/daemon-serve-lease.integration.test.ts)
  exercises the shared store and index, independent listener boundaries and
  cleanup on launcher disconnect.
- [ACP over daemon](../../tests/clients/acp/daemon.integration.test.ts) and
  [built TUI over daemon](../../tests/cli/daemon-tui.e2e.test.ts) exercise the
  client entry points.
