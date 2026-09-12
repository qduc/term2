---
title: Agent Tools
description: Built-in tools for file management, shell execution, code context, and sandboxed code running.
---

term2 exposes a controlled set of tools to the agent, gated by the active profile and sandbox policies.

## Filesystem Tools

- **`read_file`**: Reads file contents with support for line-number ranges (`offset` and `limit`) and size bounds.
- **`apply_patch`**: Applies unified patches to files with preview and self-healing syntax recovery.
- **`search_replace`**: Performs precise contiguous block replacements within a file.
- **`create_file`**: Creates a new file in the workspace (or overwrites an existing file if explicitly approved).
- **`find_files`**: Finds files and directories using glob patterns (leveraging `fd` when installed).
- **`grep`**: Performs regex or literal text searches across files (leveraging `ripgrep` when installed).
- **`read_code_outline`**: Generates high-level symbol outlines (classes, functions, interfaces) for rapid file comprehension.
- **`code_context_search`**: Searches code symbols and definitions across the codebase.

## Shell Execution

- **`shell`**: Executes shell commands within the active sandbox policy. Commands that read or write outside approved boundaries prompt for explicit confirmation.
- **Background Shell Jobs**: Long-running commands can run detached in the background:
  - `shell_job_status`: Check running state, exit codes, and output byte counts.
  - `shell_job_output`: Stream or fetch buffered output logs.
  - `shell_job_kill`: Terminate background jobs gracefully or forcefully.

## Sandboxed JavaScript Execution (`run_code`)

- **`run_code`**: Executes JavaScript in a sandboxed V8 context directly inside the Node.js process.
- **Nested Tool Invocation**: Inside a `run_code` script, the agent can call other exposed tools programmatically via `await tools.<toolName>(args)`.
- **Approval Policy**: Nested tool calls within `run_code` are automatically evaluated by the policy registry: auto-approved read operations execute seamlessly, while mutating calls require confirmation.
- **Realm Isolation**: The host context enforces strict realm boundaries so scripts cannot escape into process or environment globals.

## User & Advisory Tools

- **`ask_user`**: Asks clarifying questions to the user with an interactive prompt and selectable choices.
- **`ask_mentor`**: Consults the higher-tier mentor model for architectural guidance or code review.
- **`activate_skill`**: Loads specialized instruction sets and workflows for domain-specific tasks.
