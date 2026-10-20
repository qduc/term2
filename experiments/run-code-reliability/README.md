# Independent read isolation study

This compares one task-local instruction addition against the shipped run_code
instructions. It is not a skill mutation. Six repository read-workflow cases
are run once on each of two model strata in each arm; these are not independent
statistical samples. The frozen promotion rules are in `protocol.json`.

## Reproduction and containment

Start at the study's frozen git revision with dependencies installed. Temporarily
insert the exact bytes of `containment-block.txt` immediately before
`registerToolFormatters(tools)` in `source/agent.ts`, then run `pnpm typecheck`,
`pnpm lint`, and `pnpm build`. Restore that insertion after building, **without
rebuilding dist**. This produces an experiment-only CLI that fails closed without
a manifest. Do not use it as an ordinary Term2 installation.

Run `node experiments/run-code-reliability/preflight.mjs <evidence-directory>`.
This crosses the production definition, policy wrapper, isolated script worker,
and real filesystem boundary without a provider call. It checks exact tool
exposure, permitted reads, missing-file handling, direct outside/traversal/symlink
denials, and unavailable shell/write/network/delegation globals. The read-only
independent preflight review accepted the setup; it did not rerun the probe.

Freeze the protocol and runner in git **before** running providers. Then run
`node experiments/run-code-reliability/run.mjs <new-output-directory>`.
The runner retains a single fixture snapshot for all arms, prompts, input/output
hashes, NDJSON events, host-side read audit, exact answer oracles, per-trial
results and aggregate decision. Trial artifacts and conclusions require an
independent post-trial inspection. Do not tune cases, criteria, or candidate
after observing trials. Provider transport failures make coverage uncertain;
do not replace runs. Safety denials are conservative regression signals.

The adapter is containment for model-directed tool effects, not an OS sandbox
for the trusted CLI host. The CLI still accesses its own configuration and
provider credentials to perform authorized model requests. Fixtures are copied
by the trusted runner and cannot be mutated by any exposed model capability.

## Scope limits

The incumbent already recommends `Promise.allSettled`; the candidate repeats
that advice at task level. A low-error baseline is a plausible inconclusive
outcome, not a reason to weaken criteria. This experiment cannot establish
reliability for edits, shell operations, long workflows, or other models.
No runtime or method change is adopted unless all frozen criteria pass.
