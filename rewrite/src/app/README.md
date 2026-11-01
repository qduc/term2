# Direct app interfaces

This directory wires concrete source services into the native Session. It does
not own provider advancement, task lifecycle, or accepted history. The following
contracts cover its settings and executable tool assembly boundaries.

## Settings and runtime generations

`ProfileSelection` in `tool-contract.ts` carries the model registry dependencies
and a concrete `LoggingService`. The app also passes that logger to the source
`SettingsService`, which configures it; the model registry's narrower
`ILoggingService` contract alone is not sufficient for app assembly.

`createDirectRuntimes` in `direct-application-runtime.ts` builds session-owned
settings and tool generations. `createDirectConfigSettings` in
`direct-config-settings.ts` produces a read-only, source-schema-validated settings
snapshot; it does not persist selection changes. Its
`prepareDirectSessionConfigurationCommand` validates HTTP selection intent,
retains request identity and expected revision, and rejects unknown or empty
mutations. Reasoning validation uses the output object of the source agent
settings preprocess schema, not a second hand-maintained enum.

`DirectGlobalConfiguration` in `direct-host-config-settings.ts` implements the
host's public `SettingsProjection` rather than maintaining another projection
type. Reads redact values through `safeValue`; writes enforce the allowlist,
revision, and persistence result before returning a new projection. The public
value union is not permission to serialize arbitrary settings objects.

`createDirectTuiSettings` in `direct-launch-tui-settings.ts` prevents structural
profile changes once wire messages exist. Wire history has no system-message
role to exclude. `cli.ts` is the process entrypoint: the Discord bridge's numeric
or numeric-string `process.exitCode` is normalized to the numeric `main` result.

## Tools and delegation

`createToolSurface` in `tool-surface.ts` builds the offered tools and matching
execution and approval capabilities together. It keeps a mutable copy of the
source's readonly graph for native capability replacement; the source still
owns its original graph. Replacement rebinds the script registry. MCP capture
in `direct-mcp-source.ts` reserves the executable `describe` name from the
run-code runtime, the same owner used by tool assembly.

`createDirectSubagentTools` in `direct-subagent-tools.ts` exposes source callback
contracts over Session's admitted nested requests and task controls:

- Built-in roles use the session pool selector once per spawn; custom role
  definitions load without being passed to that built-in-only selector.
- Prompt construction passes actual offered definitions, search policy,
  settings, execution context, and skills to source `buildInstructions`.
- Foreground callbacks request foreground execution and return results, not
  background admission handles. Result projection rejects a background receipt
  in these result-only lanes. Background launch returns an accepted run ID,
  role, and the original prepared task input.
- Results preserve accepted outcome and execution evidence. Native budget
  exhaustion maps to the source's budget interruption; known interruption
  causes are preserved. An interruption with no supplied cause stays
  unclassified: the adapter must not invent a provider-continuation cause or
  imply an approval pause. Native task lifecycle remains Session-owned.
- The source prompt builder in `source/services/subagents/role-loader.ts` omits
  local memory guidance and context for remote execution. Those optional memory
  sections must not be dereferenced on the remote path.

The compile-time seam matters: changing source callback signatures, schemas, or
host projection types must be reconciled here, not hidden with casts or invented
terminal data. A successful typecheck establishes contract compatibility, not
provider execution, approval/reconnect behavior, or continuation parity.

## Compiled worker bootstrap

The rewrite build explicitly includes `source/utils/worker-cwd-preload.cts`.
`workerBootstrapExecArgv` locates its emitted `.cjs` sibling by URL, not a static
import, so following the app's TypeScript import graph alone omits it. Source-mode
`run_code` can work while the compiled CLI fails before scripted delegation starts;
verify the built CLI's worker path, not only an in-process app surface.
