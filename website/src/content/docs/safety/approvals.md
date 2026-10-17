---
title: Approvals & Run Budgets
description: Interactive tool approvals, auto-approve modes, and execution budgets.
---

term2 balances velocity with security by giving you fine-grained control over which operations execute automatically and which require interactive human approval.

## Auto-Approval Modes (`/auto-approve`)

Configure shell auto-approval using `/auto-approve` or `shell.autoApproveMode`. The CLI `--auto-approve` flag is separate and applies only to non-interactive prompts.

| Mode | Command | Behavior | Safety Guarantee |
| :--- | :--- | :--- | :--- |
| **`off`** *(Default)* | `/auto-approve off` | Shell commands prompt for interactive confirmation. Valid local workspace edits can apply without a prompt; file tools have separate boundary and authorization checks. | Shell confirmation under the default interactive policy. |
| **`advisory`** | `/auto-approve advisory` | Prompts for confirmation on every command, accompanied by a real-time safety explanation. | High safety with consequence analysis. |
| **`auto`** | `/auto-approve auto` | Opt-in smart approval mode. Automatically approves safe read-only operations and workspace file modifications. Risky commands (e.g. `rm -rf`, `git reset --hard`, network requests, system path edits) are strictly gated for confirmation. | Balanced velocity. Eliminates repetitive prompts on benign actions while intercepting destructive commands. |
| **`always`** | `/auto-approve always` | Completely unattended execution mode. Every tool runs without prompts except `ask_user`. Selecting `always` automatically disables the shell sandbox (`sandbox.enabled = false`). | For isolated, disposable environments only. |

> **Sandbox Interaction:** `always` and `sandbox.enabled` are mutually exclusive: selecting `always` disables the shell sandbox, and enabling the sandbox (`/sandbox` or `sandbox.enabled = true`) immediately demotes `always` to `auto`.

## Run Budgets (`agent.runBudget`)

Run budgets track spending, unpriced tokens, active time, and stall evidence. The default escalation is `warn`: these thresholds are advisory, not hard spending or execution caps.

- **Spending Cap (`agent.runBudget.maxUsdMicros`)**: Total priced API cost ceiling for a run (default: `$5.00` / `5,000,000` micros).
- **Token Cap (`agent.runBudget.maxUnpricedTokens`)**: Unpriced token ceiling (default: `5,000,000` tokens).
- **Active Time Cap (`agent.runBudget.maxActiveTimeMs`)**: Active execution time ceiling, excluding user idle wait time (default: 1 hour / `3,600,000` ms).
- **Turn Backstop (`agent.runBudget.turnBackstop`)**: High turn-count safeguard to detect looping subagents (default: 150 turns).
- **Budget Escalation (`agent.runBudget.escalation`)**: `warn` (default) reports advisory evidence. `contain` pauses at exhaustion while warning and stall evidence remain advisory. `pause` also stops on warning/stall evidence. `disabled` emits no budget evidence.

In non-interactive runs, a budget check-in exits with code 2 and a resume hint. `--auto-approve` approves tools only; it never grants budget extensions. With `--json`, the pause is reported as `run_budget_paused`.
