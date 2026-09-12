---
title: Overview
description: What is term2 and why choose it for terminal AI workflows.
---

**term2** is an open-source terminal AI assistant and autonomous agent runtime built for high-velocity software engineering and system administration.

Combining an interactive React (Ink) terminal user interface with an application-owned agent run loop, term2 provides fine-grained execution safety, native multi-agent delegation, provider-neutral context compaction, and multi-provider support—giving developers complete agency over their workflow without vendor lock-in or subscription gates.

## Core Capabilities

- **Universal Provider Support**: Native integration with OpenAI (WebSocket Responses and Chat Completions), ChatGPT/Codex OAuth (browser PKCE), xAI Grok (Responses API with encrypted reasoning and OAuth), and OpenRouter, plus custom adapters for Anthropic, Google Gemini, and local OpenAI-compatible endpoints (Ollama, llama.cpp, vLLM).
- **Fine-Grained Execution Safety**: Sandboxed shell execution with configurable read/write boundaries (`standard` and `strict`), interactive unified diff previews, and run budget caps.
- **Smart Shell Auto-Approval**: A hybrid heuristic safety evaluator that auto-approves safe read-only and workspace commands, eliminating prompt fatigue while gating risky operations.
- **Multi-Agent Swarms**: Spawn specialized foreground or background subagents (`explorer`, `worker`, `mentor`, `librarian`) across tiered model profiles (`smart`, `balanced`, `cheap`, `chore`).
- **Provider-Neutral Context Compaction**: Automatically compacts long conversation histories when reaching token milestones while preserving cold architectural context and hot-tail tool integrity.
- **Time-Travel Rewind & Forking**: Non-destructive conversation rewinding with discard inspection (`/rewind`, `/undo`, `/retry`), session resumption (`/resume`, `--resume`), and branching (`--fork`).
- **Native Remote Development**: Execute commands and manage codebases on remote servers seamlessly over SSH with local SSH agent authentication.
- **Private Web Gateway**: Launch `term2 serve` to expose an authenticated Unix socket or TLS gateway for programmatic control and external clients.

## How term2 Works

When you launch term2 in a project directory:
1. **Context Discovery**: term2 inspects the workspace root, detects project instructions (e.g., `AGENTS.md`, `CLAUDE.md`), discovers available skills, and establishes the operating profile.
2. **Interactive Run Loop**: You interact via a composer supporting multi-line editing, `@` file completion, `!` direct shell execution, and `/` slash commands.
3. **Safe Tool Execution**: When the agent proposes tool actions (such as editing files, running shell commands, or executing sandboxed JavaScript), term2 renders unified diffs or approval prompts before mutation occurs.
4. **Resilience & Resumption**: All events are saved to append-only logs in your platform's state directory, allowing full resumption or forking anytime.
