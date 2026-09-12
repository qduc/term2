---
title: term2
description: Terminal-based AI assistant and autonomous agent runtime.
template: splash
hero:
  tagline: A terminal-based AI assistant and autonomous agent runtime built for high-velocity software engineering and system administration.
  actions:
    - text: Get Started
      link: /term2/getting-started/
      icon: right-arrow
      variant: primary
    - text: View on GitHub
      link: https://github.com/qduc/term2
      icon: external
      variant: secondary
---

import { Card, CardGrid } from '@astrojs/starlight/components';

## Key Features

<CardGrid stagger>
  <Card title="Universal Provider Support" icon="puzzle">
    Connect to built-in providers (OpenAI, ChatGPT/Codex OAuth, xAI Grok OAuth, OpenRouter), custom Anthropic and Google Gemini adapters, and local OpenAI-compatible endpoints (Ollama, llama.cpp).
  </Card>
  <Card title="Execution Safety & Sandboxing" icon="shield">
    Sandboxed shell execution with configurable read/write boundaries (`standard` and `strict`), interactive diff previews, smart auto-approvals, and run budgets.
  </Card>
  <Card title="Five Operating Modes" icon="list-format">
    Standard, Plan, Lite, Mentor, and Orchestrator modes adapted to research, planning, full development, collaborative second-opinions, and delegated orchestration.
  </Card>
  <Card title="Multi-Agent Swarms" icon="setting">
    Deploy specialized subagents (Explorer, Worker, Mentor, Librarian) across tiered model profiles (`smart`, `balanced`, `cheap`, `chore`) in foreground or background with `Ctrl+G` task management.
  </Card>
  <Card title="Native Remote Development" icon="laptop">
    Connect directly to remote servers over SSH with local SSH agent authentication and run full or lightweight agent sessions remotely.
  </Card>
  <Card title="Private Web Gateway" icon="open-book">
    Launch `term2 serve` to expose an authenticated, audited Unix socket or TLS gateway for programmatic control and external clients.
  </Card>
</CardGrid>
