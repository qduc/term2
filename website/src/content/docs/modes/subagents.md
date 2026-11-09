---
title: Subagents
description: Subagent roles, model settings, and background tasks.
---

The assistant can delegate work to subagents. Each subagent runs in a separate conversation.

## Subagent Roles

The role sets the subagent’s default model and tool permissions.

### 1. Explorer
- **Purpose**: Find files and symbols, and trace dependencies.
- **Permissions**: Read-only (`canRead: true`, `canWrite: false`, `canSearchWeb: true`, `canRunShell: true`).
- **Safety**: Restricted to read operations and non-destructive shell commands (`rg`, `fd`, `git status`).
- **Default Model Tier**: `agent.cheapModel` (fast and token-efficient).

### 2. Worker
- **Purpose**: Edit files and run tests.
- **Permissions**: Read/Write (`canRead: true`, `canWrite: true`, `canRunShell: true`).
- **Safety**: Sandboxed to the workspace root. Supports Git worktree isolation to keep experimental work separate from the main branch.
- **Default Model Tier**: `agent.balancedModel`.

### 3. Mentor
- **Purpose**: Answer design questions and review code.
- **Permissions**: Advisory only (`canRead: false`, `canWrite: false`, `canRunShell: false`).
- **Safety**: The assistant calls `ask_mentor` to get a recommendation.
- **Default Model Tier**: `agent.smartModel`.

### 4. Librarian
- **Purpose**: Persistent memory management, domain documentation indexing, and cross-session retrieval.
- **Permissions**: Memory tools and skills only. No general filesystem or shell access.
- **Default Model Tier**: `agent.cheapModel`.

### 5. Reviewer
- **Purpose**: Review a change, plan, or design. The reviewer can ask explorers to inspect the code.
- **Permissions**: Delegation is limited to bounded read-only explorers; the reviewer does not edit the workspace.
- **Default Model Tier**: `agent.smartModel`.

## Model Capability Tiers

Subagent roles are mapped to configurable tiers in your settings:

- **`agent.smartModel` / `agent.smartProvider`**: High-reasoning model for complex architecture, mentor advisory, and planning.
- **`agent.balancedModel` / `agent.balancedProvider`**: General implementation model for code writing and edits. Multiple models form a round-robin pool for subagent spawns.
- **`agent.cheapModel` / `agent.cheapProvider`**: Fast, lightweight model for high-volume searches and indexing. Multiple models form a round-robin pool for subagent spawns.
- **`agent.choreModel` / `agent.choreProvider`**: Narrow utility model for patch self-healing and auto-approval evaluation.

Pool values are configured in the settings UI or as arrays in the corresponding tier settings. Non-subagent consumers use the first configured model.

## Background Task Manager (`Ctrl+G`)

Subagents can run in the foreground or background.

- Press `Ctrl+G` to open the Background Task Manager.
- Use `Up` and `Down` arrow keys to browse active and completed tasks.
- Press `Enter` to inspect output streams and execution logs.
- Press `b` + `Enter` on a foreground task to move it to the background.
- Press `x` + `Enter` on a running background task to request a graceful stop.
- Press `Ctrl+G` or `Escape` to close the manager.

## Background Check-Ins

term2 checks background tasks periodically and notifies the parent agent when a task finishes or needs input.
