---
title: Non-Interactive Mode
description: Using term2 in scripts, automated pipelines, and CI/CD.
---

When you provide a prompt argument on the command line, term2 executes non-interactively without launching the terminal UI:

```bash
term2 [options] [prompt...]
```

## Basic Non-Interactive Queries

Execute one-off queries with stdout output:

```bash
term2 "Explain the purpose of package.json in this project"
```

A positional prompt without `--auto-approve` uses `builtin:lite` by default (unless a persisted Mentor or Orchestrator profile takes precedence), so tools are unavailable. `--auto-approve` opts out of that implicit Lite selection and enables tools. It applies GREEN/YELLOW heuristic policy; it is not the same as `/auto-approve always`, and RED shell commands are still refused.

The output streams directly to standard output. Non-error diagnostic logs are printed to standard error.

## Enabling Tool Execution (`--auto-approve`)

To permit the agent to run tools (such as reading files, writing changes, or executing commands), pass `--auto-approve`:

```bash
term2 --auto-approve "Run pnpm typecheck and fix any trivial lint errors"
```

## Output Formatting & Scripting

### Quiet Mode (`-q`, `--quiet`)

Suppress non-error diagnostics on stderr to cleanly capture tool output in shell variables:

```bash
TODO_LIST=$(term2 -q "List all TODO comments in source/")
```

### JSON Mode (`--json`)

Emit newline-delimited JSON (NDJSON) events on standard output for machine consumption:

```bash
term2 --json "Find potential security issues in auth.ts"
```

The conversation event stream can emit these `type` values: `approval_required`, `background_check_in_due`, `background_shell_completed`, `background_shell_output`, `background_shell_started`, `codex_rate_limits`, `command_message`, `context_compaction_completed`, `context_compaction_failed`, `context_compaction_started`, `cost_update`, `error`, `final`, `reasoning_delta`, `retry`, `retry_exhausted`, `run_budget`, `subagent_approval_required`, `subagent_command_message`, `subagent_completed`, `subagent_interrupted`, `subagent_question`, `subagent_run_budget`, `subagent_started`, `subagent_streaming_text`, `subagent_streaming_tool`, `subagent_text_turn`, `subagent_tool_started`, `subagent_transferred`, `text_delta`, `tool_call_streaming_delta`, `tool_dispatched`, `tool_recovery`, `tool_started`, `usage_update`, and `user_message_consumed_for_abort`. Non-interactive JSON also emits `approval_rejected` for a refusal and `completed` after success.

### Streaming Reasoning Deltas (`--show-reasoning`)

Stream thinking/reasoning deltas from reasoning-capable models (e.g. o1, o3, Grok, Claude with thinking) to standard error:

```bash
term2 --show-reasoning "Solve this mathematical recurrence relation"
```

### Lightweight Non-Interactive Execution (`--lite`)

Run in lite mode without indexing the workspace codebase, ideal for quick terminal calculations, log analysis, or system commands:

```bash
term2 --lite "Show the top 5 largest directories under /var/log"
```
