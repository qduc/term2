---
title: Remote Development (SSH)
description: Connecting term2 directly to remote servers over SSH.
---

Use the local term2 interface to run commands and edit files on a remote host over SSH.

## Launching an SSH Session

```bash
# Connect to remote host with required remote working directory
term2 --ssh user@hostname --remote-dir /path/to/remote/project

# Specify custom SSH port (default: 22)
term2 --ssh user@hostname --remote-dir /path/to/project --ssh-port 2222
```

## Requirements & Behavior

- **Authentication**: Uses your local running SSH agent (`ssh-agent`) with loaded keys (`ssh-add`), or identity keys defined in your local `~/.ssh/config`.
- Use `--remote-dir` to set the working directory on the remote host. A full codebase session requires it.
- **Background Execution**: Background shell job execution is restricted to local workspaces; SSH sessions run synchronously.
- **Safety**: The remote session respects file boundaries and prompts for tool approvals on the local controller before modifying remote files.
