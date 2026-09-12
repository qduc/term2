---
title: Slash Commands Reference
description: Complete reference of all interactive slash commands registered in term2.
---

Slash commands are entered directly in the prompt composer starting with `/`. Pressing `/` at the start of a prompt opens an interactive completion menu.

## Command Index

| Command | Arguments | Description |
| :--- | :--- | :--- |
| **`/model`** | `[model-name]` | Change the active model (shortcut: `Ctrl+O`). |
| **`/effort`** | `[level]` | Set reasoning effort (`default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`) (shortcut: `Ctrl+T`). |
| **`/plan`** | — | Toggle read-only Plan mode (shortcut: `Shift+Tab`). |
| **`/lite`** | — | Toggle lightweight terminal mode (minimal prompt, session-only context). |
| **`/mentor`** | — | Toggle collaborative Mentor mode with dual-model consultation. |
| **`/orchestrator`** | — | Toggle prompt-guided Orchestrator mode (delegates all tool-backed work). |
| **`/profile`** | `[name]` | Switch the active operating profile (`standard`, `plan`, `lite`, `mentor`, `orchestrator`). |
| **`/auto-approve`** | `[off\|advisory\|auto\|always]` | Set shell and tool auto-approval policy. `always` disables `sandbox.enabled`. |
| **`/sandbox`** | — | Toggle shell sandbox isolation on or off. |
| **`/compact`** | — | Compact older conversation turns into a local summary. |
| **`/rewind`** | `[last\|<turn>] [edit\|resend]` | Rewind conversation history with interactive discard inspection. |
| **`/undo`** | — | Alias for `/rewind edit` (places target turn back in composer for revision). |
| **`/retry`** | — | Alias for `/rewind resend` (immediately resends the last user turn). |
| **`/retry-turn`** | — | Retry the last turn that the provider failed to complete (e.g. after network errors). |
| **`/retry-tool`** | — | Re-execute the last failed or timed-out tool call. |
| **`/copy`** | `[N]` | Copy the latest assistant response (or $N$-th prior response) to clipboard. |
| **`/usage`** | — | Show token usage and model cost metrics for the current session. |
| **`/resume`** | `[conversation-id\|ls]` | Resume a saved conversation or browse conversations. |
| **`/handoff`** | — | Hand off the last assistant response to another model. |
| **`/providers`** | — | Open interactive provider manager (list, add, edit, remove providers or switch OAuth accounts). |
| **`/skills`** | `[skill-name]` | Activate a skill for the next request. |
| **`/settings`** | `[key] [value]` | View or modify runtime configuration settings. |
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
- **Usage**: `/profile`, `/profile standard`, `/profile plan`, `/profile lite`, `/profile mentor`, `/profile orchestrator`
- Switches the active operating profile. Switching to or from `lite` mid-session prompts for confirmation or recommends `/clear`.

### `/auto-approve [mode]`
- **Usage**: `/auto-approve off`, `/auto-approve advisory`, `/auto-approve auto`, `/auto-approve always`
- Sets the tool execution approval mode. Mode `always` disables sandbox prompts entirely.

### `/rewind [last|<turn>] [edit|resend]`
- **Usage**: `/rewind`, `/rewind 3 edit`, `/rewind last resend`
- Opens the rewind menu to select a turn to rewind. Discards subsequent transcript turns and either loads the user prompt into the composer (`edit`) or resubmits it immediately (`resend`).

### `/retry-turn`
- **Usage**: `/retry-turn`
- Retries the last assistant turn when a provider error, network timeout, or rate limit prevented the response from completing.

### `/retry-tool`
- **Usage**: `/retry-tool`
- Re-executes only the last failed or timed-out tool call without losing conversation context or discarding subsequent messages.

### `/copy [N]`
- **Usage**: `/copy`, `/copy 2`
- Copies the latest assistant response text (or the $N$-th prior response) to your system clipboard using OSC 52 or platform clipboard utilities. If multiple copyable sections exist, opens a selection menu.

### `/handoff`
- **Usage**: `/handoff`
- Captures and passes the latest assistant response to the interactive handoff flow.
