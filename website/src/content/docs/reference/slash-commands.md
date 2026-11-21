---
title: Slash Commands Reference
description: Interactive slash commands and their arguments.
---

Type `/` at the start of a prompt to open the command menu.

## Command Index

| Command | Arguments | Description |
| :--- | :--- | :--- |
| **`/bridge`** | `[status\|connect [name]\|disconnect]` | Inspect or change local Discord session attachment. Connectivity to Discord is not verified by attachment status. |
| **`/model`** | `[model-name]` | Change the active model (shortcut: `Ctrl+O`). |
| **`/effort`** | `[level]` | Set reasoning effort (`default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`) (shortcut: `Ctrl+T`). |
| **`/auto-approve`** | `[off\|advisory\|auto\|always]` | Set shell and tool auto-approval policy. `always` disables `sandbox.enabled`. |
| **`/sandbox`** | — | Toggle shell sandbox isolation on or off. |
| **`/compact`** | — | Compact older conversation turns into a local summary. |
| **`/rewind`** | `[last\|<turn>] [edit\|resend]` | Choose a turn and review what will be discarded before rewinding. |
| **`/retry`** | `[turn\|tool]` | Resend the latest prompt, regenerate from the original prompt, or continue from the last tool result. |
| **`/copy`** | `[N]` | Copy the latest assistant response (or $N$-th prior response) to clipboard. |
| **`/usage`** | — | Show token usage and model cost metrics for the current session. Subscription reference cost, when available, is a catalog comparison, not a billed charge. |
| **`/resume`** | `[conversation-id\|ls]` | Resume a saved conversation or browse conversations. |
| **`/handoff`** | — | Hand off the last assistant response to another model. |
| **`/providers`** | — | Open interactive provider manager (list, add, edit, remove providers or switch OAuth accounts). |
| **`/mcp`** | — | Show configured MCP servers and their connection state. |
| **`/skills`** | `[skill-name]` | Activate a skill for the next request. |
| **`/settings`** | `[key] [value]` | View or modify runtime configuration settings. |
| **`/goal`** | `[show\|set <outcome> [--criteria <text>]\|achieved\|abandon]` | Inspect or update the durable session goal; `/clear` retains it. |
| **`/clear`** | — | Clear current conversation history and start a fresh session. |
| **`/restart`** | `[stop]` | Reload the supported built CLI and resume the session; `stop` consents to stopping background work. See [restart limits](/term2/using-term2/sessions/#restart-the-built-cli). |
| **`/quit`** | — | Exit term2 session cleanly. |

---

## Detailed Command Documentation

### `/model [model-name]`
- **Usage**: `/model`, `/model gpt-5.1`, `/model openrouter/anthropic/claude-3.7-sonnet`
- **Shortcut**: `Ctrl+O`
- Switches the primary model. If called without arguments, opens the interactive model picker menu.

### `/effort [level]`
- **Usage**: `/effort high`, `/effort medium`, `/effort none`
- **Shortcut**: `Ctrl+T`
- Sets the reasoning effort level passed to models supporting variable reasoning tokens.

### `/auto-approve [mode]`
- **Usage**: `/auto-approve off`, `/auto-approve advisory`, `/auto-approve auto`, `/auto-approve always`
- Sets the tool execution approval mode. Mode `always` sets `sandbox.enabled = false`.

### `/rewind [last|<turn>] [edit|resend]`
- **Usage**: `/rewind`, `/rewind 3 edit`, `/rewind last resend`
- Opens the rewind menu to select a turn to rewind. Discards subsequent transcript turns and either loads the user prompt into the composer (`edit`) or resubmits it immediately (`resend`).

### `/retry [turn|tool]`

- `/retry` immediately resends the latest prompt. Use `/rewind` to choose an earlier turn.
- `/retry turn` regenerates the latest response from its original prompt.
- `/retry tool` resumes model generation with the last retained tool result.

The earlier spellings `/retry-turn` and `/retry-tool` still work. `/undo` remains an alias for `/rewind edit`.

### `/copy [N]`
- **Usage**: `/copy`, `/copy 2`
- Copies the latest assistant response text (or the $N$-th prior response) to your system clipboard using OSC 52 or platform clipboard utilities. If multiple copyable sections exist, opens a selection menu.

### `/handoff`
- **Usage**: `/handoff`
- Passes the latest assistant response to another model.
