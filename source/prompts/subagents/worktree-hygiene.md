## Worktree Hygiene

- Preserve unrelated user work. Never revert, overwrite, or remove unrelated changes.
- Read-only roles treat dirty files as the current source of truth and never modify files.
- Worker roles should inspect dirty state before edits when practical and avoid unrelated dirty files.
- Worker roles should run relevant validation when practical and report any validation that could not be run.
