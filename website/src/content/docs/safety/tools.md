---
title: Agent Tools
description: Built-in tools for file management, shell execution, code context, and sandboxed code running.
---

term2 exposes a controlled set of tools to the agent, gated by the active profile and sandbox policies.

## Filesystem Tools

- **`read_file`**: Reads file contents with support for line-number ranges (`start_line` and `end_line`, inclusive and 1-based) and size bounds.
- **`apply_patch`**: Applies unified patches to files with preview and self-healing syntax recovery.
- **`search_replace`**: Performs precise contiguous block replacements within a file.
- **`create_file`**: Creates a new file in the workspace (or overwrites an existing file if explicitly approved).
- **`glob`**: Finds files and directories using glob patterns (leveraging `fd` when installed).
- **`grep`**: Performs regex or literal text searches across files (leveraging `ripgrep` when installed).
- **`read_code_outline`**: Generates high-level symbol outlines (classes, functions, interfaces) for rapid file comprehension.
- **`code_context_search`**: Searches code symbols and definitions across the codebase.

## Shell Execution

- **`shell`**: Executes shell commands within the active sandbox policy. Commands that read or write outside approved boundaries prompt for explicit confirmation.
- **Background Shell Jobs**: Long-running commands can run detached in the background:
  - `get_shell_job`: Check running state, exit codes, and output byte counts.
  - `monitor_shell_job`: Attach an output watch that delivers matching lines as notifications.
  - `cancel_shell_job`: Terminate background jobs gracefully or forcefully.
  - `cancel_shell_monitor`: Stop an output watch.

## Sandboxed JavaScript Execution (`run_code`)

- **`run_code`**: Executes JavaScript in a sandboxed V8 context directly inside the Node.js process.
- **Nested Tool Invocation**: Inside a `run_code` script, the agent can call other tools programmatically via `await tools.<toolName>(args)`.
- **Tool Approvals in Code**: Nested read-only tool calls run automatically, while actions requiring approval prompt the user before continuing.
- **Script Isolation**: Scripts execute in an isolated environment without access to process globals or host credentials.
- **Nested Shell Commands**: Scripts can invoke `tools.shell` with the same sandbox constraints, approvals, timeouts, and job tracking as top-level shell calls.
- **JSON Inputs**: Pass structured data separately from the script source with the `inputs` parameter; values are available through the script's `inputs` binding.
- **Result Contracts**: Every scriptable tool declares its scripted return contract. Compact entries include return-shape guidance, and `tools.describe` exposes the full contract before invocation.
- **Nested Trace**: Tool calls made by a script are shown in the conversation and remain subject to the active approval policy.

## User & Advisory Tools

- **`ask_user`**: Asks clarifying questions to the user with an interactive prompt and selectable choices.
- **`ask_mentor`**: Consults the higher-tier mentor model for architectural guidance or code review.
- **`activate_skill`**: Loads specialized instruction sets and workflows for domain-specific tasks.

## Web Research

- **`web_search`**: Search the web through the configured Tavily, Exa, Firecrawl, or SearXNG provider.
- **`web_fetch`**: Fetch and extract content from a URL.
