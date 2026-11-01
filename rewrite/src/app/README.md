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

## Interactive startup admission

For a fresh CLI launch with `--goal`, an otherwise admitted interactive start
must persist its native `session_started` and launcher `goal_changed` facts before
refusing a missing terminal. `cli.ts` retains its earlier argument, resume and
home-directory refusals; those are not admitted starts. `runTui` uses the same
Session creation and `setGoal` path as terminal launches, then checks terminal
availability before background detection, control sockets or Ink. `launchTui`
does not open MCP for a non-TTY start. A no-goal CLI terminal refusal still
creates no conversation. Do not restore an early unconditional terminal return
in `cli.ts`: it silently loses the user-authored goal.

## Tools and delegation

`createToolSurface` in `tool-surface.ts` builds the offered tools and matching
execution and approval capabilities together. It keeps a mutable copy of the
source's readonly graph for native capability replacement; the source still
owns its original graph. Replacement rebinds the script registry. Memory leaves are adapted into that script graph before the shared source
`isDirectlyCallable` predicate filters their top-level presentation when the
actual surface offers `run_code`; otherwise the leaves remain directly callable. The source
tool spec keeps `description` live: `run_code` binds its catalog after initial
surface assembly, and a copied string silently omits native memory leaves.
`direct-config-memory.ts` re-adapts the captured leaves on configuration even
when none is top-level. Late source-leaf adaptation retains the raw approval
policy and interceptors registered by `buildAgentTools`; it must not re-register
the wrapped `needsApproval` interrupt marker as the authorization predicate.
Bare suppresses inline memory guidance without changing
access, personal-context opt-in, snapshots, or the local-only store boundary.
When Session owns memory tools/context, `promptMemoryEnabled` builds a
description-only source capability with a marker in the prompt. Source memory
tools remain absent and no second store read occurs; Session substitutes its one
accepted guidance/global-context snapshot at `planDirectInstructions`, so a
populated index and the empty-index wording are both resolved from the real
snapshot rather than guessed.
MCP capture in `direct-mcp-source.ts` reserves the executable `describe` name from the
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

Native subagent task IDs use the source codename vocabulary so model-targeted
handles remain pronounceable; they are still the Session's canonical task IDs,
not aliases layered over UUIDs. `direct-subagent-tools.ts` inherits output
allocation through the same configured-setting/catalog policy as the source
runner; an explicit role allocation still wins. `itemToInput` canonicalizes
text-only assistant context without rewriting accepted Items or live deltas.
`directTaskNotice` renders accepted child outcomes in the source completion
wording, while persistence keeps native task/branch facts and delivery receipts.

### Async child questions

`createDirectSubagentTools` passes the real source `ask_orchestrator` callback
only for background launches; the source factory still excludes mentor and
reviewer. Foreground/result-only children do not acquire the capability, even
if later moved to background. The callback reaches the executing child's
`ToolContext.askOrchestrator`, not a user question or a legacy subagent registry.

`DirectBackgroundTasks` owns one correlated pending question per task. Session
accepts `task_question_opened` together with a planning notice; its existing
idle `drainBackgroundNotifications` admits the orchestrator's silent turn.
The orchestrator must reply before waiting for the child's result. This path
does not preempt an active root turn. `send_message` with a matching `reply_to`
accepts the closure before resolving the exact child call. Wrong IDs and
uncorrelated steering cannot consume it; ordinary steering outside a question
remains unsupported. Stop, settlement and writer failure reject pending waits;
process-loss recovery records interruption and never reconstructs a waiter.
Public task snapshots carry `pendingQuestion` separately from user interactions.
