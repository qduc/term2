# Workspace switch atomicity repair

## Scope

This repair covers the parent-session `ExecutionContext` workspace lease and
the `enter_worktree` tool boundary. It preserves the existing
`registerSessionRuntime` multi-runtime admission guard, does not publish roots
for concurrent runtimes, does not change child `ExecutionContext.pin`, and
does not alter running workers' captured roots. No production live replay was
used.

## Incident and contract

When `publishActiveWorkspaceRoot(root)` rejected an enter because multiple
session runtimes were live, `ExecutionContext.enterWorkspace` had already
stored `root` in its instance-local lease. The process-wide fallback remained
on the previous root, but the failing session's subsequent context-aware reads
used the rejected root. This split the context's lease state from the shared
fallback and could retarget permission/path decisions for that session.

The transaction contract is:

1. Validate the local, absolute-root and remote-mode preconditions.
2. Publish the candidate root.
3. Store the candidate root in the context only after publication succeeds.

If publication throws, both the context lease and active-root fallback remain
unchanged. Exit uses the same commit ordering in reverse: clear the fallback
first, then clear the local lease. The current publisher only rejects a
non-`undefined` root under the multi-runtime guard, so exit has no current
publisher-rejection path; ordering nevertheless keeps a future rejection from
partially clearing the local lease. Worktree admission rejection (`busy`,
`not_found`, `ambiguous`, and other non-entered outcomes) remains before the
lease call and unchanged.

## Repair and regression coverage

`ExecutionContext.enterWorkspace` now publishes before assigning its local
lease, and `exitWorkspace` publishes the home-root fallback before clearing
its local lease. Tests cover:

- direct `ExecutionContext` state and fallback preservation after a real
  multi-runtime publisher rejection;
- the actual `enter_worktree` tool invoking the same real publisher guard,
  proving the prior lease, context cwd, and fallback all remain unchanged;
- the existing `createSessionRuntime` isolation guard, including the rejected
  context's local lease state;
- accepted enter/exit behavior and existing admission/lease cases.

## Bug retro

- **Origin:** latent ordering defect introduced when active-root publication was
  added in commit `72f86610`; the publication call followed the local lease
  assignment and the publisher could not yet reject a live multi-runtime
  transition.
- **Detection gap:** existing tests covered successful publication and a
  rejected publication's shared fallback, but not the rejected context's own
  lease. They also did not invoke the worktree tool with the real runtime guard.
- **Sibling audit:** the only production `publishActiveWorkspaceRoot` caller is
  `ExecutionContext`; `ExecutionContext.pin` intentionally writes only its
  private lease. Test/reset publisher calls and worktree admission comparisons
  do not create another production transaction to repair.
- **Hardened artifact:** direct context and actual tool-boundary regressions
  now assert both sides of the transaction, while the existing
  `createSessionRuntime` isolation test asserts the real multi-runtime guard.
  A new type would not make this sequencing invariant unrepresentable; the
  owner-level tests are the proportional structural protection.

## Validation receipts

All commands ran in the isolated `workspace-switch-atomicity` worktree after
`pnpm install` (pnpm 11.7.0).

| Command | Result | Count / note |
| --- | --- | --- |
| `NODE_ENV=test pnpm test source/services/execution-context.test.ts source/tools/system/worktree.test.ts source/services/session/session-runtime.isolation.test.ts` (baseline) | pass | 3 files, 29 tests |
| same focused command with regression tests before implementation | fail as expected | 2 tests failed: both observed the rejected replacement root in the local context |
| same focused command after implementation | pass | 3 files, 31 tests |
| `pnpm test:related ./source/services/execution-context.ts` | fail (unrelated baseline failures) | 54 files, 991 passed, 4 failed, 1 expected fail; the failures were in non-interactive, nested-approval scripted-adapter, and Ink hidden-approval tests |
| `pnpm test:changed` | fail (unrelated baseline failures) | 54 files, 991 passed, 4 failed, 1 expected fail; same four failures as the related gate |

`pnpm typecheck`, Prettier, and `git diff --check` pass. The focused workspace
gate is the relevant green gate for this diff; the broader failures do not
exercise workspace switching and were reproduced by both broader commands.

## Remaining risks and boundaries

- The active-root publisher remains an exported test/reset escape hatch and is
  still conventionally single-writer, as specified by Contract 09.
- The multi-runtime guard is process-local and only blocks publishing a
  non-`undefined` active root; this repair neither broadens nor weakens that
  policy.
- Permission and path consumers are not each duplicated in this regression;
  they continue to derive their omitted-root defaults dynamically from the
  unchanged active-root fallback contract.
