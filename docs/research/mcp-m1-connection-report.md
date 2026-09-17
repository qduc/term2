# M1-connection: MCP config loading and connection manager

Task: **M1-connection** (run `mcp-cm-20260917`, worker W-glm), branch `mcp-m1-connection`.
Delivers the first runnable slice of [MCP servers as run_code functions](../plans/mcp-code-mode.md): config loading, a real-transport connection manager, and the `McpToolSource` implementation that the contract commit (360f7a36) fixed in place.

## Status

Complete. Gates: 27/27 `source/services/mcp` tests, `pnpm typecheck` clean, `pnpm lint` eslint pass for the new files (pre-existing warnings elsewhere untouched), `pnpm test:changed` 27/27.

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
- Project stdio gating: a project stdio entry without `projectServers.<name>.enabled = true` fails with an error naming the exact override line and the user mcp.json path. Project HTTP/SSE connect without opt-in.
- stdio crash handling: `watchStdio` pipes stderr into a 2000-char tail; `onclose` (not during manager close) marks the connection `failed` with the tail appended.
- `notifications/tools/list_changed` → `refreshTools({ cache: 'refresh' })` → snapshot rebuilt; `listTools` receives no cursor so the SDK client walks all pages.
- Timeouts: connect 15s, list 15s, call 120s default (overridable per call).
- No auto-reconnect: a failed server stays failed until the next `start()`.

### `source/services/mcp/test-fixtures/` (real transports spawned by tests)

- `stdio-fixture.mjs` — real stdio server: 2-page tool pagination, an `echo` tool, a crash tool, and a slow tool; optional arg makes it exit after writing a pid file (used by the `close()` test).
- `http-fixture.mjs` — Streamable HTTP server with the same 2-page catalog.
- `sse-fixture.mjs` — legacy HTTP+SSE server.
- The directory is named `test-fixtures/` to match the repo eslint convention that grants Node globals to standalone `.mjs` scripts tests spawn (`eslint.config.js`, "Standalone .mjs scripts" stanza).

### Dependencies

- `@modelcontextprotocol/client@2.0.0` — exact runtime dependency.
- `@modelcontextprotocol/server@2.0.0` — exact devDependency (fixture server toolkit).

## Tests

### `mcp-config.test.ts` (11)

| Test | Proves |
| --- | --- |
| infers stdio from command and http from url | transport inference + `http`→`streamable-http` mapping |
| loads project servers from .mcp.json | project provenance flows through |
| marks invalid entries as errors without dropping valid ones | one bad line never blocks startup |
| a user entry wins over a clashing project entry | merge precedence + drop note |
| expands ${VAR} in user config only | user-only expansion is a security boundary |
| attaches projectServers enabled overrides | the opt-in flag rides onto project entries; user-only key ignored for user entries |
| missing config files are empty | ENOENT is not an error |
| project file not valid JSON is noted and skipped | malformed files degrade to notes |
| non-object mcpServers section is noted and skipped | shape validation at the section level |
| parses headers and cwd | optional fields survive validation |
| exposes the resolved user config path | errors can cite the file to edit |

### `mcp-connection-manager.test.ts` (16)

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
| close() shuts every connection down, no child processes | lifecycle teardown against a real child process (pid-file check) |
| McpCallError surfaces as a rejected McpCallError instance | error type identity for `run_code` mapping |

## Gate output

```
$ NODE_ENV=test pnpm exec vitest run source/services/mcp && pnpm typecheck
 ✓ source/services/mcp/mcp-config.test.ts (11 tests) 13ms
 ✓ source/services/mcp/mcp-connection-manager.test.ts (16 tests) 1296ms
 Test Files  2 passed (2)
      Tests  27 passed (27)
$ tsc --noEmit        (exit 0)

$ pnpm test:changed   → Test Files 2 passed, Tests 27 passed
$ pnpm exec eslint .  → 0 errors (62 pre-existing warnings, none in source/services/mcp)
```

## Gaps and risks

- **No auto-reconnect.** A failed server stays `failed` until the next `start()`; a crashed stdio process is terminal for that connection. Documented in the manager header.
- **`whenSettled()` is manager-added API** beyond the `McpToolSource` contract — callers that hold only the interface cannot await settle. A later slice either extends the contract or keeps this as manager-level lifecycle.
- **The pid-file close test relies on the fixture's own exit handler.** The fixture deletes its pid file from a process-level `exit` handler, so the test proves the child process exited, not that the transport's close was the sole cause. Good enough for teardown regression detection; not a formal process-tree audit.
- **Snapshots for config-invalid entries use placeholder transport `'stdio'`.** When the entry itself is malformed, no transport is inferable; the manager never launches an errored entry, so the placeholder is inert, but snapshot consumers see `transport: 'stdio'` for such entries.
- **HTTP/SSE project servers connect without opt-in.** Only project *stdio* requires user `projectServers.<name>.enabled`. That is the coordinator decision as of this slice; a project-repo supply-chain surface remains for HTTP URLs, mitigated only by review of `.mcp.json`.
- `${VAR}` expansion is user-config only; an unset variable expands to the empty string rather than failing the entry — silent but explicit per the expansion rule tested in `mcp-config.test.ts`.
