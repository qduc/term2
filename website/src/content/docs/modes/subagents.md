---
title: Subagents
description: Subagent roles, model settings, and background tasks.
---

The assistant can delegate parts of a task to subagents, each in a separate conversation. Ask for the work you want done and describe any boundaries. For example:

> Use subagents to investigate the login failure and review the proposed fix. Keep the investigation read-only.

The assistant chooses how to delegate. An explorer can investigate without editing files; a worker can edit and run tests. Review the results and any file changes as you normally would. Tool approvals and workspace boundaries still apply.

<a id="background-task-manager-ctrlg"></a>

## Follow or stop a task

Press `Ctrl+G` to open the Background Task Manager. Select a task with the arrow keys and press `Enter` to inspect its output. To move a foreground task to the background, select it and press `b` then `Enter`; to request that a running background task stop, press `x` then `Enter`. Close the manager with `Ctrl+G` or `Escape`.

<a id="background-check-ins"></a>

term2 checks background tasks periodically and notifies the parent agent when one finishes or needs input.

## Choose models for delegated work

Use `/settings` to configure the model and provider tiers described below. The role determines which tier and permissions a subagent receives.

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
- **`agent.choreModel` / `agent.choreProvider`**: Narrow utility model for auto-approval evaluation.

Pool values are configured in the settings UI or as arrays in the corresponding tier settings. Non-subagent consumers use the first configured model.
