# Generated edge-case verification pilot

This opt-in method searches bounded input spaces using fast-check, not an LLM.
The user explicitly authorized persistent generated checks as an exception to the
traditional permanent-unit-test ban. This is not a restored example-based suite.

## Use it on a real change

Read the production contract before choosing a property. Run the installed command
from the repository root after installing dependencies:

```sh
pnpm verify:generated --seed 424242
pnpm verify:generated --target history --runs 1000
pnpm verify:generated --help
```

The default is 1,000 cases per property, sequences at most 30 actions. These are
sampling budgets, not exhaustive coverage or a proof. No credentials, provider,
model, or network calls are used by the checker. Production code runs in process;
the queue driver only records dispatches at the external executor boundary.

JSON stdout records revision/dirty state, seed, counts, shrinks, elapsed checker
time and minimized failures. `--output FILE` also saves JSON, refusing to overwrite
an existing file. Package-manager diagnostics may appear on stderr. Exit 0 means
sampled properties passed, 1 means a counterexample, 2 means invalid invocation or
infrastructure failure. Startup/package-manager time is outside `runtimeMs`.

For failure triage, preserve the JSON, inspect whether the property follows the
actual production contract, then use its `replay` command at the same source and
dependency revision. `--property`, `--seed`, `--path` and `--runs` reproduce the
shrunk failure. A dirty revision alone is not a reconstructible snapshot: retain
the diff or commit it. Replay paths depend on property/generator/fast-check versions.
Do not weaken an invariant to silence a supported defect. Fix confirmed defects
or obtain human agreement to defer them. Independently verify high-risk fixes.

## Current scope

- `history.pair-projection`: structured, unique Responses-style call IDs, JSON
  arguments, arbitrary result text, missing results and an orphan result.
  `projectProviderHistory` promises non-mutation and idempotence;
  `dropUnpairedFunctionCalls` promises complete-pair retention/orphan removal.
- `queue.serial-actions`: generated public submit, completion, failure, removal,
  edit, resume, discard and stale-completion sequences compared at every step to
  an independent serial FIFO model. The empty-pause invariant is explicit in
  `QueueController.#cancel` and `#restore`: no retained work means idle, so future
  input is not blocked behind an empty pause.

Not covered: parallel command interleavings, persistence failures, approvals,
steering, provider transports, multi-call chat envelopes, ledger recovery, or
arbitrary malformed inputs. Passing does not establish these behaviors.

Add a property only for a named supported contract and a meaningful generated
space. Keep runtime bounded, shrinks readable and failure output reproducible.
Use this when changing these boundaries; do not substitute it for required static,
integration, e2e, provider, or independent checks. Pilot acceptance and evidence
are tracked in [PLAN.md](PLAN.md).
