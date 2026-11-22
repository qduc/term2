---
title: Non-Interactive Mode
description: Using term2 in scripts, automated pipelines, and CI/CD.
---

When you provide a prompt argument on the command line, term2 executes non-interactively without launching the terminal UI:

```bash
term2 [options] [prompt...]
```

## Basic Non-Interactive Queries

Pass a prompt as a command-line argument.

```bash
term2 "Explain the purpose of package.json in this project"
```

Tool execution requires the separate `--auto-approve` boolean. `--approval-mode` selects `off`, `auto`, `unattended`, or `always`; `--show-review` controls assessment display. Neither flag replaces `--auto-approve`. With execution enabled, `auto` and `unattended` use the shared reviewer; `unattended` refuses unresolved permission requests. Requests that still need permission use the non-interactive fallback policy; this is separate from the approval-mode reviewer. `always` bypasses eligible permission prompts without model review while preserving your sandbox preference. See [approvals](/term2/safety/approvals/) for human-only decisions and unsupported escapes.

Replies stream to stdout. Diagnostic logs go to stderr.

## Enabling Tool Execution (`--auto-approve`)

To permit the agent to run tools (such as reading files, writing changes, or executing commands), pass `--auto-approve`:

```bash
term2 --auto-approve "Run pnpm typecheck and fix any trivial lint errors"
```

## Output Formatting & Scripting

### Quiet Mode (`-q`, `--quiet`)

Use `-q` to suppress non-error diagnostics on stderr.

```bash
SUMMARY=$(term2 -q "Explain what a TODO comment is")
```

### JSON Mode (`--json`)

Use `--json` to write one JSON event per line to stdout.

```bash
term2 --json "Explain common authentication security risks"
```

The conversation event stream can emit these `type` values: `approval_required`, `background_check_in_due`, `background_shell_completed`, `background_shell_output`, `background_shell_started`, `codex_rate_limits`, `command_message`, `context_compaction_completed`, `context_compaction_failed`, `context_compaction_started`, `cost_update`, `error`, `final`, `reasoning_delta`, `retry`, `retry_exhausted`, `run_budget`, `subagent_approval_required`, `subagent_command_message`, `subagent_completed`, `subagent_interrupted`, `subagent_question`, `subagent_retry`, `subagent_run_budget`, `subagent_started`, `subagent_streaming_text`, `subagent_streaming_tool`, `subagent_text_turn`, `subagent_tool_started`, `subagent_transferred`, `subagent_usage_update`, `text_delta`, `tool_call_streaming_delta`, `tool_dispatched`, `tool_recovery`, `tool_started`, `usage_update`, and `user_message_consumed_for_abort`. Non-interactive JSON also emits `approval_rejected` for a refusal and `completed` after success.

A failed turn still emits `final` before its `error`, so its `usage` and `costRecords` stay readable, but it carries no answer: `finalText` is empty and `turnItems` hold only accepted items, not text a step streamed before it failed. Text a stream delivered before it was cut off arrives only as `text_delta` events; it is never presented as the answer.

The headless run emits a `run_summary` record (version `1`) with `sessionId` and `outcome`. On success it precedes the final `completed` record; on other reported outcomes it is the last record. The summary covers the turns driven by that run, including observed subagent request spend, rather than the entire resumed session. It includes `turnIds`, `cost`, `requests`, `tokens`, `cacheHitRatio`, `contextGrowth`, `agents`, and `tools`. Costs use recorded pricing and may be partial or unknown; token values can be `null` when usage was not reported. For more than 64 root non-compaction requests, `contextGrowth.inputTokens` is omitted while the aggregate fields remain.

Summary measurement does not change the run outcome. If measurement fails, the record instead contains `type`, `version`, `sessionId`, `outcome`, and `error`, without partial measurements. A failure before the headless run starts may not produce a summary.

### Streaming Reasoning Deltas (`--show-reasoning`)

Stream thinking/reasoning deltas from reasoning-capable models (e.g. o1, o3, Grok, Claude with thinking) to standard error:

```bash
term2 --show-reasoning "Solve this mathematical recurrence relation"
```

### Default Execution

A headless session loads project instructions and can use the shell and `run_code` when you pass `--auto-approve`.

```bash
term2 "Explain the difference between disk usage and apparent file size"
```

## Pauses and Exit Codes

- **0**: Successful completion.
- **1**: Failure. A tool refusal can still be followed by successful completion; inspect stderr or JSON `approval_rejected` rather than relying only on the exit code.
- **2**: A recoverable context-limit or run-budget pause. Completed work and session history are retained; use the printed `--resume <session>` hint after reviewing the limit.

With `--json`, context-limit pauses emit `context_paused` with a `code` of `request_input_limit`, `context_compaction_hard_fit`, or `provider_context_overflow`. Budget check-ins emit `run_budget_paused`, including budget evidence and recovery guidance. `--auto-approve` never grants more run budget. The default budget escalation, `warn`, remains advisory.
