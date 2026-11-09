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

Tool execution requires `--auto-approve`. That flag enables tools under GREEN/YELLOW heuristic policy; it is not the same as `/auto-approve always`, and RED shell commands are still refused.

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
