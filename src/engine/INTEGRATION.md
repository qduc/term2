# Native engine integration contracts

The implementation lives in `packages/agent-harness-core/src/engine`; this
directory holds compatibility type surfaces and continuity/history helpers. Term2 host
policy lives in `src/session`, including `agent-runtime`, completion verification,
budget composition and prompt notices. The mechanics below describe the portable
implementation and its Session integration.

## Selected-stop admission

`InteractionDecision.stopAfterApprovalResolution` selects the decision/body/result
that must settle before later work and root model continuation stop. It does not
cancel the turn's signal.

`TurnTools#checkStart` owns that selection policy. A live tool capability alone is
not authority to start new work after a stop: `runNested` checks both body lifetime
and the existing start policy before forwarding to Session. A nonselected sibling
whose body was already admitted cannot use that still-live body to launch a new
nested run after the selection. The selected current execution may finish its
body's nested work while its capability remains active; scripted physical child
starts retain their existing target-matching policy.

Already-started work is different from new admission. Sibling bodies, physical
children and nested promises already started before the stop may settle and emit
their real results. The existing execution-owned child tracking waits for cleanup;
selection must not retroactively cancel or discard that work. Closed capabilities
remain invalid, including the selected execution's capability after its body ends.

When adding another execution-launch entry point, reuse the selected-start policy
at that entry point, not just the body-liveness check or the root model-loop stop.
Checking only “no next model request” misses a sibling's late nested launch.

## Background launch ordering

Session's `DirectBackgroundTasks` holds newly admitted background bodies with a
parent turn until that engine reports its next physical request dispatch, a
park, or termination. `TurnDeps.onTurnBoundary` is transient control state, not a
persisted event. Root and nested branch engines use the same Session release.
A boundary releases already-admitted work, not later launches by that parent.
Foreground execution and a live foreground-to-background transfer are not gated.

`Model.stream` (and native `compact`, when implemented) receives an optional
`onDispatched` callback. Provider bridges scope it around lazy iterator pulls;
shared HTTP fetch submission and OpenAI/Codex WebSocket send notify it before
waiting for a response. Calling an async generator does not dispatch a request,
and the first token is too late: a held response must not hold up the child.
Custom Model implementations must signal their actual dispatch too.

Explicit subagent joins, foreground nested waits, interactions and budget human
waits report a parked parent. Engine termination releases before joining tool
cleanup; cancellation releases immediately. Task stop, close and writer poison
also release pending kickoff before existing cancellation/settlement. These
paths prevent launch-and-wait in a single scripted tool from deadlocking.

The previous `setImmediate` yield made `subagent-batch` usually pass but did not
establish a happens-before relationship. Its load-sensitive request swap was
hidden by a green single pass. The scorer therefore retains the unchanged
nine-golden pass and adds 24 `subagent-batch` occurrences at six parallel for
each CLI; any failed occurrence fails the score. Keep that guard when changing
scheduling—do not replace dispatch with a timer or response observation.

## Tool result representation

`turn-tool-results.ts` owns script-result audit normalization and provider-facing
`tool_result` item construction. It does not publish facts, mutate history or
choose a stop. `TurnTools` retains physical admission, selected-start policy,
execution capabilities, child cleanup, ordered settlement and stop selection.

## Model request input admission

`TurnModel` checks the final full root envelope after optional compaction and
before continuity delta slicing, and checks the final auxiliary summary envelope
including its instructions. `enforceDirectInputLimit` uses the existing context
estimate and model-context policy: an explicit `maxRequestInputTokens` applies
even when compaction is disabled or has no cold turn. Capacity-based admission
uses verified catalog capacity, not the adapter's fallback context size.
A refusal uses the existing nonretryable `context_overflow` error; its diagnostic
identifies local `request_input_limit`. It does not dispatch, truncate history or
add a new persisted error kind. Structured capacity evidence reaching the native provider boundary retains
that same kind, with a `provider_context_overflow` diagnostic and no recovery
evidence authorizing retries. An adapter that discards structured error fields
upstream is not covered by that classification. Headless presents either as a
retained-work pause.

Compaction scheduling is not admission: disabled compaction and histories with no
complete cold turn must still pass the final-envelope guard. The same rule applies
to root requests before continuity slicing and to auxiliary summary envelopes.

## Application tool context

`ToolContext<AppCtx>` carries host data in `ctx.app`; the engine supplies signal,
progress, interactions, nested runs and physical child execution separately.
`Tool`, `ToolRegistry` and `TurnDeps` carry the same app-context type. A host may
supply `TurnDeps.toolContext` as plain data or `createToolContext(binding)` for
execution-bound capabilities. A factory exception ends the turn before the tool
body starts. The binding's execution ID follows the active scripted leaf; its
assertions and parked callback preserve the engine's admission and lifecycle
checks. Hosts snapshot the execution identity before detaching background work.

Term2's workspace, settings, subagent controls, shell task controls and
orchestrator questions are defined in `src/tools/index.ts`. Session binds their task
ports in `src/session/tool-context.ts`; the core imports only its own portable
contracts in `packages/agent-harness-core/src/tools/contracts.ts`.
