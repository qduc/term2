---
title: Approvals & Run Budgets
description: Interactive tool approvals, auto-approve modes, and execution budgets.
---

term2 balances velocity with security by giving you fine-grained control over which operations execute automatically and which require interactive human approval.

## Auto-Approval Modes (`/auto-approve`)

Configure the auto-approval policy using the `/auto-approve` command or via `shell.autoApproveMode`:

| Mode | Command | Behavior | Safety Guarantee |
| :--- | :--- | :--- | :--- |
| **`off`** *(Default)* | `/auto-approve off` | Every mutating tool call and shell command prompts for interactive user confirmation. | Maximum safety. Default policy across all sessions. |
| **`advisory`** | `/auto-approve advisory` | Prompts for confirmation on every command, accompanied by a real-time safety explanation. | High safety with consequence analysis. |
| **`auto`** | `/auto-approve auto` | Opt-in smart approval mode. Automatically approves safe read-only operations and workspace file modifications. Risky commands (e.g. `rm -rf`, `git reset --hard`, network requests, system path edits) are strictly gated for confirmation. | Balanced velocity. Eliminates repetitive prompts on benign actions while intercepting destructive commands. |
| **`always`** | `/auto-approve always` | Completely unattended execution mode. Every tool runs without prompts except `ask_user`. Selecting `always` automatically disables the shell sandbox (`sandbox.enabled = false`). | For isolated, disposable environments only. |

> **Sandbox Interaction:** `always` and `sandbox.enabled` are mutually exclusive: selecting `always` disables the shell sandbox, and enabling the sandbox (`/sandbox` or `sandbox.enabled = true`) immediately demotes `always` to `auto`.

## Run Budgets (`agent.runBudget`)

To prevent runaway token usage, infinite execution loops, or unintended API spending during autonomous runs, term2 enforces configurable run budgets:

- **Spending Cap (`agent.runBudget.maxUsdMicros`)**: Total priced API cost ceiling for a run (default: `$5.00` / `5,000,000` micros).
- **Token Cap (`agent.runBudget.maxUnpricedTokens`)**: Unpriced token ceiling (default: `5,000,000` tokens).
- **Active Time Cap (`agent.runBudget.maxActiveTimeMs`)**: Active execution time ceiling, excluding user idle wait time (default: 1 hour / `3,600,000` ms).
- **Turn Backstop (`agent.runBudget.turnBackstop`)**: High turn-count safeguard to detect looping subagents (default: 150 turns).
- **Budget Escalation**: As budgets approach thresholds, term2 injects soft wrap-up nudges or pauses for user confirmation before granting finite extensions.
