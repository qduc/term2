# M1-connection: MCP config loading and connection manager

Task: **M1-connection** (run `mcp-cm-20260917`, worker W-glm), branch `mcp-m1-connection`.
Delivers the first runnable slice of [MCP servers as run_code functions](../plans/mcp-code-mode.md): config loading, a real-transport connection manager, and the `McpToolSource` implementation that the contract commit (360f7a36) fixed in place.

## Status

Complete. Review round 1 fixes (C1–C4, F1–F6) and round 2 fixes (close-grace timer, absolute projectServers keys) applied; see [Review round 1](#review-round-1) and [Review round 2](#review-round-2) below.
Gates: 37/37 `source/services/mcp` tests, `pnpm typecheck` clean, `pnpm exec eslint source/services/mcp` + prettier clean, `pnpm test:related` 37/37.

## Symbols and files

### `source/services/mcp/mcp-config.ts`

- `loadMcpConfig(options)` — async loader. Reads the user `mcp.json` (next to `resolveSettingsDirectory()`) and project `.mcp.json` (at `getActiveWorkspaceRoot()`), merges, and validates.
- `ResolvedMcpServerConfig` — a validated entry. `error` set means unusable (yields a `failed` snapshot, never blocks startup). `projectEnabledOverride` carries `projectServers.<name>.enabled` from user config onto project entries.
- `McpConfigLoadResult` — `servers`, `notes` (dropped clashes, unreadable/malformed files), and `userConfigPath` so errors can cite the exact file to edit.
- Injectability: `files` reader, `settingsDir`, `workspaceRoot`, `env`, and an `onNote` sink are all options; defaults hit the real filesystem and `process.env`.
- Merge rules: a user entry wins over a clashing project entry (the drop is noted); `${VAR}` expansion runs against the environment for **user** config only — a repository can never route a secret to a URL it chose.
- Transport inference: `command` → stdio, `url` → `streamable-http`, explicit `type: sse` preserved; mapped to the `McpTransportKind` values from `mcp-tool-source.ts`.

### `source/services/mcp/mcp-stdio-launcher.ts`

- `StdioLauncher` — injectable seam `(StdioLaunchSpec) => Promise<StdioSpawnSpec>` where a future sandboxed launcher rewrites the spawn.
- `unsandboxedStdioLauncher` — default; passes the configured command through as-is. Per the coordinator decision, **no sandboxed launcher ships in this slice**: project stdio is gated by user opt-in instead.

### `source/services/mcp/mcp-connection-manager.ts`

- `McpConnectionManager implements McpToolSource` (the contract in `mcp-tool-source.ts`, unmodified).
- `start()` — connects every server concurrently in the background; construction never launches.
- `whenSettled()` — resolves once every connection left `connecting`. **Manager-added API beyond the `McpToolSource` contract** (see gaps).
- `snapshot()` — stable array identity until something actually changes (stringified comparison in `rebuildSnapshot()`), so React/script-side consumers can diff cheaply.
- `onCatalogChanged(listener)` — subscribe to snapshot changes; returns an unsubscribe function.
- `callTool(server, tool, args, { signal, timeoutMs })` — maps failures to the contract's `McpCallError` codes: `unknown_server`, `unknown_tool`, `server_unavailable`, `timeout`, `aborted`, `protocol`. A server-reported tool failure is **returned** with `isError: true`, not thrown.
- Project stdio gating: a project stdio entry not enabled under `projectServers."<realpath of this workspace root>"` in user config fails with an error naming the exact nested override line (real workspace path + user mcp.json path). The opt-in is scoped to one workspace: enabling `"github"` for repo A never starts another repo's `"github"`. Project HTTP/SSE connect without opt-in.
- stdio crash handling: `watchStdio` pipes stderr into a 2000-char tail; `onclose` (not during manager close) marks the connection `failed` with the tail appended.
- `notifications/tools/list_changed` → `refreshTools({ cache: 'refresh' })` → snapshot rebuilt; `listTools` receives no cursor so the SDK client walks all pages.
- Timeouts: connect 15s, list 15s, call 120s default (overridable per call).
- No auto-reconnect: a failed server stays failed until the next `start()`.

### `source/services/mcp/test-fixtures/` (real transports spawned by tests)

- `stdio-fixture.mjs` — real stdio server: 2-page tool pagination, `echo`, a tool-failure tool, `crash` (replies then exits), `die` (exits without replying — mid-call crash), `slow`, `refresh`; optional pid-file and slow-initialize env vars for teardown/handshake-race tests.
- `stdio-bad-list.mjs` — answers `initialize` then returns a JSON-RPC error for `tools/list`, so the first catalog fetch fails after a clean handshake (teardown-on-failed-setup test).
- `http-fixture.mjs` — Streamable HTTP server with the same 2-page catalog.
- `sse-fixture.mjs` — legacy HTTP+SSE server.
- The directory is named `test-fixtures/` to match the repo eslint convention that grants Node globals to standalone `.mjs` scripts tests spawn (`eslint.config.js`, "Standalone .mjs scripts" stanza).

### Dependencies

- `@modelcontextprotocol/client@2.0.0` — exact runtime dependency.
- `@modelcontextprotocol/server@2.0.0` — exact devDependency (fixture server toolkit).

## Tests

### `mcp-config.test.ts` (15)

| Test | Proves |
| --- | --- |
| infers stdio from command and http from url | transport inference + `http`→`streamable-http` mapping |
| loads project servers from .mcp.json | project provenance flows through |
| marks invalid entries as errors without dropping valid ones | one bad line never blocks startup |
| a user entry wins over a clashing project entry | merge precedence + drop note |
| expands ${VAR} in user config only | user-only expansion is a security boundary |
| attaches workspace-scoped projectServers overrides | the opt-in flag rides onto project entries; `projectServers` in project config is ignored |
| an opt-in for one workspace does not enable a same-named server in another | the workspace scoping of the opt-in (security boundary) |
| matches the workspace root by realpath on both sides | a symlinked session root still matches the user-config key (real fs + symlink) |
| resolves a relative cwd against the workspace root (project) and the settings dir (user) | relative `cwd` never depends on term2's process cwd |
| ignores projectServers keys that are not absolute paths, with a note | a relative key is never resolved against term2's process cwd; absolute keys still apply |
| missing config files are empty | ENOENT is not an error |
| project file not valid JSON is noted and skipped | malformed files degrade to notes |
| non-object mcpServers section is noted and skipped | shape validation at the section level |
| parses headers and cwd | optional fields survive validation |
| exposes the resolved user config path | errors can cite the file to edit |

### `mcp-connection-manager.test.ts` (22)

| Test | Proves |
| --- | --- |
| starts a stdio server, walks pagination, keeps snapshot identity | real stdio launch, full catalog fetch, `snapshot()` returns the same array while nothing changes |
| returns content and structuredContent | successful call shape |
| server-reported tool failure as a result, not a rejection | `isError` contract |
| passes configured env to the spawned stdio server | env reaches the child process |
| refetches on list_changed, fires onCatalogChanged, swaps the snapshot array | notification path and identity change on real change |
| maps unknown server/tool names to their codes | `unknown_server` / `unknown_tool` |
| call exceeding timeoutMs → timeout code | `timeout` |
| aborted call → aborted code | `aborted`, including pre-send abort |
| stdio crash → failed with stderr tail | crash handling against a real exiting process |
| project stdio fails closed unless enabled, naming the exact override | the user-opt-in gate, including the exact error text and user mcp.json path |
| project stdio starts once the user enabled it | the gate opens via user `projectServers` |
| config-invalid entries fail without launching | errored configs never spawn |
| connects to Streamable HTTP and calls tools | real HTTP transport |
| connects to legacy HTTP+SSE | real SSE transport |
| close() shuts every connection down, no child processes | lifecycle teardown against a real child process (pid liveness check) |
| close() during a slow handshake kills the child and never reports ready | no `ready` snapshot, listener call, or orphan child after close() races the handshake |
| close() of settled connections leaves no pending grace timer | `process.getActiveResourcesInfo()` shows the close() grace timer cleared once teardown wins |
| close() during the launcher await never spawns a process | the post-launcher abandonment check stops the spawn itself |
| tears the spawned process down when the first tools/list fails | a JSON-RPC error on the first catalog fetch closes client + transport before `failed` |
| maps a mid-call process crash to server_unavailable | connection loss during a call is `server_unavailable`, not `protocol` |
| does not mark a server failed or notify after close() races list_changed | teardown rejections and `markFailed` are inert after close() |
| McpCallError surfaces as a rejected McpCallError instance | error type identity for `run_code` mapping |

## Review round 1

Fixes for the coordinator findings C1–C4 (`.coord/mcp-code-mode/reviews/coord-connection.md`) and the independent cross-review findings F1–F6 (`.coord/mcp-code-mode/reviews/XR-connection.md`) against dc2f18fd:

- **C1 (workspace-scoped opt-in).** User config shape is now
  `"projectServers": { "<absolute workspace root>": { "<name>": { "enabled": true } } }`.
  Both the workspace root and each key are matched by `realpath` (exact match), so a
  symlinked session root matches its real path. An opt-in for one workspace cannot
  enable a same-named server elsewhere (tested). The failed-snapshot error names the
  exact nested line with the real workspace path and the user config path.
- **F1/C2 (close during connect).** `connectOne` re-checks abandonment after every
  await (launcher, connect, `refreshTools`) and tears down anything just created;
  the stdio transport and the client are registered on the connection *before* the
  connect/handshake, so a mid-handshake `close()` can always reach and kill them.
  `close()` now awaits the client/transport closes, bounded by a 5s per-connection
  timeout, so `await close()` means the children are gone. Nothing becomes `ready`
  or notifies listeners after close.
- **F2 (teardown on failed setup).** `connectOne`'s catch tears down client +
  transport before `markFailed`. HTTP/SSE transports are stored on the connection
  like stdio, so teardown is uniform. Tested with a fixture whose `tools/list`
  returns a JSON-RPC error: the server goes `failed` and its process exits.
- **F3 (vacuous helper).** `until` now awaits the probe. Mutation check: with
  `close()` reduced to a no-op, four close-related tests fail (both child-process
  assertions time out at 5s, the launcher-await test sees a `ready` snapshot, the
  list_changed race test sees a post-close `failed` transition). Observed locally,
  then reverted; 35/35 green after the revert.
- **F4 (crash mid-call).** `mapCallError` maps SDK `ConnectionClosed`/`NotConnected`
  — or a connection that has already left `ready` — to `server_unavailable`.
  Tested by crashing the fixture mid-call (new `die` tool exits without replying).
- **F5 (list_changed after close).** `handleListChanged` returns without
  `markFailed`/notification when close() raced the refetch (guarded both after the
  await and in the catch); `markFailed` itself is inert once abandoned.
- **C3/F6 (relative cwd).** Resolved against the workspace root for project entries
  and the settings directory (the user config file's directory) for user entries.
- **C4 (HTTP/SSE drop detection).** Documented only: a dropped remote HTTP/SSE
  session is not detected in this slice; the server stays `ready` until a call
  fails. Comment in `connectHttp` and the gaps list below.

## Review round 2

- **close() grace timer kept the event loop alive.** The `Promise.race` timeout in
  `close()` is now unref'd and cleared in a `finally` once teardown wins, so a
  finished `close()` leaves no pending timer. Test: `Timeout` resources counted via
  `process.getActiveResourcesInfo()` before/after closing a settled manager. Mutation
  check observed: with the timer never cleared, the test fails (2 vs ≤ 1).
- **projectServers keys must be absolute.** A non-absolute key would have been
  realpath'd against term2's process cwd; such keys are now ignored with a note
  (`"projectServers.<key>" is not an absolute path and was ignored.`), and absolute
  keys still apply (tested).

## Gate output

```
$ NODE_ENV=test pnpm exec vitest run source/services/mcp && pnpm typecheck
 Test Files  2 passed (2)
      Tests  37 passed (37)
$ tsc --noEmit        (exit 0)

$ pnpm test:related ./source/services/mcp/mcp-config.ts ./source/services/mcp/mcp-connection-manager.ts ./source/services/mcp/mcp-stdio-launcher.ts
                      → Test Files 2 passed, Tests 37 passed
$ pnpm exec eslint source/services/mcp   → clean
$ pnpm exec prettier --check source/services/mcp → clean
```

## Gaps and risks

- **No auto-reconnect.** A failed server stays `failed` until the next `start()`; a crashed stdio process is terminal for that connection. Documented in the manager header.
- **`whenSettled()` is manager-added API** beyond the `McpToolSource` contract — callers that hold only the interface cannot await settle. A later slice either extends the contract or keeps this as manager-level lifecycle.
- **Child-exit assertions use pid liveness probes.** `fixtureGone` reads the pid the fixture wrote and probes `process.kill(pid, 0)`. Waiting on the fixture's `exit`-handler pid-file cleanup proved unreliable for signal kills: SIGTERM termination never runs `exit` handlers, so the round-0 probe was replaced. Still not a formal process-tree audit (no grandchildren).
- **Snapshots for config-invalid entries use placeholder transport `'stdio'`.** When the entry itself is malformed, no transport is inferable; the manager never launches an errored entry, so the placeholder is inert, but snapshot consumers see `transport: 'stdio'` for such entries.
- **HTTP/SSE project servers connect without opt-in.** Only project *stdio* requires a workspace-scoped user `projectServers` entry. That is the coordinator decision as of this slice; a project-repo supply-chain surface remains for HTTP URLs, mitigated only by review of `.mcp.json`.
- **A dropped HTTP/SSE session is not detected (review C4).** The transports do not surface a remote session close, so such a server stays `ready` until a call fails. Document-only in this slice.
- `${VAR}` expansion is user-config only; an unset variable expands to the empty string rather than failing the entry — silent but explicit per the expansion rule tested in `mcp-config.test.ts`.
