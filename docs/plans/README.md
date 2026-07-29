# Plan documents

## Convention

Every plan in this directory should open with a `Status:` line. Use one of:

- **`Status: plan.`** — not yet implemented. Say what it is waiting on.
- **`Status: in progress.`** — active multi-session work. Must also carry a
  **Resume here** section, per `AGENTS.md`.
- **`Status: shipped.`** — implemented. Name the production symbols or files that
  carry the behaviour, so a reader can confirm it without re-deriving the plan.
- **`Status: abandoned.`** — deliberately not doing this. Say why; that reasoning
  is usually the most valuable part of the document.

## Reading these documents

**A plan document is a record of intent at a point in time, not a description of
the current code.** Several plans here predate large refactors and refer to files
and module layouts that no longer exist. Before acting on any plan:

1. Check its `Status:` line.
2. If it has none, treat it as historical. Verify every claim against the code
   before relying on it — do not assume the described work is pending, shipped,
   or still shaped the way the document says.

`AGENTS.md` names the plans that are actually active. That list, not this
directory's contents, is the source of truth for what is in flight.

## Why documents are not moved when they are finished

Plans cross-reference each other by path (`docs/plans/<name>.md`). Moving a
finished plan into an archive subdirectory breaks those references, and the
history in `git log` already records when each was written. Marking status in
place is cheaper and loses nothing.
