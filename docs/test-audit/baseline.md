# Test suite audit baseline

Measured 2026-08-09 in the isolated `test-suite-audit-foundation` worktree at
`c61909ea277867a9bb5b96da06ef011f27cd3831`.

## Environment

- Linux 6.8.12-41-pve x86_64, 8 logical CPUs
- Node.js v24.19.0
- pnpm 11.7.0
- Vitest 4.1.9, default thread pool and default concurrency

Worker concurrency, not test count, dominates the wall-clock figure below. A repeat
measurement on a machine with a different CPU count, or with `--pool`/`maxThreads`
overridden, is not comparable to this one.
- No explorer or other audit test process was intentionally run concurrently.

## Reproduction

A fresh worktree must be built because `source/cli.integration.test.ts` spawns
`dist/cli.js`.

```bash
pnpm install
pnpm build
/usr/bin/time -p pnpm exec vitest run \
  --reporter=json \
  --outputFile=/tmp/term2-test-audit-baseline-built.json
```

The successful cartography run reported:

- 459 test files containing 659 Vitest suites/blocks.
- 5,809 passed tests and 1 skipped opt-in Docker integration test.
- 0 failed tests.
- 49.90 seconds wall time, 252.02 seconds user CPU, and 76.66 seconds system CPU.

The preceding unbuilt run is useful setup evidence, not a test result: 458 of 459
files passed, while five assertions in `source/cli.integration.test.ts` failed
because `dist/cli.js` did not exist. After `pnpm build`, the same suite passed.

## Slowest file observations

Vitest's per-file `endTime - startTime` values provide a first ranking under parallel
execution. They are not additive and should not be treated as stable benchmarks.

| File | Tests | Observed ms |
| --- | ---: | ---: |
| `source/cli.integration.test.ts` | 6 | 8,430 |
| `source/components/InputBox.test.tsx` | 37 | 5,985 |
| `source/components/message/CommandMessage.test.tsx` | 75 | 4,123 |
| `source/cli.e2e.test.ts` | 1 | 4,081 |
| `source/components/prompt/ApprovalPrompt.ask-user.test.tsx` | 32 | 2,812 |
| `source/components/layout/BottomArea.test.tsx` | 28 | 2,547 |
| `source/components/message/MessageList.test.tsx` | 42 | 2,268 |
| `scripts/provider-black-box/provider-test-harness.test.ts` | 11 | 2,258 |
| `source/components/layout/StatusBar.test.tsx` | 33 | 2,195 |
| `source/hooks/use-model-selection.test.tsx` | 13 | 2,054 |
| `source/components/input/menu-system.integration.test.tsx` | 11 | 2,004 |
| `source/components/MarkdownRenderer.test.tsx` | 32 | 1,997 |
| `source/hooks/use-app-keyboard-shortcuts.test.tsx` | 21 | 1,818 |
| `source/services/agent-runtime/workflow/workflow-evaluator.test.ts` | 25 | 1,779 |
| `source/hooks/use-provider-selection.test.ts` | 15 | 1,709 |
| `source/tools/file/search-replace.test.ts` | 62 | 1,408 |
| `scripts/provider-black-box/provider-record-security.test.ts` | 1 | 1,292 |
| `source/components/input/ModelMenuSession.test.tsx` | 8 | 1,178 |
| `source/tools/file/code-context.test.ts` | 30 | 1,146 |
| `source/app.test.tsx` | 17 | 1,116 |

## Interpretation boundary

This run establishes suite topology and candidate areas for semantic inspection. It
does not establish that any listed test is redundant or low value. Repeat the
measurement before claiming a cleanup changed runtime, preferably with the same
build state and no competing test processes.

## Runtime history (decided 2026-09-04)

**Policy: checked-in aggregates, ephemeral raw data.** The audit's runtime/result
history is recorded here as checked-in aggregates because it must be diffable and
survive; raw vitest JSON per run stays out of the repository (Baseline method
above), and CI logs stay ephemeral. Each row is one full default-suite
measurement (`pnpm exec vitest run --reporter=json`, no concurrent test
processes) at a known commit. Counts are comparable; wall-clock runtimes are
only weakly comparable across hosts and load (see Interpretation boundary).

| Commit (main) | Batch | Default-suite tests | Note |
| --- | --- | ---: | --- |
| `d36c392a` | M3 inventory | 5,809 (+1 skip) | original baseline, 2026-08-09, 49.9 s isolated |
| pre-B1 `main` | M4 start | 7,558 | |
| `06dafa96` | B1 hooks-real-code | 7,557 | −1 |
| `876eb4b3` | B2 commands | 7,557 | 0 |
| `3e8bfe13` | B3 util-fixes | 7,557 | 0 |
| `9388adb0` | B4 conversation-utils | 7,543 | −14 |
| `fe6aba76` | B5 runtime-lib | 7,543 | 0 |
| `85f9943b` | B6 session-obs | 7,540 | −3 |
| `8bf8d2ed` | B7 consolidations | 7,532 | −8 |
| `edf840cd` | B8 shell-tools-misc | 7,537 | +5 (table-ified matrices) |
| `5510ba8f` | B9 subagents | 7,535 | −2 |
| `02031587` | B10 eval+stream+provider | 7,538 | +3 |
| Topology | cli.e2e retier | 7,521 | −17 relocated to `test:e2e`, not deleted |

All post-B6 rows carry the same 6 environment-class failures
(`needsApproval` outside-workspace / symlink-escape cases in
apply-patch/create-file/search-replace) and 2 skipped tests; B9-B10 full-suite
runs measured ~166-168 s on the shared dev host. The e2e tier (17 tests:
`cli.e2e.test.ts`, `scripts/build-output.e2e.test.ts`,
`scripts/fake-codex-server.e2e.test.ts`) moved out of the default suite in the
Topology batch and is covered by the CI e2e job (`pnpm test:e2e`,
`vitest.e2e.config.ts`).
