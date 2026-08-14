---
name: guard-design
description: Design, implement, or review evidence-calibrated runtime guards. Use whenever adding or changing a timeout, deadline, watchdog, cap, budget, retry limit, admission or concurrency limit, repetition or runaway detector, truncation, eviction, retention rule, or recovery path that can block, reject, pause, truncate, abort, kill, or discard work. Also use when diagnosing a guard false positive or auditing existing guards. Do not use for test-only deadlines, UI timing, or logging-only truncation that cannot affect execution, context, persistence, or recovery.
---

# Guard design

Design guards as evidence-calibrated controls: the strength of the action must
not exceed the strength of the signal. A proxy such as elapsed time, repeated
text, or output volume can justify measurement and containment; by itself it is
not proof that productive work is invalid.

This skill is preventive by default. Use its audit branch for existing code or a
reported false positive.

## Start from the current contracts

Before changing a guard:

1. Read `docs/plans/guard-ledger.md` completely, including its **Resume here**
   section, inventory, test contracts, dependencies, and excluded leads.
2. Follow any owner plan linked from the relevant ledger row. In particular,
   turn, time, cost, token-budget, and identical-failure escalation remain owned
   by `docs/plans/run-budget-stall-escalation.md` unless that plan authorizes
   implementation.
3. Read the `testing` skill before writing tests. Use `provider-testing` for any
   provider, bridge, run-loop, registry, or non-interactive change. Use
   `setting-wiring` when a setting is added or changed.
4. Trace the public execution boundary before selecting a module; use the
   `architecture` skill when ownership is unclear.

Complete this step when the current enforcement owner, recovery owner, relevant
plans, and mandatory test suites are known.

## Choose the branch

- **New or changed guard:** follow every design and implementation step below.
- **False-positive diagnosis:** first reproduce legitimate work being harmed,
  then follow the same steps. Do not tune the threshold before tracing the
  measured signal and recovery path.
- **Audit:** use the audit branch after the shared design rules.

## 1. Classify the guard

Choose the class from behavior, not its name:

| Class | Typical signal | Required bias |
| --- | --- | --- |
| Inactivity watchdog | absence of activity at a transport or process boundary | Reset only on activity meaningful to the watched abstraction; fail through a typed recoverable path. |
| Containment budget | wall time, cost, turns, tokens, workflow runtime | Progress is evidence, not an unlimited reset. Prefer staged escalation before destructive settlement when the owner design permits it. |
| Admission limit | count, depth, concurrency, capacity | Reject before new work starts and leave admitted work untouched. |
| Context or retention bound | bytes, lines, messages, age | Preserve omitted material or make it retrievable; state explicitly when loss is unavoidable. |
| Runaway detector | periodic output, duplicate calls, repeated failures | Require evidence specific to the runaway class and challenge it with legitimate repetition. |
| Advisory guard | suspicious but inconclusive evidence | Guide or request confirmation without fabricating failure or execution state. |

Security and authority boundaries are not weakened by this skill. If such a
boundary also destroys unrelated work, audit only that settlement behavior.

Complete this step when one primary class and any secondary information-loss or
recovery consequence are named.

## 2. Write the guard contract before code

Record this contract in the implementation plan, issue, or change description:

```text
Harm prevented:
Scope and execution paths:
Guard class:
Enforcement owner:
Recovery owner:
Measured signal and observation boundary:
Direct evidence or proxy:
Legitimate work that can produce the same signal:
Configuration sources and precedence:
Effective default and clamping:
Action and why the signal justifies it:
Partial-work settlement:
Retry, fallback, and provider-continuity semantics:
Observability fields:
Persisted-setting migration, if any:
Rollback boundary:
Ledger row:
```

Trace configuration through defaults, environment, persisted settings, roles,
parents, runtime overrides, and per-invocation overrides that exist for this
guard. Test the effective value, not merely the declared value.

Complete this step when every field is source-backed or explicitly marked as an
open question that blocks implementation.

## 3. Calibrate signal and action

Ask two adversarial questions:

1. What legitimate slow, large, repetitive, or quiet work produces this signal?
2. What genuine harmful behavior stays just below the proposed threshold?

Select the least destructive action justified by the answers. Consider this
ladder, skipping steps that do not fit the class:

```text
observe -> warn -> request confirmation/check in -> finite extension or transfer
        -> reject before start -> truncate with retrieval -> abort -> kill
```

Do not create a universal “progress disables the limit” rule. Raw transport
activity may reset an inactivity watchdog; stdout does not make a total shell
runtime infinite; productive turns do not silently waive an explicit budget.

If another owner measures the same failure class, characterize both together.
Prefer one enforcement owner with one typed settlement contract over independently
tuned duplicate guards.

Complete this step when the false-positive case, evasive true-positive case, and
chosen action are all explained by the same invariant.

## 4. Go red on the contract

Write deterministic tests through the owning public boundary before production
code. Use fake time, providers, transports, and processes rather than real waits.
The matrix must cover every applicable row:

1. a genuine harmful case trips the guard;
2. legitimate work resembling the signal survives or reaches the intended
   confirmation/recovery path;
3. threshold minus one, threshold, and threshold plus one;
4. every configuration source and effective-value clamp;
5. root, foreground subagent, background subagent, workflow, non-interactive,
   and shell paths that share the owner;
6. cancellation, retry, fallback, and ambiguous-outcome settlement;
7. partial output, artifact references, and provider continuity;
8. observability fields without prompts, secrets, or full provider frames;
9. persisted defaults and customized-value migration when settings change.

A regression test is the floor. Ask what allowed the defect class, search sibling
owners, and prefer an automated class-wide contract when proportional.

Complete this step when the new behavior has a focused red command and existing
true-positive protection remains green.

## 5. Implement at the owner

Make the smallest change at the module that owns the invariant. Keep measurement,
policy, presentation, and recovery in their existing layers. Do not add a second
guard in a convenient caller when an owner already exists.

Preserve these invariants:

- admitted or sibling work is not aborted by a local rejection;
- partial work settles truthfully and is retrievable where promised;
- dispatched-but-unobserved effects are not labeled failed or blindly replayed;
- timers observe the boundary named in the contract;
- explicit finite limits remain finite;
- defaults or persisted values change only with evidence and migration tests;
- guard trips expose code, class, configured source, effective value, measured
  count/time, execution path, action, and recovery classification without
  sensitive payloads.

Keep each behavior-changing guard repair independently revertible. Use an isolated
worktree for a non-trivial guard change and preserve user-owned dirty files.

Complete this step when the red test is green through the public owner and no
parallel enforcement path was introduced.

## 6. Verify and close the loop

Run focused tests, `pnpm typecheck`, and formatting for changed files. Run
`pnpm test:provider-black-box` during development for provider, bridge, run-loop,
registry, or non-interactive changes. Run the broader suite required by the
`testing` skill for shared utilities or architecture.

Update `docs/plans/guard-ledger.md` in the same change with:

- source-backed effective value and precedence;
- signal, action, recovery path, class, status, and owner;
- red-proof and final verification commands;
- observability and rollback notes;
- final disposition and commit ID when merged.

Report focused success separately from baseline, environment, or sandbox
failures. Never call a guard safe solely because its termination test passes.

Complete this step when the ledger and code agree, every mandatory command has a
truthful result, and the final diff contains no unrelated guard changes.

## Audit branch

For a repository audit, execute the current mechanical searches in the ledger;
do not copy their patterns here because the ledger is their single source of
truth. Treat every match as a lead:

1. deduplicate by enforcement owner rather than setting name;
2. trace configuration through settlement and recovery;
3. add or update the ledger row;
4. classify it as `uncharacterized`, `candidate`, `confirmed defect`,
   `verified safe`, or `dependency` using the ledger definitions;
5. put true exclusions in the ledger appendix with caller evidence;
6. move only red-proven defects into behavior-changing work.

Complete an audit only when every mechanical lead is mapped or explicitly
excluded and every confirmed defect has an approved disposition.

## Stop for approval

Do not infer authorization to:

- implement a dependency owned by an unapproved plan;
- weaken a security or authority boundary;
- change a default or rewrite persisted values without migration evidence;
- replace warning or confirmation with abort/kill, or broaden the affected scope;
- accept information loss when a retrieval design requires a product decision.

Present the contract, red evidence, and alternatives, then ask for direction.
