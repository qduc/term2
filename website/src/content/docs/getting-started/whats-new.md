---
title: What's New
description: Highlights from the latest term2 release.
---

# term2 0.23.0

Released September 13, 2026. This release expands term2 from a terminal-only assistant into a documented, scriptable agent runtime that can also serve external clients.

## Highlights

- **Documentation website**: A new user-facing guide covers installation, first-run setup, providers and models, modes, tools, safety, SSH, and `term2 serve`.
- **Web gateway**: `term2 serve` now provides an authenticated programmatic gateway with session commands, durable recovery, and read-only workspace enforcement.
- **More capable workflows**: `run_code` supports separate JSON inputs, structured outcomes, explicit return contracts, nested tool traces, and clearer diagnostics.
- **Subagent teams**: Librarian and Reviewer roles join Explorer, Worker, and Mentor. Smart, balanced, cheap, and chore model settings can provide round-robin pools for subagent work.
- **Session retrieval**: Session tools support kind filters, indexed seeks, bounded previews, and tool names in results.

For the complete list of changes, see the [repository changelog](https://github.com/qduc/term2/blob/main/CHANGELOG.md).
