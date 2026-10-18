# Independent prototype review

2026-10-18. Verdict: **accept as a bounded executable comparison**. Candidate A demonstrated the stated composition slice, including reversed dependency installation. Candidate B is an executable comparison with an explicit unmet requirement: Fastify rejects reversed prerequisite order rather than automatically resolving it. This is not acceptance of B as satisfying automatic dependency assembly.

Read `spec.md`, `README.md`, and all five implementation files. Applied the repository verification/testing skills. No implementation files were changed by the verifier. Reviewed hashes are in `independent-reviewed-sha256.txt`.

## Executed evidence

Working directory: `/home/qduc/term2/.worktrees/agent-assembly-prototypes/experiments/agent-assembly-prototypes`.

```sh
pnpm demo --out evidence/independent-cli > evidence/independent-cli-output.txt
pnpm typecheck
pnpm demo --backend awilix --scenario custom --config assemblies.json --interactive --out evidence/independent-interactive
# PTY: prompt was Allow echo(HELLO)? [y/N]; entered y, completed cached:HELLO.
pnpm demo --backend fastify --scenario custom --config assemblies.json --interactive --out evidence/independent-interactive
# PTY: same rewritten invocation prompt; entered n, completed Denied.
```

The independent temporary probe is retained as inert text at `independent-probe-source.txt`. Reproduce it without adding permanent tests:

```sh
cp evidence/independent-probe-source.txt .independent-probe.ts
pnpm exec tsx .independent-probe.ts > evidence/independent-probe-output.txt
rm .independent-probe.ts
```

All assertions passed for both adapters; package typecheck passed. The final CLI/probe rerun used the current loop with `tool.end(cancelled)` on interrupted approval.

- Approved workflow asked about `echo(HELLO)`, returned cached output, and emitted no physical execution. Order override ran cache/rewrite/approval in that order and physically executed HELLO.
- Denial and approval cancellation emitted no physical execution. Cancellation balanced interaction/tool/step/run start/end lifecycles. Results and complete traces: `independent-cli/<backend>/<scenario>/result.json`.
- Actual disk files held redacted main input and original peer input; explorer had no memory, main/peer shared storage identity and had separate memory identities. A later approved run replaced main's file with `remember next`.
- Configuration-only alternate binding wrote the redacted input under `independent-alternate/<backend>/custom/alternate/main`.
- Duplicate/missing hook-order entries, unknown pieces, removed required memory, and missing storage all rejected before model execution. See `independent-{duplicate-order,missing-order,unknown-piece,dangling-dependency}` and baseline `missing` artifacts.
- A genuinely new external catalog entry `stamp` declared its memory dependency and memory.beforeSave hook, appended `[review stamp]`, and was selected through a blueprint. Both existing adapters accepted it without modifying loop.ts, contracts.ts, or assemblies.ts. Real files are `independent-extension/<backend>/external`. Captured second-run model requests contained the first saved context. This also directly verifies reading saved memory, which the baseline scripted model alone does not observe.
- Storage get failure produced failed before model.start; storage put failure after tool execution produced failed with an end-hook error. Both closed run lifecycles. Raw reports/traces and CLI command outputs are in `independent-probes.json`.

The executable temporary probe and temporary configuration were deleted; only inert source and evidence remain.

## Findings and limits

No additional blocking defect found within the documented prototype claims. Fastify's dependency-order failure is concrete and disqualifies it from the automatic-resolution requirement as currently implemented; the README already describes it. Demo startup-rejection scenarios exit process code 0, so inspect structured startupError and trace fields rather than treating exit status as an acceptance test; the CLI deliberately reports observations.

This verifies ordinary composition APIs and deterministic CLI workflows, not production Term2 runtime correctness or a full fresh-agent orchestration capability. No production provider suite was run because it does not execute these prototypes. Root lint/typecheck are owned by the parent; independently ran only package typecheck. Physical cancellation during an actual long-running job, streaming, retries, durability, simultaneous writes, arbitrary/malicious plugins, resource disposal, and behavior outside the supplied normal agent names remain unverified. Human assessment of authoring/assembly ergonomics remains pending.
