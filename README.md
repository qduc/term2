# term2

[![npm version](https://img.shields.io/npm/v/@qduc/term2.svg)](https://www.npmjs.com/package/@qduc/term2)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A powerful terminal-based AI assistant that helps you get things done on your computer through natural conversation.

**Why term2?** Unlike proprietary alternatives, term2 is **open-source (MIT)**, works with **any AI provider** (OpenAI, OpenRouter, local self-hosted, etc.), requires **no subscription**, and uniquely supports **remote server management via SSH** — all while giving you full control over what commands execute on your system.

## Demo

https://github.com/user-attachments/assets/ac960d65-f7c8-453a-9440-91f6397ae842

## Features

- 🎭 **Five Operating Modes** - Standard (full-power, auto-approves patches), Lite (fast & safe), Mentor (expert model advice), Plan (read-only research/planning), and Orchestrator (delegates task execution to subagents)
- 🌍 **Open Source** - MIT licensed, hackable, auditable, community-driven
- 🤖 **Multi-Provider Support** - Works with OpenAI, OpenRouter, OpenAI-compatible APIs, and Vercel AI SDK providers
- 🔒 **Safe Execution** - Every command requires your explicit approval with diff preview
- 🛠️ **Advanced Tools** - Shell execution, file patching, search/replace (with `<...>` gap matching), grep, find files, file reading, file creation, web search, web fetching, code outline & context search, mentor consultation, and subagent invocation
- 👥 **Subagent Delegation** - Spawn specialized, synchronous subagents (`explorer`, `worker`, `researcher`, `mentor`) to perform sub-tasks in parallel while conserving your main context
- ⏪ **Conversation Undo & Rewind** - Undo the last turn or select any past user message to rewind the conversation state back to that point
- 💾 **Conversation Resumption & Persistence** - Saved conversations are persisted using robust event logging and can be resumed later using the `--resume` flag
- 💬 **Slash Commands** - Quick actions like `/clear`, `/quit`, `/model`, `/mentor`, `/lite`, `/copy`, `/auto-approve`, `/plan`, `/undo`, `/usage`, `/effort`, `/handoff`, `/retry`, and `/orchestrator` for easy control
- 📝 **Smart Context** - The assistant understands your environment and provides relevant help
- 🎯 **Streaming Responses** - See the AI's thoughts and reasoning in real-time
- 🧠 **Reasoning Effort Control** - Configurable reasoning levels (minimal to high) for O1/O3 models
- ⚡ **Command History** - Navigate previous inputs with arrow keys
- 🎨 **Markdown Rendering** - Formatted code blocks, tables, and text in the terminal
- 🔄 **Retry Logic** - Automatic recovery from tool hallucinations and upstream errors
- 🌐 **SSH Mode** - Execute commands and edit files on remote servers over SSH
- 🔒 **Sandboxed Execution** - Shell commands run in a sandbox with configurable read policies (`credential-denylist`, `home-denylist`, `standard`, `strict`) to protect sensitive files
- 🤖 **Non-Interactive Mode** - Run commands from the CLI without starting the full UI
- ✏️ **Standard Mode** - Auto-approves file edits in your workspace for faster development (active by default)
- 🛡️ **Smart Shell Auto-Approval** - A hybrid local-heuristic + LLM-based safety evaluator that auto-approves safe commands, eliminating prompt fatigue while strictly blocking risky ones (with detailed reasoning explanations)
- 🖼️ **Image Pasting** - Paste images from your clipboard directly into the terminal for vision-model analysis
- 📈 **Real-time Token Usage** - Live token consumption displayed during streaming


## Why term2 vs Alternatives?

|  | **term2** | **Claude Code** | **Warp** |
| --- | --- | --- | --- |
| **Open Source** | ✅ MIT | ❌ Proprietary | ✅ Open Source |
| **Cost** | Pay-per-use API | $20 - $200/mo (or API) | Freemium / Paid tiers |
| **AI Providers** | Any (OpenAI, OpenRouter, local) | Anthropic only | Selected models / BYOLLM |
| **SSH / Remote** | ✅ Native | ✅ Yes (Remote Control/SSH) | ✅ Yes |
| **Mentor Mode** | ✅ Built-in | ❌ No | ❌ No |
| **Self-Hostable** | ✅ Yes | ❌ No (Requires Anthropic) | ❌ Cloud elements (Oz) |

## Installation

**Requirements:**

- Node.js 20 or higher
- An API key from OpenAI, OpenRouter, or any OpenAI-compatible provider

Install globally via npm:

```bash
npm install --global @qduc/term2
```

Set your API key as an environment variable (see [Configuration](#configuration) section for details):

```bash
export OPENAI_API_KEY="your-api-key-here"
```

## Usage

Start the assistant:

```bash
term2              # Start in standard mode (full capabilities, auto-approves patches)
term2 --lite       # Start in lite mode (fast, read-only)
```

Then simply chat with the AI! Type your question or request, press Enter, and the assistant will help you.

**New to term2?**

- Working on a codebase/project? Use standard mode: `term2`
- Just need general terminal help? Use lite mode: `term2 --lite`
- Tackling a complex problem? Enable mentor mode with `/mentor` command

See the "Operating Modes" section below for full details.

### Basic Examples

```
"What files are in my current directory?"
"Show me my git status"
"Create a backup of my documents folder"
"What's using port 3000?"
```

### Advanced Examples

```
"Find all TODO comments in my JavaScript files"
"Help me debug why my server won't start on port 8080"
"Create a new React component called UserProfile"
"Show me the disk usage of my home directory"
"What processes are consuming the most memory?"
"Search for the word 'config' in all .json files"
```

### Command Line Options

```bash
# Model selection
term2                          # Start with default model (gpt-5.1)
term2 -m gpt-5.2               # Use a specific model
term2 --model gpt-5-mini      # Use GPT-5 mini for faster/cheaper responses
term2 -r high                  # Set reasoning effort to high (for GPT-5 models)
term2 --reasoning medium       # Set reasoning effort to medium

# Operating modes (see "Operating Modes" section below for details)
term2 --lite                   # Start in lite mode for general terminal work (no codebase)

# Resuming past conversations
term2 --resume                 # Resume the last conversation session
term2 -R <conversation-uuid>   # Resume a specific conversation by ID

# SSH Mode - execute on remote servers
term2 --ssh user@host --remote-dir /path/to/project
term2 --ssh deploy@server.com --remote-dir /var/www/app --ssh-port 2222

# Combine SSH with lite mode for lightweight remote assistance
term2 --ssh user@host --remote-dir /path --lite

# Non-interactive mode
term2 "how to use grep"
term2 --auto-approve "list files in current directory"
```

### Slash Commands

While in the chat, you can use these commands:

- `/clear` - Clear the conversation history
- `/quit` - Exit the application
- `/model [model-name]` - Switch to a different model
- `/mentor` - Toggle mentor mode
- `/lite` - Toggle lite mode (requires `/clear` first if a session is active)
- `/plan` - Toggle plan mode (read-only research/planning mode)
- `/orchestrator` - Toggle orchestrator mode (delegates all tool-backed work to subagents; requires `/clear` first if a session is active)
- `/skills` - Browse and manage available skills
- `/undo [last]` - Open the conversation rewind menu, or revert the last turn immediately if `last` is specified
- `/retry` - Undo the last user message and re-send it
- `/usage` - Show token usage breakdown for the current session (includes subagent usage)
- `/effort [level]` - Set reasoning effort for O1/O3 models (e.g. none, minimal, low, medium, high)
- `/copy` - Copy the latest assistant response to the clipboard
- `/handoff` - Hand off the last assistant response to another model or session
- `/auto-approve [off|advisory|auto]` - Set or cycle shell auto-approval mode
- `/settings [key] [value]` - Modify runtime settings (e.g., `/settings agent.temperature 0.7`)


## Operating Modes

| Mode        | Toggle / Start with | Best for                             | Tools Available      | Context       |
| ----------- | ------------------- | ------------------------------------ | -------------------- | ------------- |
| **Standard**| `term2`             | Codebase work & development          | Auto-approves patches| Full codebase |
| **Plan**    | `/plan`             | Researching and designing plans      | Read-only tools      | Full codebase |
| **Lite**    | `term2 --lite`      | General terminal tasks (no codebase) | Read-only tools      | None          |
| **Mentor**  | `/mentor`           | Complex codebase problems            | All + mentor tool    | Full codebase |
| **Orchestrator**| `/orchestrator` | Delegating complex multi-step work   | Subagents + read-only| Full codebase |

**Standard Mode** is the default. It auto-approves `apply_patch` operations within the workspace for high-velocity coding, while still requiring confirmation for destructive operations.

**Plan Mode** enforces read-only boundaries — no file writes or mutating shell commands. Use `/plan` or `Shift+Tab` to toggle.

**Lite Mode** is a fast, lightweight assistant for general terminal work (system admin, file management, SSH sessions). No codebase context or file editing tools. Use `term2 --lite` or `/lite` to toggle.

**Mentor Mode** pairs your primary AI with the `agent.smartModel` tier for strategic guidance on complex problems. Toggle it with `/mentor`.

**Orchestrator Mode** delegates all tool-backed work to subagents, preserving the main context window for high-level orchestration. Toggle with `/orchestrator`.

**Switching modes:** Use `/lite`, `/mentor`, `/plan`, `/orchestrator`, or `Shift+Tab` (cycles Standard ↔ Plan). Modes handle mutual exclusions automatically.


## SSH Mode

Execute commands and modify files on remote servers over SSH. Requires an SSH agent with keys loaded.

```bash
term2 --ssh user@hostname --remote-dir /path/to/project
term2 --ssh user@hostname --remote-dir /path/to/project --ssh-port 2222  # custom port
term2 --ssh user@hostname --lite  # lightweight remote assistance (--remote-dir optional)
```

**Limitations:** SSH agent auth only (no passwords), text files only, no binary file support.

## Non-Interactive Mode

Pass a prompt as a positional argument for one-off tasks. Tool execution is rejected by default; use `--auto-approve` to allow it.

```bash
term2 "list files in current directory"
term2 --auto-approve "delete /tmp/test-file"

# Output: AI response → stdout, events → stderr
ANSWER=$(term2 "is there any TODO in source/cli.tsx?")
```

With `--auto-approve`, defaults to Standard Mode; without it, defaults to Lite Mode.

## Shell Auto-Approval

term2 uses a hybrid local-heuristic + LLM safety evaluation to minimize prompt fatigue while blocking risky commands. Destructive operations (e.g., `rm -rf`, `git push --force`) are always blocked from auto-approval.

Toggle modes with `/auto-approve`:

| Mode | Behavior |
| --- | --- |
| `off` (default) | Every command requires manual confirmation |
| `advisory` | Manual confirmation, but LLM reasoning is displayed alongside |
| `auto` | Safe commands execute automatically; risky ones still prompt |

```json
{
  "shell": { "autoApproveMode": "auto" },
  "agent": { "choreModel": "gpt-5.4-mini" }
}
```

> [!TIP] The chore tier also handles edit self-healing. Use a fast, lightweight model to keep these narrow background tasks responsive.

## Configuration

term2 stores its configuration in:

- **macOS**: `~/Library/Logs/term2-nodejs/settings.json`
- **Linux**: `~/.local/state/term2-nodejs/settings.json`

### Environment Variables (API Keys Only)

API keys should be set as environment variables for security (never commit them to git):

```bash
# OpenAI (default provider)
export OPENAI_API_KEY="sk-..."

# OpenRouter (for Claude, Gemini, and other models)
export OPENROUTER_API_KEY="sk-or-v1-..."

# Web Search (Tavily — default)
export TAVILY_API_KEY="tvly-..."

# Web Search (Exa)
export EXA_API_KEY="..."
```

To make them permanent, add these exports to your shell configuration file (`~/.bashrc`, `~/.zshrc`, or `~/.profile`).

### Configuring Other Settings

Settings (model, provider, temperature, etc.) can be configured via:

1. **App menu** - Use `/settings` command during a session (e.g., `/settings agent.model gpt-5.2`)
2. **Settings file** - Manually edit the JSON file:
   - **macOS**: `~/Library/Logs/term2-nodejs/settings.json`
   - **Linux**: `~/.local/state/term2-nodejs/settings.json`
3. **CLI flags** - Override for a single session (e.g., `-m gpt-5.2`)

### Provider Configuration Examples

```json
// OpenAI (default)
{ "agent": { "provider": "openai", "model": "gpt-5.5" } }

// OpenRouter
{ "agent": { "provider": "openrouter", "model": "anthropic/claude-sonnet-4.6" } }
```

For local LLMs, add a provider entry to the `providers` list:

```json
{
  "providers": [
    { "name": "llama.cpp", "type": "llama.cpp", "baseUrl": "http://127.0.0.1:8080/v1" }
  ],
  "agent": { "provider": "llama.cpp", "model": "qwen3.6-35b-a3b" }
}
```

Supported provider types: `openai` (default), `openai-compatible`, `anthropic`, `google`, `opencode`, `llama.cpp`. Custom providers with `openai-compatible` type work with any OpenAI-compatible endpoint. Set the appropriate API key environment variable for each provider (e.g. `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`).

### General Settings

```json
{
  "agent": {
    "model": "gpt-5.4",
    "provider": "openai",
    "reasoningEffort": "default",
    "temperature": 1,
    "smartModel": "gpt-5.5",
    "balancedModel": "gpt-5.3-codex",
    "cheapModel": "gpt-5.4-mini",
    "choreModel": "gpt-5.4-mini"
  },
  "shell": {
    "timeout": 120000,
    "autoApproveMode": "off",
    "maxParallelToolCalls": 5
  },
  "webSearch": { "provider": "tavily" },
  "app": { "searchViaShell": "auto" }
}
```

See the full schema in `settings.json` for all available options (shell output limits, app mode toggles, concise display mode, etc.).


## Supported Models

- **OpenAI** (default): `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.2`, `gpt-5.1`
- **OpenRouter**: Claude, Gemini, DeepSeek, and hundreds more — use `-m model-name`
- **Local/Self-hosted**: Any OpenAI-compatible API (Ollama, LM Studio, vLLM, Groq, etc.)

You can reorder provider priority with the `PROVIDER_ORDER` setting in `settings.json`.

## Subagents

Delegate tasks to specialized subagents to prevent context bloat. Available roles: **Explorer** (codebase scanning), **Worker** (modifications & tests), **Researcher** (web search & docs), **Mentor** (strategic guidance). Ancillary workloads use four configurable tiers: mentor uses `smart`, worker and researcher use `balanced`, explorer and librarian use `cheap`, and approval/edit-healing tasks use `chore`. Each tier can set a matching provider, such as `agent.smartProvider`; subagent tiers can also set reasoning effort with `agent.smartReasoningEffort`, `agent.balancedReasoningEffort`, or `agent.cheapReasoningEffort`. Unset values inherit the main agent settings.

Legacy per-role, mentor, auto-approval, and edit-healing model settings remain readable for compatibility but are hidden from the interactive settings menu. New configuration should use the tier settings.

Subagents can also use the `ask_user` tool to ask you structured multi-choice questions during execution. Low-risk (YELLOW) shell commands issued by subagents are auto-approved to reduce interruptions.

## Conversation Resumption & Persistence

Conversations are auto-saved on exit. Resume with:

```bash
term2 --resume               # resume last session
term2 --resume <session-uuid> # resume specific session
term2 --resume ls             # list saved sessions with metadata
```



## Development

Want to contribute or run from source?

```bash
# Clone the repository
git clone https://github.com/qduc/term2.git
cd term2

# Install dependencies
npm install

# Run in development mode
npm run dev

# Run tests
npm test

# Build
npm run build
```

## Troubleshooting

| Issue | Fix |
| --- | --- |
| `OPENAI_API_KEY not set` | `export OPENAI_API_KEY="sk-..."` |
| `command not found: term2` | Restart terminal or `source ~/.zshrc` |
| Permission denied during install | `sudo npm install --global @qduc/term2` or [fix npm perms](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally) |
| SSH connection failed | Start agent (`eval "$(ssh-agent -s)"`), add key (`ssh-add`), verify with `ssh-add -l` |
| `remote-dir is required` | Add `--remote-dir /path` or use `--lite` (auto-detects) |

## Tips

- Choose the right mode: **lite** for terminal work, **standard** for codebase work, **mentor** for complex problems
- Paste images directly into the terminal for vision-model analysis
- Press `Ctrl+C` to exit, arrow keys to navigate history
- Use `/auto-approve auto` to reduce prompt fatigue during long sessions
- System notifications alert you when the agent needs approval or finishes a task
- Sandbox protects sensitive files — configure `sandbox.readPolicy` in settings for stricter access control

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request or open an Issue on [GitHub](https://github.com/qduc/term2).

## License

MIT License - see [LICENSE](LICENSE) file for details

## Acknowledgments

Built with:

- [OpenAI Agents SDK](https://github.com/openai/openai-agents-js)
- [Ink](https://github.com/vadimdemedes/ink) - React for CLI
- [TypeScript](https://www.typescriptlang.org/)
- [ssh2](https://github.com/mscdex/ssh2) - SSH client for Node.js
