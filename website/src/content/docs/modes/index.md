---
title: Operating Modes
description: The five built-in profiles and how to switch between them.
---

term2 features five distinct operating modes (built-in profiles) tailored to different stages of software development and system administration.

## Built-in Profiles

| Mode | Identifier | Activation | Purpose | Capabilities & Restrictions |
| :--- | :--- | :--- | :--- | :--- |
| **Standard** | `builtin:standard` | Default (`term2`) | Primary engineering mode. High-velocity development with full workspace tool access. | Full codebase context, file read/write, shell execution, subagents. |
| **Plan** | `builtin:plan` | `/plan` or `Shift+Tab` | Architecture design, research, and code review. | Read-only enforcement: mutations and writes are strictly denied at the policy level. |
| **Lite** | `builtin:lite` | `term2 --lite` or `/lite` | General terminal operations, DevOps, and administration without codebase ingestion overhead. | Minimal prompt, session context only; no codebase indexing; subagents and mentor disabled. |
| **Mentor** | `builtin:mentor` | `/mentor` | Collaborative second-opinion consulting. Pairs primary model with an advisory strategic model. | Full codebase context, all standard tools plus the `ask_mentor` advisory tool. |
| **Orchestrator** | `builtin:orchestrator` | `/orchestrator` | High-level task coordination and multi-agent delegation. | All tool-backed implementation work must be delegated to subagents. |

## Switching Modes

- **Toggling Plan Mode (`Shift+Tab` or `/plan`)**:
  Pressing `Shift+Tab` toggles between Standard mode and Plan mode. In Plan mode, write operations (file editing, file creation, mutating shell commands) are blocked by the enforcement policy.
- **Switching Profiles (`/profile <name>`)**:
  Run `/profile` followed by the profile name (`standard`, `plan`, `lite`, `mentor`, `orchestrator`) or run bare `/profile` to open the profile selection menu.
- **Dedicated Slash Commands**:
  - `/plan`: Toggle Plan mode on or off.
  - `/lite`: Toggle Lite mode on or off (switching mid-session requires confirmation or `/clear` to reset context).
  - `/mentor`: Toggle Mentor mode on or off.
  - `/orchestrator`: Toggle Orchestrator mode on or off.

## Profile Architecture

Under the hood, term2 operates on a unified, typed Profile resolver. Each profile defines:
1. **Instructions**: Base model instructions and workflow add-ons.
2. **Context**: Included and excluded context sources (environment, workspace, project instructions, memory, skills).
3. **Tools**: Enabled tool capabilities.
4. **Enforcement Policies**: Hard denials (such as `filesystem-mutation` or `shell-mutation` in Plan mode).
5. **Integrations**: Built-in integrations such as mentor consultation or async subagent delegation.
