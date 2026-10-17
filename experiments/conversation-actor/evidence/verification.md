# Verification record

Date: 2026-10-17. Baseline: `36d30a5c`. Scope: standalone fake-port experiment;
production runtime code remains unchanged. Independent reviewer: fresh agent
`/root/actor_review`, given the original brief and artifact location without the
author's conclusion. See [the independent report](review.md).

The requested user workflow is the executable simulation CLI. Final retained
commands, exit codes, all scenario results and repeatability checks are in
[commands.json](commands.json); full output is in [commands.log](commands.log).
Source hashes identify the executable artifacts measured. Every named scenario
was also run in a separate process, rather than relying only on shared-process
execution. Two complete `--all --trace` runs must match byte for byte.

Final result: all 20 scenarios pass together and in 20 independent processes;
both full traces match byte for byte. The retained trace is [trace.log](trace.log).
Root and focused TypeScript checks pass. `pnpm lint` passes with 31 warnings in
unchanged production files and no errors; the experiment's focused lint is clean.
`pnpm check:no-unit-tests` passes, and `pnpm test` passes all 28 static checks in
seven files. `metrics.ts` records 394 physical runtime lines and 443 simulation
lines, alongside the explicitly non-equivalent production basket.

Behavioral claims map to assertions in `simulate.ts` and the invariant table in
the [experiment README](../README.md). The independent report adds late-result,
multiple-rollover and mutable-input probes. The top-level TypeScript check does
not include experiments, so the experiment has its own explicit TypeScript check
and a narrow ESLint project override.

## Review disposition and retrospective

Scope: typed in-memory fake adapters, event settlement, cancellation, steering,
background lifetimes and reconstructed history. Real providers, UI, persistence,
and semantic effect deduplication across new invocations are outside the brief's
prototype implementation scope.

Finding: port mutation could reroute completions and strand work. Disposition:
**route**, reachable stuck state violating the requested ownership contract.
Independently reproduced by the author before repair. Remove/narrow alternative:
forbid adapter mutation; rejected because a disposable input copy should not own
continuation policy. Repair cost: one immutable local routing value, no lifecycle
state, service or synchronization protocol.

Red evidence from the same two now-shipped scenarios before the repair:

```text
mutable-background-port: AssertionError: adapter mutation cannot strand job
actual 1, expected 0 (job count)
mutable-foreground-port: AssertionError: adapter mutation cannot strand foreground turn
actual 1, expected 2 (model request count)
```

Both commands exited 1 before the fix and 0 after it. The independent reviewer
reproduced the failures and reran the repaired probes. Prevention artifact:
`#runTool` captures actor routing before passing the cloned call across the port.
This removes the external alias from completion policy. Two named scenarios
cover both routing directions. Sibling audit: model request copies, tool call
identity, admitted commands, observer events, and snapshots; these retain copies
or actor-owned primitive identities rather than reading externally mutable
policy. No additional demonstrated shared-mutation defect remains in this scope.
The initial 15 green scenarios missed adapter mutation; the independent boundary
challenge supplied that missing evidence. This was a latent defect in the new
experiment, caught before task completion, not an escaped production defect.

Other concerns: cross-turn semantic effect duplication, absent physical exit
proof, and real provider/durability guarantees are **accepted prototype limits**,
explicitly mapped in the comparison. They prohibit a production replacement
recommendation; they are not claimed as verified guarantees.

## Interpretation and limits

No production provider path was changed, so the built CLI provider black-box and
terminal UI suites were not used as evidence for this isolated fake runtime.
The requested simulation is the applicable runtime workflow. Provider wire
validity, socket recovery, partial streams, physical process cancellation,
durable settlement, real UI consumers, and production suitability remain
unverified. The real-use skill/orchestration gate is not claimed by these fixture
runs: no agent skill or delegation capability is being shipped, and actual
production adoption would need separate real-use acceptance.

The findings support **adapt**, scoped to ownership principles. They do not
establish a whole-system complexity reduction or equal behavioral guarantees.
