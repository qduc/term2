---
title: Slash Commands Reference
description: Complete reference of all interactive slash commands registered in term2.
---

Slash commands are entered directly in the prompt composer starting with `/`. Pressing `/` at the start of a prompt opens an interactive completion menu.

## Command Index

| Command | Arguments | Description |
| :--- | :--- | :--- |
| **`/bridge`** | `[status\|connect [name]\|disconnect]` | Inspect or change local Discord session attachment. Connectivity to Discord is not verified by attachment status. |
| **`/model`** | `[model-name]` | Change the active model (shortcut: `Ctrl+O`). |
| **`/effort`** | `[level]` | Set reasoning effort (`default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`) (shortcut: `Ctrl+T`). |
| **`/plan`** | — | Toggle read-only Plan mode (shortcut: `Shift+Tab`). |
| **`/lite`** | — | Toggle Bare (compatibility alias retained from Lite). |
| **`/mentor`** | — | Toggle collaborative Mentor mode with dual-model consultation. |
| **`/orchestrator`** | — | Toggle prompt-guided Orchestrator mode (delegates all tool-backed work). |
| **`/profile`** | `[name]` | Switch the active operating profile (`standard`, `bare`, `plan`, `pair`, `mentor`, `orchestrator`; `lite` aliases `bare`). |
| **`/auto-approve`** | `[off\|advisory\|auto\|always]` | Set shell and tool auto-approval policy. `always` disables `sandbox.enabled`. |
| **`/sandbox`** | — | Toggle shell sandbox isolation on or off. |
| **`/compact`** | — | Compact older conversation turns into a local summary. |
| **`/rewind`** | `[last\|<turn>] [edit\|resend]` | Rewind conversation history with interactive discard inspection. |
| **`/undo`** | — | Alias for `/rewind edit` (places target turn back in composer for revision). |
| **`/retry`** | — | Alias for `/rewind resend` (immediately resends the last user turn). |
| **`/retry-turn`** | — | Regenerate the latest user turn from its original prompt. |
| **`/retry-tool`** | — | Retry the last tool call by rewinding to it. |
| **`/copy`** | `[N]` | Copy the latest assistant response (or $N$-th prior response) to clipboard. |
| **`/usage`** | — | Show token usage and model cost metrics for the current session. |
| **`/resume`** | `[conversation-id\|ls]` | Resume a saved conversation or browse conversations. |
| **`/handoff`** | — | Hand off the last assistant response to another model. |
| **`/providers`** | — | Open interactive provider manager (list, add, edit, remove providers or switch OAuth accounts). |
| **`/mcp`** | — | Show configured MCP servers and their connection state. |
| **`/skills`** | `[skill-name]` | Activate a skill for the next request. |
| **`/settings`** | `[key] [value]` | View or modify runtime configuration settings. |
| **`/goal`** | `[show\|set <outcome> [--criteria <text>]\|achieved\|abandon]` | Inspect or update the durable session goal; `/clear` retains it. |
| **`/clear`** | — | Clear current conversation history and start a fresh session. |
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

### `/profile [profile-name]`
- **Usage**: `/profile`, `/profile standard`, `/profile bare`, `/profile plan`, `/profile lite`, `/profile pair`, `/profile mentor`, `/profile orchestrator`
- Switches the active operating profile. `lite` is a compatibility alias for `bare`. Switching to or from Bare mid-session prompts for confirmation or recommends `/clear`.

### `/auto-approve [mode]`
- **Usage**: `/auto-approve off`, `/auto-approve advisory`, `/auto-approve auto`, `/auto-approve always`
- Sets the tool execution approval mode. Mode `always` sets `sandbox.enabled = false`.

### `/rewind [last|<turn>] [edit|resend]`
- **Usage**: `/rewind`, `/rewind 3 edit`, `/rewind last resend`
- Opens the rewind menu to select a turn to rewind. Discards subsequent transcript turns and either loads the user prompt into the composer (`edit`) or resubmits it immediately (`resend`).

### `/retry-turn`
- **Usage**: `/retry-turn`
- Regenerates the entire latest user turn from its original prompt, replacing the old turn in the transcript.

### `/retry-tool`
- **Usage**: `/retry-tool`
- Retries the last tool call by rewinding the transcript to it. Verify any effects that may already have occurred before retrying.

### `/copy [N]`
- **Usage**: `/copy`, `/copy 2`
- Copies the latest assistant response text (or the $N$-th prior response) to your system clipboard using OSC 52 or platform clipboard utilities. If multiple copyable sections exist, opens a selection menu.

### `/handoff`
- **Usage**: `/handoff`
- Captures and passes the latest assistant response to the interactive handoff flow.
