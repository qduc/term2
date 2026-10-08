---
name: testing
description: Which test tiers exist in this repo during the evidence-driven development experiment, the commands that run them, the rule against committing unit tests, and the standards an integration or e2e test is held to. Use before writing or changing any test and after making code changes to decide what to run. For how to prove a change works, use the `verification` skill.
---

# Testing

This repository is running an [evidence-driven development experiment](../../../docs/experiments/evidence-driven-development/README.md).
There is no permanent unit test suite, and no test-first requirement; the global `tdd`
skill does not apply here. Prove changes with the `verification` skill.

## Tiers and commands

```bash
pnpm typecheck                     # every .ts/.tsx change
pnpm lint                          # eslint + prettier check
pnpm test                          # the static repository guards (+ any uncommitted temporary tests)
pnpm test path/to/tmp.test.ts      # run one temporary test
pnpm test:integration              # cross-module and child-process journeys
pnpm test:e2e                      # process-level: terminal UI smoke, build/rollback, fake-codex network
pnpm test:provider-black-box       # built CLI against loopback provider fixtures (see `provider-testing`)
pnpm check:no-unit-tests           # what CI and the pre-commit hook run
```

Keep `NODE_ENV=test` when invoking Vitest directly; the scripts set it. React's
production build lacks `act`.

## Rules

- **Never commit a unit test.** A `*.test.ts(x)` or `*.spec.ts(x)` under `source/`,
  `scripts/` or `docs/` that the default Vitest config would pick up is rejected unless
  it is one of the guards listed in `scripts/check-no-unit-tests.mjs`. Adding a guard
  needs the user's approval.
- **Temporary tests are fine.** Write them next to the code so the default config finds
  them, run them, then delete them before committing. Don't `git add -A` with one in the
  tree.
- **The other tiers stay and run in CI.** Change them when behavior changes. Add to them
  only when the check crosses a real boundary (child process, filesystem, network
  fixture, persisted session, built CLI) and is worth paying for on every CI run. Never
  dress a unit test up as an integration or e2e test.
- **Deleted tests are at tag `unit-suite-baseline`.** Run one temporarily against your
  change if it helps (`git show unit-suite-baseline:<path> > <path>`), then delete it.

## Choosing what to run

- Every TypeScript change: `pnpm typecheck`.
- Provider, bridge, run loop, registry, or non-interactive changes: the provider
  black-box suite.
- Changes the integration or e2e tiers exercise: that tier.
- Package, TypeScript, Vitest, or build configuration: all tiers.
- Everything else: the evidence the `verification` skill asks for. Running tiers that don't
  touch your change is not evidence.

CI runs every tier. Follow any late CI failure through to a passing run or a blocker someone clearly owns.
Never claim a test, build, or check passed unless you ran it and it succeeded. For long runs, set an
explicit finite timeout and wait for the completion notification rather than polling.

## Standards for integration and e2e tests

- Exercise observable behavior through public entry points: the CLI, a service facade,
  or a protocol boundary.
- Assert structured values (codes, statuses, persisted records) over raw strings or
  broad snapshots, unless the text is the contract.
- Deterministic and independent: no real provider network, no shared fixed temp paths,
  no writes into the repository tree, runnable in any order.
- Mock only at external boundaries (provider fixtures, the network guard).

## Prompt and instruction changes

Prompt text under `source/prompts/` is product behavior. When trimming a prompt, show
that its non-obvious content survives. For example, run the assembled prompt for the
affected model and confirm the text is present, or run a non-interactive turn that
depends on it.
