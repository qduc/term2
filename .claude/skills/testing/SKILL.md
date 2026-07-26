---
name: testing
description: How to test in this repo — the TDD requirement, which test command matches the scope of a change, and the standards a unit test here is held to. Use before writing or changing any test, and after making code changes to decide what to run.
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

## Prompt and instruction changes

Prompt text under `source/prompts/` is product behavior, not documentation. When trimming a prompt, keep a test asserting that its non-obvious content survives — see `source/prompts/search-via-shell.test.ts`, which pins the two shell gotchas so a future cleanup can't silently drop them.
