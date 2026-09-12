---
title: Installation
description: How to install term2 on Linux, macOS, and Windows.
---

## Prerequisites

- **Node.js**: Version 20.0.0 or higher (Node 24 recommended).
- **Package Manager**: `npm`, `pnpm` (>= 11.0.0), or `yarn`.
- **Operating System**: Linux, macOS, or Windows (WSL / PowerShell).
- **AI Credentials**: An API key or OAuth account for your preferred provider (OpenAI, OpenRouter, Grok, Codex, Anthropic, or Gemini).

## Global Installation

Install term2 globally using your preferred package manager:

```bash
# Using npm
npm install --global @qduc/term2

# Or using pnpm
pnpm add --global @qduc/term2
```

## Verify Installation

Check that term2 is accessible on your `PATH`:

```bash
term2 --version
```

To display help and available command-line flags:

```bash
term2 --help
```

## Optional Tools

term2 automatically detects and uses helper tools installed on your system:

- **ripgrep (`rg`)**: Highly recommended for high-performance codebase searches.
- **fd (`fd` or `fdfind`)**: Recommended for fast file and path discovery.
- **git**: Required for repository worktrees and version-controlled diffs.
- **ssh & ssh-agent**: Required for remote SSH sessions (`--ssh`).
