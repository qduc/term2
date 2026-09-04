# Field-test worktree archive

Captured 2026-09-04 before removing the experiment worktrees. Each directory
is one worktree from rounds E1, E5, R2, plus two unrelated branches.

## What is in each directory

| file | meaning |
| --- | --- |
| `base.txt` | the merge-base the worktree was cut from |
| `work.diff` | **the model's actual work**: `git diff <base>` over the worktree, so it includes both committed and uncommitted tracked changes |
| `commits.txt` | commits unique to the worktree (`main..HEAD`) |
| `untracked-list.txt` | untracked paths, gitignore-respecting |
| `untracked.tar.gz` | copies of those untracked files, where any existed |

**Do not use `git diff main` on these.** Most worktrees sit at old bases, so a
diff against current `main` is dominated by main's later commits shown in
reverse. That is why `work.diff` is taken against `base.txt` instead.

## Content

| worktree | base | work.diff | files | untracked |
| --- | --- | --- | --- | --- |
| codemode-task | c9e07135 | 228 | 15 | - |
| e1-ds | c9e07135 | 0 | 0 | 52 (tools-map snapshot) |
| e1-glm | c9e07135 | 0 | 0 | 2 (audit json) |
| e5-b-ds | 201e61d4 | 23 | 1 | - |
| e5-b-glm | 862782a4 | 22 | 1 | - |
| e5-b-muse | cb73db64 | 25 | 1 | - |
| e5-c-ds | cb73db64 | 314 | 2 | - |
| e5-c-glm | cb73db64 | 327 | 2 | - |
| e5-c-muse | cb73db64 | 159 | 1 | **1 (shell-approval.ts, 160 lines)** |
| luna-chained | 443ed580 | 0 | 0 | 1 (probe script) |
| r2-a-ds | c9e07135 | 116 | 2 | - |
| r2-a-glm | c9e07135 | 112 | 4 | - |
| r2-a-muse | c9e07135 | 128 | 2 | - |
| r2-b-ds | c9e07135 | 26 | 1 | - |
| r2-b-glm | c9e07135 | 45 | 2 | - |
| r2-b-muse | c9e07135 | 28 | 1 | - |
| r2-c-ds | c9e07135 | 349 | 2 | - |
| r2-c-glm | c9e07135 | 321 | 2 | - |
| r2-c-muse | c9e07135 | 331 | 2 | - |

Untracked files are stored as a **tarball, not loose files**: the repo's
lint-staged hook runs eslint with `parserOptions.project` over any staged
`.ts`, and snapshot copies are not in `tsconfig.json`, so loose `.ts` copies
cannot be committed here. `tar -xzf untracked.tar.gz` to read them.

## A correction this capture forced

**E5's recorded task-C diffs undercount new-file work.** `e5/run.sh` captures
`git diff main -- source`, which does not see untracked files. `e5-c-muse`
created `source/tools/system/shell-approval.ts` - a 160-line extracted
approval module that *was* the refactor's deliverable - and it appears in no
`out/*.diff`. The recorded "cm-c-muse 159 lines vs nocm-c-muse 163 lines"
comparison therefore compared incomplete artifacts.

Worse, both arms of a cell share one worktree, so the surviving untracked file
belongs to whichever arm ran last (cm). The nocm equivalent, if there was one,
is unrecoverable.

**Fix before the next round:** capture `git add -A` / `git status --porcelain`
output, or diff with `--no-index` against a pristine copy, so new files are
recorded.

`e1-ds` and `e1-glm` hold only untracked audit output and no source changes -
their task was a read-only audit, so that is expected, not a capture failure.
