---
title: Providers Overview
description: Supported providers, models, and custom endpoint integration.
---

term2 features a provider-neutral model layer supporting major commercial LLM APIs, browser OAuth logins, and local endpoints.

## Supported Providers

| Provider | Identifier (`-p`) | Connection Method | Auth Mechanism | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **OpenAI** | `openai` | WebSocket Responses / Chat Completions | `OPENAI_API_KEY` or `agent.openai.apiKey` | Default provider. Supports native server-side context management. |
| **ChatGPT / Codex** | `codex` | WebSocket Responses | PKCE OAuth (`term2 --codex-login`) | Direct login with ChatGPT subscription credentials. |
| **xAI Grok** | `grok` | Responses API | PKCE OAuth (`term2 --grok-login`) | Encrypted reasoning tokens round-tripped with full continuity. |
| **OpenRouter** | `openrouter` | HTTP Streaming | `OPENROUTER_API_KEY` or `agent.openrouter.apiKey` | Unified gateway to Claude, Gemini, DeepSeek, Llama, and hundreds more. |
| **Anthropic** | `anthropic` | HTTP Streaming | `ANTHROPIC_API_KEY` | Direct Claude 3.5 Sonnet, Claude 3.7 Sonnet, etc. |
| **Google Gemini** | `google` | HTTP Streaming | `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini 1.5 Pro, Gemini 2.0 Flash, etc. |
| **Local llama.cpp** | Custom | HTTP (`baseUrl: http://127.0.0.1:8080/v1`) | No auth required for loopback | Local CPU/GPU inference. |
| **Local Ollama** | Custom | HTTP (`baseUrl: http://127.0.0.1:11434/v1`) | No auth required for loopback | Configured via custom provider. |

## Managing Providers Interactively (`/providers`)

Run `/providers` in any interactive session to open the Provider Manager:
- List active and available providers.
- Add new custom endpoints.
- Edit existing connection settings (Base URL, API keys).
- Switch active accounts when multiple OAuth accounts are configured.
- Remove custom providers.

## Custom OpenAI-Compatible Endpoints

You can register custom providers via the `/providers` menu or directly in `settings.json`:

```json
{
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

Loopback endpoints (`127.0.0.1`, `localhost`, `::1`) are treated as local and do not require API keys. Remote endpoints can specify an optional `apiKey`.
