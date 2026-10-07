---
title: What's New
description: Published release highlights and changes available only on main.
---

## Published releases

Use `term2 --version` to check your installation and `npm view @qduc/term2 version` for the latest published release.

## 0.31.1 - October 4, 2026

- Model selections retain their provider binding across settings, model menus, sessions, and subagent tier pools, so ambiguous model names no longer select the wrong provider.
- Existing persisted model selections are migrated before strict settings validation, so older settings remain usable on startup.
- Failed `run_code` scripts expose results from nested tools that already completed, allowing recovery without repeating their effects.

See the [0.31.1 changelog](https://github.com/qduc/term2/blob/v0.31.1/CHANGELOG.md) for details.

## 0.31.0 - October 3, 2026

- **Themes and skins:** configurable colour themes with automatic terminal-background detection through `ui.theme`, and classic, rail, cards, ledger, and zen layout skins through `ui.skin`.
- **Interactive input:** queued input and drafts survive approval prompts and queued-message editing.
- **Web sessions:** live turn status is exposed on reconnect, local errors are preserved, and active chat-completions streams cancel correctly.
- **Background work:** background-shell watches surface matching output before retention eviction, and completed background agents release their pending approvals.

See the [0.31.0 changelog](https://github.com/qduc/term2/blob/v0.31.0/CHANGELOG.md) for details.

## 0.30.0 - September 29, 2026

Highlights from 0.30.0:

- **More flexible delegated tasks:** subagents accept a per-invocation specification with a goal, context, tools, constraints, completion criterion, model policy, and budget. Existing roles remain as presets.
- **Compose child agents in `run_code`:** scripts can start, inspect, collect, and cancel child agents. Child permissions are narrowed to the parent's authority, and approval requests use the session's normal prompt.
- **Session goal proposals:** the agent can suggest a goal with `propose_goal`; the user must approve it.
- **More web search options:** Firecrawl and SearXNG join the configurable search providers.

The release also improves provider-pool failover, gateway session lifecycle handling, and web search configuration. See the [0.30.0 changelog](https://github.com/qduc/term2/blob/v0.30.0/CHANGELOG.md) for details.

## On main, ahead of releases

This documentation site builds from `main`, so it can describe work ahead of the published package.

The `web-client/` application is separate from this documentation site and connects through the private `term2 serve` gateway. Follow [gateway setup](/term2/remote/web-gateway/) for integration requirements.

For the complete release history, see the [repository changelog](https://github.com/qduc/term2/blob/main/CHANGELOG.md). For changes on main since 0.31.1, see the [tag-to-main comparison](https://github.com/qduc/term2/compare/v0.31.1...main).
