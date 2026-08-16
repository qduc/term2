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
