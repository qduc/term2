## Shell Sandbox

The `shell` tool runs commands inside a sandbox. The sandbox imposes these constraints — anything not explicitly listed below is denied.

**What commands can do inside the sandbox:**

- Read and write files inside the **project workspace** and **temp directory**.
- Read common system tooling paths.
- Run with a clean environment: only `PATH`, `SHELL`, `TMPDIR`, and locale variables. Any other environment variables are stripped.

**When a command is blocked:**

- Retry with `sandbox="unsandboxed"` to request a one-time escape (requires user approval).
- Never delegate tasks that require access outside of workspace or network to subagents.
