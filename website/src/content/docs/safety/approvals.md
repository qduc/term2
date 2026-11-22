---
title: Approvals & Run Budgets
description: Interactive tool approvals, auto-approve modes, and execution budgets.
---

When term2 wants to run a shell command in an interactive session, it normally asks for your approval. Read the proposed action and choose from the options in the prompt. Valid edits inside the local workspace can apply without a prompt; file tools have their own authorization and boundary checks.

Choose the approval policy with `/auto-approve` or `shell.autoApproveMode`. The four modes decide who can grant permission and what happens when the reviewer does not approve. They do not change `sandbox.enabled`.

## Auto-Approval Modes (`/auto-approve`)

| Mode | Reviewer | When permission is still needed |
| :--- | :--- | :--- |
| **`off`** *(Default)* | No automatic approval. | Ask a person. |
| **`auto`** | Approves eligible requests that pass the existing safety assessment. | Ask a person. |
| **`unattended`** | Uses the same approval threshold as `auto`. | Refuse the request to the agent; repeated refusals end the run. |
| **`always`** | No model review; bypasses eligible permission prompts. | Questions and human-only decisions still ask. Unsupported sandbox escapes remain restricted. |

Use `/auto-approve off`, `/auto-approve auto`, `/auto-approve unattended`, or `/auto-approve always`. Valid local workspace edits can apply without a prompt; file tools have separate authorization and boundary checks. A passing automatic review requires low or medium assessed risk, explicit or implied authorization, and high confidence.

`shell.showReview` is a separate setting, off by default. Enable it to show the assessment when a person must decide. With `off`, it also requests an advisory assessment for eligible requests, which cannot approve them. In `auto` and `unattended`, hiding the assessment does not disable the reviewer or remove recorded review evidence. Saved `advisory` settings migrate to `off` with `shell.showReview = true`; new commands must use the four modes above.

The CLI options `--approval-mode` and `--show-review` select these settings separately. For a non-interactive prompt, the existing `--auto-approve` boolean is a separate execution option; see [non-interactive use](/term2/using-term2/non-interactive/).

**Sandbox and approvals are independent.** Switching approval modes preserves your sandbox preference, including in `always`. With the sandbox enabled, `always` can grant an eligible one-time network destination or supported foreground sandbox escape without a model review; it uses the request's scoped grant rather than disabling the sandbox. Background and Docker host-control escapes remain unsupported. Questions, explicit-user decisions such as `propose_goal`, and hard-gated requests that reach the approval router still require a person (or are refused in `unattended`). Use `always` only where you accept its broad permission grants.

**Some writes always need you, in every mode.** A file-tool write to a Term2 hook (`.term2/hooks`), Term2's own settings or credentials, the project's remembered sandbox read grants (`.term2/sandbox-allow-paths.json`), or the repository's git hooks or git config (`.git/hooks`, `.git/config`, `config.worktree`, and the same files of submodules) changes who checks the agent's work. Term2 asks you about these even in `always`, never lets the reviewer approve them, and refuses them in headless runs and `unattended`, `--auto-approve` included. With the sandbox on, shell commands cannot write anything under the project's `.term2` (use the file tools for skills there) or `.git/hooks`; `.git/config` stays writable from the sandbox so that git can record branch upstreams. Not covered: shell commands with the sandbox off, SSH sessions, and hook directories set by `core.hooksPath` such as `.husky`.

## Unattended mode

`unattended` is for runs nobody is watching. The reviewer's approval threshold is the same as in `auto`; what changes is where a request goes when the reviewer does not approve it.

- **Refused, not asked.** The request is closed and the agent receives a refusal as the tool's result: what was refused, why (the reviewer's reasoning, or that the review was unavailable), and an instruction to try a different approach. It is recorded in the conversation as refused by policy.
- **Refused without a review:** running a command outside the sandbox while the sandbox is on and available, Docker host control, writes to hooks, Term2's settings or git's hooks and config, retrying a read the sandbox denied, anything that needs an explicit answer from you, tools the reviewer is not allowed to grant (such as `propose_goal`), and run budget check-ins. To let the reviewer decide sandbox escapes as in `auto`, set `shell.unattendedEscapeReview` to `true`.
- **Questions still ask.** In an interactive session `ask_user` still waits for your answer; a non-interactive run stops on a question as before.
- **Refusal limit.** Three refusals in a row, or ten in one turn or task, stop that run before its next model request. The turn's final output lists every refusal and its reason. A non-interactive foreground run exits with code 2. A tool execution that finishes between refusals resets the consecutive count. A `run_code` script that contained a refusal preserves the streak. Each background task tracks its own refusals.

### Workspace snapshot

Before an unattended turn's first model request, and so before any of its tool calls, term2 records the workspace in a private snapshot repository of its own, kept under term2's state directory (`~/.local/state/term2-nodejs/workspace-snapshots/` on Linux) rather than in your project. The snapshot holds every file git does not ignore: tracked, staged, modified and untracked. Nothing in your project changes: no branch, ref, index entry, stash entry or object is added, and nothing appears in `git status` or `git log --all`. In a git project, the snapshot repository reads the project's own object store, so files that are already committed are not stored twice. A folder that is not a git repository gets a snapshot too, and no `.git` is created in it.

When the turn ends, its output names the snapshot, lists the changed files in your workspace directory, and prints a Bash command that restores modified and deleted files to their pre-turn contents. Stop other activity in the workspace before running it. The command leaves newly created files in place and stops if a directory or parent path blocks a restore. It leaves your Git index and submodule working trees alone. Existing files marked `assume-unchanged` or `skip-worktree` are recorded as they are on disk, including local edits.

Snapshot capture skips SSH workspaces and worktrees that contain Term2's state directory. It also skips capture when new and changed files exceed 256 MiB, a Git step fails or takes longer than 30 seconds, or capture exceeds 60 seconds. The turn continues and reports the reason at the end. The changed-file listing has the same size bound and a 10-second limit per Git step. If listing fails, the turn still prints the restore command. Term2 keeps the 20 newest snapshots per workspace and lets Git reclaim older data. Snapshot repositories for retired workspaces remain in the state directory. The snapshot repository sits outside the sandbox's writable paths. With the sandbox disabled, a command can remove it.

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
