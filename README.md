# term2

[![npm version](https://img.shields.io/npm/v/@qduc/term2.svg?style=flat-square)](https://www.npmjs.com/package/@qduc/term2)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg?style=flat-square)](https://www.typescriptlang.org/)

term2 is an open-source terminal AI assistant and autonomous agent runtime built for high-velocity software engineering and system administration.

Combining a fast React (Ink) terminal interface with an application-owned run loop, term2 provides fine-grained execution safety, native multi-agent delegation, provider-neutral context compaction, and seamless multi-provider support—giving developers complete agency over their workflow without vendor lock-in or subscription gates.

---

## Core Capabilities

- **Open Source and Local First**: MIT licensed. No mandatory subscriptions, telemetry lock-in, or proprietary walled gardens.
- **Universal Provider Support**: Native integration with OpenAI (WebSocket Responses and Chat Completions), ChatGPT/Codex OAuth (browser PKCE), Grok Responses API (with encrypted reasoning and OAuth), OpenRouter, Anthropic, Google Gemini, and custom local endpoints (Ollama, llama.cpp, vLLM).
- **Fine-Grained Sandboxing and Safety**: Sandboxed shell execution with configurable read/write boundaries (`standard`, `strict`) and interactive unified diff previews.
- **Smart Shell Auto-Approval**: A hybrid heuristic and LLM safety evaluator that auto-approves safe read-only and workspace commands, eliminating prompt fatigue while strictly gating risky operations.
- **Multi-Agent Orchestration**: Spawn specialized foreground or background subagents (`explorer`, `worker`, `mentor`, `librarian`) across tiered model profiles (`smart`, `balanced`, `cheap`, `chore`).
- **Provider-Neutral Context Compaction**: Intelligently compacts long conversation histories (via `/compact` or automatic thresholds) while preserving cold-prefix architectural facts and hot-tail tool ledger integrity.
- **Time-Travel Rewind and Forking**: Non-destructive conversation rewinding with discard previews (`/rewind`, `/undo`, `/retry`), session resumption (`/resume`, `--resume`), and session branching (`--fork`).
- **Native Remote Development**: Execute commands and manage codebases on remote servers seamlessly over SSH with SSH agent authentication.
- **Five Focused Operating Modes**: Standard, Plan, Lite, Mentor, and Orchestrator modes adapted to every phase of engineering.

---

## Comparison: Why term2?

| Feature | term2 | Claude Code | Warp |
| :--- | :---: | :---: | :---: |
| **License** | **MIT Open Source** | Proprietary | Proprietary / Closed Core |
| **Cost** | **Direct API / Pay-per-use** | Subscription / API | Freemium / Paid Tiers |
| **Model Ecosystem** | **Any** (OpenAI, Codex, Grok, OpenRouter, Anthropic, Google, Local) | Anthropic only | Selected Cloud Models |
| **OAuth Browser Login** | **Grok and Codex PKCE** | No | No |
| **Local LLMs (Ollama/llama.cpp)** | **Native** | No | Partial (BYOLLM) |
| **Subagent Swarms** | **Configurable 4-Tier Roles** | Limited | No |
| **Remote SSH Workspaces** | **Native SSH Agent** | Remote Control | SSH Client |
| **Dual-Model Mentor Mode** | **Built-in** | No | No |
| **Context Compaction** | **Local and Provider-Native** | Automatic (Closed) | No |

---

## Installation

### Prerequisites
- Node.js version 20.0.0 or higher
- An API key or OAuth account for your preferred AI provider

### Install via Package Manager
```bash
# Install globally via npm
npm install --global @qduc/term2

# Or using pnpm
pnpm add --global @qduc/term2
```

### Quick Setup

#### 1. OAuth Browser Login (Grok or Codex)
term2 supports browser-based PKCE OAuth logins for OpenAI Codex/ChatGPT and xAI Grok:
```bash
# Log in to xAI Grok
term2 --grok-login

# Log in to OpenAI Codex / ChatGPT
term2 --codex-login
```

> **Multi-Account Management**: Manage multiple OAuth accounts and switch between active profiles at runtime via the `/providers` menu.

#### 2. Environment Variables (API Keys)
Alternatively, export the API key for your chosen provider:
```bash
# OpenAI
export OPENAI_API_KEY="sk-..."

# OpenRouter (Claude, Gemini, DeepSeek, etc.)
export OPENROUTER_API_KEY="sk-or-v1-..."

# Anthropic
export ANTHROPIC_API_KEY="sk-ant-..."

# Google Gemini
export GOOGLE_GENERATIVE_AI_API_KEY="..."

# Web Search (Tavily or Exa)
export TAVILY_API_KEY="tvly-..."
export EXA_API_KEY="..."
```

---

## Quick Start

Launch term2 in your project directory:

```bash
# Start standard interactive session
term2

# Start in lightweight mode (fast system/terminal operations, no codebase ingestion)
term2 --lite

# Start with a specific model and provider
term2 -m claude-sonnet-4.6 -p openrouter

# Resume the last conversation session
term2 --resume

# Run a non-interactive prompt from the command line
term2 "Explain the architecture of source/agent.ts"
```

---

## Operating Modes

term2 features five distinct operating modes tailored to different stages of development:

| Mode | Trigger / CLI | Purpose and Behavior | Tools and Context |
| :--- | :--- | :--- | :--- |
| **Standard** | `term2` *(default)* | High-velocity codebase development. Automatically approves workspace file patches while gating destructive commands. | Full codebase context, all tools, patch auto-approval. |
| **Plan** | `/plan` or `Shift+Tab` | Architecture design, research, and code exploration. Enforces read-only safety guarantees (no file writes or mutating commands). | Full codebase context, read-only tools. |
| **Lite** | `term2 --lite` or `/lite` | General terminal tasks, DevOps, and SSH administration without codebase ingestion overhead. | Session context only, read-only system tools. |
| **Mentor** | `/mentor` | Collaborative problem-solving. Pairs the primary model with a higher-tier strategic model (`smartModel`) for architectural review. | Full codebase context, all tools and `ask_mentor`. |
| **Orchestrator** | `/orchestrator` | High-level task coordination. Encourages prompt-guided delegation across specialized subagents while retaining end-to-end turn ownership. | Full codebase context, direct tools and subagent delegation. |

> **Mode Switching:** Press `Shift+Tab` to cycle the application's operating modes. To run one direct shell command in any operating mode, prefix the input with `!`; the command and output are added to the conversation, then the input returns to normal mode. Use slash commands (`/plan`, `/lite`, `/mentor`, `/orchestrator`) to switch modes explicitly.

---

## Subagents Architecture

term2 includes a modular subagent execution system designed to isolate heavy computational, research, or modification workloads from the main conversation transcript. Each subagent operates under a defined role profile with explicit permissions, execution budgets, and capability tiers.

### Explorer Subagent
- **Purpose**: Rapid codebase reconnaissance, symbol search, file discovery, and dependency mapping.
- **Permissions**: Read-only (`canRead: true`, `canWrite: false`, `canSearchWeb: true`, `canRunShell: true`).
- **Safety Boundary**: Restricted to non-destructive read operations and safe read-only shell commands (`rg`, `fd`, `git status`).
- **Model Tier**: Defaults to `agent.cheapModel` (e.g. `gpt-5.4-mini`) to minimize latency and token consumption during wide search operations.

### Worker Subagent
- **Purpose**: Autonomous implementation of discrete tasks, file modifications, refactoring slices, and running automated test suites.
- **Permissions**: Full read/write (`canRead: true`, `canWrite: true`, `canSearchWeb: false`, `canRunShell: true`).
- **Safety Boundary**: Sandboxed to the workspace root directory. Supports pinning execution to a dedicated Git worktree (`worktree` parameter) to isolate dirty state from the parent checkout.
- **Model Tier**: Defaults to `agent.balancedModel` (e.g. `gpt-5.3-codex` or `claude-sonnet-4.6`).

### Mentor Subagent
- **Purpose**: High-level strategic consultation, algorithmic design analysis, and independent second-opinion code review.
- **Permissions**: Advisory only (`canRead: false`, `canWrite: false`, `canSearchWeb: false`, `canRunShell: false`).
- **Safety Boundary**: Completely detached from the workspace filesystem and tool execution. Receives architectural queries via the `ask_mentor` tool and returns structured recommendations without polluting turn history.
- **Model Tier**: Defaults to `agent.smartModel` (e.g. `gpt-5.5`).

### Librarian Subagent
- **Purpose**: Long-term persistent memory management, documentation discovery, and indexing domain knowledge across sessions.
- **Permissions**: Memory management (`canRead: false`, `canWrite: false`, `canSearchWeb: false`, `canRunShell: false`). Interacts with memory exclusively via specialized `memory_*` tools and `activate_skill`.
- **Safety Boundary**: Operates strictly within persistent memory storage without general filesystem, shell, or web access.
- **Model Tier**: Defaults to `agent.cheapModel`.

### Subagent Capability Tiers
Subagent roles are mapped to four configurable model tiers in `settings.json`:
- `agent.smartModel` / `agent.smartProvider` / `agent.smartReasoningEffort`: For deep reasoning and strategic advisory (used by Mentor).
- `agent.balancedModel` / `agent.balancedProvider` / `agent.balancedReasoningEffort`: For implementation, editing, and execution (used by Worker).
- `agent.cheapModel` / `agent.cheapProvider` / `agent.cheapReasoningEffort`: For high-throughput search and discovery (used by Explorer and Librarian).
- `agent.choreModel` / `agent.choreProvider`: For narrow utility tasks such as AST patch self-healing and auto-approval evaluation.

### Background Subagent Management and Lifecycle
- **Concurrent Execution**: Subagents can run synchronously in the foreground or asynchronously in the background.
- **Task Manager (`Ctrl+G`)**: Press `Ctrl+G` to open the Background Task Manager to inspect live running subagents, view stream output, pause runs, or terminate hung jobs.
- **Resource Budgets**: Each subagent run is bounded by an execution turn budget (`maxTurns`) to prevent infinite recursive loops.

### Subagent Check-In and Steering
- **Periodic Check-In**: The `BackgroundCheckInScheduler` periodically wakes the launching agent with status summaries of background work without interrupting active user turns.
- **Mid-Turn Steering**: Deliver real-time steering messages to running subagent tasks at clean request boundaries.
- **Orchestrator Inquiries**: Subagents can query the parent orchestrator for clarifying decisions using the `ask_orchestrator` tool when encountering ambiguity.

---

## Safety, Sandboxing, and Auto-Approval

### Sandboxed Execution
Shell commands execute inside an isolated execution boundary:
- `standard` policy: Restricts file writes to the workspace and temporary directories while blocking reads of sensitive credential paths (`~/.ssh`, `~/.aws`, `~/.docker`, `~/.netrc`, `~/.kube`, etc.).
- `strict` policy: Locks down file reading to the workspace and safe toolchains, blocking access to the user home directory and system roots (`/etc`, `/var`, `/root`).
- Toggle sandbox enforcement anytime using `/sandbox`, or configure policies via `sandbox.readPolicy` in `/settings`.

### Smart Shell Auto-Approval Modes (`/auto-approve`)
- `off` (Default): Every shell command prompts for interactive user confirmation with a unified diff preview.
- `advisory`: Commands require confirmation, but include real-time LLM-generated safety and consequence explanations.
- `auto`: Safe, read-only, and idempotent workspace operations execute automatically; potentially destructive commands (e.g. `rm -rf`, `git reset --hard`, `git push --force`) are strictly blocked for user confirmation.
- `always`: Unattended execution mode. Disables sandbox boundaries (intended for automated CI environments; use with caution).

---

## Context Management and Compaction

### Local and Server-Side Compaction
- **Provider-Neutral Compactor**: When conversation tokens exceed configured ratios or thresholds, term2 performs request-boundary context compaction.
- **Cold-Prefix Preservation**: Architectural decisions, environment constraints, and critical requirements are summarized and retained verbatim.
- **Hot-Tail Invariants**: Recent conversation turns and active tool ledger call/result pairs remain completely intact, preventing broken references.
- **Manual Trigger**: Run `/compact` at any point to compress transcript history immediately.
- **OpenAI Native Compaction**: Leverages server-side context management when supported by the provider endpoint.

---

## Conversation Resumption, Rewind, and Queuing

### Time-Travel Rewind (`/rewind`, `/undo`, `/retry`)
- **Inspection Picker**: Running `/rewind` opens an interactive menu detailing exactly which turns, replies, and modified files will be affected before committing.
- **Disposition Modes**:
  - `edit` (Default / `/undo`): Discards subsequent turns and places the selected user prompt back into the input editor for revision.
  - `resend` (`/retry`): Discards subsequent turns and immediately resends the selected prompt to the model.
- **Tool Retry (`/retry-tool`)**: Retries only the most recent failed or timed-out tool call without losing conversation context.

### Session Persistence and Resumption
- **Persistence Engine**: Sessions are auto-saved using append-only event streams.
- **Resuming Sessions**:
  ```bash
  term2 --resume               # Resume the most recent session
  term2 --resume <session-id>  # Resume a specific session by UUID
  term2 --resume ls            # List recent saved sessions with metadata
  ```
- **Session Branching (`--fork`)**:
  ```bash
  term2 --resume <session-id> --fork
  ```

### Mid-Turn Injection and Prompt Queuing
- **Input Queuing**: Press `Alt+Enter` or `Esc+Enter` to queue additional user instructions while a turn is actively generating.
- **Queue Editing**: Edit or delete pending queued prompts before they are admitted at the next request boundary.

---

## Remote Development over SSH

term2 connects directly to remote hosts over SSH, executing commands and modifying remote files within a remote working directory:

```bash
# Connect to remote server with working directory
term2 --ssh user@hostname --remote-dir /path/to/project

# Custom SSH port
term2 --ssh user@hostname --remote-dir /path/to/project --ssh-port 2222

# Lightweight remote administration without codebase indexing
term2 --ssh user@hostname --lite
```

**Requirements and Behavior**:
- Requires an SSH agent running locally (`ssh-agent`) with loaded keys (`ssh-add`), or configured identity keys in `~/.ssh/config`.
- `--remote-dir` is required for full codebase sessions. In `--lite` mode, omitting `--remote-dir` defaults to the remote user's home directory.
- Background command execution is restricted to local workspaces.

---

## Non-Interactive and Scripting Mode

Execute one-off queries and automation tasks directly from shell scripts:

```bash
# Standard non-interactive query (output prints to stdout)
term2 "Summarize recent commits in this repository"

# Automated task execution with tool approvals enabled
term2 --auto-approve "Fix syntax errors in source/cli.tsx and run typecheck"

# Capture output in shell pipeline
TODO_LIST=$(term2 "List all TODO markers in source/")
```

---

## Reference Guide

### Slash Commands

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `/model` | `[model-name]` | Open model selection menu or switch model directly (`Ctrl+O`). |
| `/effort` | `[effort-level]` | Configure reasoning effort (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`) (`Ctrl+T`). |
| `/plan` | — | Toggle read-only Plan Mode (`Shift+Tab`). |
| `/lite` | — | Toggle lightweight terminal mode. |
| `/mentor` | — | Toggle collaborative Mentor Mode. |
| `/orchestrator` | — | Toggle prompt-guided Orchestrator Mode. |
| `/auto-approve` | `[off\|advisory\|auto\|always]` | Cycle or set shell command auto-approval level. |
| `/sandbox` | — | Toggle shell sandbox isolation on or off. |
| `/compact` | — | Manually trigger context compaction. |
| `/providers` | — | Open interactive provider manager (list, add, edit, remove, switch accounts). |
| `/skills` | `[skill-name]` | Activate a skill for the next request. |
| `/rewind` | `[last\|<turn>] [edit\|resend]` | Rewind conversation history with interactive discard inspection. |
| `/undo` | — | Alias for `/rewind edit` (places target turn back in input box). |
| `/retry` | — | Alias for `/rewind resend` (immediately resends the last user turn). |
| `/retry-tool` | — | Re-execute the last failed or timed-out tool call. |
| `/copy` | `[N]` | Copy the latest assistant response (or $N$-th prior response) to clipboard. |
| `/usage` | — | Display exact token counts, cost breakdown, and provider rate-limit metrics. |
| `/resume` | `[ls\|conversation-id]` | Resume the latest or a specific saved conversation; use `/resume ls` to list recent conversations. |
| `/handoff` | — | Export current conversation context for handoff to another session or model. |
| `/settings` | `[key] [value]` | View or modify runtime configuration settings. |
| `/clear` | — | Clear current conversation history and start a fresh turn. |
| `/quit` | — | Exit term2 session. |

### Keyboard Shortcuts

| Shortcut | Context | Action |
| :--- | :--- | :--- |
| `Ctrl + O` | Input Box | Open interactive model selection menu. |
| `Ctrl + T` | Input Box | Open reasoning effort selection menu. |
| `Ctrl + G` | Global | Open Background Task Manager (inspect/pause/stop tasks). |
| `Shift + Tab` | Global | Cycle Operating Modes. |
| `!` prefix | Input Box | Execute the following command directly in the shell; the red `!` prompt remains active until the command completes. |
| `Alt + Enter` / `Esc + Enter` | Input Box | Queue input while a turn is executing. |
| `Ctrl + R` | Model Menu | Refresh provider model catalog from API. |
| `Ctrl + D` | Settings Menu | Reset highlighted setting to its default value. |
| `Escape` | Input Box | Clear input buffer (when typing). |
| `Double Escape` | Active Turn | Safely interrupt in-flight generation or tool execution. |
| `y` / `n` | Approval Prompt | Single-key approve or reject for tool execution. |
| `Ctrl + C` | Global | Force immediate graceful exit. |

---

## Configuration

Settings are persisted across sessions in `settings.json`:
- **macOS**: `~/Library/Logs/term2-nodejs/settings.json`
- **Linux**: `~/.local/state/term2-nodejs/settings.json` *(or `$XDG_STATE_HOME/term2-nodejs/settings.json`)*
- **Windows**: `%LOCALAPPDATA%\term2-nodejs\Log\settings.json`

### Configuration Example

```json
{
  "agent": {
    "provider": "openai",
    "model": "gpt-5.4",
    "reasoningEffort": "medium",
    "smartModel": "gpt-5.5",
    "smartProvider": "openai",
    "balancedModel": "claude-sonnet-4.6",
    "balancedProvider": "openrouter",
    "cheapModel": "gpt-5.4-mini",
    "choreModel": "gpt-5.4-mini",
    "temperature": 0.7,
    "maxTurns": 100
  },
  "shell": {
    "autoApproveMode": "auto",
    "timeout": 120000,
    "maxParallelToolCalls": 3
  },
  "sandbox": {
    "readPolicy": "standard"
  },
  "webSearch": {
    "provider": "tavily"
  },
  "providers": [
    {
      "name": "Local Ollama",
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:11434/v1"
    },
    {
      "name": "Local llama.cpp",
      "type": "llama.cpp",
      "baseUrl": "http://127.0.0.1:8080/v1"
    }
  ]
}
```

---

## Development and Testing

To set up the development environment from source:

```bash
# 1. Clone repository
git clone https://github.com/qduc/term2.git
cd term2

# 2. Install dependencies (requires pnpm >= 11)
pnpm install

# 3. Start TypeScript compiler in watch mode
pnpm dev

# 4. Run test suites
pnpm test                    # Run Vitest unit tests
pnpm test:lane               # Run deterministic fast-lane tests
pnpm test:provider-black-box # Run provider black-box wire tests
pnpm typecheck               # Run strict type checking
pnpm lint                    # Run ESLint and Prettier checks

# 5. Build for distribution
pnpm build
```

---

## License

This project is licensed under the [MIT License](LICENSE).

---

## Acknowledgments

term2 is built on open-source libraries:
- [Ink](https://github.com/vadimdemedes/ink) — React for interactive command-line apps
- [Vercel AI SDK](https://github.com/vercel/ai) — Multi-provider AI streaming primitives
- [OpenAI Node SDK](https://github.com/openai/openai-node) — OpenAI API transport
- [ssh2](https://github.com/mscdex/ssh2) — SSH2 client for remote server execution
- [Zod](https://github.com/colinhacks/zod) — TypeScript-first schema validation
