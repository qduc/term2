---
title: First Run
description: Setting up your first provider, model, and running term2.
---

## Authenticating Your Provider

Before starting term2, configure authentication for at least one provider.

### Option 1: Browser-Based OAuth (Recommended for Grok & Codex)

term2 provides built-in browser PKCE OAuth flows. You do not need to generate or paste API keys:

```bash
# Log in to xAI Grok
term2 --grok-login

# Log in to OpenAI Codex / ChatGPT
term2 --codex-login
```

This launches your default browser to authenticate. Once complete, term2 stores the tokens locally and exits.

### Option 2: Environment Variables (API Keys)

Export the API key for your chosen provider in your shell environment (or add it to your shell profile):

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

### Option 3: Interactive First-Run Wizard

If you start `term2` without configured credentials, an interactive setup prompt helps you configure your primary provider and model directly in the terminal.

## Launching term2

Navigate to any project directory and start an interactive session:

```bash
cd /path/to/project
term2
```

### Starting in Specific Modes

```bash
# Start in lightweight mode (minimal context, no codebase indexing overhead)
term2 --lite

# Start with a specific model and provider
term2 -m claude-sonnet-4.6 -p openrouter

# Set reasoning effort level
term2 -r high

# Open interactive model picker on startup
term2 --model
```

### Resuming Conversations

Sessions automatically save across restarts:

```bash
# Resume the last conversation in this directory
term2 --resume

# List recent saved sessions with metadata
term2 --resume ls

# Resume a specific session by UUID
term2 --resume <session-id>

# Fork a previous session into a new branch
term2 --resume <session-id> --fork
```
