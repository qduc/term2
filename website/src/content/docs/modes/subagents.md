---
title: Subagent Swarms
description: Multi-agent delegation, specialized roles, model tiers, and background task management.
---

term2 features a modular subagent execution system that isolates computational, search, or modification workloads from the main conversation transcript.

## Subagent Roles

Subagents run under distinct role profiles with explicit permission boundaries and execution limits:

### 1. Explorer
- **Purpose**: Fast codebase reconnaissance, symbol lookup, file discovery, and dependency mapping.
- **Permissions**: Read-only (`canRead: true`, `canWrite: false`, `canSearchWeb: true`, `canRunShell: true`).
- **Safety**: Restricted to read operations and non-destructive shell commands (`rg`, `fd`, `git status`).
- **Default Model Tier**: `agent.cheapModel` (fast and token-efficient).

### 2. Worker
- **Purpose**: Autonomous implementation of discrete tasks, writing file patches, refactoring, and running tests.
- **Permissions**: Read/Write (`canRead: true`, `canWrite: true`, `canRunShell: true`).
- **Safety**: Sandboxed to the workspace root. Supports Git worktree isolation to keep experimental work separate from the main branch.
- **Default Model Tier**: `agent.balancedModel`.

### 3. Mentor
- **Purpose**: High-level architectural consultation and second-opinion code review.
- **Permissions**: Advisory only (`canRead: false`, `canWrite: false`, `canRunShell: false`).
- **Safety**: Receives questions via the `ask_mentor` tool and returns structured recommendations without polluting turn history.
- **Default Model Tier**: `agent.smartModel`.

### 4. Librarian
- **Purpose**: Persistent memory management, domain documentation indexing, and cross-session retrieval.
- **Permissions**: Memory tools and skills only. No general filesystem or shell access.
- **Default Model Tier**: `agent.cheapModel`.

## Model Capability Tiers

Subagent roles are mapped to configurable tiers in your settings:

- **`agent.smartModel` / `agent.smartProvider`**: High-reasoning model for complex architecture, mentor advisory, and planning.
- **`agent.balancedModel` / `agent.balancedProvider`**: General implementation model for code writing and edits.
- **`agent.cheapModel` / `agent.cheapProvider`**: Fast, lightweight model for high-volume searches and indexing.
- **`agent.choreModel` / `agent.choreProvider`**: Narrow utility model for patch self-healing and auto-approval evaluation.

## Background Task Manager (`Ctrl+G`)

Subagents can execute synchronously in the foreground or asynchronously in the background.

- Press `Ctrl+G` to open the Background Task Manager.
- Use `Up` and `Down` arrow keys to browse active and completed tasks.
- Press `Enter` to inspect output streams and execution logs.
- Press `b` + `Enter` on a foreground task to move it to the background.
- Press `x` + `Enter` on a running background task to request a graceful stop.
- Press `Ctrl+G` or `Escape` to close the manager.

## Background Check-Ins

The background check-in scheduler periodically notifies the parent agent when background tasks finish or require input, ensuring you are updated without manual polling.
