---
name: verification
description: How to establish that a change works without permanent unit tests — identify the claims and risks, choose and run checks that produce observable evidence, report what stays uncertain, and when to get an independent verifier. Use for every code change during the evidence-driven development experiment, before declaring a task complete, and when acting as the verifier for someone else's change.
---

# Verification

This repository is running an [evidence-driven development experiment](../../../docs/experiments/evidence-driven-development/README.md).
Do not commit permanent unit tests. You choose how to verify a change, but the
result must be evidence someone else can check, not a belief about the code.

## The contract

1. **Claims.** Write down what must be true for the task to count as done. Include
   behavior that must *not* change.
2. **Risks.** List what could realistically go wrong: the edge cases, the callers you
   did not touch, and the failure paths.
3. **Methods.** For each claim, pick the cheapest check that would actually fail if the
   claim were false. If the check would pass on a broken implementation, it proves
   nothing.
4. **Execute.** Run the checks and keep the output. A plan you did not run is not
   evidence.
5. **Report.** Say what was verified and how, what was not, and why.

## Choosing methods

Any technique counts if its evidence supports the claim. Common ones here:

- `pnpm typecheck` and `pnpm lint` for every TypeScript change. They are the floor, not
  the evidence for a behavioral change.
- A temporary test or script: write it, run it, keep the output, delete it. It must stay
  untracked; the pre-commit hook and CI reject committed unit tests.
- Existing tiers: `pnpm test:integration`, `pnpm test:e2e`, and `pnpm test:provider-black-box`
  (see the `provider-testing` skill).
- Running the product: `pnpm build && pnpm start` for the interactive UI, or a
  command-line prompt for a scripted non-interactive turn (`--auto-approve` enables
  tools; only use it in a scratch directory).
- Inspecting what actually happened: session logs and persisted events
  (`debugging-logs`), and wire captures (`provider-traffic`).
- Fault injection: kill the process, drop the network fixture, corrupt a file, and watch
  recovery.
- A before/after comparison against the parent commit for performance, token, or output
  claims.

The deleted unit suite is at tag `unit-suite-baseline`. Running an old test against your
change is a legitimate temporary check, as long as you don't commit it.

Prefer a check that crosses the real boundary over one that mocks it. If proving a claim
means mocking half the system, say so in the report; that is a design signal.

## Risk levels

- **Low:** typos, docs, copy, isolated renames, and changes with no behavior. Typecheck and lint, plus one
  observation of the change if it is user-visible.
- **Medium:** behavior inside one module or one UI surface. Direct evidence for every
  claim.
- **High:** provider/bridge/run loop, session persistence, rollover, compaction, approval
  and sandbox/security policy, settings migration, tool execution and effects, and anything that
  can lose user data or run a command the user did not approve. Direct evidence for
  every claim, at least one failure-path check, and **independent verification**.

When unsure between two levels, pick the higher one.

## Independent verification (high risk)

A separate agent that did not write the change verifies it. Give it the task, the diff,
your claims, and your evidence, but not your conclusion. The verifier:

- checks that each claim's evidence actually supports it and would have failed on a
  broken implementation;
- re-runs or extends the checks where the evidence is thin, and adds its own for risks
  you didn't list;
- rejects a unit-style test disguised as an `*.integration.*` or `*.e2e.*` file. An
  integration test must cross a real boundary: process, filesystem, network fixture,
  persisted session, or the built CLI;
- returns `accept` or `reject` with reasons. On reject, rework and verify again.

Verifier time counts as verification cost in the task record.

## What does not count

- "I reviewed the code and it looks correct" for a behavioral change.
- A check that cannot fail, for example asserting what a mock was told to return.
- A passing typecheck offered as proof of behavior.
- Evidence from a different commit than the one you are handing off.

## Report and record

End the task with the claims, the evidence for each claim (command plus result, or what you
observed), and an **Uncertain** list. Then append one line to
`docs/experiments/evidence-driven-development/tasks.jsonl` in the format in that
directory's README. If you find a defect in work already marked complete, append it to
`defects.jsonl` with the task it traces to.

## After a bug fix

Show the bug happening before the fix and gone after it, using the same check. Then ask
why it was possible: can a type, API shape, lint rule, guard, or an integration test at
the boundary make the whole defect class impossible? A new static guard needs the user's
approval (see `scripts/check-no-unit-tests.mjs`).
