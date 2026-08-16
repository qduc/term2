# SB-08 workspace authority handoff

Status: **audit draft — not owner-reviewed.** This is the local handoff record
for the isolated `sb08-workspace-authority` worktree. It does not update the
coordinator-owned service-boundary tracker.

## Scope completed

- Added Contract 09 at
  `docs/contracts/09-execution-root-authority-and-workspace-lease.md`.
- Added G2 in `source/services/file-service.test.ts`: the public completion
  accessor invalidates its root-sensitive cache when a parent lease changes and
  returns the original fallback root after exit. The test uses two real
  temporary roots and a `process.cwd` test spy; it never calls `process.chdir`.
- Added G5 and G6 in
  `source/services/workspace/workspace-lease-authority.test.ts`:
  - sandbox `filesystem.allowWrite` follows an omitted-cwd leased root;
  - `analyzePathRisk` classifies an absolute leased path as project-local and a
    real non-leased comparison path as outside-project review. G6 creates its
    leased root as a real sibling under the parent `.worktrees` directory,
    outside the current worktree and not `/tmp`, while keeping the comparison
    path inside the current worktree; it cleans the lease in a `finally` block.
- Added the `source/tools/system/worktree.test.ts:24-40,58-71` citation and
  matrix/gate entry for the `enter_worktree`/`exit_worktree` tool coupling.
- Added `source/components/layout/StatusBar.tsx:13,70` to the verified
  default-root-consumer audit for Docker project-grant status presentation.
- Cited the existing C9.3 execution-context evidence and the active-root and
  worktree-transition matrices. No G4 test was added.

## Contract-09 audit decisions retained

- Contract number and filename are the coordinator-assigned **09** values.
- `ExecutionContext.enterWorkspace` and `exitWorkspace` are the sole
  production publishers by convention. `publishActiveWorkspaceRoot` remains an
  exported test/reset escape hatch; the record does not claim an uncallable
  single-writer capability.
- The source audit lists every verified direct default-root consumer found in
  the current source search, including the StatusBar Docker project-grant
  lookup. The three new tests are representative public boundary
  characterizations, not an exhaustive proof of every current or future
  consumer.
- Sandbox fail-closed policy remains Contract 05 C5.5; Contract 09 owns root
  authority and default-root selection.
- Entry and exit settlement unions are recorded exactly as
  `entered | already_active | not_found | ambiguous | unavailable | busy` and
  `exited | not_in_worktree | busy`.
- No provider black-box gate applies: this packet changes only tests and docs,
  not a provider, bridge, run loop, registry, or non-interactive path.

## Allowed-file check

Only these four packet files were changed in this worktree:

1. `docs/contracts/09-execution-root-authority-and-workspace-lease.md`
2. `docs/plans/service-boundary-contract-completion-sb08-workspace.md`
3. `source/services/file-service.test.ts`
4. `source/services/workspace/workspace-lease-authority.test.ts`

No commit, merge, push, or staging was performed. Final verification must also
confirm that the production-source diff is empty.

## Verification record

Commands are recorded verbatim after execution:

```sh
pnpm --dir /home/qduc/term2/.worktrees/sb08-workspace-authority install
NODE_ENV=test pnpm --dir /home/qduc/term2/.worktrees/sb08-workspace-authority test \
  source/services/workspace/active-workspace-root.test.ts \
  source/services/workspace/worktree-transition.test.ts \
  source/tools/system/worktree.test.ts \
  source/services/execution-context.test.ts \
  source/services/file-service.test.ts \
  source/services/workspace/workspace-lease-authority.test.ts \
  source/utils/shell/sandbox/sandbox-policy.test.ts \
  source/utils/shell/command-safety.path.test.ts
pnpm --dir /home/qduc/term2/.worktrees/sb08-workspace-authority typecheck
pnpm --dir /home/qduc/term2/.worktrees/sb08-workspace-authority exec prettier --check docs/contracts/09-execution-root-authority-and-workspace-lease.md docs/plans/service-boundary-contract-completion-sb08-workspace.md source/services/file-service.test.ts source/services/workspace/workspace-lease-authority.test.ts
git -C /home/qduc/term2/.worktrees/sb08-workspace-authority diff --check
NODE_ENV=test pnpm --dir /home/qduc/term2/.worktrees/sb08-workspace-authority test
```

Results:

- `pnpm install` in `/home/qduc/term2/.worktrees/sb08-workspace-authority`:
  lockfile up to date; 580 packages installed in the isolated worktree.
- Corrected focused gate: **8 files / 101 tests passed**, including
  `source/tools/system/worktree.test.ts`.
- `pnpm --dir /home/qduc/term2/.worktrees/sb08-workspace-authority typecheck`:
  passed (`tsc --noEmit`).
- `pnpm --dir /home/qduc/term2/.worktrees/sb08-workspace-authority exec
  prettier --check ...` over the four allowed files: passed.
- `git -C /home/qduc/term2/.worktrees/sb08-workspace-authority diff --check`:
  passed.
- First full `NODE_ENV=test pnpm test` attempt: 483 files passed, 2 failed,
  1 skipped; one transient `InputBox.test.tsx` Alt+Enter failure and the known
  settings-schema baseline. The focused InputBox rerun passed **1 file / 37
  tests**.
- Full-suite rerun: **484 files passed, 1 failed, 1 skipped; 6,239 passed,
  1 failed, 2 skipped**. The only remaining failure is the known settings
  baseline: `settings-schema.test.ts` expects the default
  `maxModelRequestDurationMs` to be `0`, but the current baseline returns
  `300000`.

The full suite was not rerun for this correction; the prior broader rerun
remains recorded above with only the unrelated known settings baseline failure.
No provider black-box suite was run or required.
