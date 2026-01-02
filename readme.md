# term2

[![npm version](https://img.shields.io/npm/v/term2.svg)](https://www.npmjs.com/package/term2)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/term2.svg)](https://nodejs.org)

A powerful terminal-based AI assistant that helps you get things done on your computer through natural conversation.

## Features

-   🤖 **Multi-Provider Support** - Works with OpenAI, OpenRouter, and OpenAI-compatible APIs
-   🔒 **Safe Execution** - Every command requires your explicit approval with diff preview
-   🛠️ **Advanced Tools** - Shell execution, file patching, search/replace, grep, find files, file reading, and mentor consultation
-   💬 **Slash Commands** - Quick actions like `/clear`, `/quit`, `/model`, `/setting` for easy control
-   📝 **Smart Context** - The assistant understands your environment and provides relevant help
-   🎯 **Streaming Responses** - See the AI's thoughts and reasoning in real-time
-   🧠 **Reasoning Effort Control** - Configurable reasoning levels (minimal to high) for O1/O3 models
-   ⚡ **Command History** - Navigate previous inputs with arrow keys
-   🎨 **Markdown Rendering** - Formatted code blocks and text in the terminal
-   🔄 **Retry Logic** - Automatic recovery from tool hallucinations and upstream errors
-   🌐 **SSH Mode** - Execute commands and edit files on remote servers over SSH

## Demo

<!-- Add a demo GIF or screenshot here -->

```
$ term2
You: What files are in my current directory?
Assistant: I'll list the files for you.

📋 Command to execute:
ls -la

Approve? (y/n): y
...
```

## Installation

**Requirements:**

-   Node.js 16 or higher
-   An API key from OpenAI, OpenRouter, or any OpenAI-compatible provider

Install globally via npm:

```bash
npm install --global term2
```

Set your API key as an environment variable:

```bash
# For OpenAI (default)
export OPENAI_API_KEY="your-api-key-here"

# For OpenRouter
export TERM2_AGENT_PROVIDER="openrouter"
export TERM2_AGENT_OPENROUTER_API_KEY="your-openrouter-key"
```

To make it permanent, add the export to your shell configuration file (`~/.bashrc`, `~/.zshrc`, or `~/.profile`).

## Usage

Start the assistant:

```bash
term2
```

Then simply chat with the AI! Type your question or request, press Enter, and the assistant will help you.

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
term2                           # Start with default model (gpt-5.1)
term2 -m gpt-4o                # Use a specific model
term2 --model gpt-4o-mini      # Use GPT-4o mini for faster/cheaper responses
term2 -r high                  # Set reasoning effort to high (for O1/O3 models)
term2 --reasoning medium       # Set reasoning effort to medium

# SSH Mode - execute on remote servers
term2 --ssh user@host --remote-dir /path/to/project
term2 --ssh deploy@server.com --remote-dir /var/www/app --ssh-port 2222

# Combine SSH with lite mode for remote terminal assistance
term2 --ssh user@host --remote-dir /path --lite
```

### Slash Commands

While in the chat, you can use these commands:

-   `/clear` - Clear the conversation history
-   `/quit` or `/exit` - Exit the application
-   `/model [model-name]` - Switch to a different model
-   `/mentor` - Toggle mentor mode (collaborative mode with mentor model)
-   `/lite` - Toggle lite mode (minimal context, no codebase)
-   `/setting [key] [value]` - Modify runtime settings (e.g., `/setting agent.temperature 0.7`)
-   `/help` - Show available commands

## Configuration

term2 stores its configuration in:

-   **macOS**: `~/Library/Logs/term2-nodejs/settings.json`
-   **Linux**: `~/.local/state/term2-nodejs/settings.json`

You can also configure settings via environment variables (prefix with `TERM2_`):

```bash
# Agent settings
export TERM2_AGENT_MODEL="gpt-4o"
export TERM2_AGENT_PROVIDER="openai"  # or "openrouter"
export TERM2_AGENT_REASONING_EFFORT="medium"  # none, minimal, low, medium, high, default
export TERM2_AGENT_TEMPERATURE="0.7"  # 0.0 to 2.0
export TERM2_AGENT_MAX_TURNS="100"
export TERM2_AGENT_RETRY_ATTEMPTS="2"

# Provider-specific settings
export TERM2_AGENT_OPENROUTER_API_KEY="your-key"

# Tool settings
export TERM2_SHELL_TIMEOUT="180000"
export TERM2_SHELL_MAX_OUTPUT_LINES="1000"

# App settings
export TERM2_APP_MODE="default"  # or "edit" for automatic patch approval

# SSH settings (alternative to CLI flags)
export TERM2_SSH_HOST="user@server.com"
export TERM2_SSH_PORT="22"
export TERM2_SSH_REMOTE_DIR="/path/to/project"
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
- `--remote-dir` is required to specify the working directory on the remote server

### Usage

```bash
# Basic usage
term2 --ssh user@hostname --remote-dir /path/to/project

# With custom SSH port
term2 --ssh user@hostname --remote-dir /path/to/project --ssh-port 2222
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

The AI assistant has access to these tools to help you:

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
- Configurable mentor model via settings
- Useful for getting second opinions

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


## Supported Models

term2 works with multiple AI providers:

### OpenAI (default)
-   `gpt-5.1` (default)
-   `gpt-4o`
-   `gpt-4o-mini`
-   `o1` (supports reasoning effort)
-   `o3-mini` (supports reasoning effort)
-   `gpt-4-turbo`
-   `gpt-4`
-   `gpt-3.5-turbo`

### OpenRouter
Access hundreds of models through OpenRouter including:
-   Claude models (Anthropic)
-   Gemini models (Google)
-   Open-source models (Llama, Mistral, etc.)

Set `TERM2_AGENT_PROVIDER="openrouter"` to use OpenRouter.

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
sudo npm install --global term2
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

When using `--ssh`, you must also specify `--remote-dir`:

```bash
term2 --ssh user@host --remote-dir /home/user/project
```

## Tips

-   The assistant won't run dangerous commands without your approval
-   You can reject any command by pressing 'n' when prompted
-   Press Ctrl+C to exit the chat at any time
-   Use arrow keys to navigate through your command history
-   Be specific in your requests for better results

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
