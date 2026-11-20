---
title: Approvals & Run Budgets
description: Interactive tool approvals, auto-approve modes, and execution budgets.
---

When term2 wants to run a shell command in an interactive session, it normally asks for your approval. Read the proposed action and choose from the options in the prompt. Valid edits inside the local workspace can apply without a prompt; file tools have their own authorization and boundary checks.

To change how often shell commands need your approval, run `/auto-approve` in a session. Keep `off` if you want to review each command, choose `advisory` for an explanation with each prompt, or choose `auto` to approve commands classified as safe while still reviewing risky ones. Choose `unattended` when nobody will be at the keyboard: term2 never asks you, and whatever the reviewer does not approve is refused to the agent instead. The `always` mode disables the shell sandbox and skips tool approval prompts; use it only in an isolated, disposable environment.

For a non-interactive prompt, `--auto-approve` is a separate option. See [non-interactive use](/term2/using-term2/non-interactive/) before enabling tool execution there.

## Auto-Approval Modes (`/auto-approve`)

Configure shell auto-approval using `/auto-approve` or `shell.autoApproveMode`. The CLI `--auto-approve` flag is separate and applies only to non-interactive prompts.

| Mode | Command | Behavior |
| :--- | :--- | :--- |
| **`off`** *(Default)* | `/auto-approve off` | Shell commands prompt for interactive confirmation. Valid local workspace edits can apply without a prompt; file tools have separate boundary and authorization checks. |
| **`advisory`** | `/auto-approve advisory` | Prompts before each command and shows a safety explanation. |
| **`auto`** | `/auto-approve auto` | Approves commands classified as safe, such as read-only commands and workspace edits. Commands classified as risky still require approval. |
| **`unattended`** | `/auto-approve unattended` | Never asks you. A request the reviewer approves runs as in `auto`; anything else is refused to the agent with the reason, and the agent continues. Repeated refusals end the turn. See [Unattended mode](#unattended-mode). |
| **`always`** | `/auto-approve always` | Disables the shell sandbox and skips tool approval prompts. `ask_user` can still ask questions. Use only in an isolated, disposable environment. |

> **Sandbox Interaction:** `always` and `sandbox.enabled` are mutually exclusive: selecting `always` disables the shell sandbox, and enabling the sandbox (`/sandbox` or `sandbox.enabled = true`) immediately demotes `always` to `auto`.

## Unattended mode

`unattended` is for runs nobody is watching. The reviewer's approval threshold is the same as in `auto`; what changes is where a request goes when the reviewer does not approve it.

- **Refused, not asked.** The request is closed and the agent receives a refusal as the tool's result: what was refused, why (the reviewer's reasoning, or that the review was unavailable), and an instruction to try a different approach. It is recorded in the conversation as refused by policy.
- **Refused without a review:** running a command outside the sandbox, Docker host control, retrying a read the sandbox denied, anything that needs an explicit answer from you, tools the reviewer is not allowed to grant (such as `propose_goal`), and run budget check-ins. To let the reviewer decide sandbox escapes as in `auto`, set `shell.unattendedEscapeReview` to `true`.
- **Questions still ask.** In an interactive session `ask_user` still waits for your answer; a non-interactive run stops on a question as before.
- **Refusal limit.** Three refusals in a row, or ten in one turn, end the turn without another model request. The turn's final output lists every refusal and its reason; a non-interactive run exits with code 2. A command that runs between refusals resets the "in a row" count. Each background task has its own count.

What unattended does not defend:

- **The reviewer is a model, not a security boundary.** It catches mistakes; it can be wrong, and it reads text the agent, a web page, or a file can write. Published results for comparable reviewers miss a meaningful share of overeager or injected actions.
- **Without the sandbox, the reviewer is the only layer.** With `sandbox.enabled` off, the sandbox unavailable, or an SSH workspace, every shell command goes to the reviewer, and whatever it approves runs with your permissions.
- **Network hosts.** The reviewer may approve a network destination. Content the agent read could steer it into sending workspace files, a `.env` included, to an approved host. The sandbox's credential denials cover paths under your home directory, not files in the workspace.
- **An agent working against its reviewer** is not something unattended tries to stop.

## Manage a long run

Run budgets can warn or pause a run based on cost, time, tokens, or signs of a stall. By default they warn rather than enforce a hard cap. Configure `agent.runBudget.escalation` if you want a pause instead, and review the thresholds below before relying on them.

## Run Budgets (`agent.runBudget`)

Run budgets track spending, unpriced tokens, active time, and stall evidence. The default escalation is `warn`: these thresholds are advisory, not hard spending or execution caps.

- **Spending Cap (`agent.runBudget.maxUsdMicros`)**: Total priced API cost ceiling for a run (default: `$5.00` / `5,000,000` micros).
- **Token Cap (`agent.runBudget.maxUnpricedTokens`)**: Unpriced token ceiling (default: `5,000,000` tokens).
- **Active Time Cap (`agent.runBudget.maxActiveTimeMs`)**: Active execution time ceiling, excluding user idle wait time (default: 1 hour / `3,600,000` ms).
- **Turn Backstop (`agent.runBudget.turnBackstop`)**: High turn-count safeguard to detect looping subagents (default: 150 turns).
- **Budget Escalation (`agent.runBudget.escalation`)**: `warn` (default) reports advisory evidence. `contain` pauses at exhaustion while warning and stall evidence remain advisory. `pause` also stops on warning/stall evidence. `disabled` emits no budget evidence.

In non-interactive runs, a budget check-in exits with code 2 and a resume hint. `--auto-approve` approves tools only; it never grants budget extensions. With `--json`, the pause is reported as `run_budget_paused`.
