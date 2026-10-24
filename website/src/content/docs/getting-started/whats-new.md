---
title: What's New
description: Published release highlights and changes available only on main.
---

## Published releases

Use `term2 --version` to check your installation and `npm view @qduc/term2 version` for the latest published release.

## 0.37.0 - October 24, 2026

- Local context compaction prefers a one-shot summary over the live request prefix when the conversation fits the input window, preserving prompt-cache and transport affinity on Codex, Grok, and OpenCode while keeping the serialized chunk reducer as the fallback for larger histories.
- Local context compaction caps the verbatim hot tail at 16,000 tokens (keeping at least the newest settled round when a single round exceeds the budget) and renders up to 40 recent tool receipts as a one-line digest outside `<summary>`.
- The Bare profile advertises a foreground-only `shell` schema and batching guidance while keeping the full canonical schema for runtime normalization and approval checks.
- The interactive banner and status bar read profile labels (`Bare`, `Pair`, etc.) directly from the built-in profile registry instead of falling back to `Standard`.
- Native Codex freeform `apply_patch` tool calls pass `{ patch }` to match the canonical tool schema instead of failing validation before writing.
- `/resume` and `term2 --resume` sort session files by modification time before reading and stop full log parsing once the requested limit is filled.

See the [0.37.0 changelog](https://github.com/qduc/term2/blob/v0.37.0/CHANGELOG.md) for details.

## 0.36.0 - October 23, 2026

- The Bare profile now includes the skills catalog (`activate_skill`) and environment context.
- Logging survives disk failures: a full or unwritable log disk produces one warning instead of crashing, and startup prunes application and provider-traffic logs older than 7 days or beyond 512 MiB per directory.
- Sandbox blocked-read approval prompts (deny, allow once, Escape) resolve correctly instead of erroring.
- Session rollover no longer runs while a queued submission owns the queue; a failed rollover preserves its handoff brief.

See the [0.36.0 changelog](https://github.com/qduc/term2/blob/v0.36.0/CHANGELOG.md) for details.

## 0.35.0 - October 22, 2026

- Opt-in Bare profile (`--profile bare`, `/profile bare`) with a minimal system prompt that keeps codebase tools and completion verification.
- `--profile <name>` selects an operating profile at startup.
- `agent.backgroundWaitTimeoutMs` bounds how long headless runs wait for background tasks (default 1 hour).
- `verifier.model` designates an independent completion-verification model.
- Headless runs with durable goals stop cleanly once completion verification passes.

See the [0.35.0 changelog](https://github.com/qduc/term2/blob/v0.35.0/CHANGELOG.md) for details.

## 0.34.0 - October 19, 2026

- Adaptive independent verification for durable goals: `goal_check` proposals can be gated by an independent verifier before goals are closed (`agent.completionVerification`).
- Reworked interactive settings menu: `/settings` categorizes settings into curated tabs (Models, Providers, Context, Safety, Tools, UI, Hooks) with human-readable labels, dollar-denominated budget editing, masked API keys, and in-place boolean toggling.
- Declarative provider preset inventory: provider configuration leverages presets for straightforward setup and connection management.
- Runtime agent model discovery: agents and `run_code` scripts can query models and providers via `list_models` with filtering, pagination, and credential readiness.
- Grok client version resolution: resolves the CLI client version dynamically to avoid API version floor rejections.

See the [0.34.0 changelog](https://github.com/qduc/term2/blob/v0.34.0/CHANGELOG.md) for details.

## 0.33.0 - October 18, 2026

- `tools.shell` is available inside `run_code` scripts with shared sandbox enforcement, approvals, timeouts, monitors, and job tracking.
- The interactive model picker shows providers in a grouped leading column across unified and favorites views.
- Custom catalogs (including OrcaRouter) isolate catalog adapters and filter unsupported generation models.
- Provider policies are kept in owning adapters, and the conversation engine consolidates turns and submissions under a single loop runner and session projection.

See the [0.33.0 changelog](https://github.com/qduc/term2/blob/v0.33.0/CHANGELOG.md) for details.

## 0.32.2 - October 17, 2026

- Gemini tool continuations preserve thought signatures during replay, and rate-limit retries honor supported provider delays within the retry policy's bounds.
- Model filtering prioritizes whole-word matches and resets selection when results change.
- Working indicators end tool steps when results arrive, show "Waiting for model", and count down retry backoff.
- `run_code` tool entries include return-shape guidance, with declared return contracts required for scriptable tools.

See the [0.32.2 changelog](https://github.com/qduc/term2/blob/v0.32.2/CHANGELOG.md) for details.

## 0.32.1 - October 10, 2026

- Codex sessions retain reusable WebSocket connections across turns.
- Shift+Enter inserts a newline again in terminals that send the Alt+Enter sequence while idle.
- Goal proposals show labelled outcome and success criteria, and background timers remain visible in narrow panels.

See the [0.32.1 changelog](https://github.com/qduc/term2/blob/v0.32.1/CHANGELOG.md) for details.

## 0.32.0 - October 8, 2026

- Durable goals have an agent stop check, and a valid achieved check closes the goal when the turn ends.
- Requests that cannot fit a known model context window pause before sending. Non-interactive context and budget pauses exit with code 2 and resume guidance.
- The opt-in `contain` budget escalation pauses at exhaustion; `warn` remains the default. `--auto-approve` never grants more budget.
- New installs enable local context compaction and use adaptive output allocation. Existing saved settings are retained: enable compaction explicitly and remove a saved `agent.maxOutputTokens` to opt into the adaptive cap.
- One-time approvals are bound to the answered call, and interrupted tool outcomes are marked unobserved on resume.
- `/retry-turn` regenerates the latest user turn from its original prompt.

See the [0.32.0 changelog](https://github.com/qduc/term2/blob/v0.32.0/CHANGELOG.md), including upgrade and downgrade compatibility notes.

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

For the complete release history, see the [repository changelog](https://github.com/qduc/term2/blob/main/CHANGELOG.md). For changes on main since 0.37.0, see the [tag-to-main comparison](https://github.com/qduc/term2/compare/v0.37.0...main).
