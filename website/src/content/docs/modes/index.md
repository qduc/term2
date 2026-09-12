---
title: Operating Modes
description: The five built-in profiles and how to switch between them.
---

term2 features five distinct operating modes (built-in profiles) tailored to different stages of software development and system administration.

## Operating Profiles

| Profile | Activation | Purpose | Observable Capabilities & Restrictions |
| :--- | :--- | :--- | :--- |
| **Standard** | Default (`term2`), `/profile standard` | Primary engineering mode for everyday development. | Full codebase context, file reading and editing, shell execution, subagents. |
| **Plan** | `/plan`, `Shift+Tab`, `/profile plan` | Architecture design, research, and code review. | Read-only operation: file modifications, file creations, and mutating shell commands are prevented. |
| **Lite** | `term2 --lite`, `/lite`, `/profile lite` | Quick terminal operations, DevOps, and administration without codebase ingestion overhead. | Minimal prompt with session context only; codebase indexing, subagents, and mentor tools are disabled. |
| **Mentor** | `/mentor`, `/profile mentor` | Collaborative second-opinion consulting. Pairs primary model with an advisory strategic model. | Full codebase context, all standard development tools plus the `ask_mentor` advisory tool. |
| **Orchestrator** | `/orchestrator`, `/profile orchestrator` | High-level task coordination and multi-agent delegation. | All implementation work is delegated to specialized subagents. |

## Switching Modes

- **Toggling Plan Mode (`Shift+Tab` or `/plan`)**:
  Pressing `Shift+Tab` toggles between Standard mode and Plan mode. In Plan mode, write operations (file editing, file creation, and mutating shell commands) are safely blocked, allowing you to design and explore without risk of unintentional modifications.
- **Switching Profiles (`/profile <name>`)**:
  Run `/profile` followed by the profile name (`standard`, `plan`, `lite`, `mentor`, `orchestrator`) or run bare `/profile` to open the interactive selection menu.
- **Dedicated Slash Commands**:
  - `/plan`: Toggle Plan mode on or off.
  - `/lite`: Toggle Lite mode on or off (switching mid-session requires confirmation or `/clear` to reset context).
  - `/mentor`: Toggle Mentor mode on or off.
  - `/orchestrator`: Toggle Orchestrator mode on or off.

## Plan Mode Restrictions

When Plan mode is active:
- **Read-Only Operation**: File edits, file creations, and workspace mutations are disabled.
- **Safe Command Execution**: Only read-only inspection commands (such as directory listings, search, and status checks) are permitted; destructive or mutating shell commands are blocked.
- **Structured Planning**: The agent focuses on reading code, gathering context, and outlining architecture plans or implementation steps for your review before you switch back to Standard mode to execute them.

## Profile Identifiers in Configuration (`builtin:`)

When configuring your default profile in `settings.json` via the `app.activeProfileId` setting (or when specifying full identifiers in `/profile <id>`), term2 uses the `builtin:` prefixed profile identifier:

| Profile Name | Configuration Identifier (`app.activeProfileId`) |
| :--- | :--- |
| **Standard** | `builtin:standard` (default) |
| **Plan** | `builtin:plan` |
| **Lite** | `builtin:lite` |
| **Mentor** | `builtin:mentor` |
| **Orchestrator** | `builtin:orchestrator` |

Everyday CLI flags and slash commands (`/profile standard`, `/plan`, `--lite`) accept the short visible profile names directly.
