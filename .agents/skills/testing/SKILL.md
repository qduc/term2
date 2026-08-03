---
name: testing
description: How to test in this repo — the TDD requirement, which test command matches the scope of a change, the standards a unit test here is held to, and the follow-up expected after a bug fix. Use before writing or changing any test, after making code changes to decide what to run, and after fixing any non-trivial bug.
---

# Testing

This project follows TDD. Write tests first, then the minimum code to pass them.

After making code changes, run tests appropriate to the scope and report the results.

## Commands

```bash
pnpm test                          # Run all tests
pnpm test path/to/my-file.test.ts  # Run tests in a specific file
pnpm exec prettier --write <files> # Fix formatting in files you changed
```

## Choosing scope

- **Small, localized changes** — run focused tests for the affected area.
- **Broad or architectural changes, shared utilities, anything that may affect multiple areas** — run the full suite.
- **No relevant focused test exists** — run the smallest applicable broader command, and say why.
- **Provider, bridge, run-loop, registry, or non-interactive changes** — these additionally require the provider black-box suite; use the `provider-testing` skill.

Never claim a test, build, or check passed unless you actually ran it and it succeeded.

## Standards

Tests are colocated with production files and are usually the fastest way to discover an intended contract.

- Test observable behavior through public interfaces, not implementation details. A refactor shouldn't break tests.
- One behavior per test; name the test after the rule being verified.
- Assert structured values (codes, statuses, types) over raw strings or broad snapshots — unless the text or full output *is* the contract.
- Keep tests deterministic and independent: no real time, randomness, network, DB, or filesystem. Runnable in any order.
- Mock only at boundaries.
- Don't duplicate production logic in expected values.
- Cover edge cases, boundaries, and invalid input.
- Add a regression test for every bug fixed.
- Maintain tests like production code: refactor or delete them when they stop providing value.

## After a bug fix

A regression test is the floor, not the finish line. After any non-trivial bug fix:

1. Ask why the bug was possible and whether design, types, or APIs can make the defect class unrepresentable.
2. Search sibling implementations and similar boundaries for the same failure pattern.
3. Identify why tests, review, or observability did not catch it earlier. Treat a shipped defect as both a code defect and a detection-gap defect.
4. Prefer an automated class-wide guard—such as a contract test, lint rule, exhaustive type check, or CI validation—when proportional.

Prioritize behavioral contracts at risky boundaries, error paths, and edge conditions over coverage percentages. High line coverage with weak assertions is not evidence of correctness. If meaningful testing requires mocking half the system, treat that as an architecture signal rather than merely a testing inconvenience.

Keep analysis blameless: ask what allowed the defect, not who introduced it. Use proportional judgment—a typo-grade issue does not require a full retrospective, but surprising, severe, or long-lived bugs require the broader audit. Fix the bug factory, not only the observed instance.

## Prompt and instruction changes

Prompt text under `source/prompts/` is product behavior, not documentation. When trimming a prompt, keep a test asserting that its non-obvious content survives — see `source/prompts/search-via-shell.test.ts`, which pins the two shell gotchas so a future cleanup can't silently drop them.
