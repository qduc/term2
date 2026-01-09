# term2

[![npm version](https://img.shields.io/npm/v/@qduc/term2.svg)](https://www.npmjs.com/package/@qduc/term2)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/term2.svg)](https://nodejs.org)

A powerful terminal-based AI assistant that helps you get things done on your computer through natural conversation.

## Features

-   🎭 **Three Operating Modes** - Default (full-power), Lite (fast & safe), and Mentor (collaborative problem-solving)
-   🤖 **Multi-Provider Support** - Works with OpenAI, OpenRouter, and OpenAI-compatible APIs
-   🔒 **Safe Execution** - Every command requires your explicit approval with diff preview
-   🛠️ **Advanced Tools** - Shell execution, file patching, search/replace, grep, find files, file reading, web search, and mentor consultation
-   💬 **Slash Commands** - Quick actions like `/clear`, `/quit`, `/model`, `/mentor`, `/lite` for easy control
-   📝 **Smart Context** - The assistant understands your environment and provides relevant help
-   🎯 **Streaming Responses** - See the AI's thoughts and reasoning in real-time
-   🧠 **Reasoning Effort Control** - Configurable reasoning levels (minimal to high) for O1/O3 models
-   ⚡ **Command History** - Navigate previous inputs with arrow keys
-   🎨 **Markdown Rendering** - Formatted code blocks and text in the terminal
-   🔄 **Retry Logic** - Automatic recovery from tool hallucinations and upstream errors
-   🌐 **SSH Mode** - Execute commands and edit files on remote servers over SSH

## Operating Modes

term2 offers three modes tailored to different workflows. Choose the mode that matches your current task.

### Quick Reference

| Mode | Start with | Best for | Tools Available | Context |
|------|------------|----------|-----------------|---------|
| **Default** | `term2` | Codebase work & development | All editing tools | Full codebase |
| **Lite** | `term2 --lite` | General terminal tasks (no codebase) | Read-only | None |
| **Mentor** | Use `/mentor` | Complex codebase problems | All + mentor | Full codebase |

### Lite Mode - Everyday Terminal Assistant

**The problem it solves:** You need a general-purpose terminal assistant for everyday system tasks—not working with a codebase or project.

Lite mode is designed for general terminal work: system administration, file management, running commands, investigating logs, and SSH sessions. It's **not** for codebase/project work (no code editing tools, no project context loading). Think of it as your everyday terminal companion for non-coding tasks.

**Key benefits:**
- 🚀 **Fast and lightweight** - No codebase context, no project file loading, quick startup
- 🔧 **General terminal tools** - Shell commands, grep, read files, find files (no code editing)
- 🌐 **Perfect for SSH** - Ideal for remote server management and investigation
- 🔄 **Toggleable** - Switch on/off mid-session with `/lite` command
- 🐚 **Shell mode** - Press Shift+Tab to toggle direct shell command execution

**When to use Lite mode:**
- System administration and server management tasks
- Investigating logs, config files, and system issues
- File system navigation and organization
- SSH into servers for maintenance or debugging
- General terminal help when not working on a codebase
- Quick command help and syntax lookups

**Example:**
```bash
# Everyday terminal assistant (not working with code)
term2 --lite

# SSH server management and investigation
term2 --ssh deploy@server.com --lite

# Remote server debugging
term2 --ssh user@host --remote-dir /var/log --lite
```

### Mentor Mode - Collaborative Problem Solving

**The problem it solves:** You're tackling a complex codebase problem and need a different perspective or expert consultation.

Mentor mode gives you two AI minds working together on your codebase. Your primary AI does the reconnaissance and implementation work, while a separate (often more powerful) mentor model provides strategic guidance, challenges assumptions, and suggests alternatives. Think of it as pair programming with an expert consultant.

**Key benefits:**
- 🧠 **Two minds, better solutions** - Primary AI gathers context, mentor provides strategic guidance
- 🔍 **Structured problem-solving** - Forces clear articulation of findings before jumping to solutions
- ❓ **Challenges assumptions** - Mentor actively probes for gaps and alternative approaches
- 🎯 **You stay in control** - Mentor advises, primary AI implements your decisions

**How it works:**
1. You give the AI a task or problem
2. The AI does quick reconnaissance of your codebase
3. AI consults the mentor using `ask_mentor` tool with findings and questions
4. Mentor challenges assumptions and provides strategic guidance
5. AI implements the solution based on the guidance

**Important:** The mentor model doesn't have direct access to your codebase. Your primary AI must share all relevant information (code snippets, file paths, findings) when consulting the mentor. This forces clear problem articulation and save cost on the more expensive mentor model.

**When to use Mentor mode:**
- Architectural decisions with multiple valid approaches
- "Am I missing something?" sanity checks before major refactoring
- Stuck on a problem after trying multiple solutions
- Designing new features that must fit existing patterns
- Getting a pre-commit review of your approach

**Requirements:**
- Configure `agent.mentorModel` in settings (e.g., `gpt-5.2`, `claude-opus-4.5` or `gemini-3-pro-preview`)
- Mentor model should be more capable than primary model for best results
- Toggle with `/mentor` command mid-session

**Example workflow:**
```
You: "Add dark mode support to the app"

AI: [Searches for theme infrastructure]
    [Finds ThemeProvider at src/context/ThemeContext.tsx]

AI: [Consults mentor] "User wants dark mode. Found ThemeProvider that uses
    CSS variables like --background-color. Currently fixed to 'light' theme.
    Propose extending this provider to toggle themes. Confidence: High.
    Does this approach make sense?"

Mentor: "Good find. Before proceeding, check:
         1. Are CSS variables used consistently across all components?
         2. Any third-party UI libraries that need theme integration?
         3. Should theme preference persist across sessions?
         Missing any of these could create inconsistent theming."

AI: [Does additional checks based on mentor's questions]
    [Implements solution addressing all concerns]
```

### Switching Modes

Modes are mutually exclusive—each represents a different working style matched to your task. You can switch modes mid-session:

- `/lite` - Toggle lite mode (clears history when switching)
- `/mentor` - Toggle mentor mode
- Switching to lite mode automatically disables edit/mentor modes
- Enabling edit or mentor mode automatically disables lite mode

## Demo

<!-- Add a demo GIF or screenshot here -->

## Installation

**Requirements:**

-   Node.js 16 or higher
-   An API key from OpenAI, OpenRouter, or any OpenAI-compatible provider

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
term2              # Start in default mode (full capabilities)
term2 --lite       # Start in lite mode (fast, read-only)
```

Then simply chat with the AI! Type your question or request, press Enter, and the assistant will help you.

**New to term2?**
- Working on a codebase/project? Use default mode: `term2`
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

# Operating modes (see "Operating Modes" section above for details)
term2 --lite                   # Start in lite mode for general terminal work (no codebase)

# SSH Mode - execute on remote servers
term2 --ssh user@host --remote-dir /path/to/project
term2 --ssh deploy@server.com --remote-dir /var/www/app --ssh-port 2222

# Combine SSH with lite mode for lightweight remote assistance
term2 --ssh user@host --remote-dir /path --lite
```

### Slash Commands

While in the chat, you can use these commands:

-   `/clear` - Clear the conversation history
-   `/quit` - Exit the application
-   `/model [model-name]` - Switch to a different model
-   `/mentor` - Toggle mentor mode (see "Operating Modes" section for details)
-   `/lite` - Toggle lite mode (see "Operating Modes" section for details)
-   `/settings [key] [value]` - Modify runtime settings (e.g., `/settings agent.temperature 0.7`)

## Configuration

term2 stores its configuration in:

-   **macOS**: `~/Library/Logs/term2-nodejs/settings.json`
-   **Linux**: `~/.local/state/term2-nodejs/settings.json`

### Environment Variables (API Keys Only)

API keys should be set as environment variables for security (never commit them to git):

```bash
# OpenAI (default provider)
export OPENAI_API_KEY="sk-..."

# OpenRouter (for Claude, Gemini, and other models)
export OPENROUTER_API_KEY="sk-or-v1-..."

# Web Search (Tavily)
export TAVILY_API_KEY="tvly-..."
```

To make them permanent, add these exports to your shell configuration file (`~/.bashrc`, `~/.zshrc`, or `~/.profile`).

### Configuring Other Settings

All other settings (model, temperature, reasoning effort, timeouts, etc.) can be configured via:

1. **App menu** - Use `/settings` command during a session for interactive configuration
2. **Settings file** - Manually edit the JSON file:
   - **macOS**: `~/Library/Logs/term2-nodejs/settings.json`
   - **Linux**: `~/.local/state/term2-nodejs/settings.json`
3. **CLI flags** - Override for a single session (e.g., `-m gpt-5.2`, `-r high`)

Example settings file:
```json
{
  "agent": {
    "model": "gpt-5.1",
    "reasoningEffort": "medium",
    "temperature": 0.7,
    "provider": "openai",
    "mentorModel": "gpt-5.2"
  },
  "shell": {
    "timeout": 120000,
    "maxOutputLines": 1000
  }
}
```

## How It Works

1. You type a message and press Enter
2. The AI analyzes your request and determines if it needs to execute commands
3. If a command is needed, you'll see a preview and approval prompt
4. After approval, the command runs and results are shown
5. The AI uses the results to provide a helpful response
6. You stay in full control - reject any command with 'n'

## SSH Mode

SSH mode enables term2 to execute commands and modify files on remote servers over SSH. This is useful for managing remote deployments, debugging server issues, or working on remote development environments.

### Requirements

- SSH agent running with your keys loaded (`ssh-add`)
- SSH access to the target server
- `--remote-dir` is required to specify the working directory (optional in lite mode - will auto-detect)

### Usage

```bash
# Basic usage
term2 --ssh user@hostname --remote-dir /path/to/project

# With custom SSH port
term2 --ssh user@hostname --remote-dir /path/to/project --ssh-port 2222

# With lite mode (auto-detects remote directory)
term2 --ssh user@hostname --lite
```

### How It Works

When SSH mode is enabled:
1. term2 establishes an SSH connection using your SSH agent for authentication
2. All shell commands are executed on the remote server via SSH
3. File operations (read, write, patch) are performed remotely using shell commands (`cat`, heredocs)
4. The working directory is set to `--remote-dir` on the remote server
5. The connection is automatically closed when you exit term2

### Combining with Lite Mode

SSH mode works seamlessly with lite mode for lightweight remote terminal assistance:

```bash
term2 --ssh user@host --remote-dir /path/to/project --lite
```

This combination provides:
- Remote command execution over SSH
- Read-only tools (grep, find_files, read_file) for exploration
- Minimal context and faster responses
- No file editing tools (safer for production servers)

### Limitations

- Authentication is via SSH agent only (no password prompts)
- Binary file operations are not supported (text files only)
- Large file transfers may be slower than local operations

## Safety Features

-   **Command Approval** - Every destructive operation requires your explicit confirmation
-   **Diff Preview** - See exact file changes before approving patches or edits
-   **Risk Analysis** - Dangerous operations (like `rm -rf`, `git push --force`) are flagged
-   **Path Safety** - Operations on sensitive directories require extra caution
-   **Dry-Run Validation** - Patches are validated before approval to prevent errors
-   **No Hidden Actions** - All tool usage is transparent and visible
-   **Retry Limits** - Automatic abort after consecutive tool failures (default: 3)

## Available Tools

The AI assistant has access to these tools to help you. **Note:** Tool availability depends on your operating mode—see the "Operating Modes" section above for details.

### Shell Tool
Execute shell commands with safety validation:
- Detects dangerous patterns (`rm -rf`, force operations)
- Validates paths to prevent operations on sensitive directories
- Configurable timeout and output limits
- Requires explicit approval before execution

### Apply Patch Tool
Apply file changes using unified diff format:
- Create new files or update existing ones
- Dry-run validation before approval
- Clear diff preview showing exact changes
- Supports "edit mode" for automatic approval

### Search & Replace Tool
Find and replace text in files:
- Exact match with fallback to line-by-line matching
- Diff generation for user preview
- Single or multiple replacements
- Requires approval before making changes

### Grep Tool
Search codebase for patterns:
- Uses ripgrep when available (fast!)
- Supports regex patterns
- Respects .gitignore
- Read-only operation (no approval needed)

### Ask Mentor Tool
Consult a smarter model for advice:
- Query a different/better model for complex questions
- Available when mentor mode is enabled (see "Operating Modes" section)
- Configure via `agent.mentorModel` setting (e.g., `gpt-5.1`, `claude-sonnet-4.5`)
- Useful for architectural decisions and getting second opinions
- Mentor provides strategic guidance without direct codebase access

### Find Files Tool
Search for files in the workspace:
- High-performance file search using `fd`
- Supports glob patterns and exclusions
- Respects `.gitignore` by default

### Read File Tool
Read file contents with precision:
- Read entire files or specific line ranges
- Optimizes context usage for large files
- Support for reading multiple files

### Web Search Tool
Search the web for information:
- Uses Tavily API by default for web search
- Converts results to markdown for readability
- Pluggable architecture ready to swap in other providers (Serper, Brave, etc.)
- Read-only operation (no approval needed)
- Requires `TAVILY_API_KEY` environment variable or settings configuration


## Supported Models

term2 works with multiple AI providers:

### OpenAI (default)
-   `gpt-5.2` (latest)
-   `gpt-5.1` (default)
-   `gpt-5`
-   `gpt-5-mini`
-   `gpt-4.1`
-   `gpt-4.1-mini`
-   `gpt-5.1`
-   `gpt-5.1-mini`
-   `o3` (supports reasoning effort)
-   `o3-mini` (supports reasoning effort)
-   `o1` (supports reasoning effort)

### OpenRouter
Access hundreds of models through OpenRouter including:
-   Claude models (Anthropic)
-   Gemini models (Google)
-   Open-source models (Deepseek, GLM, Minimax, Devstral, etc.)

Use CLI flags (`-m model-name`) or settings file to select OpenRouter models.

### OpenAI-Compatible
Any OpenAI-compatible API endpoint can be configured through runtime settings.

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

### "OPENAI_API_KEY not set"

Make sure you've exported your OpenAI API key:

```bash
export OPENAI_API_KEY="sk-..."
```

### Command not found: term2

After installation, you may need to restart your terminal or run:

```bash
source ~/.bashrc  # or ~/.zshrc
```

### Permission denied

If you get permission errors during global installation, use:

```bash
sudo npm install --global @qduc/term2
```

Or configure npm to install globally without sudo: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally

### SSH connection failed

Make sure your SSH agent is running and has your keys loaded:

```bash
# Start SSH agent if not running
eval "$(ssh-agent -s)"

# Add your SSH key
ssh-add ~/.ssh/id_rsa

# Verify the key is loaded
ssh-add -l
```

Also verify you can connect manually: `ssh user@hostname`

### SSH mode: "remote-dir is required"

When using `--ssh` without `--lite`, you must also specify `--remote-dir`:

```bash
term2 --ssh user@host --remote-dir /home/user/project
```

With `--lite` mode, `--remote-dir` is optional and will auto-detect:

```bash
term2 --ssh user@host --lite
```

## Tips

-   **Choose the right mode** - Use lite mode for general terminal work (not codebase), default mode for codebase work, mentor mode for complex codebase problems (see "Operating Modes" section)
-   The assistant won't run dangerous commands without your approval
-   You can reject any command by choosing 'No' when prompted
-   Press Ctrl+C to exit the chat at any time
-   Use arrow keys to navigate through your command history
-   Be specific in your requests for better results
-   Use `/mentor` to get expert consultation on difficult architectural decisions
-   Use `--lite` flag when SSH'ing to servers for general system work without codebase context

## License

MIT License - see [LICENSE](LICENSE) file for details

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request or open an Issue on [GitHub](https://github.com/qduc/term2).

## Acknowledgments

Built with:

-   [OpenAI Agents SDK](https://github.com/openai/openai-agents-js)
-   [Ink](https://github.com/vadimdemedes/ink) - React for CLI
-   [TypeScript](https://www.typescriptlang.org/)
-   [ssh2](https://github.com/mscdex/ssh2) - SSH client for Node.js

---

Made with ❤️ by [qduc](https://github.com/qduc)
