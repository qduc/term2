---
name: verification
description: How to establish that a change works without permanent unit tests — identify the claims and risks, choose and run checks that produce observable evidence, report what stays uncertain, and when to get an independent verifier. Use for every code change during the evidence-driven development experiment, before declaring a task complete, and when acting as the verifier for someone else's change.
---

# Verification

This repository is running an [evidence-driven development experiment](../../../docs/experiments/evidence-driven-development/README.md).
Do not commit permanent unit tests; the pre-commit hook and CI reject them. You choose
how to verify a change, but the result must be evidence someone else can check, not a
belief about the code. Reading the code and a passing typecheck are not evidence of
behavior.

The user-authorized [generated verification pilot](../../../docs/experiments/generated-verification/README.md)
allows persistent bounded generated properties as an additional method. Use
`pnpm verify:generated` for its supported history/queue boundaries; retain failed
seeds, shrinks and source snapshots, and triage the oracle before fixing code.

## Checks

State the claims, including behavior that must *not* change, and the realistic risks:
edge cases, callers you did not touch, failure paths. For each claim, pick the cheapest
check that would fail if the claim were false, run it, and keep the output.

- `pnpm typecheck` and `pnpm lint` for every TypeScript change. They are the floor, not
  behavioral evidence.
- A temporary test or script: run it, keep the output, delete it. It must stay
  untracked. Old tests from tag `unit-suite-baseline` can be run this way.
- `pnpm test:integration`, `pnpm test:e2e`, and `pnpm test:provider-black-box`
  (see the `provider-testing` skill).
- Running the product: `pnpm build && pnpm start` for the interactive UI, or a
  command-line prompt for a scripted non-interactive turn. `--auto-approve` enables
  tools; only use it in a scratch directory.
- Inspecting what happened: session logs and persisted events (`debugging-logs`), and
  wire captures (`provider-traffic`).
- Fault injection, or a before/after comparison against the parent commit, where the
  claim calls for it.

Prefer a check that crosses the real boundary over one that mocks it. If proving a claim
means mocking half the system, say so in the report; that is a design signal.

Run the smallest relevant check first. Don't rerun a check during development while its
existing evidence still answers the question; rerun to verify a fix, cover a relevant
change, or resolve uncertainty. Run required gates against the revision being delivered.

When an observation fails after an effect may have happened (a launch, a send), inspect
the actual state before retrying the effect. Integrated protocol tests are not
live-runtime compatibility: check both endpoints before activation.

## Risk levels

- **Low:** typos, docs, copy, isolated renames, and changes with no behavior. Typecheck
  and lint, plus one observation of the change if it is user-visible.
- **Medium:** behavior inside one module or one UI surface. Direct evidence for every
  claim.
- **High:** provider/bridge/run loop, session persistence, rollover, compaction, approval
  and sandbox/security policy, settings migration, tool execution and effects, and
  anything that can lose user data or run a command the user did not approve. Direct
  evidence for every claim, at least one failure-path check, and **independent
  verification**.

When unsure between two levels, pick the higher one.

## Independent verification (high risk)

A separate agent that did not write the change verifies it. Give it the task, the diff,
your claims, and your evidence, but not your conclusion. The verifier:

- checks that each claim's evidence would have failed on a broken implementation;
- re-runs or extends thin checks, and adds its own for risks you didn't list;
- rejects a unit-style test disguised as an `*.integration.*` or `*.e2e.*` file. An
  integration test must cross a real boundary: process, filesystem, network fixture,
  persisted session, or the built CLI;
- reads the "Recorded deviations added in this change" output of
  `node scripts/check-baselines.mjs` and rejects any deviation whose reason does not
  hold, or where fixing the violation would cost less than the exception
  ([When a gate fails](../../../docs/architecture/layers.md#when-a-gate-fails));
- returns `accept` or `reject` with reasons. On reject, rework and verify again.

## Report

End the task with the claims, the evidence for each (tested revision, command plus
result, or observation), and an **Uncertain** list. Evidence must come from the revision
being handed off; label dirty snapshots explicitly. Report independent acceptance
separately from author checks; neither implies the other ran.

Routine task/defect/test-result ledgers are retired; do not append or recreate them.
When a failure teaches something reusable, keep the cause, diagnostic signature, and
recovery advice in the relevant existing docs or code.

## After a bug fix

Show the bug happening before the fix and gone after it, using the same check. Then ask
why it was possible: can a type, API shape, lint rule, guard, or an integration test at
the boundary make the whole defect class impossible? A new static guard needs the user's
approval (see `scripts/check-no-unit-tests.mjs`).