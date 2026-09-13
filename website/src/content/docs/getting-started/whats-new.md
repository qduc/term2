---
title: What's New
description: Highlights from the latest term2 release.
---

# term2 0.24.0

Released September 13, 2026. This release fixes OAuth logins, makes search tool exposure consistent, and polishes the message feed.

## Highlights

- **Easier OAuth logins**: Remote logins accept a pasted callback query string or a bare authorization code, and Grok's OAuth redirect now works against auth.x.ai.
- **Uniform search tools**: `grep` and `glob` are available on every model and gate on read authority, so read-only configurations no longer lose text and file search.
- **Cleaner message feed**: User messages render as full-width content blocks, and command groups no longer reprint as older messages are trimmed.

For the complete list of changes, see the [repository changelog](https://github.com/qduc/term2/blob/main/CHANGELOG.md).
