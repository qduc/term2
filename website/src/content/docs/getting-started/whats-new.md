---
title: What's New
description: Published release highlights and changes available only on main.
---

## Published: 0.30.0

npm's latest release is **0.30.0**, published September 29, 2026. Release availability was checked October 3; use `term2 --version` to check your installation.

Highlights from 0.30.0:

- **More flexible delegated tasks:** subagents accept a per-invocation specification with a goal, context, tools, constraints, completion criterion, model policy, and budget. Existing roles remain as presets.
- **Compose child agents in `run_code`:** scripts can start, inspect, collect, and cancel child agents. Child permissions are narrowed to the parent's authority, and approval requests use the session's normal prompt.
- **Session goal proposals:** the agent can suggest a goal with `propose_goal`; the user must approve it.
- **More web search options:** Firecrawl and SearXNG join the configurable search providers.

The release also improves provider-pool failover, gateway session lifecycle handling, and web search configuration. See the [0.30.0 changelog](https://github.com/qduc/term2/blob/v0.30.0/CHANGELOG.md) for details.

## On main, not yet in npm 0.30.0

This documentation site builds from `main`, so it can describe work ahead of the published package.

As of October 3, main includes terminal themes and skins, plus web client session/event handling and live-stream cancellation fixes. The web UI fixes merged in PR #13 do **not** establish a new npm release. Installing `@qduc/term2` from npm still gives 0.30.0 at this checkpoint.

The `web-client/` application is separate from this documentation site and connects through the private `term2 serve` gateway. Follow [gateway setup](/term2/remote/web-gateway/) for integration requirements.

For the complete release history, see the [repository changelog](https://github.com/qduc/term2/blob/main/CHANGELOG.md). For changes after 0.30.0, see the [tag-to-main comparison](https://github.com/qduc/term2/compare/v0.30.0...main).
