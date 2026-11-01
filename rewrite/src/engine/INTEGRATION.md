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
