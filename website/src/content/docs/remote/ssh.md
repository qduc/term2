---
title: Remote Development (SSH)
description: Connecting term2 directly to remote servers over SSH.
---

term2 can connect directly to a remote host over SSH, executing commands and editing files on the remote server while presenting the familiar local terminal user interface.

## Launching an SSH Session

```bash
# Connect to remote host with required remote working directory
term2 --ssh user@hostname --remote-dir /path/to/remote/project

# Specify custom SSH port (default: 22)
term2 --ssh user@hostname --remote-dir /path/to/project --ssh-port 2222

# Lightweight remote administration (no remote codebase indexing)
term2 --ssh user@hostname --lite
```

## Requirements & Behavior

- **Authentication**: Uses your local running SSH agent (`ssh-agent`) with loaded keys (`ssh-add`), or identity keys defined in your local `~/.ssh/config`.
- **Remote Working Directory**:
  - `--remote-dir <path>` is required for full codebase sessions.
  - In `--lite` mode, omitting `--remote-dir` defaults to the remote user's home directory.
- **Background Execution**: Background shell job execution is restricted to local workspaces; SSH sessions run synchronously.
- **Safety**: The remote session respects file boundaries and prompts for tool approvals on the local controller before modifying remote files.
