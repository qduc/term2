# Native engine: selected-stop admission

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
