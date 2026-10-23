# Plan documents

## Scope

Keep substantive plans and designs here. Do not retain temporary execution
reports, scratchpads, worker assignments, handoffs, audit snapshots, or experiment
fixtures. When removing one, update references in retained documents; use a
commit-pinned Git history link when the historical evidence still matters.

## Convention

Every plan in this directory should open with a `Status:` line. Use one of:

- **`Status: plan.`** — not yet implemented. Say what it is waiting on.
- **`Status: in progress.`** — active multi-session work. Must also carry a
  **Resume here** section, per `AGENTS.md`.
- **`Status: shipped.`** — implemented. Name the production symbols or files that
  carry the behaviour and the merge commit, so a reader can confirm it without
  re-deriving the plan.
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

`AGENTS.md` links area-specific context, including completed plans. A link there
does not mean the work is active. Check each plan's status and **Resume here**
notes against Git history and the current implementation before treating it as
unfinished work. Branches and worktrees can retain unmerged work independently
of these documents.

## Organization

Give each plan one home based on its primary feature. Keep related designs,
implementation plans, and verification plans together. Cross-cutting engineering
work belongs in `engineering/`; do not duplicate a plan across features.

| Folder | Plans |
| --- | --- |
| [Agent runtime](agent-runtime/) | Assembly, execution flow, durable goals, hooks, run budgets |
| [Subagents](subagents/) | Workers, delegation, oversight, peer communication |
| [Background work](background-work/) | Monitoring, lifecycle, transfers, background UI |
| [Sessions](sessions/) | Persistence, queries, retrieval, rollover, recovery |
| [Context and memory](context-and-memory/) | Context lifecycle, compaction, memory |
| [Providers](providers/) | Integrations, OAuth, reasoning, provider continuity, model benchmarks |
| [Tools](tools/) | Tool interfaces, dispatch, shell modes, search, output safety |
| [Run code](tools/run-code/) | Code mode, MCP, TypeScript, nested approval, code host |
| [Approvals and sandbox](approvals-and-sandbox/) | Approval policies, sandboxing, shell safety |
| [Terminal UI](terminal-ui/) | Menus, input, themes, queue editing, TUI control |
| [Settings](settings/) | Settings infrastructure, field editing, tool configuration |
| [Web client](web-client/) | Gateway, frontend, LAN/TLS |
| [Engineering](engineering/) | Cross-cutting refactors, contracts, testing, logging |

Existing multi-file plan groups stay together inside their feature folder.
Completion changes a plan’s status, not its location: do not split features
between active and archive folders. Git history retains previous versions.

When moving a plan, update repository references and rebase its relative links,
including links to documents outside this directory. Commit-pinned historical
links should continue to point to their original paths.
