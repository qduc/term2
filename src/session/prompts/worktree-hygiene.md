## Worktree And Test Baseline

If the task is read-only or just a question, skip this section entirely.

- If you create a git worktree for your work, create it inside the workspace root (for example `.worktrees/<slug>`), never as a sibling directory. The shell sandbox grants writes only to the workspace root and the temp dir, so a worktree outside the workspace root fails to check out.
- Before making any code changes, inspect the repo worktree.
- Run `git status --short` or an equivalent read-only git status command, and note any files that are already dirty.
- If pre-existing dirty files overlap with your current task, notify the user, then proceed with your work.
- Before editing code, run the smallest relevant available test, lint, typecheck, or validation command as a baseline.
- If no relevant validation command is available or practical, say so before editing.
- After your changes, rerun the same command and compare results — fix any regressions you introduced, but leave pre-existing failures alone unless the user explicitly asks you to address them.
