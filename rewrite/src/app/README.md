# Direct app interfaces

This directory wires concrete source services into the native Session. It does
not own provider advancement, task lifecycle, or accepted history. The following
contracts cover its settings and executable tool assembly boundaries.

## Settings and runtime generations

`ProfileSelection` in `tool-contract.ts` carries the model registry dependencies
and a concrete `LoggingService`. The app also passes that logger to the source
`SettingsService`, which configures it; the model registry's narrower
`ILoggingService` contract alone is not sufficient for app assembly.

The direct CLI's headless, interactive, model-listing and shared ACP/server
bootstrap paths let `SettingsService` own logger construction, passing
`loggingServiceOptions` for session context and retrieving the same logger via
`getLoggingService()`. Settings loading uses a silent bootstrap logger until
the validated, merged `logging.disableLogging` policy is known. An explicit
disable option or `DISABLE_LOGGING=true` still disables capture even if the
stored setting is false. Do not construct and inject an enabled logger before
settings load: its file transport creates files immediately, and its provider
traffic store fixes its enabled state at construction. Session runtime bindings
may reuse the already-resolved logger; canonical conversation persistence is
separate and remains enabled. This is startup policy, not a runtime toggle.

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
role to exclude. Its `/auto-approve` and `/sandbox` commands save the applied
preference through `DirectApplication.saveApprovalPreference`, using the global
settings owner for targeted file updates rather than persisting session model or
profile overrides. A rejected rebuild does not save; an uncertain rebuild does
not claim success. A failed file write leaves the applied session value visible
and reports that saving failed. Other direct TUI setting changes remain
session-only. The sandbox preference is retained configuration, not a claim of
direct sandbox execution support. Restart still explicitly carries the live
approval/sandbox values in its exec environment.
Interactive startup enables the source settings owner's ordinary file creation,
recovery and schema/default migrations as well as explicit preference saves.
CLI profile/model/reasoning overrides still opt out of persistence. Headless,
ACP and serve startup persistence policy is unchanged.

`cli.ts` is the process entrypoint: the Discord bridge's numeric
or numeric-string `process.exitCode` is normalized to the numeric `main` result.

`startDirectHooks` owns one public root lifecycle per app, not per durable native
leaf. First attachment starts it (including an empty resumed leaf); `/clear`,
session switching and client disconnects do not end it. App shutdown drains the
host before emitting the single root end and closing the shared hook runner.
Session observers still retain their native turn/tool correlation; they cannot
close the shared runner. This preserves the root lifecycle contract used by
Herdr registration without treating a new native leaf as a new process.

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

## Native CLI conversation discovery

`cli-conversations.ts` lists existing native logical lineages through the shared
[derived catalogue](native-catalogue.md), without opening a
writable Session or creating a runtime. `--resume ls` and `--resume list` show the
last ten matching conversations. `--resume last` and bare `--resume` select the
matching lineage with the newest accepted fact timestamp (not copied-file mtime),
with logical ID as the deterministic tie-breaker. Rotated physical logs list once.
Discovery filters local paths and SSH endpoint identities before selection; the
store/runtime still enforce the current workspace grant on writable open.

Exact native IDs and lowercase raw UUID aliases are resolved before the non-TTY
follow-up-prompt check, so missing
and foreign-project references report their real diagnostic. Profile/model labels
use the latest accepted configuration where present. Goal/profile restoration is
still Session/runtime-owned: discovery neither rewrites facts nor substitutes
launcher defaults. No native log-format changes, legacy log reads, or migration
fallback are part of this boundary. A raw exact UUID normalizes to `conv_<uuid>`,
the standalone migrator's deterministic ID; it succeeds only when that native log
exists and matches the current workspace. Partial, uppercase and otherwise
noncanonical IDs do not alias. Discovery does not read the private provenance map
or old store. Listings count current visible native user messages, deduplicate
observed/derived display by message ID, and do not count hidden restoration input.
They omit text previews so warm listing needs metadata rather than log replay.

`cli-account-commands.ts` owns login and model-catalog subcommands, including
source OAuth prompts and catalogue diagnostics. They do not open a conversation;
`cli.ts` retains process startup, mode selection and signal ownership.

## Tools and delegation

`direct-subagent-tools.ts` owns child admission, preparation, invocation scope and
Session launch authority. `direct-subagent-callbacks.ts` adapts source delegation
callbacks and projects accepted task status/results with actual execution evidence;
it does not introduce a task lifecycle registry or grant child authority.

Local surfaces use a native `LocalExecutionContext` home/lease, retained
across configured generations. Worktree tools use the existing git inventory and
running-shell guards; `enter`/`exit` never publish a process-wide root. Native
source-tool contexts read that lease for each execution. Child tool graphs
snapshot the current root at admission so a later parent switch cannot retarget
a running child. Bare, read-only, and SSH surfaces do not offer local worktree tools.
The source context stays frozen; native leases must not alter its old-CLI behavior.
Legacy command-safety helpers that default to the process-global root do not
follow these local leases: sibling-worktree reads can require extra approval.
Sandbox configuration and file tools receive the explicit execution root; do not
restore global publication to avoid those extra prompts.

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

`configure_task_check_in` preserves the source's synchronous `target` callback
contract and maps seconds to native scheduler milliseconds. Returning a Promise
here serializes as `{}` in the source tool, while an `id` parameter loses named
aliases; the adapter derives its parameter type from `AgentFactoryDeps` to keep
that boundary explicit.

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

### Local shell task bridge

The default surface follows the frozen old CLI's existing session mode:
local interactive sessions receive the shell registry/output capability; batch
and SSH sessions do not. `createToolSurface` uses the existing `interactive`
signal, not a new feature flag. The unchanged old/direct batch goldens pin prompt
text, shell and `run_code` schemas, and advertised tools only for that mode;
interactive shell jobs require their own actual-session verification.
Subagent background controls are not shell-job controls.

`createDirectShellTools` adapts the source shell's prepared runner to the
engine-injected `ToolContext.shellTasks` port. The adapter does not instantiate
the source lifecycle registry: the native Session admits a `kind: 'shell'` task
before running a command, and the source job ID is that task's canonical ID.
Foreground leases use the same task when moved to background. Source command
policy and pre-execution approvals still run before this admission; the bridge
does not grant approval or add a second engine loop. SSH background shell remains
unavailable through this local bridge.

Session stop/close and `/restart stop` wait for the prepared runner **and its
cleanup**, including cleanup of a background admission cancelled before kickoff.
An abort request alone is not a terminal receipt. Shell controls reject other
Sessions' IDs and non-shell tasks; monitor cancellation also resolves the watch's
job through the invoking Session, since a retained surface can serve several
Sessions. The shell adapter keeps only live watch/output
callbacks; terminal state and formatted process results live in Session facts.
Monitor firings use the admitted launch handle's `notify` callback, retaining its
physical execution identity even when a later monitor invocation schedules replay.
Resolving ambient execution identity at timer delivery can instead attribute the
launcher's notification to the monitor and silently fail Session's ownership check.
Synchronous controls still resolve the invoking Session. Monitor firings enter
the existing durable background-notice lane. Raw progress
and watch buffers do not survive process loss; unfinished recovered tasks become
interrupted, not reattached subprocesses. Sandbox post-execution pauses are not
introduced by this bridge.

## Historical source tool catalog

`adopted/agent-tools.ts` still assembles source generations for the historical
engine bridge and benches. Its `engine/adopted/tool-catalog.ts` catalog retains
source-definition identity, ordered lookup and atomic generation replacement;
it does not implement native parsing, approval, execution or display. The native
CLI uses `source-tools.ts` for that adaptation. Keeping only the catalog avoids
maintaining a second, unused source-to-native tool adapter.
