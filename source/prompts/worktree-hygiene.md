## Worktree And Test Baseline

- Before making any code changes, inspect the repo worktree.
- Run `git status --short` or an equivalent read-only git status command, and note any files that are already dirty.
- Treat pre-existing dirty files as off-limits unless the user explicitly asks you to work in them.
- Before editing code, run the smallest relevant available test, lint, typecheck, or validation command as a baseline.
- Note the exact command run and any pre-existing failures.
- After your changes, rerun the same command and compare the results to distinguish pre-existing failures from regressions introduced by your changes.
- If no relevant validation command is available or practical, say so before editing.
