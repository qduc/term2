---
name: testing
description: Which test tiers exist in this repo during the evidence-driven development experiment, the commands that run them, the rule against committing unit tests, and the standards an integration or e2e test is held to. Use before writing or changing any test and after making code changes to decide what to run. For how to prove a change works, use the `verification` skill.
---

# Testing

This repository is running an [evidence-driven development experiment](../../../docs/experiments/evidence-driven-development/README.md).
The user-authorized [generated verification pilot](../../../docs/experiments/generated-verification/README.md)
permits persistent bounded generated properties via `pnpm verify:generated`; this
exception does not restore example-based unit tests or replace required tiers.

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

## Recurring verification traps

These are historical diagnostic leads, not blanket exemptions from failing gates.
Match the signature and environment, inspect intervening fixes and reproduce on
base when needed. A passing rerun does not explain or erase an earlier failure.
Exhaustive former run records are in git history at `42724797` (remote source)
and `68ef50ff` (local-only evidence), not a result file to resume appending.

- **Approval fixture temp authority:** inherited app-suffix `TMPDIR` put ordinary
  targets inside the child's permitted scratch root. Five reused-call-ID cases
  returned YELLOW instead of expected RED; the Bare outside-write target was
  created. Isolate child `TMPDIR`/`TEMP`/`TMP`, keep ordinary outside targets
  outside both workspace and child scratch, and retain intentional scratch-write
  controls. A unique directory is not a distinct permission root. See
  `docs/agent-context.md`, “Shell Safety For Agents”.
- **PTY waits:** `turn-decisions.blackbox.ts` has recorded 40,000ms repeated-question
  waits with Amber/Violet or `SELECT_A_SECOND_COLOR` visible; restart e2e has a
  5,000ms composer acknowledgement wait “after revision 2; got revision 3”.
  Unchanged-source reruns passed, but the recurring signatures' root causes were
  not established. Do not increase product deadlines or declare concurrency the
  cause from that alone. A separate fixed harness defect missed an already
  captured HTTP request when no later PTY event woke its waiter; test HTTP-only
  wakeup and an unmet-predicate timeout, not just terminal output.
- **Build/host isolation:** suites that replace `dist` in one worktree must run
  sequentially; overlapping builds produced transient missing-module errors.
  Missing `dist/cli.js` is setup failure, not behavioral red proof. Child-process
  tests must isolate persisted config/task storage and inherited `XDG_STATE_HOME`.
  macOS fixtures also exposed `/tmp` canonicalization, Linux-only XDG paths,
  `/dev/full` assumptions, Yoga headless startup and wrapped terminal text.
- **Lint scope:** broad lint in the shared primary checkout scanned untracked
  `.cache`, `.coord`, `.term2` and `packages` artifacts. Local-only runs at
  `99e31c51` and `207f6427` classified all 9,431 errors plus three warnings as
  untracked, while tracked files had zero errors/31 warnings. Classify current
  paths before calling a failure pre-existing. Scoped success is not full-lint
  success. The former result JSON itself repeatedly failed Prettier; its removal
  does not establish that other formatting failures are gone.
- **Fixture timing/settings:** fixed event-loop counts raced Discord detached
  completion; wait for exact output and durable job completion instead. Unsupported
  sandbox environment flags left restart fixtures on “Allow this action” when
  `bwrap`/`socat` were unavailable; use supported persisted fixture settings and
  exercise the missing-dependency host. A 150ms repair deadline included real
  Git/SQLite snapshot work, expiring before repair; control the task clock while
  retaining the real boundary. Check residue after runner shutdown too: passing
  suites once leaked per-suite cache directories on success/failure/collection errors.
- **Provider catalog policy:** OrcaRouter once listed image/video/embedding models
  as chat-capable after a generic mapper discarded capability metadata; moving
  vendor filtering into that shared mapper then wrongly filtered other custom
  endpoints. Check heterogeneous network catalogs, cached pre-filter rows and an
  unrelated endpoint with identical metadata. Scope vendor policy to its endpoint.
  A later nullable model-list type change also broke compilation in this caller;
  typecheck the integrated tree, not only the pre-merge branch.
- **Independent oracles:** Discord reaction fixtures incremented the sent ID
  twice (created IDs 10/12 versus acknowledged 11/13); assert the association
  against actual acknowledgements. Discord image fixtures must stage outside the
  app scratch root: an inherited app-suffix `TMPDIR` otherwise bypasses read approval
  and can mask invalid settings. On load, `shell.autoApproveMode: always` with
  `sandbox.enabled: true` is deliberately demoted to `auto`; an unattended-read
  fixture must configure both settings consistently. Image bytes reached model input
  even though completed job text had cleared `read_file`; observe the model request,
  not an unrelated transient field. Headless approval-required results do not prove a
  bypass; an interactive approval claim needs an interactive owner.

### Local-only boundary lessons reviewed for reconciliation

These failures came from the October 29–30 local candidates, not features newly
implemented by this documentation cleanup. Preserve their evidence when combining
branches; do not infer that remote source `42724797` has those capabilities.

- **Human timing:** deriving gaps before FIFO admission used stale history and
  emitted two notices for 02:00/02:01 steers after a 00:00 input. Receipt timestamps
  were also lost from recovered pending items. The accepted timing candidate
  `a0375335` derived at admission and persisted the original timestamp; dispatch
  time is not arrival time. Released-steer reordering needs a monotonic human baseline.
- **Rollover timing:** same-leaf resume coverage missed the successor's absent
  predecessor human baseline. A built-CLI rollover/resume case on `bc96f19d`
  expected one timing notice and saw none; repair `a5a0ebb3` carries the checkpoint.
  Missing/invalid legacy checkpoints must not invent a time. Sanitized wire output
  alone does not prove absence; inspect canonical history. Natural hour-gap live
  acceptance was still pending in those records.
- **Chained memory delivery:** a persisted edited snapshot did not prove OpenAI
  received its sibling data notice: the chain filter sent human text alone.
  `fa0fd319` repaired the trailing user/system-timing block after a loopback-provider
  red case on `3744dd59`. Codex/general success had not covered OpenAI chaining.
- **Migration guards:** synthetic layer-map cases missed real A1/A2 dependency
  closures. The accepted G1 traversal at `2525064b` applied root adopter permissions
  beyond lawful source-layer transitions and omitted shared-origin edges. Exercise
  the real adapter closures as well as synthetic boundaries, not just a green guard.
- **Direct executable migration:** the M1 broad run on `9e2f2c30` recorded 65 legacy
  CLI integration failures and 27 provider failures (interactive-terminal refusal
  or unknown `--provider`/`-p`). Hundreds of other passing provider cases did not
  reach the direct path. Those totals were neither M1 coverage nor a passing tier;
  keep executable routing explicit when interpreting migration evidence.

## Prompt and instruction changes

Prompt text under `source/prompts/` is product behavior. When trimming a prompt, show
that its non-obvious content survives. For example, run the assembled prompt for the
affected model and confirm the text is present, or run a non-interactive turn that
depends on it.
