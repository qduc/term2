# Validation baseline — 2026-08-13

## Scope and checkout

This baseline was run at `6296339e21dae420fe4fac1c4d35d568e0531d1b` on
`2026-08-13` in an isolated worktree. It classifies the validation debt cited by
the public-hooks and historical plan records; it does not revise their original
observations.

## Results

| Signal | Command | Result |
| --- | --- | --- |
| Ink `act` regression | `NODE_ENV=test pnpm exec vitest run source/components/message/MessageList.test.tsx --reporter=minimal --testTimeout=30000 --hookTimeout=30000` | Passed: 1 file, 43 tests, 1.53s. |
| Terminal UI E2E | `NODE_ENV=test pnpm exec vitest run source/cli.e2e.test.ts --reporter=verbose --testTimeout=30000 --hookTimeout=30000` | Passed: 1 file, 1 test, 1.12s. |
| Responses lifecycle PTY | `NODE_ENV=test pnpm build && NODE_ENV=test pnpm exec vitest run --config vitest.provider-black-box.config.ts scripts/provider-black-box/provider-session-responses.blackbox.ts --reporter=verbose --testTimeout=30000 --hookTimeout=30000` | Passed: 1 file, 27 tests, 25.74s. |
| Full unit suite | `NODE_ENV=test pnpm test` | Passed: 477 files, 6,106 tests; 1 file and 2 tests skipped; 17.37s. |
| Provider black-box gate | `NODE_ENV=test pnpm test:provider-black-box` | Passed: 18 files, 162 tests; 1 test skipped; 27.04s. |

The full unit suite emitted a non-fatal Node `TimeoutNaNWarning`; Vitest exited
0. The provider skip was `openai-websocket.reasoning`, with reason
`openai-websocket: no application-owned response traffic was persisted`.

## Closure verification after pinning the package scripts

The Phase 0 closure branch added `scripts/package-scripts.test.ts` and then
ran the ordinary package commands with ambient `NODE_ENV=production`:

| Command | Result |
| --- | --- |
| `NODE_ENV=production pnpm test scripts/package-scripts.test.ts --reporter=verbose` | Passed: 1 file, 1 test. The command output showed `NODE_ENV=test vitest ...`. |
| `NODE_ENV=production pnpm test` | Passed: 478 files, 6,107 tests; 1 file and 2 tests skipped; 16.01s. It also emitted the non-fatal `TimeoutNaNWarning`. |
| `NODE_ENV=production pnpm test:provider-black-box` before serializing files | Did not pass on two consecutive runs: 17 files passed / 1 failed, 161 tests passed / 1 failed / 1 skipped. The exact failure was `provider-session-resilience.blackbox.ts` — `does not re-execute a tool after its turn is replaced by compaction` — timing out waiting for PTY child exit after 7,500ms. |
| Focused resilience reproduction | Passed: the same test passed in isolation in 1.20s (1 passed, 36 skipped). |

The full-gate timeout was distinct from the resolved Responses-lifecycle debt:
all Responses lifecycle cases completed before the resilience failure. The
complete resilience file and the compaction group both passed in normal order,
but serializing black-box files did not remove the timeout. Replacing the final
forced termination with the normal `/quit` path also did not remove it. The
next bounded investigation is to compare live child-process groups, workspace
locks, and handles immediately before the final scenario with its isolated
counterpart; do not weaken the 7,500ms deadline without that evidence.

## Classification and follow-up

| Documented debt | Classification on 2026-08-13 | Follow-up |
| --- | --- | --- |
| Ink `act is not a function` | Test-command configuration defect. The focused and full suites pass with `NODE_ENV=test`, but package scripts previously inherited ambient `NODE_ENV`. | Package scripts now pin `NODE_ENV=test`; `scripts/package-scripts.test.ts` protects every Vitest-facing entry point. |
| Responses-lifecycle PTY timeout | Resolved for this baseline. | Retain ordinary CI observation; no repair is justified by this run. |
| `source/cli.e2e.test.ts` terminal-output timeout | Resolved for this baseline environment. | Reinvestigate only if it recurs on a distinct terminal or CI host. |
| Context-compaction resilience PTY exit | Reproducible full-suite test defect. It passed in isolation, in the complete resilience file, and in the compaction group, but failed three full gates after 7,500ms. Neither disabled file parallelism nor `/quit` instead of forced termination removed it. | Provider black-box owner should compare PTY process groups, workspace locks, and active handles immediately before this scenario versus isolated execution. |

The baseline does not establish public-hooks completion: the remaining
plan-specific end-to-end acceptance gaps are recorded in
[`public-hooks-system.md`](./public-hooks-system.md).
